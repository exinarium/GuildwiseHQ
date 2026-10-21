import { DEPLOY_CONNECT_CAPABILITY, type DeployProbePayload } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/**
 * Reachability checks (docs/design/deploy-run-ux-design.md v2): "can the computer that deploys this server still sign in to
 * it?". The answer (a connection state) is what the target card's chip shows. A check is a single non-interactive ssh connect
 * (scope `ssh_check`): daily for every server target, and at once after a deploy to it failed. Only runners that announce
 * `deploy-connect:1` are asked.
 */

export const REACHABILITY_EVERY_MS = 24 * 3600_000;
const MAX_PER_TICK = 5;

/** Asks the target's computer to check, unless a check is already on its way. Returns whether one was queued. */
export async function queueReachabilityCheck(ctx: Ctx, targetId: string): Promise<boolean> {
  const t = await one(
    ctx.pool,
    `SELECT t.id, t.project_id, t.host, t.workstation_id, w.connected, c.capabilities
       FROM deploy_targets t JOIN workstations w ON w.id = t.workstation_id AND w.status='active'
       LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id
      WHERE t.id=$1 AND t.kind='remote_ssh' AND t.removed_at IS NULL AND t.host IS NOT NULL`,
    [targetId],
  );
  if (!t || !t.connected || !(t.capabilities ?? []).includes(DEPLOY_CONNECT_CAPABILITY)) return false;
  const pending = await one(
    ctx.pool,
    `SELECT 1 AS x FROM runner_commands WHERE workstation_id=$1 AND type='deploy.probe' AND status IN ('pending','sent')
        AND payload->>'scope'='ssh_check' AND payload->>'targetId'=$2`,
    [t.workstation_id, t.id],
  );
  if (pending) return false;
  const payload: DeployProbePayload = {
    projectId: t.project_id,
    targetId: t.id,
    scope: 'ssh_check',
    host: t.host,
  };
  await enqueueRunnerCommand(ctx.pool, t.workstation_id, 'deploy.probe', payload as never);
  void Promise.resolve(ctx.services.gateway.deliverPending(t.workstation_id)).catch(() => undefined);
  return true;
}

/** The scheduler's pass: server targets whose answer is older than a day (or missing), a few at a time. */
export async function reachabilityTick(ctx: Ctx): Promise<number> {
  await purgeExpiredConnects(ctx);
  const due = await rows(
    ctx.pool,
    `SELECT t.id FROM deploy_targets t
       JOIN workstations w ON w.id = t.workstation_id AND w.status='active' AND w.connected
       JOIN workstation_capabilities c ON c.workstation_id = w.id AND $2 = ANY(c.capabilities)
       LEFT JOIN deploy_target_connections k ON k.target_id = t.id AND k.workstation_id = t.workstation_id
      WHERE t.kind='remote_ssh' AND t.removed_at IS NULL AND t.host IS NOT NULL
        AND (k.at IS NULL OR k.at < $1)
      ORDER BY k.at NULLS FIRST LIMIT $3`,
    [new Date(ctx.clock.now().getTime() - REACHABILITY_EVERY_MS), DEPLOY_CONNECT_CAPABILITY, MAX_PER_TICK],
  );
  let n = 0;
  for (const d of due) if (await queueReachabilityCheck(ctx, d.id).catch(() => false)) n++;
  return n;
}

/**
 * A sealed sign-in (`deploy.connect`) that nobody picked up before it expired is useless and should not sit in the queue: its
 * payload is emptied and the command ends as expired.
 */
export async function purgeExpiredConnects(ctx: Ctx): Promise<number> {
  const r = await ctx.pool.query(
    `UPDATE runner_commands SET payload='{}'::jsonb, status='failed', last_error='expired'
      WHERE type='deploy.connect' AND payload <> '{}'::jsonb AND expires_at IS NOT NULL AND expires_at < $1
        AND status IN ('pending','sent')`,
    [ctx.clock.now()],
  );
  return r.rowCount ?? 0;
}
