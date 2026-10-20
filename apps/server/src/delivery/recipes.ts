import { randomUUID } from 'node:crypto';
import {
  DELIVERY_DIR,
  type DeliveryRecipeDto,
  type LintItem,
  lintHasErrors,
  lintRecipe,
  projectVaultFolder,
  type Recipe,
  type RecipeFileInfo,
  type RecipeInspectResult,
  RecipeInspectResultSchema,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { orgScope, projectScope, runnerActor, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { vaultAudience } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { closeDeskNotice, raiseDeskNotice } from './notices.ts';

/**
 * Delivery recipes, server side (docs/design/ceo-front-door.md sections 9.1 and 9.4). The recipe lives in the project vault;
 * the workstation reports what it finds (`recipe.inspect`) and the server records it. Only the Owner's button turns an
 * observed content hash into an approved one.
 */

export const RECIPE_APPROVAL_SUBKIND = 'recipe_approval';

export interface ProjectVault {
  vaultId: string;
  orgId: string;
  storage: 'git' | 'local';
  /** Local vaults: the one workstation that holds the folder. */
  workstationId: string | null;
  name: string;
  folder: string;
}

/** The project's own vault. Recipes live there, never in the organization vault (section 14.3). */
export async function projectVault(db: Queryable, projectId: string): Promise<ProjectVault | null> {
  const p = await one(
    db,
    `SELECT id, org_id, key, vault_folder, vault_dir FROM projects WHERE id=$1 AND kind='project'`,
    [projectId],
  );
  if (!p) return null;
  const v = await one(
    db,
    `SELECT id, org_id, storage, local_workstation_id, name FROM vaults WHERE project_id=$1`,
    [projectId],
  );
  if (!v) return null;
  return {
    vaultId: v.id,
    orgId: p.org_id,
    storage: v.storage,
    workstationId: v.local_workstation_id ?? null,
    name: v.name,
    folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
  };
}

export const NO_PROJECT_VAULT =
  'this project has no vault yet: every project gets one (a git repository is recommended; without one it is a local folder on the Owner’s workstation)';

/** A workstation that can read the vault: the local one for a local vault, else the audience's, a connected one first. */
export async function workstationForVault(
  db: Queryable,
  projectId: string,
  vault: ProjectVault,
  orgId: string,
): Promise<string | null> {
  if (vault.storage === 'local') {
    const w = await one<{ id: string }>(db, `SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
      vault.workstationId,
    ]);
    return w?.id ?? null;
  }
  const audience = await vaultAudience(db, { org_id: orgId, project_id: projectId });
  const w = await one<{ id: string }>(
    db,
    `SELECT w.id FROM workstations w
      WHERE w.status='active' AND w.user_id = ANY($1::uuid[])
      ORDER BY w.connected DESC, w.last_seen_at DESC NULLS LAST, w.paired_at LIMIT 1`,
    [audience],
  );
  return w?.id ?? null;
}

export async function loadRecipeRow(db: Queryable, projectId: string): Promise<Row | undefined> {
  return one(db, 'SELECT * FROM delivery_recipes WHERE project_id=$1', [projectId]);
}

/** Asks a workstation to inspect `delivery/` of the project vault (once: a pending request is not repeated). */
export async function requestRecipeInspect(
  ctx: Ctx,
  projectId: string,
  opts: { commit?: string } = {},
): Promise<{ queued: boolean; reason?: string }> {
  const vault = await projectVault(ctx.pool, projectId);
  if (!vault) return { queued: false, reason: NO_PROJECT_VAULT };
  const ws = await workstationForVault(ctx.pool, projectId, vault, vault.orgId);
  if (!ws) return { queued: false, reason: 'no workstation can read the project vault' };
  const pending = await one(
    ctx.pool,
    `SELECT 1 FROM runner_commands WHERE type='recipe.inspect' AND status IN ('pending','sent')
        AND workstation_id=$1 AND payload->>'projectId'=$2`,
    [ws, projectId],
  );
  if (pending) return { queued: true };
  await enqueueRunnerCommand(ctx.pool, ws, 'recipe.inspect', {
    projectId,
    vault: { vaultId: vault.vaultId, storage: vault.storage, folder: vault.folder },
    ...(opts.commit ? { commit: opts.commit } : {}),
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(ws)).catch(() => undefined);
  return { queued: true };
}

/** The checks only the server can make: targets, presets and repositories of this project. */
async function serverLint(
  db: Queryable,
  orgId: string,
  projectId: string,
  recipe: Recipe | null,
  files: RecipeFileInfo[],
  runnerLint: LintItem[],
  parseError: string | undefined,
): Promise<LintItem[]> {
  const targets = (
    await rows(db, `SELECT name, production FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL`, [
      projectId,
    ])
  ).map((t) => ({ name: t.name as string, production: !!t.production }));
  const presets = (await rows(db, 'SELECT name FROM gate_presets WHERE org_id=$1', [orgId])).map(
    (r) => r.name as string,
  );
  const repos = (
    await rows(db, `SELECT name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL`, [projectId])
  ).map((r) => r.name as string);
  const ours = lintRecipe({
    recipe,
    parseError,
    files: files.map((f) => ({ path: f.path, mode: f.mode, secret: f.secret ?? null })),
    targets,
    presets,
    repos,
  });
  // The workstation's own findings and ours overlap on secrets and scripts: keep each message once.
  const seen = new Set<string>();
  return [...runnerLint, ...ours].filter((l) => {
    const k = `${l.code}|${l.env ?? ''}|${l.path ?? ''}|${l.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What the workstation found in `delivery/`: recorded as an observation, with a drift event when it is not what was approved. */
export async function observeRecipe(
  ctx: Ctx,
  projectId: string,
  inspected: RecipeInspectResult,
  workstationId: string | null,
): Promise<{ recorded: boolean; status?: string }> {
  if (!inspected.ok) return { recorded: false };
  const project = await one(ctx.pool, `SELECT id, org_id, key FROM projects WHERE id=$1 AND kind='project'`, [
    projectId,
  ]);
  const vault = await projectVault(ctx.pool, projectId);
  if (!project || !vault) return { recorded: false };
  const cur = await loadRecipeRow(ctx.pool, projectId);
  // The same content again changes nothing: a vault sync asks often, and a commit that touched other files of the vault leaves
  // the hash of `delivery/` as it was (the approval is pinned to the commit that was observed when its hash first appeared).
  if (
    cur &&
    cur.observed_hash === (inspected.present ? inspected.hash : null) &&
    cur.present === inspected.present
  )
    return { recorded: false, status: cur.status };
  const recipe = (inspected.present ? inspected.recipe : null) as Recipe | null;
  const lint = await serverLint(
    ctx.pool,
    project.org_id,
    projectId,
    recipe,
    inspected.files,
    inspected.lint as LintItem[],
    inspected.parseError,
  );
  const recipeId = cur?.id ?? randomUUID();
  const scope = projectScope(project.org_id, projectId);
  const drifted = !!cur?.approved_hash && inspected.present && cur.approved_hash !== inspected.hash;
  const events: AppendInput[] = [
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliveryRecipeObserved',
        payload: {
          recipeId,
          orgId: project.org_id,
          projectId,
          vaultId: vault.vaultId,
          path: `${vault.folder}/${DELIVERY_DIR}`,
          vaultCommit: inspected.vaultCommit,
          hash: inspected.hash,
          present: inspected.present,
          recipe,
          lint,
          fileCount: inspected.files.length,
          files: inspected.files.map((f) => ({ path: f.path, mode: f.mode, sha256: f.sha256 })),
          ...(workstationId ? { workstationId } : {}),
        },
      },
      actor: workstationId ? runnerActor(workstationId) : SYSTEM_ACTOR,
      scope,
    },
    ...(drifted
      ? [
          {
            streamId: streamId.project(projectId),
            event: {
              type: 'DeliveryRecipeDrifted' as const,
              payload: {
                recipeId,
                orgId: project.org_id,
                projectId,
                hash: inspected.hash,
                approvedHash: cur?.approved_hash as string,
              },
            },
            actor: SYSTEM_ACTOR,
            scope,
          },
        ]
      : []),
  ];
  await ctx.store.append(events);
  const status = !inspected.present
    ? 'absent'
    : drifted
      ? 'changed_unapproved'
      : cur?.approved_hash === inspected.hash
        ? 'approved'
        : 'observed';
  // A recipe waiting for the Owner's approval is a desk notice (an alert: the approval itself is a button on the Delivery page).
  if (inspected.present && status !== 'approved' && recipe)
    await raiseDeskNotice(ctx, {
      orgId: project.org_id,
      projectId,
      subkind: RECIPE_APPROVAL_SUBKIND,
      subjectKey: `recipe_approval:${projectId}`,
      title: drifted
        ? `${project.key}: the delivery recipe changed and needs your approval`
        : `${project.key}: a delivery recipe is waiting for your approval`,
      body: `Open Project settings, Delivery, to see the environments, who releases each, and the changes since the last approved version. Until you approve this exact version, nothing is deployed from the recipe. ${lintHasErrors(lint) ? 'The lint found errors: they must be fixed first.' : ''}`.trim(),
      data: { recipeId, projectId, hash: inspected.hash },
    });
  return { recorded: true, status };
}

/** `command.result` of `recipe.inspect`. */
export async function applyInspectResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  if (!ok || typeof payload.projectId !== 'string') return;
  const parsed = RecipeInspectResultSchema.safeParse(result);
  if (!parsed.success) return;
  await observeRecipe(ctx, payload.projectId, parsed.data, workstationId);
}

async function ownerOrThrow(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<void> {
  if ((await orgRoleOf(ctx.pool, user.id, orgId)) !== 'owner')
    throw forbidden('only the Owner of the organization approves a delivery recipe');
}

/** The Owner approves exactly the content hash he saw. Never relayed text: this is the button's route. */
export async function approveRecipe(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  hash: string,
): Promise<void> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  await ownerOrThrow(ctx, user, project.org_id);
  await withAppendTx(ctx.pool, async (tx) => {
    const row = await one(tx, 'SELECT * FROM delivery_recipes WHERE project_id=$1 FOR UPDATE', [projectId]);
    if (!row || !row.present || !row.observed_hash)
      throw notFound('this project has no delivery recipe to approve');
    if (row.observed_hash !== hash)
      throw conflict(
        'recipe_changed',
        'the recipe changed since you looked at it: reload and review it again',
      );
    if (row.status === 'approved' && row.approved_hash === hash) return;
    if (lintHasErrors((row.lint ?? []) as LintItem[]))
      throw unprocessable('recipe_lint_errors', 'the recipe has lint errors: fix them before approving');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'DeliveryRecipeApproved',
            payload: {
              recipeId: row.id,
              orgId: row.org_id,
              projectId,
              version: (row.version ?? 0) + 1,
              hash,
              vaultCommit: row.observed_commit ?? null,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(row.org_id, projectId),
        },
      ],
      { tx },
    );
  });
  await closeDeskNotice(ctx, `recipe_approval:${projectId}`, user.id);
}

export async function rejectRecipe(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  hash: string,
  reason?: string,
): Promise<void> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  await ownerOrThrow(ctx, user, project.org_id);
  const row = await loadRecipeRow(ctx.pool, projectId);
  if (!row || row.observed_hash !== hash)
    throw conflict('recipe_changed', 'the recipe changed: reload and review it again');
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliveryRecipeRejected',
        payload: {
          recipeId: row.id,
          orgId: row.org_id,
          projectId,
          hash,
          by: user.id,
          ...(reason ? { reason } : {}),
        },
      },
      actor: userActor(user.id),
      scope: projectScope(row.org_id, projectId),
    },
  ]);
  await closeDeskNotice(ctx, `recipe_approval:${projectId}`, user.id);
}

