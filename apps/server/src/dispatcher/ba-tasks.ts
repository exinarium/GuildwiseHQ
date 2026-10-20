import { randomUUID } from 'node:crypto';
import {
  BA_TASK_MAX_ATTEMPTS,
  BA_TASK_MAX_SHIFT_MINUTES,
  BA_TASK_STALL_MS,
  BATCH_MAX_IN_FLIGHT,
  MAIN_ACCOUNT,
  streamId,
} from '@aom/shared';
import { endBaTaskShift, runBaTaskFallback } from '../commands/ba-tasks.ts';
import { withCommitAs } from '../commands/commit-as.ts';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildBaTaskShiftStart } from '../runner-gateway/ba-task-brief.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { accountFor, loadProjectAccounts } from './accounts.ts';
import { projectHeldSql } from './project-hold.ts';

const ONLINE_WINDOW_MS = 45_000;
const OVERRUN_SLACK_MS = 10 * 60_000;

export interface BaTaskDispatch {
  taskId: string;
  shiftId: string;
  agentId: string;
  workstationId: string;
}

/**
 * BA background queue (docs/design/phases.md A5.5), the structure of `questionPass`: queued `ba_tasks` oldest first, one
 * `ba_task` shift at a time per BA agent, outside card capacity (a BA in a Finalize shift can still take one). The
 * intake's BA is preferred, else the least recently busy BA of the organization that is online. A task nobody takes
 * (no BA hired, none online for 15 minutes, two failed attempts) is done by the server from a template: no agent ever
 * blocks, and the manager is never left uninformed.
 */
