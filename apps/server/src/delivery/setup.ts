import {
  type ChangeItem,
  compileSetup,
  DEPLOY_SETUP_CAPABILITY,
  DeliverySetupSchema,
  findSecret,
  type LintItem,
  type ProbeReport,
  type PublishSetupRequest,
  parseRecipe,
  planChanges,
  type RecipeWritePayload,
  RecipeWriteResultSchema,
  type SaveSetupDraftRequest,
  SETUP_GENERATOR,
  type SetupPreviewDto,
  type SetupStateDto,
  type SetupTargetDto,
  type SetupWorkstationDto,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { projectScope, runnerActor, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { listProposalDtos, openScan, scanProblemFor } from '../commands/setup-proposals.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { listProbeDtos, setupBlockedReason } from './probes.ts';
import {
  guidedEnvsWithoutDryRun,
  loadRecipeRow,
  NO_PROJECT_VAULT,
  observeRecipe,
  projectVault,
  serverLint,
  workstationForVault,
} from './recipes.ts';
import { requestDeployRun } from './runs.ts';

/**
 * The guided deploy setup, server side (docs/design/deploy-run-ux-design.md sections 4 and 7). The server never writes the
 * vault: it compiles the setup with the shared compiler, shows a preview (files, lint, Found / Will change / Will not touch),
 * and on publish sends `recipe.write` to the workstation that holds the vault. What lands in `delivery/` is observed like any
 * other recipe and still needs the Owner's approval of exactly that hash.
 */

const asLint = (l: LintItem[]) =>
  l.map((x) => ({
    level: x.level,
    code: x.code,
    message: x.message,
    ...(x.env ? { env: x.env } : {}),
    ...(x.path ? { path: x.path } : {}),
  }));

async function projectOwnerOrThrow(ctx: Ctx, user: AuthSession['user'], projectId: string) {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can set up deploys');
  if (p.status !== 'active') throw conflict('project_archived', 'this project is archived');
  return p;
}

async function targetsOf(db: Queryable, projectId: string): Promise<Array<Record<string, any>>> {
  return rows(
    db,
    `SELECT t.*, w.name AS workstation_name, w.connected AS workstation_connected
       FROM deploy_targets t LEFT JOIN workstations w ON w.id = t.workstation_id
      WHERE t.project_id=$1 AND t.removed_at IS NULL ORDER BY lower(t.name)`,
    [projectId],
  );
}

// -------------------------------------------------------------------------------------------------------- state

export async function getSetupState(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<SetupStateDto> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const org = await orgRoleOf(ctx.pool, user.id, p.org_id);
  const draft = await one(ctx.pool, 'SELECT * FROM delivery_setup_drafts WHERE project_id=$1', [projectId]);
  const recipe = await loadRecipeRow(ctx.pool, projectId);
  const parsedSetup = DeliverySetupSchema.safeParse(recipe?.setup ?? null);
  const targets = await targetsOf(ctx.pool, projectId);
  const conns = await rows(ctx.pool, 'SELECT * FROM deploy_target_connections WHERE project_id=$1', [
    projectId,
  ]);
  const targetDtos: SetupTargetDto[] = targets.map((t) => {
    // the deploying workstation's own answer; for a target with none, the newest answer
    const c = conns
      .filter((x) => x.target_id === t.id && (!t.workstation_id || x.workstation_id === t.workstation_id))
      .sort((a, b) => +b.at - +a.at)[0];
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      production: !!t.production,
      workstationId: t.workstation_id ?? null,
      workstationName: t.workstation_name ?? null,
      workstationOnline: t.workstation_id ? !!t.workstation_connected : null,
      host: t.host ?? null,
      appUrl: t.app_url ?? null,
      connection: c ? { state: c.state, at: iso(c.at) as string, detail: c.detail ?? null } : null,
    };
  });
  const stations = await rows(
    ctx.pool,
    `SELECT w.id, w.name, w.connected, w.user_id, c.capabilities
       FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id
       JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id=$1 AND pm.status='active'
      WHERE w.status='active' ORDER BY (w.user_id = $2) DESC, w.connected DESC, w.name, w.id`,
    [projectId, user.id],
  );
  const workstations: SetupWorkstationDto[] = [];
  for (const w of stations) {
    const blocked = await setupBlockedReason(ctx.pool, w.id);
    workstations.push({
      id: w.id,
      name: w.name,
      connected: !!w.connected,
      mine: w.user_id === user.id,
      canProbe: blocked === null,
      blocked,
    });
  }
  const lp = draft?.last_publish as
    | {
        setupHash: string;
        commandId: string;
        status: 'pending' | 'written' | 'failed';
        error?: string | null;
        at: string;
      }
    | null
    | undefined;
  const dryRunOk: string[] = [];
  if (recipe?.observed_hash && parsedSetup.success) {
    const missing = new Set(await guidedEnvsWithoutDryRun(ctx.pool, projectId, recipe));
    for (const e of parsedSetup.data.environments)
      if (e.mode === 'guided' && !missing.has(e.name)) dryRunOk.push(e.name);
  }
  const vault = await projectVault(ctx.pool, projectId);
  const writeWs = vault ? await workstationForVault(ctx.pool, projectId, vault, p.org_id) : null;
  const writeBlocked = !vault
    ? NO_PROJECT_VAULT
    : !writeWs
      ? 'No computer of the project can read the project files.'
      : await setupBlockedReason(ctx.pool, writeWs);
  const proposals = await listProposalDtos(ctx.pool, projectId, 'deploy', true);
  const scan = await openScan(ctx.pool, projectId, 'deploy', ctx.clock.now());
  return {
    canEdit: p.my_role === 'owner',
    canApprove: org === 'owner',
    draft: draft
      ? {
          setup: draft.setup,
          customScripts: draft.custom_scripts ?? {},
          proposalId: draft.proposal_id ?? null,
          updatedAt: iso(draft.updated_at) as string,
        }
      : null,
    current: {
      setup: parsedSetup.success ? parsedSetup.data : null,
      handEdited: (recipe?.hand_edited ?? []) as string[],
      recipePresent: !!recipe?.present,
      recipeStatus: recipe?.status ?? null,
      observedHash: recipe?.observed_hash ?? null,
      approvedHash: recipe?.approved_hash ?? null,
      lint: asLint((recipe?.lint ?? []) as LintItem[]),
      dryRunOk,
      custom: !!recipe?.present && !parsedSetup.success,
    },
    publish: lp
      ? {
          setupHash: lp.setupHash,
          commandId: lp.commandId,
          status: lp.status,
          error: lp.error ?? null,
          at: lp.at,
        }
      : null,
    targets: targetDtos,
    workstations,
    probes: await listProbeDtos(ctx.pool, projectId),
    writeBlocked,
    scan,
    scanProblem: scan || proposals[0] ? null : await scanProblemFor(ctx.pool, projectId, 'deploy'),
    proposal: proposals[0] ?? null,
    generator: SETUP_GENERATOR,
  };
}

// -------------------------------------------------------------------------------------------------------- draft

export async function saveSetupDraft(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SaveSetupDraftRequest,
  proposalId?: string,
): Promise<void> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  if (JSON.stringify(req.setup ?? null).length > 400_000) throw badRequest('too_big', 'the setup is too big');
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliverySetupDraftSaved',
        payload: {
          projectId,
          setup: req.setup ?? null,
          ...(req.customScripts ? { customScripts: req.customScripts } : {}),
          ...(proposalId ? { proposalId } : {}),
          by: user.id,
        },
      },
      actor: userActor(user.id),
      scope: projectScope(p.org_id, projectId),
    },
  ]);
}