/** `recipe` needs an approved recipe whose observed content is still the approved one; `instructions` is always allowed. */
export async function setDeliveryMode(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  mode: 'instructions' | 'recipe',
): Promise<void> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (!['owner', 'admin'].includes((await orgRoleOf(ctx.pool, user.id, project.org_id)) ?? ''))
    throw forbidden('only an Owner or Admin changes how a project delivers');
  if (mode === 'recipe') {
    const row = await loadRecipeRow(ctx.pool, projectId);
    if (!row?.approved_hash)
      throw unprocessable(
        'no_approved_recipe',
        'a project switches to recipe delivery only when it has an approved recipe',
      );
  }
  if (project.delivery_mode === mode) return;
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: { type: 'DeliveryModeSet', payload: { projectId, orgId: project.org_id, mode, by: user.id } },
      actor: userActor(user.id),
      scope: projectScope(project.org_id, projectId),
    },
  ]);
}

/** What changed between the approved recipe and the observed one: environments and files, in plain words. */
export function recipeDiff(
  oldR: Recipe | null,
  newR: Recipe | null,
  oldFiles: Array<{ path: string; sha256: string; mode: string }>,
  newFiles: Array<{ path: string; sha256: string; mode: string }>,
): string[] {
  const out: string[] = [];
  const oldEnv = new Map((oldR?.environments ?? []).map((e) => [e.name, e]));
  const newEnv = new Map((newR?.environments ?? []).map((e) => [e.name, e]));
  for (const [n, e] of newEnv) {
    const o = oldEnv.get(n);
    if (!o) {
      out.push(`New environment ${n}: ${e.targets.join(', ')}, released by ${e.releasedBy}`);
      continue;
    }
    const fields: Array<[string, unknown, unknown]> = [
      ['targets', o.targets, e.targets],
      ['script', o.script, e.script],
      ['args', o.args, e.args],
      ['triggers', o.triggers, e.triggers],
      ['released by', o.releasedBy, e.releasedBy],
      ['gate', o.gate, e.gate],
      ['health check', o.health, e.health],
      ['smoke', o.smoke, e.smoke],
      ['secrets', o.secrets, e.secrets],
      ['env file', o.envFile, e.envFile],
      ['runs outside the sandbox', o.docker, e.docker],
      ['timeout', o.timeoutSec, e.timeoutSec],
    ];
    for (const [label, a, b] of fields)
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null))
        out.push(`${n}: ${label} changed from ${JSON.stringify(a ?? null)} to ${JSON.stringify(b ?? null)}`);
  }
  for (const n of oldEnv.keys()) if (!newEnv.has(n)) out.push(`Environment ${n} removed`);
  const oldF = new Map(oldFiles.map((f) => [f.path, f]));
  for (const f of newFiles) {
    const o = oldF.get(f.path);
    if (!o) out.push(`New file ${f.path}`);
    else if (o.sha256 !== f.sha256 || o.mode !== f.mode)
      out.push(`${f.path} ${o.sha256 !== f.sha256 ? 'content changed' : 'mode changed'}`);
  }
  const newF = new Set(newFiles.map((f) => f.path));
  for (const f of oldFiles) if (!newF.has(f.path)) out.push(`File ${f.path} removed`);
  return out;
}

