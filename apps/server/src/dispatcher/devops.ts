import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { withCommitAs } from '../commands/commit-as.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildDevopsShiftStart } from '../runner-gateway/brief.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { mainUsable } from './accounts.ts';
import { projectPausedSql } from './project-hold.ts';

const ONLINE_WINDOW_MS = 45_000;

export interface DevopsDispatch {
  requestId: string;
  shiftId: string;
  workstationId: string;
  agentId: string;
}

/**
 * A request somebody waits for (`r` is the `devops_requests` row): a card is parked on it, or the agent that asked still
 * holds a card shift on that card that started before the request (the request `questionStatus` polls for).
 */
export const WAITED_SQL = `(EXISTS (SELECT 1 FROM cards wc WHERE wc.parked_request_id = r.id AND wc.status = 'waiting')
  OR (r.requested_by_kind = 'agent' AND r.card_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM shifts ws WHERE ws.card_id = r.card_id AND ws.agent_id::text = r.requested_by_id
           AND ws.kind = 'card' AND ws.status <> 'ended' AND ws.started_at <= r.created_at)))`;

/** The second (express) slot opens only while the engineer's single running shift is at least this old. */
export const EXPRESS_AFTER_MS = 5 * 60_000;

/** An open DevOps shift of one engineer: when it started and the card of the request it works (null: none). */
export interface OpenDevopsShift {
  startedAt: Date;
  cardId: string | null;
}

/**
 * The capacity rule (docs/ARCHITECTURE.md section 16.2): at most two open DevOps shifts per engineer. The first slot
 * takes the head of the queue; the second (express) slot opens only while the one running shift is at least
 * `EXPRESS_AFTER_MS` old, and only for a waited-on request of another card. Null: the request waits.
 */
export function devopsLane(
  open: readonly OpenDevopsShift[],
  req: { cardId: string | null; waited: boolean },
  now: Date,
): 'normal' | 'express' | null {
  if (open.length === 0) return 'normal';
  if (open.length > 1) return null;
  const running = open[0]!;
  if (!req.waited || !req.cardId || req.cardId === running.cardId) return null;
  if (now.getTime() - running.startedAt.getTime() < EXPRESS_AFTER_MS) return null;
  return 'express';
}

async function openDevopsShifts(db: Queryable, agentId: string): Promise<OpenDevopsShift[]> {
  const open = await rows(
    db,
    `SELECT s.started_at, (SELECT dr.card_id FROM devops_requests dr WHERE dr.shift_id = s.id LIMIT 1) AS card_id
       FROM shifts s WHERE s.agent_id=$1 AND s.kind='devops' AND s.status <> 'ended'`,
    [agentId],
  );
  return open.map((o) => ({
    startedAt: new Date(o.started_at),
    cardId: (o.card_id as string | null) ?? null,
  }));
}

/**
 * DevOps request queue (docs/ARCHITECTURE.md section 16.2), per workstation: waited-on requests first, then the oldest;
 * one DevOps shift per DevOps engineer plus the express slot of `devopsLane`; only on a connected, reconciled
 * workstation whose runtime is available. Returns the shifts started; `shift.start` is sent after the dispatch committed.
 */