export async function baTaskPass(
  ctx: Ctx,
  skipAgent: (agentId: string) => boolean = () => false,
  /** The workstation already runs as many shifts as its owner allows (backlog #76): nothing more is offered to it. */
  workstationFull: (workstationId: string) => boolean = () => false,
): Promise<BaTaskDispatch[]> {
  const now = ctx.clock.now();
  await endStaleShifts(ctx, now);
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const queued = await rows(
    ctx.pool,
    `SELECT t.* FROM ba_tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
       JOIN organizations po ON po.id = p.org_id AND po.status IN ('trial','active')
      WHERE t.status = 'queued' AND NOT ${projectHeldSql('p', '$1')}
      ORDER BY (t.kind = 'batch_intake'), t.created_at, t.id`,
    [now],
  );
  const started: BaTaskDispatch[] = [];
  const busy = new Set<string>();
  for (const t of queued) {
    // Batch intake: at most BATCH_MAX_IN_FLIGHT items of one batch are with a BA at once. Batch work also queues behind
    // all other BA tasks (see the ORDER BY), so normal BA work still flows.
    if (t.batch_id) {
      const running = await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM ba_tasks WHERE batch_id=$1 AND status='running'`,
        [t.batch_id],
      );
      if ((running?.n ?? 0) >= BATCH_MAX_IN_FLIGHT) continue;
    }
    // A `spec_card` task for a card that was cancelled (or deleted) while it waited is dropped, never dispatched.
    if (t.kind === 'spec_card') {
      const card = t.card_id
        ? await one(ctx.pool, 'SELECT status FROM cards WHERE id=$1', [t.card_id])
        : undefined;
      if (!card || card.status === 'cancelled') {
        await withAppendTx(ctx.pool, async (tx) => {
          const cur = await one(tx, `SELECT 1 FROM ba_tasks WHERE id=$1 AND status='queued' FOR UPDATE`, [
            t.id,
          ]);
          if (!cur) return;
          await ctx.store.append(
            [
              {
                streamId: streamId.baTask(t.id),
                event: {
                  type: 'BaTaskCompleted',
                  payload: {
                    taskId: t.id,
                    status: 'cancelled',
                    note: 'the card was cancelled before the task started',
                  },
                },
                actor: SYSTEM_ACTOR,
                scope: t.project_id
                  ? projectScope(t.org_id, t.project_id)
                  : { orgId: t.org_id, projectId: null, audience: 'org' },
              },
            ],
            { tx },
          );
        });
        continue;
      }
    }
    const bas = await rows(
      ctx.pool,
      `SELECT a.*, ws.id AS ws_id, ws.runtimes, ws.connected, ws.last_seen_at
         FROM agents a JOIN workstations ws ON ws.id = a.workstation_id AND ws.status = 'active'
                       JOIN users wu ON wu.id = ws.user_id AND wu.status = 'active'
        WHERE a.org_id = $1 AND a.role_key = 'ba' AND a.status = 'active' AND a.paused_at IS NULL AND NOT a.is_devops
          AND ${wsServesOrgSql('ws', 'a.org_id')}
          AND ($4::boolean OR ((a.allowed_project_ids IS NULL OR $2::uuid = ANY (a.allowed_project_ids))
               AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $2::uuid AND pm.user_id = ws.user_id
                            AND pm.status = 'active')))
        ORDER BY (a.id = $3::uuid) DESC, a.last_shift_ended_at NULLS FIRST, a.hired_at, a.id`,
      [t.org_id, t.project_id, t.preferred_agent_id, t.org_level === true],
    );
    const stalled =
      t.kind !== 'batch_intake' && now.getTime() - new Date(t.updated_at).getTime() > BA_TASK_STALL_MS;
    if (bas.length === 0 || t.attempts >= BA_TASK_MAX_ATTEMPTS || stalled) {
      await withAppendTx(ctx.pool, async (tx) => {
        const cur = await one(tx, `SELECT * FROM ba_tasks WHERE id=$1 AND status='queued' FOR UPDATE`, [
          t.id,
        ]);
        if (cur) await runBaTaskFallback(ctx, tx, cur);
      });
      continue;
    }
    // Claude account: a task about one ticket runs on its project's account; a task without a card uses main.
    let setting = null;
    if (t.card_id) {
      const pid = await cardProject(ctx, t.card_id, t.project_id);
      setting = (await loadProjectAccounts(ctx.pool, [pid])).get(pid) ?? null;
    }
    for (const a of bas) {
      const account = accountFor(setting, a.runtimes, a.runtime, now);
      const reachable =
        a.connected && a.last_seen_at && new Date(a.last_seen_at) > onlineSince && account !== null;
      if (!reachable || busy.has(a.id) || skipAgent(a.id) || workstationFull(a.ws_id)) continue;
      const conn = ctx.services.runners.get(a.ws_id);
      if (!conn || !conn.reconciled) continue;
      const shiftId = randomUUID();
      const ok = await withAppendTx(ctx.pool, async (tx) => {
        const task = await one(tx, `SELECT * FROM ba_tasks WHERE id=$1 AND status='queued' FOR UPDATE`, [
          t.id,
        ]);
        if (!task) return false;
        const open = await one(
          tx,
          `SELECT 1 FROM shifts WHERE agent_id=$1 AND kind='ba_task' AND status <> 'ended' LIMIT 1`,
          [a.id],
        );
        if (open) return false;
        await ctx.store.append(
          [
            {
              streamId: streamId.baTask(t.id),
              event: {
                type: 'BaTaskDispatched',
                payload: {
                  taskId: t.id,
                  shiftId,
                  agentId: a.id,
                  workstationId: a.ws_id,
                  ...(account && account.key !== MAIN_ACCOUNT ? { accountKey: account.key } : {}),
                },
              },
              actor: SYSTEM_ACTOR,
              scope: t.project_id
                ? projectScope(t.org_id, t.project_id)
                : { orgId: t.org_id, projectId: null, audience: 'org' },
            },
          ],
          { tx },
        );
        return true;
      });
      busy.add(a.id);
      if (!ok) continue;
      started.push({ taskId: t.id, shiftId, agentId: a.id, workstationId: a.ws_id });
      const built = await buildBaTaskShiftStart(ctx, t.id, shiftId);
      if (built)
        ctx.services.runners.send(a.ws_id, 'shift.start', await withCommitAs(ctx, built), ctx.clock.now());
      break;
    }
  }
  return started;
}

/** The project of the ticket a BA task is about (the task's own project when the card is gone). */
async function cardProject(ctx: Ctx, cardId: string, fallback: string): Promise<string> {
  const c = await one(ctx.pool, 'SELECT project_id FROM cards WHERE id=$1', [cardId]);
  return c?.project_id ?? fallback;
}

/** BA task shifts the runner never reported on (a lost connection) end after their maximum duration plus slack. */
async function endStaleShifts(ctx: Ctx, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - BA_TASK_MAX_SHIFT_MINUTES * 60_000 - OVERRUN_SLACK_MS);
  const stale = await rows(
    ctx.pool,
    `SELECT id FROM shifts WHERE kind='ba_task' AND status <> 'ended' AND started_at < $1`,
    [cutoff],
  );
  for (const s of stale) {
    await withAppendTx(ctx.pool, async (tx) => {
      const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [s.id]);
      if (shift) await ctx.store.append(await endBaTaskShift(tx, shift, 'lost'), { tx });
    });
  }
}
