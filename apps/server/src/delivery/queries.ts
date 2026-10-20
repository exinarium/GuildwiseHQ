import {
  type DeliverySecretStatus,
  type DeliverySettingsResponse,
  type DeployRunDto,
  type GateBindingDto,
  type GatePresetDto,
  GateSchema,
  type Recipe,
  type ReleaseQueueItem,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { evaluateEnvGate } from './gate.ts';
import { loadRecipeRow, projectVault, toRecipeDto } from './recipes.ts';

export function toRunDto(r: Row): DeployRunDto {
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project_key ?? '',
    env: r.env,
    targetName: r.target_name,
    targetId: r.target_id ?? null,
    commit: r.commit ?? null,
    deployedCommit: r.deployed_commit ?? null,
    status: r.status,
    waitingFor: r.waiting_for ?? null,
    releasedByPolicy: r.released_by_policy,
    trigger: r.trigger,
    trial: !!r.trial,
    dryRun: !!r.dry_run,
    requestedBy: r.requested_by,
    releasedBy: r.released_by ?? null,
    recipeHash: r.hash,
    evidence: r.evidence ?? [],
    missing: r.missing ?? [],
    refusal: r.refusal ?? null,
    refusalDetail: r.refusal_detail ?? null,
    health: r.health ?? null,
    smoke: r.smoke ?? null,
    summary: r.summary ?? null,
    logTail: r.log_tail ?? null,
    url: r.url ?? null,
    createdAt: iso(r.created_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

export async function deploySecretStatuses(
  db: Queryable,
  userId: string,
  projectId: string,
): Promise<DeliverySecretStatus[]> {
  return (
    await rows(
      db,
      `SELECT s.*, w.name AS workstation_name FROM deploy_secret_status s
         JOIN workstations w ON w.id = s.workstation_id AND w.user_id=$2 AND w.status='active'
        WHERE s.project_id=$1 ORDER BY w.name, s.name`,
      [projectId, userId],
    )
  ).map((r) => ({
    workstationId: r.workstation_id,
    workstationName: r.workstation_name,
    name: r.name,
    setAt: iso(r.set_at) as string,
  }));
}

/** The Delivery section of the project settings. */
export async function deliverySettings(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<DeliverySettingsResponse> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  const role = await orgRoleOf(ctx.pool, user.id, project.org_id);
  const vault = await projectVault(ctx.pool, projectId);
  const row = await loadRecipeRow(ctx.pool, projectId);
  const dto = toRecipeDto(row);
  const shown = (dto?.approvedRecipe ?? dto?.recipe ?? null) as Recipe | null;
  const targets = await rows(
    ctx.pool,
    `SELECT name, production FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL`,
    [projectId],
  );
  return {
    mode: project.delivery_mode ?? 'instructions',
    vault: vault ? { storage: vault.storage, name: vault.name, folder: vault.folder } : null,
    recipe: dto,
    canApprove: role === 'owner',
    canChangeMode: role === 'owner' || role === 'admin',
    environments: (shown?.environments ?? []).map((e) => ({
      name: e.name,
      targets: e.targets.map((t) => {
        const known = targets.find((x) => x.name.toLowerCase() === t.toLowerCase());
        return { name: t, production: !!known?.production, exists: !!known };
      }),
      releasedBy: e.releasedBy,
      triggers: e.triggers,
      gate: typeof e.gate === 'string' ? e.gate : 'inline',
      secrets: e.secrets,
    })),
    secrets: await deploySecretStatuses(ctx.pool, user.id, projectId),
  };
}

/**
 * The release queue of an organization: runs that wait for a releaser, grouped by (project, environment, commit), one row per
 * server. The gate is evaluated again for each group so the list says when a release is no longer allowed.
 */
export async function releaseQueue(ctx: Ctx, orgId: string): Promise<ReleaseQueueItem[]> {
  const waiting = await rows(
    ctx.pool,
    `SELECT r.*, p.key AS project_key, w.name AS workstation_name, t.production AS target_production, t.host AS target_host
       FROM deploy_runs r JOIN projects p ON p.id = r.project_id
       LEFT JOIN workstations w ON w.id = r.workstation_id
       LEFT JOIN deploy_targets t ON t.id = r.target_id
      WHERE r.org_id=$1 AND r.status='waiting_release' ORDER BY r.created_at, r.id`,
    [orgId],
  );
  const groups = new Map<string, ReleaseQueueItem>();
  for (const r of waiting) {
    const key = `${r.project_id}|${r.env}|${r.commit ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      const rec = await one(ctx.pool, 'SELECT approved_parsed FROM delivery_recipes WHERE project_id=$1', [
        r.project_id,
      ]);
      const env = (rec?.approved_parsed as Recipe | null)?.environments.find((e) => e.name === r.env);
      const verdict = env
        ? await evaluateEnvGate(ctx.pool, {
            orgId,
            projectId: r.project_id,
            env,
            production: !!r.target_production,
            commit: r.commit ?? null,
            now: ctx.clock.now(),
          })
        : { satisfied: false, missing: ['the recipe no longer has this environment'] };
      g = {
        projectId: r.project_id,
        projectKey: r.project_key,
        env: r.env,
        commit: r.commit ?? null,
        waitingFor: r.waiting_for ?? 'owner',
        requestedAt: iso(r.created_at) as string,
        gateNow: { satisfied: verdict.satisfied, missing: verdict.missing },
        targets: [],
      };
      groups.set(key, g);
    }
    g.targets.push({
      runId: r.id,
      targetId: r.target_id ?? null,
      targetName: r.target_name,
      production: !!r.target_production,
      host: r.target_host ?? null,
      workstationName: r.workstation_name ?? null,
    });
  }
  return [...groups.values()];
}

export async function listPresets(db: Queryable, orgId: string): Promise<GatePresetDto[]> {
  return (
    await rows(db, 'SELECT name, gate, updated_at FROM gate_presets WHERE org_id=$1 ORDER BY name', [orgId])
  )
    .map((r) => {
      const g = GateSchema.safeParse(r.gate);
      return g.success ? { name: r.name, gate: g.data, updatedAt: iso(r.updated_at) } : null;
    })
    .filter((x): x is GatePresetDto => !!x);
}

export async function listBindings(db: Queryable, orgId: string): Promise<GateBindingDto[]> {
  return (
    await rows(
      db,
      'SELECT id, project_id, repo_id, env_match, preset FROM gate_bindings WHERE org_id=$1 ORDER BY updated_at',
      [orgId],
    )
  ).map((r) => ({
    id: r.id,
    projectId: r.project_id ?? null,
    repoId: r.repo_id ?? null,
    envMatch: r.env_match,
    preset: r.preset,
  }));
}