export async function devopsPass(
  ctx: Ctx,
  skipAgent: (agentId: string) => boolean = () => false,
  /** The workstation already runs as many shifts as its owner allows (backlog #76): nothing more is offered to it. */
  workstationFull: (workstationId: string) => boolean = () => false,
): Promise<DevopsDispatch[]> {
  const onlineSince = new Date(ctx.clock.now().getTime() - ONLINE_WINDOW_MS);
  const queued = await rows(
    ctx.pool,
    `SELECT r.id, r.org_id, r.workstation_id, r.devops_agent_id, r.card_id, a.runtime, w.runtimes, ${WAITED_SQL} AS waited
       FROM devops_requests r
       JOIN agents a ON a.id = r.devops_agent_id AND a.status = 'active'
       JOIN workstations w ON w.id = r.workstation_id AND w.status = 'active' AND w.connected AND w.last_seen_at > $1
       JOIN users wu ON wu.id = w.user_id AND wu.status = 'active'
       JOIN organizations po ON po.id = r.org_id AND po.status IN ('trial','active')
      WHERE r.status = 'queued' AND ${wsServesOrgSql('w', 'r.org_id')}
        -- A request about a paused project (its card, or the project the user asked from) waits; one about neither is not held.
        AND NOT EXISTS (SELECT 1 FROM projects rp
                         WHERE ${projectPausedSql('rp')}
                           AND rp.id = COALESCE((SELECT rc.project_id FROM cards rc WHERE rc.id = r.card_id),
                                                (r.context->>'projectId')::uuid))
      ORDER BY waited DESC, r.created_at, r.id`,
    [onlineSince],
  );
  const started: DevopsDispatch[] = [];
  // Each engineer's open DevOps shifts, loaded once and extended with what this pass starts.
  const openOf = new Map<string, OpenDevopsShift[]>();
  for (const r of queued) {
    if (skipAgent(r.devops_agent_id) || workstationFull(r.workstation_id)) continue;
    let open = openOf.get(r.devops_agent_id);
    if (!open) {
      open = await openDevopsShifts(ctx.pool, r.devops_agent_id);
      openOf.set(r.devops_agent_id, open);
    }
    const req = { cardId: (r.card_id as string | null) ?? null, waited: r.waited === true };
    if (!devopsLane(open, req, ctx.clock.now())) continue;
    // DevOps always runs on the workstation's main account (docs/design/claude-accounts.md D2).
    if (!mainUsable(r.runtimes, r.runtime, ctx.clock.now())) continue;
    const conn = ctx.services.runners.get(r.workstation_id);
    if (!conn || !conn.reconciled) continue;
    const shiftId = randomUUID();
    const ok = await withAppendTx(ctx.pool, async (tx) => {
      const row = await one(tx, `SELECT status FROM devops_requests WHERE id=$1 FOR UPDATE`, [r.id]);
      if (row?.status !== 'queued') return false;
      // Re-checked inside the transaction: another pass may have started a shift since the queue was read.
      const w = await one(tx, `SELECT ${WAITED_SQL} AS waited FROM devops_requests r WHERE r.id=$1`, [r.id]);
      const lane = devopsLane(
        await openDevopsShifts(tx, r.devops_agent_id),
        { cardId: req.cardId, waited: w?.waited === true },
        ctx.clock.now(),
      );
      if (!lane) return false;
      await ctx.store.append(
        [
          {
            streamId: streamId.thread(r.id),
            event: {
              type: 'DevOpsShiftDispatched',
              payload: {
                requestId: r.id,
                shiftId,
                agentId: r.devops_agent_id,
                workstationId: r.workstation_id,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(r.org_id),
          },
        ],
        { tx },
      );
      return true;
    });
    if (!ok) {
      // The engineer's shifts changed under this pass: read them again for its next request.
      openOf.delete(r.devops_agent_id);
      continue;
    }
    open.push({ startedAt: ctx.clock.now(), cardId: req.cardId });
    started.push({ requestId: r.id, shiftId, workstationId: r.workstation_id, agentId: r.devops_agent_id });
    const built = await buildDevopsShiftStart(ctx, r.id, shiftId);
    if (built)
      ctx.services.runners.send(
        r.workstation_id,
        'shift.start',
        await withCommitAs(ctx, built),
        ctx.clock.now(),
      );
  }
  return started;
}

/** Where one DevOps request stands: worked on now, waiting for an approval, or its place in its engineer's queue. */
export type DevopsQueuePosition =
  | { state: 'running' }
  | { state: 'needs_approval' }
  | { state: 'queued'; position: number; of: number }
  | null;

/**
 * The request's place in its DevOps engineer's queue, in the dispatcher's order (waited-on first, then the oldest).
 * `asWaited`: count it as waited-on (a card is being parked on it in the same transaction). Null: it is finished.
 */
export async function devopsQueuePosition(
  db: Queryable,
  requestId: string,
  opts: { asWaited?: boolean } = {},
): Promise<DevopsQueuePosition> {
  const req = await one(db, 'SELECT status, devops_agent_id FROM devops_requests WHERE id=$1', [requestId]);
  if (!req) return null;
  if (req.status === 'running') return { state: 'running' };
  if (req.status === 'needs_approval') return { state: 'needs_approval' };
  if (req.status !== 'queued') return null;
  const pos = await one<{ position: number; of: number }>(
    db,
    `WITH q AS (
       SELECT r.id, r.created_at, ((r.id = $1 AND $3::boolean) OR ${WAITED_SQL}) AS waited
         FROM devops_requests r WHERE r.status = 'queued' AND r.devops_agent_id = $2)
     SELECT position, total AS of FROM (
       SELECT id, row_number() OVER (ORDER BY waited DESC, created_at, id)::int AS position, count(*) OVER ()::int AS total
         FROM q) ranked
      WHERE id = $1`,
    [requestId, req.devops_agent_id, opts.asWaited === true],
  );
  return pos ? { state: 'queued', position: Number(pos.position), of: Number(pos.of) } : null;
}

/** "number 2 of 3 in the DevOps queue", "running now: ...": for card facts and the park messages. Empty when finished. */
export function devopsQueueText(pos: DevopsQueuePosition): string {
  if (!pos) return '';
  if (pos.state === 'running') return 'running now: the DevOps engineer is working on it';
  if (pos.state === 'needs_approval') return 'waiting for an approval before the DevOps engineer goes on';
  return `number ${pos.position} of ${pos.of} in the DevOps queue`;
}

/** " The request is number 1 of 2 in the DevOps queue." for a park message; empty when the request is finished. */
export async function devopsQueueSentence(
  db: Queryable,
  requestId: string,
  opts: { asWaited?: boolean } = {},
): Promise<string> {
  const text = devopsQueueText(await devopsQueuePosition(db, requestId, opts));
  return text ? ` The DevOps request is ${text}.` : '';
}
