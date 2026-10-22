import {
  blockersFor,
  type ChangeItem,
  compileSetup,
  DEPLOY_DIRECT_CAPABILITY,
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_SETUP_V2_CAPABILITY,
  type DeliverySetup,
  DeliverySetupSchema,
  findSecret,
  type LintItem,
  type ProbeReport,
  type ProposalMergeInfo,
  type PublishSetupRequest,
  parseRecipe,
  planChanges,
  type RecipeWritePayload,
  RecipeWriteResultSchema,
  type SaveSetupDraftRequest,
  SETUP_GENERATOR,
  type SetupPreviewDto,
  SetupProposalSchema,
  type SetupStateDto,
  type SetupTargetDto,
  type SetupWorkstationDto,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { projectScope, runnerActor, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { listProposalDtos, openQuestionsOf, openScan, scanProblemFor } from '../commands/setup-proposals.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { connectBlockedReason, listKeyDtos } from './connect.ts';
import { workingSetup } from './environments.ts';
import { modeHistory, releasesPaused } from './mode.ts';
import { moveBlockedReason } from './move.ts';
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

export const RECIPE_WRITE_TTL_MS = 3_600_000;

const asLint = (l: LintItem[]) =>
  l.map((x) => ({
    level: x.level,
    code: x.code,
    message: x.message,
    ...(x.env ? { env: x.env } : {}),
    ...(x.path ? { path: x.path } : {}),
  }));

export async function projectOwnerOrThrow(ctx: Ctx, user: AuthSession['user'], projectId: string) {
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
  const keys = await listKeyDtos(ctx.pool, projectId);
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
      connection: c
        ? { state: c.state, at: iso(c.at) as string, detail: c.detail ?? null, method: c.method }
        : null,
      keys: keys.filter((k) => k.targetId === t.id),
      role: (t.role ?? 'active') as 'active' | 'standby' | 'retired',
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
    const connectBlocked = await connectBlockedReason(ctx.pool, w.id);
    workstations.push({
      canConnect: connectBlocked === null,
      canMove: (await moveBlockedReason(ctx.pool, w.id)) === null,
      id: w.id,
      name: w.name,
      connected: !!w.connected,
      mine: w.user_id === user.id,
      canProbe: blocked === null,
      blocked,
      canNewMethods: (w.capabilities ?? []).includes(DEPLOY_SETUP_V2_CAPABILITY),
      canDirect: (w.capabilities ?? []).includes(DEPLOY_DIRECT_CAPABILITY),
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
  // A draft is "unfinished" only while it differs from what was published: a save appends DraftSaved and then Published, so a
  // draft that was not touched after its newest publish (pending or written) is just the saved setup. A failed publish, or an
  // edit after it, keeps the draft. (Derived here, so replay needs nothing new.)
  const draftIsPublished =
    !!lp &&
    (lp.status === 'written' || lp.status === 'pending') &&
    !!draft?.updated_at &&
    +new Date(lp.at) >= +new Date(draft.updated_at);
  const dryRunOk: string[] = [];
  let dryRunMissing: string[] = [];
  if (recipe?.observed_hash) {
    dryRunMissing = await guidedEnvsWithoutDryRun(ctx.pool, projectId, recipe);
    if (parsedSetup.success)
      for (const e of parsedSetup.data.environments)
        if (!dryRunMissing.includes(e.name)) dryRunOk.push(e.name);
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
    draft:
      draft?.setup && !draftIsPublished
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
      dryRunMissing,
      custom: !!recipe?.present && !parsedSetup.success,
      envNames: parsedSetup.success
        ? parsedSetup.data.environments.map((e) => e.name)
        : ((recipe?.parsed as { environments?: Array<{ name: string }> } | null)?.environments ?? []).map(
            (e) => e.name,
          ),
    },
    publish: lp
      ? {
          setupHash: lp.setupHash,
          commandId: lp.commandId,
          // a write nobody picked up in time is never delivered any more
          ...(lp.status === 'pending' && ctx.clock.now().getTime() - Date.parse(lp.at) > RECIPE_WRITE_TTL_MS
            ? { status: 'failed' as const, error: 'The computer did not pick this up in time. Save again.' }
            : { status: lp.status, error: lp.error ?? null }),
          at: lp.at,
        }
      : null,
    targets: targetDtos,
    workstations,
    probes: await listProbeDtos(ctx.pool, projectId, {
      userId: user.id,
      projectOwner: p.my_role === 'owner',
    }),
    writeBlocked,
    scan,
    scanProblem: scan || proposals[0] ? null : await scanProblemFor(ctx.pool, projectId, 'deploy'),
    proposal: proposals[0] ?? null,
    generator: SETUP_GENERATOR,
    improvedAvailable: parsedSetup.success && parsedSetup.data.generator !== SETUP_GENERATOR,
    deliveryMode: p.delivery_mode === 'recipe' ? 'recipe' : 'instructions',
    releasesPaused: await releasesPaused(ctx.pool, projectId),
    modeHistory: await modeHistory(ctx.pool, projectId),
  };
}

// -------------------------------------------------------------------------------------------------------- draft

/** A draft keeps hand-written scripts as text: a credential in one is refused here, not discovered later. */
function refuseSecretsIn(customScripts: Record<string, string> | undefined): void {
  for (const [env, text] of Object.entries(customScripts ?? {})) {
    const hit = findSecret(text);
    if (hit)
      throw unprocessable(
        'secret_in_script',
        `the script of ${env} contains ${hit}: a script names its secrets and never holds them`,
      );
  }
}

export async function saveSetupDraft(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SaveSetupDraftRequest,
  proposalId?: string,
): Promise<void> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  if (JSON.stringify(req.setup ?? null).length > 400_000) throw badRequest('too_big', 'the setup is too big');
  refuseSecretsIn(req.customScripts);
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

/** Does this setup use what only a runner with `deploy-setup:2` writes: the override file or the registry / build-on-server steps? */
export function needsV2(setup: DeliverySetup): boolean {
  const newKinds = new Set([
    'write_override',
    'push_image_registry',
    'pull_image_ssh',
    'ship_source_ssh',
    'build_image_server',
  ]);
  return setup.environments.some(
    (e) =>
      e.mode === 'guided' &&
      e.runtime !== 'direct' &&
      e.hosting === 'ssh' &&
      (!e.app.imageVar || e.steps.some((x) => newKinds.has(x.kind))),
  );
}

/** Does this setup have an environment whose app runs directly on the machine (capability `deploy-direct:1`)? */
export function needsDirect(setup: DeliverySetup): boolean {
  return setup.environments.some((e) => e.mode === 'guided' && e.runtime === 'direct');
}

/** Why a computer cannot write the newer update methods (null: it can). */
export async function v2BlockedReason(db: Queryable, workstationId: string): Promise<string | null> {
  const w = await one(
    db,
    `SELECT w.name, c.capabilities FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id WHERE w.id=$1`,
    [workstationId],
  );
  if (!w) return null;
  return (w.capabilities ?? []).includes(DEPLOY_SETUP_V2_CAPABILITY)
    ? null
    : `Guildwise on ${w.name} needs an update for this way of updating the server.`;
}

export async function directBlockedReason(db: Queryable, workstationId: string): Promise<string | null> {
  const w = await one(
    db,
    `SELECT w.name, c.capabilities FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id WHERE w.id=$1`,
    [workstationId],
  );
  if (!w) return null;
  return (w.capabilities ?? []).includes(DEPLOY_DIRECT_CAPABILITY)
    ? null
    : `Guildwise on ${w.name} needs an update for apps that run without Docker.`;
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
  refuseSecretsIn(req.customScripts);
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
  for (const e of c.setup.environments)
    if (e.mode === 'guided' && e.health.kind === 'none')
      lint.push({
        level: 'warn',
        code: 'no_health_check',
        env: e.name,
        message: `${e.name}: there is no address to check after an update, so a broken update is not noticed and nothing is rolled back automatically. Add the address of the site.`,
      });
  if (needsV2(c.setup) || needsDirect(c.setup)) {
    const vault = await projectVault(ctx.pool, projectId);
    const wsId = vault ? await workstationForVault(ctx.pool, projectId, vault, p.org_id) : null;
    const why = wsId
      ? ((needsV2(c.setup) ? await v2BlockedReason(ctx.pool, wsId) : null) ??
        (needsDirect(c.setup) ? await directBlockedReason(ctx.pool, wsId) : null))
      : null;
    if (why) lint.push({ level: 'error', code: 'runner_update_needed', message: why });
  }
  const reports = await reportsFor(ctx.pool, projectId, c.setup);
  const changes: ChangeItem[] = planChanges(c.setup, reports);
  const recipe = await loadRecipeRow(ctx.pool, projectId);
  const current = await currentGeneratedHash(recipe);
  const guided = c.setup.environments.filter((e) => e.mode === 'guided').map((e) => e.name);
  // Saving replaces the folder, so a file the setup does not make (a smoke test, an old script) would vanish. It stays unless
  // the Owner names it.
  const generated = new Set(c.files.map((f) => f.path));
  const unmodelled = ((recipe?.files ?? []) as Array<{ path: string }>)
    .map((f) => f.path)
    .filter((path) => !generated.has(path) && !c.keep.includes(path))
    .sort();
  // The script of an environment the person took out goes with it (nothing else is deleted unless they name it)
  const curSetup = DeliverySetupSchema.safeParse(recipe?.setup ?? null);
  const taken = curSetup.success
    ? curSetup.data.environments
        .map((e) => e.name)
        .filter((n) => !c.setup.environments.some((x) => x.name === n))
        .map((n) => `scripts/${n}.sh`)
    : [];
  const removing = [...new Set([...(req.removeFiles ?? []), ...taken])].filter((f) => unmodelled.includes(f));
  const kept = unmodelled.filter((f) => !removing.includes(f));
  return {
    ok: true,
    issues: [],
    hash: c.hash,
    files: c.files,
    keep: [...c.keep, ...kept],
    unmodelled,
    removing,
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
    ...(req.removeFiles ? { removeFiles: req.removeFiles } : {}),
  });
  const errors = preview.lint.filter((l) => l.level === 'error' && l.code !== 'runner_update_needed');
  if (errors.length)
    throw unprocessable(
      'setup_lint_errors',
      errors
        .map((e) => e.message)
        .join('; ')
        .slice(0, 400),
    );
  // A save of one environment is stopped only by that environment's own blockers; a whole-setup publish by every one.
  const blockers = blockersFor(preview.changes, req.onlyEnv);
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
  const blocked =
    (await setupBlockedReason(ctx.pool, wsId)) ??
    (needsV2(c.setup) ? await v2BlockedReason(ctx.pool, wsId) : null) ??
    (needsDirect(c.setup) ? await directBlockedReason(ctx.pool, wsId) : null);
  if (blocked)
    throw conflict(blocked.includes('update') ? 'runner_outdated' : 'workstation_offline', blocked);
  const payload: RecipeWritePayload = {
    projectId,
    vault: { vaultId: vault.vaultId, storage: vault.storage, folder: vault.folder },
    files: c.files,
    keep: preview.keep,
    commitMessage: `delivery setup for ${p.key} (guided, ${c.setup.generator})`,
    expectedHash: c.hash,
    setupHash: c.hash,
  };
  const commandId = await withAppendTx(ctx.pool, async (tx) => {
    // The newest save wins: an older write that has not been picked up yet is cancelled, and a write nobody picks up within
    // an hour is never delivered (a computer that comes back next week must not overwrite newer files).
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', last_error='superseded', payload='{}'::jsonb
        WHERE type='recipe.write' AND status IN ('pending','sent') AND payload->>'projectId' = $1`,
      [projectId],
    );
    const id = await enqueueRunnerCommand(
      tx,
      wsId,
      'recipe.write',
      payload as unknown as Record<string, unknown>,
      new Date(ctx.clock.now().getTime() + RECIPE_WRITE_TTL_MS),
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
  // A dry run RUNS the script on the deploying computer, as that computer's user: the same people who may deploy may try.
  const role = await orgRoleOf(ctx.pool, user.id, p.org_id);
  if (role !== 'owner' && role !== 'admin')
    throw forbidden('only an Owner or an Admin can try a deploy setup');
  // A script that a person wrote or edited may not honour "only check": only the Owner may run it, even as a trial.
  const recipe = await loadRecipeRow(ctx.pool, projectId);
  const parsedSetup = DeliverySetupSchema.safeParse(recipe?.setup ?? null);
  const envDef = parsedSetup.success ? parsedSetup.data.environments.find((e) => e.name === env) : undefined;
  const handWritten =
    !parsedSetup.success ||
    envDef?.mode === 'custom' ||
    ((recipe?.hand_edited ?? []) as string[]).includes(env);
  if (handWritten && role !== 'owner')
    throw forbidden(
      'this script was written or edited by hand and may not stop at "only check": only the Owner can try it',
    );
  return requestDeployRun(ctx, {
    projectId,
    env,
    trigger: 'request',
    trial: true,
    dryRun: true,
    requester: { kind: role, id: user.id, name: user.displayName, provenance: 'session' },
  });
}

// -------------------------------------------------------------------------------------------------------- proposals

/**
 * A deploy scan proposal MERGES into the wizard's draft (else the saved setup) by environment name: an environment the
 * proposal names replaces the one with that name, every other one stays as it was. The person still reviews Found / Will
 * change before saving. Unanswered questions block it (409 `questions_open`).
 */
export async function useDeployProposal(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  proposalId: string,
): Promise<ProposalMergeInfo> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  return withAppendTx(ctx.pool, async (tx) => {
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
    const proposal = SetupProposalSchema.parse(sp.proposal);
    const open = openQuestionsOf(proposal);
    if (open.length > 0)
      throw conflict(
        'questions_open',
        `answer ${open.length === 1 ? 'the question' : `the ${open.length} questions`} first: ${open
          .slice(0, 3)
          .map((q) => `"${q.question}"`)
          .join(', ')}`,
      );
    const proposed = (proposal.deploy ?? { environments: [] }) as Record<string, any> & {
      environments: Array<Record<string, any>>;
    };
    const { setup: base } = await workingSetup(tx, projectId);
    const existing = ((base?.environments ?? []) as Array<Record<string, any>>).slice();
    const merge: ProposalMergeInfo = { added: [], replaced: [], notCovered: [] };
    const merged = existing.map((e) => {
      const np = proposed.environments.find((x) => x.name === e.name);
      if (!np) {
        merge.notCovered.push(e.name);
        return e;
      }
      merge.replaced.push(e.name);
      return np;
    });
    for (const np of proposed.environments)
      if (!existing.some((e) => e.name === np.name)) {
        merged.push(np);
        merge.added.push(np.name);
      }
    const setup = { ...(base ?? proposed), environments: merged };
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'DeliverySetupDraftSaved',
            payload: { projectId, setup, proposalId, by: user.id },
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
    return merge;
  });
}

void SYSTEM_ACTOR;
void DEPLOY_SETUP_CAPABILITY;
void notFound;
