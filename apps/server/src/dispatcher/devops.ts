import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { withCommitAs } from '../commands/commit-as.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildDevopsShiftStart } from '../runner-gateway/brief.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

const ONLINE_WINDOW_MS = 45_000;

export interface DevopsDispatch {
  requestId: string;
  shiftId: string;
  workstationId: string;
  agentId: string;
}

/**
 * DevOps request queue (docs/ARCHITECTURE.md section 16.2): FIFO per workstation, one DevOps shift at a time per
 * DevOps engineer (capacity 1), only on a connected, reconciled workstation whose runtime is available. Returns the
 * shifts started; `shift.start` is sent after the dispatch committed.
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
    `SELECT r.id, r.org_id, r.workstation_id, r.devops_agent_id, a.runtime, w.runtimes
       FROM devops_requests r
       JOIN agents a ON a.id = r.devops_agent_id AND a.status = 'active'
       JOIN workstations w ON w.id = r.workstation_id AND w.status = 'active' AND w.connected AND w.last_seen_at > $1
       JOIN users wu ON wu.id = w.user_id AND wu.status = 'active'
       JOIN organizations po ON po.id = r.org_id AND po.status IN ('trial','active')
      WHERE r.status = 'queued' AND ${wsServesOrgSql('w', 'r.org_id')}
      ORDER BY r.created_at, r.id`,
    [onlineSince],
  );
  const started: DevopsDispatch[] = [];
  const busy = new Set<string>();
  for (const r of queued) {
    if (busy.has(r.devops_agent_id) || skipAgent(r.devops_agent_id) || workstationFull(r.workstation_id))
      continue;
    const rt = (r.runtimes as Array<{ id: string; available: boolean }>).find((x) => x.id === r.runtime);
    if (!rt?.available) continue;
    const conn = ctx.services.runners.get(r.workstation_id);
    if (!conn || !conn.reconciled) continue;
    const shiftId = randomUUID();
    const ok = await withAppendTx(ctx.pool, async (tx) => {
      const req = await one(tx, `SELECT status FROM devops_requests WHERE id=$1 FOR UPDATE`, [r.id]);
      if (req?.status !== 'queued') return false;
      const open = await one(
        tx,
        `SELECT 1 FROM shifts WHERE agent_id=$1 AND kind='devops' AND status <> 'ended' LIMIT 1`,
        [r.devops_agent_id],
      );
      if (open) return false;
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
      busy.add(r.devops_agent_id);
      continue;
    }
    busy.add(r.devops_agent_id);
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
