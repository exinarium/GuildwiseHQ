import {
  DeployRunParamsSchema,
  DeployStatusParamsSchema,
  DeployTrialParamsSchema,
  RecipeSaveParamsSchema,
} from '@aom/shared';
import { runAction } from '../ceo/engine.ts';
import { ceoCallContext } from '../ceo/gateway.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { loadRecipeRow, NO_PROJECT_VAULT, observeRecipe, projectVault } from './recipes.ts';
import { requestDeployRun } from './runs.ts';

type Reply = [boolean, unknown?, string?];

/** The project a call is about: its key, else the only project of the organization. */
async function projectOf(ctx: Ctx, orgId: string, key: string | undefined): Promise<Row | string> {
  if (key) {
    const p = await one(
      ctx.pool,
      `SELECT * FROM projects WHERE org_id=$1 AND key=upper($2) AND kind='project'`,
      [orgId, key],
    );
    return p ?? `project ${key.toUpperCase()} not found`;
  }
  const all = await rows(
    ctx.pool,
    `SELECT * FROM projects WHERE org_id=$1 AND kind='project' AND status='active' LIMIT 2`,
    [orgId],
  );
  return all.length === 1 ? (all[0] as Row) : 'name the project with --project KEY';
}

const bad = (e: { error: { issues: Array<{ path: PropertyKey[]; message: string }> } }): Reply => [
  false,
  undefined,
  `invalid request: ${e.error.issues.map((i) => `${i.path.join('.') || 'request'} ${i.message}`).join('; ')}`,
];

/**
 * `aom deploy run|trial|status` and `aom recipe save` (docs/design/ceo-front-door.md 9.5, 9.6 and 10). The model's only
 * deploy action is to ASK: the CEO goes through its verb (policy, audit, who releases); DevOps may request an automatic
 * environment and, in a recipe conversation the Owner started, trial a recipe and save it into the vault.
 */
export async function deployRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<Reply> {
  const agent = await one(ctx.pool, 'SELECT id, name, org_id, role_key, is_devops FROM agents WHERE id=$1', [
    shift.agent_id,
  ]);
  if (!agent) return [false, undefined, 'unknown agent'];
  const orgId = agent.org_id as string;
  const isCeo = agent.role_key === 'ceo' && (shift.kind === 'ceo' || shift.kind === 'chat');
  const isDevops = shift.kind === 'devops' && !!agent.is_devops;
  if (!isCeo && !isDevops) return [false, undefined, `${method} is for the CEO and the DevOps engineer`];

  if (method === 'deploy.status') {
    const p = DeployStatusParamsSchema.safeParse(params);
    if (!p.success) return bad(p);
    const project = await projectOf(ctx, orgId, p.data.project);
    if (typeof project === 'string') return [false, undefined, project];
    const recipe = await loadRecipeRow(ctx.pool, project.id);
    const runs = await rows(
      ctx.pool,
      `SELECT id, env, target_name, status, trial, dry_run, commit, hash, summary, refusal, refusal_detail, missing, health, smoke, waiting_for, created_at
         FROM deploy_runs WHERE project_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::text IS NULL OR env=$3)
        ORDER BY created_at DESC, id DESC LIMIT 10`,
      [project.id, p.data.run ?? null, p.data.env ?? null],
    );
    return [
      true,
      {
        project: project.key,
        mode: project.delivery_mode,
        recipe: recipe
          ? {
              status: recipe.status,
              hash: recipe.observed_hash,
              approvedHash: recipe.approved_hash,
              commit: recipe.observed_commit,
              lint: recipe.lint,
            }
          : null,
        runs,
      },
    ];
  }

  if (method === 'deploy.run') {
    const p = DeployRunParamsSchema.safeParse(params);
    if (!p.success) return bad(p);
    const project = await projectOf(ctx, orgId, p.data.project);
    if (typeof project === 'string') return [false, undefined, project];
    if (isCeo) {
      // Through the CEO's verb: the policy, the audit row, and (from an owner turn) the inline confirmation all apply.
      const call = await ceoCallContext(ctx, shift, { writes: true });
      if (typeof call === 'string') return [false, undefined, call];
      const r = await runAction(
        call.env,
        {
          op: 'act',
          action: 'deploy',
          params: {
            project: project.key,
            env: p.data.env,
            ...(p.data.commit ? { commit: p.data.commit } : {}),
            ...(p.data.target ? { target: p.data.target } : {}),
          },
          reason: p.data.reason ?? `deploy ${project.key} ${p.data.env}`,
          confidence: 0.9,
          evidence: [],
          dryRun: false,
        },
        call.origin,
      );
      return [true, r];
    }
    const r = await requestDeployRun(ctx, {
      projectId: project.id,
      env: p.data.env,
      commit: p.data.commit,
      targets: p.data.target ? [p.data.target] : undefined,
      trigger: 'request',
      requester: { kind: 'devops', id: agent.id, name: agent.name, provenance: 'session' },
    });
    return [true, r];
  }

  // Trials and saving a recipe: DevOps, inside a recipe request the CEO filed from the Owner's own turn.
  if (!isDevops)
    return [
      false,
      undefined,
      `${method} is DevOps work: ask DevOps through \`aom ceo devops --kind recipe\``,
    ];
  const req = await one(
    ctx.pool,
    `SELECT id, context FROM devops_requests WHERE shift_id=$1 AND status IN ('running','needs_approval')`,
    [shift.id],
  );
  const c = (req?.context ?? {}) as { requestKind?: string; ownerTurn?: boolean; projectKey?: string };
  if (c.requestKind !== 'recipe' || c.ownerTurn !== true)
    return [
      false,
      undefined,
      'trials and recipe saves belong to a recipe request the CEO filed from a conversation with the Owner',
    ];

  if (method === 'deploy.trial') {
    const p = DeployTrialParamsSchema.safeParse(params);
    if (!p.success) return bad(p);
    const project = await projectOf(ctx, orgId, p.data.project ?? c.projectKey);
    if (typeof project === 'string') return [false, undefined, project];
    if (c.projectKey && project.key !== c.projectKey)
      return [false, undefined, `this request is for ${c.projectKey}`];
    const r = await requestDeployRun(ctx, {
      projectId: project.id,
      env: p.data.env,
      commit: p.data.commit,
      targets: p.data.target ? [p.data.target] : undefined,
      trigger: 'request',
      trial: true,
      requester: { kind: 'devops', id: agent.id, name: agent.name, provenance: 'owner' },
    });
    return [true, r];
  }

  if (method === 'recipe.save') {
    const p = RecipeSaveParamsSchema.safeParse(params);
    if (!p.success) return bad(p);
    const project = await projectOf(ctx, orgId, p.data.project);
    if (typeof project === 'string') return [false, undefined, project];
    if (c.projectKey && project.key !== c.projectKey)
      return [false, undefined, `this request is for ${c.projectKey}`];
    const vault = await projectVault(ctx.pool, project.id);
    if (!vault) return [false, undefined, NO_PROJECT_VAULT];
    if (p.data.phase === 'begin')
      return [
        true,
        {
          projectId: project.id,
          vault: { vaultId: vault.vaultId, storage: vault.storage, folder: vault.folder },
        },
      ];
    const r = await observeRecipe(ctx, project.id, p.data.inspected, shift.workstation_id ?? null);
    const row = await loadRecipeRow(ctx.pool, project.id);
    return [
      true,
      {
        recorded: r.recorded,
        status: row?.status ?? null,
        hash: row?.observed_hash ?? null,
        lint: row?.lint ?? [],
      },
    ];
  }
  return [false, undefined, `${method} is not available`];
}
