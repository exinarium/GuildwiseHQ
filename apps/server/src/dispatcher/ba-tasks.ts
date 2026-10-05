import { randomUUID } from 'node:crypto';
import { BA_TASK_MAX_ATTEMPTS, BA_TASK_MAX_SHIFT_MINUTES, BA_TASK_STALL_MS, streamId } from '@aom/shared';
import { endBaTaskShift, runBaTaskFallback } from '../commands/ba-tasks.ts';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildBaTaskShiftStart } from '../runner-gateway/ba-task-brief.ts';

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
): Promise<BaTaskDispatch[]> {
  const now = ctx.clock.now();
  await endStaleShifts(ctx, now);
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const queued = await rows(
    ctx.pool,
    `SELECT t.* FROM ba_tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
      WHERE t.status = 'queued' ORDER BY t.created_at, t.id`,
  );
  const started: BaTaskDispatch[] = [];
  const busy = new Set<string>();
  for (const t of queued) {
    const bas = await rows(
      ctx.pool,
      `SELECT a.*, ws.id AS ws_id, ws.runtimes, ws.connected, ws.last_seen_at
         FROM agents a JOIN workstations ws ON ws.id = a.workstation_id AND ws.status = 'active'
                       JOIN users wu ON wu.id = ws.user_id AND wu.status = 'active'
        WHERE a.org_id = $1 AND a.role_key = 'ba' AND a.status = 'active' AND NOT a.is_devops
          AND (a.project_id IS NULL OR a.project_id = $2 OR $4::boolean)
        ORDER BY (a.id = $3::uuid) DESC, a.last_shift_ended_at NULLS FIRST, a.hired_at, a.id`,
      [t.org_id, t.project_id, t.preferred_agent_id, t.kind === 'floor_report'],
    );
    const stalled = now.getTime() - new Date(t.updated_at).getTime() > BA_TASK_STALL_MS;
    if (bas.length === 0 || t.attempts >= BA_TASK_MAX_ATTEMPTS || stalled) {
      await withAppendTx(ctx.pool, async (tx) => {
        const cur = await one(tx, `SELECT * FROM ba_tasks WHERE id=$1 AND status='queued' FOR UPDATE`, [
          t.id,
        ]);
        if (cur) await runBaTaskFallback(ctx, tx, cur);
      });
      continue;
    }
    for (const a of bas) {
      const rt = (a.runtimes as Array<{ id: string; available: boolean }> | null)?.find(
        (x) => x.id === a.runtime,
      );
      const reachable =
        a.connected && a.last_seen_at && new Date(a.last_seen_at) > onlineSince && rt?.available === true;
      if (!reachable || busy.has(a.id) || skipAgent(a.id)) continue;
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
                payload: { taskId: t.id, shiftId, agentId: a.id, workstationId: a.ws_id },
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
      const payload = await buildBaTaskShiftStart(ctx, t.id, shiftId);
      if (payload) ctx.services.runners.send(a.ws_id, 'shift.start', payload, ctx.clock.now());
      break;
    }
  }
  return started;
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