// -------------------------------------------------------------------------------------------------------- preview

/** The report that applies to an environment: its target's, from the deploying workstation, newest first. */
async function reportsFor(
  db: Queryable,
  projectId: string,
  setup: ReturnType<typeof DeliverySetupSchema.parse>,
) {
  const targets = await targetsOf(db, projectId);
  const out: Record<string, ProbeReport | null> = {};
  for (const e of setup.environments) {
    const t = targets.find((x) => x.name.toLowerCase() === e.target.toLowerCase());
    const scope = e.hosting === 'ssh' ? 'ssh_target' : 'local';
    const r = await one(
      db,
      `SELECT report FROM deploy_probes WHERE project_id=$1 AND scope=$2 AND report IS NOT NULL
          AND ($3::uuid IS NULL OR target_id = $3 OR target_id IS NULL)
          AND ($4::text IS NULL OR host = $4)
          AND ($5::uuid IS NULL OR workstation_id = $5)
        ORDER BY (target_id IS NOT NULL) DESC, at DESC LIMIT 1`,
      [
        projectId,
        scope,
        t?.id ?? null,
        e.hosting === 'ssh' ? (e.host ?? null) : null,
        t?.workstation_id ?? null,
      ],
    );
    out[e.name] = (r?.report as ProbeReport | undefined) ?? null;
  }
  return out;
}