export function toRecipeDto(row: Row | undefined): DeliveryRecipeDto | null {
  if (!row) return null;
  const parsed = (row.parsed ?? null) as Recipe | null;
  const approvedParsed = (row.approved_parsed ?? null) as Recipe | null;
  return {
    id: row.id,
    status: row.status,
    present: !!row.present,
    observedHash: row.observed_hash ?? null,
    observedCommit: row.observed_commit ?? null,
    approvedHash: row.approved_hash ?? null,
    approvedCommit: row.approved_commit ?? null,
    approvedAt: iso(row.approved_at),
    approvedBy: row.approved_by ?? null,
    version: row.version ?? 0,
    observedAt: iso(row.observed_at),
    recipe: parsed,
    approvedRecipe: approvedParsed,
    lint: (row.lint ?? []) as LintItem[],
    fileCount: row.file_count ?? 0,
    changes:
      row.approved_hash && row.observed_hash && row.approved_hash !== row.observed_hash
        ? recipeDiff(approvedParsed, parsed, row.approved_files ?? [], row.files ?? [])
        : [],
  } as DeliveryRecipeDto;
}

/** Marks a vault status report: a project vault that pulled new commits may carry a changed recipe. */
export async function onProjectVaultSynced(ctx: Ctx, vaultId: string): Promise<void> {
  const v = await one(ctx.pool, `SELECT project_id FROM vaults WHERE id=$1 AND project_id IS NOT NULL`, [
    vaultId,
  ]).catch(() => undefined);
  if (!v?.project_id) return;
  // Only projects that have (or had) a recipe are inspected: the check is cheap but not free.
  const has = await one(ctx.pool, 'SELECT 1 FROM delivery_recipes WHERE project_id=$1', [v.project_id]);
  if (has) await requestRecipeInspect(ctx, v.project_id).catch(() => undefined);
}

void badRequest;
void orgScope;
void exec;
