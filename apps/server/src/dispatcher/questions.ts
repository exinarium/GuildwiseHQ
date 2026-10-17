import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { withCommitAs } from '../commands/commit-as.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { endQuestionShift, escalateEvents, QUESTION_STALL_MS } from '../commands/escalation.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildQuestionShiftStart, QUESTION_MAX_SHIFT_MINUTES } from '../runner-gateway/question-brief.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

const ONLINE_WINDOW_MS = 45_000;
const MAX_ATTEMPTS = 2;
const OVERRUN_SLACK_MS = 10 * 60_000;

export interface QuestionDispatch {
  deskItemId: string;
  shiftId: string;
  agentId: string;
  workstationId: string;
}

/**
 * Question queue (docs/ARCHITECTURE.md section 15): open desk items routed to an agent. Each gets one `question`
 * shift on that agent's workstation (one at a time per agent, outside the card capacity like a chat). An item nobody
 * works on (agent gone, runtime down, shifts failing) goes on to the next step of the chain after
 * `QUESTION_STALL_MS`, or at once when the agent can no longer be asked at all.
 */
export async function questionPass(
  ctx: Ctx,
  skipAgent: (agentId: string) => boolean = () => false,
): Promise<QuestionDispatch[]> {
  const now = ctx.clock.now();
  await endStaleShifts(ctx, now);
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const queued = await rows(
    ctx.pool,
    `SELECT d.id, d.routed_agent_id, d.updated_at, d.created_at,
            a.status AS agent_status, a.runtime, ws.id AS ws_id, ws.runtimes, ws.connected, ws.last_seen_at, ws.status AS ws_status,
            (SELECT count(*)::int FROM shifts s WHERE s.desk_item_id = d.id AND s.agent_id = d.routed_agent_id
               AND s.status = 'ended' AND s.outcome IS DISTINCT FROM 'rejected' AND s.outcome IS DISTINCT FROM 'reported') AS failed
       FROM desk_items d JOIN agents a ON a.id = d.routed_agent_id LEFT JOIN workstations ws ON ws.id = a.workstation_id
       JOIN organizations po ON po.id = d.org_id AND po.status IN ('trial','active')
      WHERE d.status = 'open' AND d.routed_to = 'agent'
        AND (ws.id IS NULL OR ${wsServesOrgSql('ws', 'd.org_id')})
        AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.desk_item_id = d.id AND s.status <> 'ended')
      -- an asker that is waiting inside its shift (aom question --wait) goes first, then blocking questions
      ORDER BY EXISTS (SELECT 1 FROM shifts a WHERE a.id = d.shift_id AND a.status <> 'ended') DESC,
               d.blocking DESC, d.created_at, d.id`,
  );
  const started: QuestionDispatch[] = [];
  const busy = new Set<string>();
  for (const r of queued) {
    const rt = (r.runtimes as Array<{ id: string; available: boolean }> | null)?.find(
      (x) => x.id === r.runtime,
    );
    const reachable =
      r.agent_status === 'active' &&
      r.ws_status === 'active' &&
      r.connected &&
      r.last_seen_at &&
      new Date(r.last_seen_at) > onlineSince &&
      rt?.available;
    const stalled = now.getTime() - new Date(r.updated_at).getTime() > QUESTION_STALL_MS;
    if (r.agent_status !== 'active' || r.failed >= MAX_ATTEMPTS || (!reachable && stalled)) {
      await escalateStalled(
        ctx,
        r.id,
        r.agent_status !== 'active' ? 'the agent is no longer available' : 'no answer',
      );
      continue;
    }
    if (!reachable || busy.has(r.routed_agent_id) || skipAgent(r.routed_agent_id)) continue;
    const conn = ctx.services.runners.get(r.ws_id);
    if (!conn || !conn.reconciled) continue;
    const shiftId = randomUUID();
    const ok = await withAppendTx(ctx.pool, async (tx) => {
      const item = await one(
        tx,
        `SELECT * FROM desk_items WHERE id=$1 AND status='open' AND routed_agent_id=$2 FOR UPDATE`,
        [r.id, r.routed_agent_id],
      );
      if (!item) return false;
      const open = await one(
        tx,
        `SELECT 1 FROM shifts WHERE (desk_item_id=$1 OR (agent_id=$2 AND kind='question')) AND status <> 'ended' LIMIT 1`,
        [r.id, r.routed_agent_id],
      );
      if (open) return false;
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(r.id),
            event: {
              type: 'QuestionShiftDispatched',
              payload: { deskItemId: r.id, shiftId, agentId: r.routed_agent_id, workstationId: r.ws_id },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(item.org_id),
          },
        ],
        { tx },
      );
      return true;
    });
    busy.add(r.routed_agent_id);
    if (!ok) continue;
    started.push({ deskItemId: r.id, shiftId, agentId: r.routed_agent_id, workstationId: r.ws_id });
    const built = await buildQuestionShiftStart(ctx, r.id, shiftId);
    if (built)
      ctx.services.runners.send(r.ws_id, 'shift.start', await withCommitAs(ctx, built), ctx.clock.now());
  }
  return started;
}

/** The item goes on to the next step (the system passes it on). */
async function escalateStalled(ctx: Ctx, deskItemId: string, why: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const item = await one(
      tx,
      `SELECT * FROM desk_items WHERE id=$1 AND status='open' AND routed_to='agent' FOR UPDATE`,
      [deskItemId],
    );
    if (!item) return;
    const to = (await one(tx, 'SELECT name, role_key FROM agents WHERE id=$1', [item.routed_agent_id])) as
      | Row
      | undefined;
    const { events } = await escalateEvents(
      ctx,
      tx,
      item,
      null,
      `${to ? `${to.name} (${to.role_key})` : 'The agent'} could not take it: ${why}`,
    );
    await ctx.store.append(events, { tx });
  });
}

/** Question shifts the runner never reported on (a lost connection) end after their maximum duration plus slack. */
async function endStaleShifts(ctx: Ctx, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - QUESTION_MAX_SHIFT_MINUTES * 60_000 - OVERRUN_SLACK_MS);
  const stale = await rows(
    ctx.pool,
    `SELECT id FROM shifts WHERE kind='question' AND status <> 'ended' AND started_at < $1`,
    [cutoff],
  );
  for (const s of stale) {
    await withAppendTx(ctx.pool, async (tx) => {
      const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [s.id]);
      if (shift) await ctx.store.append(endQuestionShift(shift, 'lost'), { tx });
    });
  }
}