export async function previewSetup(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SaveSetupDraftRequest,
): Promise<SetupPreviewDto> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const empty: SetupPreviewDto = {
    ok: false,
    issues: [],
    hash: null,
    files: [],
    keep: [],
    lint: [],
    changes: [],
    differsFromCurrent: false,
    needsDryRun: [],
  };
  const c = compileSetup(req.setup, { customScripts: req.customScripts ?? {} });
  if (!c.ok) return { ...empty, issues: c.issues };
  const recipeText = c.files.find((f) => f.path === 'recipe.yaml')?.content ?? '';
  const parsed = parseRecipe(recipeText);
  const lint = await serverLint(
    ctx.pool,
    p.org_id,
    projectId,
    parsed.ok ? parsed.recipe : null,
    c.files.map((f) => ({
      path: f.path,
      mode: f.mode,
      sha256: '0'.repeat(64),
      secret: findSecret(f.content),
    })),
    [],
    parsed.ok ? undefined : parsed.error,
  );
  const reports = await reportsFor(ctx.pool, projectId, c.setup);
  const changes: ChangeItem[] = planChanges(c.setup, reports);
  const recipe = await loadRecipeRow(ctx.pool, projectId);
  const current = await currentGeneratedHash(recipe);
  const guided = c.setup.environments.filter((e) => e.mode === 'guided').map((e) => e.name);
  return {
    ok: true,
    issues: [],
    hash: c.hash,
    files: c.files,
    keep: c.keep,
    lint: asLint(lint),
    changes,
    differsFromCurrent: current !== c.hash,
    needsDryRun: guided,
  };
}

/** The hash of the generated files that are in `delivery/` now: recompiled from the stored setup (null when there is none). */
async function currentGeneratedHash(recipe: Record<string, any> | undefined): Promise<string | null> {
  const parsed = DeliverySetupSchema.safeParse(recipe?.setup ?? null);
  if (!parsed.success || (recipe?.hand_edited ?? []).length > 0) return null;
  const c = compileSetup(parsed.data);
  return c.ok ? c.hash : null;
}

// -------------------------------------------------------------------------------------------------------- publish

