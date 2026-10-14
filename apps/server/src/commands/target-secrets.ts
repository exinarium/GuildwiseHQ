import { EnvSecretResultSchema, type SetTargetSecretRequest, type TargetSecretsResponse } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Test accounts for a deploy target (backlog #59, phase 4, design D11). The browser encrypts each value with the
 * workstation runner's public key (the one the sudo password uses); the server relays the ciphertext in the durable command
 * queue and empties the payload as soon as the runner answered. Only the fact that a name has a value on a workstation is
 * kept (`target_secret_status`). A workstation owner sets values for their own workstation only.
 */
export async function setTargetSecret(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: SetTargetSecretRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
      workstationId,
      user.id,
    ]);
    if (!ws) throw notFound('workstation not found');
    const target = await one(tx, 'SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL', [
      body.targetId,
    ]);
    if (!target) throw notFound('deploy target not found');
    await loadVisibleProject(tx, user.id, target.project_id);
    if (!((target.secret_names ?? []) as string[]).includes(body.name))
      throw unprocessable(
        'unknown_secret_name',
        `"${body.name}" is not one of the test accounts declared for ${target.name}: add the name to the target first`,
      );
    const k = await one(tx, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [workstationId]);
    if (!k || k.key_id !== body.keyId)
      throw conflict(
        'sudo_key_changed',
        "the runner's key changed: reload the page and enter the value again",
      );
    // One value per name is pending at a time.
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb
        WHERE workstation_id=$1 AND type='env.secret.set' AND status IN ('pending','sent')
          AND payload->>'targetId' = $2 AND payload->>'name' = $3`,
      [workstationId, body.targetId, body.name],
    );
    // A value nobody collected within a day is forgotten (the sweep empties and fails it).
    await enqueueRunnerCommand(
      tx,
      workstationId,
      'env.secret.set',
      { targetId: body.targetId, name: body.name, keyId: body.keyId, ciphertext: body.ciphertext },
      new Date(ctx.clock.now().getTime() + 24 * 3600_000),
    );
  });
  deliver(ctx, [workstationId]);
}

/** `command.result` of `env.secret.set`: forget the ciphertext and record that the workstation holds the name. */
export async function applyTargetSecretResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [commandId]);
  const parsed = ok ? (EnvSecretResultSchema.safeParse(result).data ?? null) : null;
  if (!parsed?.stored) return;
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  await exec(
    ctx.pool,
    `INSERT INTO target_secret_status (workstation_id, target_id, name, set_at, set_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workstation_id, target_id, name) DO UPDATE SET set_at = EXCLUDED.set_at, set_by = EXCLUDED.set_by`,
    [workstationId, String(payload.targetId), String(payload.name), ctx.clock.now(), ws?.user_id ?? null],
  );
}

/** Which of the viewer's workstations hold which test accounts of the project's targets (names and time). */
export async function targetSecretStatuses(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<TargetSecretsResponse> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  const list = await rows(
    ctx.pool,
    `SELECT s.*, w.name AS workstation_name FROM target_secret_status s
       JOIN workstations w ON w.id = s.workstation_id AND w.user_id = $2 AND w.status = 'active'
       JOIN deploy_targets t ON t.id = s.target_id AND t.project_id = $1 AND t.removed_at IS NULL
      ORDER BY w.name, t.name, s.name`,
    [projectId, user.id],
  );
  return {
    secrets: list.map((r) => ({
      workstationId: r.workstation_id,
      workstationName: r.workstation_name,
      targetId: r.target_id,
      name: r.name,
      setAt: iso(r.set_at) as string,
    })),
  };
}
