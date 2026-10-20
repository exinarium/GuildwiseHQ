import { randomUUID } from 'node:crypto';
import type { Gate } from '@aom/shared';
import { type SetDeploySecretRequest, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { orgScope, projectScope, userActor } from '../commands/common.ts';
import { deliver } from '../commands/workstation-setup.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

async function ownerOrAdmin(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<'owner' | 'admin'> {
  const role = await orgRoleOf(ctx.pool, user.id, orgId);
  if (role !== 'owner' && role !== 'admin') throw forbidden('only an Owner or an Admin changes gates');
  return role;
}

/** Gate presets are the Owner's rule book: an Owner or an Admin edits them (the freeze switch is part of one). */
export async function setGatePreset(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  name: string,
  gate: Gate,
) {
  await ownerOrAdmin(ctx, user, orgId);
  await ctx.store.append([
    {
      streamId: streamId.org(orgId),
      event: { type: 'GatePresetSet', payload: { orgId, name, gate, by: user.id } },
      actor: userActor(user.id),
      scope: orgScope(orgId),
    },
  ]);
}

export async function removeGatePreset(ctx: Ctx, user: AuthSession['user'], orgId: string, name: string) {
  await ownerOrAdmin(ctx, user, orgId);
  const used = await one(ctx.pool, 'SELECT 1 FROM gate_bindings WHERE org_id=$1 AND preset=$2', [
    orgId,
    name,
  ]);
  if (used) throw conflict('preset_in_use', 'a rule is bound to this preset: remove the binding first');
  await ctx.store.append([
    {
      streamId: streamId.org(orgId),
      event: { type: 'GatePresetRemoved', payload: { orgId, name, by: user.id } },
      actor: userActor(user.id),
      scope: orgScope(orgId),
    },
  ]);
}

export async function setGateBinding(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  b: {
    projectId?: string | undefined;
    repoId?: string | undefined;
    envMatch: 'production' | '*';
    preset: string | null;
  },
) {
  await ownerOrAdmin(ctx, user, orgId);
  if (
    b.preset &&
    !(await one(ctx.pool, 'SELECT 1 FROM gate_presets WHERE org_id=$1 AND name=$2', [orgId, b.preset]))
  )
    throw unprocessable('unknown_preset', `there is no gate preset named ${b.preset}`);
  if (b.projectId) await loadVisibleProject(ctx.pool, user.id, b.projectId);
  if (
    b.repoId &&
    !(await one(
      ctx.pool,
      'SELECT 1 FROM project_repos pr JOIN projects p ON p.id = pr.project_id WHERE pr.id=$1 AND p.org_id=$2',
      [b.repoId, orgId],
    ))
  )
    throw notFound('repository not found');
  await ctx.store.append([
    {
      streamId: streamId.org(orgId),
      event: {
        type: 'GateBindingSet',
        payload: {
          bindingId: randomUUID(),
          orgId,
          projectId: b.projectId ?? null,
          repoId: b.repoId ?? null,
          envMatch: b.envMatch,
          preset: b.preset,
          by: user.id,
        },
      },
      actor: userActor(user.id),
      scope: orgScope(orgId),
    },
  ]);
}

/**
 * One secret of a recipe, sealed in the browser for the runner of one of the viewer's workstations. The server relays the
 * ciphertext in the durable queue and forgets it as soon as the runner answered; only the NAME is ever recorded.
 */
export async function setDeploySecret(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: SetDeploySecretRequest,
): Promise<void> {
  const project = await loadVisibleProject(ctx.pool, user.id, body.projectId);
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
      workstationId,
      user.id,
    ]);
    if (!ws) throw notFound('workstation not found');
    const rec = await one(tx, 'SELECT parsed, approved_parsed FROM delivery_recipes WHERE project_id=$1', [
      project.id,
    ]);
    const named = new Set(
      [rec?.approved_parsed, rec?.parsed].flatMap(
        (r) =>
          (r as { environments?: Array<{ secrets: string[] }> } | null)?.environments?.flatMap(
            (e) => e.secrets,
          ) ?? [],
      ),
    );
    if (!named.has(body.name))
      throw unprocessable(
        'unknown_secret_name',
        `"${body.name}" is not a secret named by this project's recipe`,
      );
    const k = await one(tx, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [workstationId]);
    if (!k || k.key_id !== body.keyId)
      throw conflict(
        'sudo_key_changed',
        "the runner's key changed: reload the page and enter the value again",
      );
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb
        WHERE workstation_id=$1 AND type='deploy.secret.set' AND status IN ('pending','sent')
          AND payload->>'projectId' = $2 AND payload->>'name' = $3`,
      [workstationId, body.projectId, body.name],
    );
    await enqueueRunnerCommand(
      tx,
      workstationId,
      'deploy.secret.set',
      { projectId: body.projectId, name: body.name, keyId: body.keyId, ciphertext: body.ciphertext },
      new Date(ctx.clock.now().getTime() + 24 * 3600_000),
    );
  });
  deliver(ctx, [workstationId]);
}

/** `command.result` of `deploy.secret.set`: forget the ciphertext and record that the workstation holds the name. */
export async function applyDeploySecretResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [commandId]);
  const stored = ok && (result as { stored?: boolean } | null)?.stored === true;
  if (!stored) return;
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  const project = await one(ctx.pool, 'SELECT org_id FROM projects WHERE id=$1', [String(payload.projectId)]);
  await exec(
    ctx.pool,
    `INSERT INTO deploy_secret_status (workstation_id, project_id, name, set_at, set_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workstation_id, project_id, name) DO UPDATE SET set_at=EXCLUDED.set_at, set_by=EXCLUDED.set_by`,
    [workstationId, String(payload.projectId), String(payload.name), ctx.clock.now(), ws?.user_id ?? null],
  );
  if (project && ws)
    await ctx.store.append([
      {
        streamId: streamId.project(String(payload.projectId)),
        event: {
          type: 'DeploySecretSet',
          payload: {
            projectId: String(payload.projectId),
            orgId: project.org_id,
            workstationId,
            name: String(payload.name),
            by: ws.user_id,
          },
        },
        actor: userActor(ws.user_id),
        scope: projectScope(project.org_id, String(payload.projectId)),
      },
    ]);
}