export async function publishSetup(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: PublishSetupRequest,
): Promise<{ commandId: string; hash: string }> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  const c = compileSetup(req.setup, { customScripts: req.customScripts ?? {} });
  if (!c.ok) throw unprocessable('invalid_setup', c.issues.join('; ').slice(0, 400));
  if (c.hash !== req.setupHash)
    throw conflict('preview_changed', 'the setup changed since you previewed it: preview it again');
  const preview = await previewSetup(ctx, user, projectId, {
    setup: req.setup,
    ...(req.customScripts ? { customScripts: req.customScripts } : {}),
  });
  const errors = preview.lint.filter((l) => l.level === 'error');
  if (errors.length)
    throw unprocessable(
      'setup_lint_errors',
      errors
        .map((e) => e.message)
        .join('; ')
        .slice(0, 400),
    );
  const blockers = preview.changes.filter((i) => i.group === 'setup_once');
  if (blockers.length)
    throw unprocessable(
      'setup_needs_work',
      blockers
        .map((b) => b.text)
        .join(' ')
        .slice(0, 400),
    );
  const vault = await projectVault(ctx.pool, projectId);
  if (!vault) throw conflict('no_vault', NO_PROJECT_VAULT);
  const wsId = await workstationForVault(ctx.pool, projectId, vault, p.org_id);
  if (!wsId) throw conflict('no_workstation', 'no computer of the project can read the project files');
  const blocked = await setupBlockedReason(ctx.pool, wsId);
  if (blocked)
    throw conflict(blocked.includes('update') ? 'runner_outdated' : 'workstation_offline', blocked);
  const payload: RecipeWritePayload = {
    projectId,
    vault: { vaultId: vault.vaultId, storage: vault.storage, folder: vault.folder },
    files: c.files,
    keep: c.keep,
    commitMessage: `delivery setup for ${p.key} (guided, ${c.setup.generator})`,
    expectedHash: c.hash,
    setupHash: c.hash,
  };
  const commandId = await withAppendTx(ctx.pool, async (tx) => {
    const id = await enqueueRunnerCommand(
      tx,
      wsId,
      'recipe.write',
      payload as unknown as Record<string, unknown>,
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'DeliverySetupDraftSaved',
            payload: { projectId, setup: c.setup, customScripts: req.customScripts ?? {}, by: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'DeliverySetupPublished',
            payload: {
              projectId,
              setupHash: c.hash,
              commandId: id,
              generator: c.setup.generator,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return id;
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(wsId)).catch(() => undefined);
  return { commandId, hash: c.hash };
}

/** `command.result` of `recipe.write`: observe what was written (so the Owner can approve it), and record the outcome. */
export async function applyWriteResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  commandId: string,
  error?: string,
): Promise<void> {
  const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
  if (!projectId) return;
  const project = await one(ctx.pool, `SELECT id, org_id FROM projects WHERE id=$1 AND kind='project'`, [
    projectId,
  ]);
  if (!project) return;
  const parsed = ok ? RecipeWriteResultSchema.safeParse(result) : undefined;
  const r = parsed?.success
    ? parsed.data
    : { ok: false as const, error: error ?? 'the computer could not write the files' };
  if (r.ok) await observeRecipe(ctx, projectId, r.inspected, workstationId);
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliverySetupPublishResult',
        payload: {
          projectId,
          commandId,
          ok: r.ok,
          error: r.ok ? null : r.error.slice(0, 480),
          vaultCommit: r.ok ? r.vaultCommit : null,
        },
      },
      actor: runnerActor(workstationId),
      scope: projectScope(project.org_id, projectId),
    },
  ]);
}

// -------------------------------------------------------------------------------------------------------- dry run

/** "Try it without changing anything": a trial of the observed version that only checks (never changes the target). */
export async function requestSetupDryRun(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  env: string,
): Promise<ReturnType<typeof requestDeployRun>> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  const role = await orgRoleOf(ctx.pool, user.id, p.org_id);
  return requestDeployRun(ctx, {
    projectId,
    env,
    trigger: 'request',
    trial: true,
    dryRun: true,
    requester: {
      kind: role === 'owner' ? 'owner' : role === 'admin' ? 'admin' : 'owner',
      id: user.id,
      name: user.displayName,
      provenance: 'session',
    },
  });
}

// -------------------------------------------------------------------------------------------------------- proposals

/** A deploy scan proposal becomes the wizard's draft; the user still reviews Found / Will change before saving. */
export async function useDeployProposal(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  proposalId: string,
): Promise<void> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  await withAppendTx(ctx.pool, async (tx) => {
    const sp = await one(
      tx,
      `SELECT * FROM setup_proposals WHERE id=$1 AND project_id=$2 AND area='deploy' FOR UPDATE`,
      [proposalId, projectId],
    );
    if (!sp) throw notFound('proposal not found');
    if (sp.status !== 'open')
      throw conflict('proposal_resolved', 'this proposal was already used or dismissed');
    const ws = await one(tx, 'SELECT user_id FROM workstations WHERE id=$1', [sp.workstation_id]);
    if (ws && ws.user_id !== user.id)
      throw forbidden('only the owner of the computer that scanned can use this proposal');
    const deploy = (sp.proposal as { deploy?: unknown }).deploy;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'DeliverySetupDraftSaved',
            payload: { projectId, setup: deploy, proposalId, by: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
        {
          streamId: streamId.project(projectId),
          event: { type: 'SetupProposalResolved', payload: { proposalId, outcome: 'accepted', by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

void SYSTEM_ACTOR;
void DEPLOY_SETUP_CAPABILITY;
void notFound;
