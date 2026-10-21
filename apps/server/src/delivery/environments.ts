import {
  DeliverySetupSchema,
  type EarlierReleaseDto,
  type EarlierReleasesResponse,
  type EnvCardState,
  type EnvironmentStatusDto,
  type EnvironmentsStatusResponse,
  type Gate,
  type LiveRowDto,
  MOVE_OPEN_STATES,
  type MergePlacesRequest,
  type MergePlacesResult,
  type OrgLiveResponse,
  type PlaceDto,
  type PlacesResponse,
  type RemoveEnvironmentResult,
  type RemovePlaceRequest,
  type RemovePlaceResult,
  type RollbackRequest,
  type SetupEnv,
  describeGate,
  ProposalDtoSchema,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject, visibleProjectIds } from '../authz/scope.ts';
import { projectScope, userActor } from '../commands/common.ts';
import { targetInUse } from '../commands/deploy-targets.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { listProposalDtos } from '../commands/setup-proposals.ts';
import { evaluateEnvGate } from './gate.ts';
import { guidedEnvsWithoutDryRun, loadRecipeRow } from './recipes.ts';
import { requestDeployRun, type RequestDeployResult } from './runs.ts';
import { projectOwnerOrThrow } from './setup.ts';
import { revokeKeyOnRemoval } from './connect.ts';

/**
 * The Environments page, server side (docs/design/environments-ux.md section 13): places (deploy targets seen as the page
 * sees them), removing and merging them, taking an environment out of the draft, stopping guided deploys, and the read-only
 * status of every environment. Everything here reads rows that exist; nothing runs a command except the optional key cleanup
 * of a removed server, which is a normal durable `deploy.revoke`.
 */

// ------------------------------------------------------------------------------------------------------ helpers

interface Usage {
  saved: Map<string, Array<{ env: string; label: string }>>;
  draft: Map<string, string[]>;
}

const lc = (s: string) => s.toLowerCase();

/** The environments of a stored or drafted setup, tolerant of drafts that do not validate yet. */
function rawEnvs(setup: unknown): Array<{ name: string; label: string; target: string; role?: string }> {
  const list = (setup as { environments?: unknown } | null)?.environments;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e) => {
    const x = e as { name?: unknown; label?: unknown; target?: unknown; role?: unknown };
    return typeof x.name === 'string' && typeof x.target === 'string'
      ? [
          {
            name: x.name,
            label: typeof x.label === 'string' ? x.label : x.name,
            target: x.target,
            ...(typeof x.role === 'string' ? { role: x.role } : {}),
          },
        ]
      : [];
  });
}

/** The saved environments including those of a recipe that is not from the guided setup (several targets each). */
function savedEnvUsage(recipe: Row | undefined): Array<{ name: string; label: string; targets: string[] }> {
  const guided = rawEnvs(recipe?.setup);
  if (guided.length) return guided.map((e) => ({ name: e.name, label: e.label, targets: [e.target] }));
  const parsed = (recipe?.parsed as { environments?: Array<{ name: string; targets: string[] }> } | null)
    ?.environments;
  return (parsed ?? []).map((e) => ({ name: e.name, label: e.name, targets: e.targets }));
}

async function usageOf(db: Queryable, projectId: string): Promise<Usage> {
  const recipe = await loadRecipeRow(db, projectId);
  const draft = await one(db, 'SELECT setup FROM delivery_setup_drafts WHERE project_id=$1', [projectId]);
  const saved: Usage['saved'] = new Map();
  for (const e of savedEnvUsage(recipe))
    for (const t of e.targets) saved.set(lc(t), [...(saved.get(lc(t)) ?? []), { env: e.name, label: e.label }]);
  const dr: Usage['draft'] = new Map();
  const savedKey = (name: string, target: string) =>
    (saved.get(lc(target)) ?? []).some((x) => x.env === name);
  for (const e of rawEnvs(draft?.setup))
    if (!savedKey(e.name, e.target)) dr.set(lc(e.target), [...(dr.get(lc(e.target)) ?? []), e.name]);
  return { saved, draft: dr };
}

const nameList = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

async function targetRows(db: Queryable, projectId: string): Promise<Row[]> {
  return rows(
    db,
    `SELECT t.*, w.name AS workstation_name, w.connected AS workstation_connected
       FROM deploy_targets t LEFT JOIN workstations w ON w.id = t.workstation_id
      WHERE t.project_id=$1 AND t.removed_at IS NULL ORDER BY lower(t.name), t.created_at`,
    [projectId],
  );
}

async function followupsUsing(db: Queryable, targetId: string): Promise<number> {
  const r = await one(
    db,
    `SELECT count(*)::int AS n FROM phase_followups f JOIN phases p ON p.id = f.phase_id
      WHERE f.target_id=$1 AND f.status IN ('pending','queued','briefed','running')
        AND p.status NOT IN ('done','done_with_failures','followups_rejected','discarded','cancelled')`,
    [targetId],
  );
  return r?.n ?? 0;
}

/** Why a place cannot be removed now (null: it can), naming the environments and follow-ups that use it. */
export function placeBlock(
  t: Row,
  usage: Usage,
  followups: number,
  inMove: boolean,
): { code: 'place_in_use' | 'target_in_move'; message: string } | null {
  if (inMove)
    return {
      code: 'target_in_move',
      message: `${t.name} is part of a move that is not finished: finish or cancel the move first.`,
    };
  const saved = usage.saved.get(lc(t.name)) ?? [];
  const draft = usage.draft.get(lc(t.name)) ?? [];
  const parts: string[] = [];
  if (saved.length) parts.push(`the environment ${nameList(saved.map((s) => `"${s.label}"`))}`);
  if (draft.length) parts.push(`the unfinished change to ${nameList(draft.map((d) => `"${d}"`))}`);
  if (followups > 0)
    parts.push(`${followups} unfinished phase follow-up${followups === 1 ? '' : 's'}`);
  if (parts.length === 0) return null;
  return {
    code: 'place_in_use',
    message: `${t.name} is still used by ${nameList(parts)}. Point ${saved.length + draft.length > 1 ? 'them' : 'it'} at another place first, then remove it.`,
  };
}

/** `placeBlock` for a target row, with its own lookups (the plain DELETE of a target uses it). */
export async function placeBlockFor(db: Queryable, t: Row, withFollowups = true) {
  return placeBlock(
    t,
    await usageOf(db, t.project_id),
    withFollowups ? await followupsUsing(db, t.id) : 0,
    await inOpenMove(db, t.id),
  );
}

async function inOpenMove(db: Queryable, targetId: string): Promise<boolean> {
  return !!(await one(
    db,
    `SELECT 1 AS x FROM deploy_target_moves WHERE (from_target_id=$1 OR to_target_id=$1) AND state = ANY($2::text[]) LIMIT 1`,
    [targetId, [...MOVE_OPEN_STATES]],
  ));
}

// ---------------------------------------------------------------------------------------------------------- places

export function duplicateOfPlace(t: Row, all: Row[]): PlaceDto['duplicateOf'] {
  // the OLDER one is the original; the newer is the duplicate
  for (const o of all) {
    if (o.id === t.id || o.kind !== t.kind) continue;
    const older = +o.created_at < +t.created_at || (+o.created_at === +t.created_at && o.id < t.id);
    if (!older) continue;
    if (t.kind === 'remote_ssh' && o.host && t.host && lc(o.host) === lc(t.host) && o.workstation_id === t.workstation_id)
      return { id: o.id, name: o.name, reason: 'same_server' };
    if (t.kind === 'local_docker' && o.workstation_id && o.workstation_id === t.workstation_id)
      return { id: o.id, name: o.name, reason: 'same_computer' };
  }
  return null;
}

export async function listPlaces(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<PlacesResponse> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const targets = await targetRows(ctx.pool, projectId);
  const usage = await usageOf(ctx.pool, projectId);
  const conns = await rows(ctx.pool, 'SELECT * FROM deploy_target_connections WHERE project_id=$1', [projectId]);
  const keys = await rows(
    ctx.pool,
    `SELECT target_id, count(*)::int AS n FROM deploy_target_keys WHERE project_id=$1 AND state='active' GROUP BY target_id`,
    [projectId],
  );
  const probes = await rows(
    ctx.pool,
    `SELECT target_id, max(at) AS at FROM deploy_probes WHERE project_id=$1 AND target_id IS NOT NULL GROUP BY target_id`,
    [projectId],
  );
  const places: PlaceDto[] = [];
  for (const t of targets) {
    const c = conns
      .filter((x) => x.target_id === t.id && (!t.workstation_id || x.workstation_id === t.workstation_id))
      .sort((a, b) => +b.at - +a.at)[0];
    const block = placeBlock(t, usage, await followupsUsing(ctx.pool, t.id), await inOpenMove(ctx.pool, t.id));
    places.push({
      id: t.id,
      name: t.name,
      kind: t.kind === 'remote_ssh' ? 'server' : 'computer',
      workstationId: t.workstation_id ?? null,
      workstationName: t.workstation_name ?? null,
      workstationOnline: t.workstation_id ? !!t.workstation_connected : null,
      host: t.host ?? null,
      appUrl: t.app_url ?? null,
      production: !!t.production,
      role: (t.role ?? 'active') as PlaceDto['role'],
      reachability: c
        ? { state: c.state, at: iso(c.at) as string, detail: c.detail ?? null, method: c.method }
        : null,
      lastProbeAt: iso(probes.find((x) => x.target_id === t.id)?.at ?? null),
      usedBy: usage.saved.get(lc(t.name)) ?? [],
      usedByDraft: usage.draft.get(lc(t.name)) ?? [],
      usedByFollowups: await followupsUsing(ctx.pool, t.id),
      duplicateOf: duplicateOfPlace(t, targets),
      keyCount: keys.find((k) => k.target_id === t.id)?.n ?? 0,
      canRemove: block === null,
      removeBlockedReason: block?.message ?? null,
    });
  }
  return { places, canEdit: p.my_role === 'owner' };
}

/**
 * Removes a place (a deploy target). 409 `place_in_use` names the environments; an unreachable server never blocks it. With
 * `removeKey`, the computer that holds Guildwise's key for it is asked to take the key off the server and delete its key
 * material (a durable command that outlives the place).
 */
export async function removePlace(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  placeId: string,
  req: RemovePlaceRequest,
): Promise<RemovePlaceResult> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  const t = await one(
    ctx.pool,
    'SELECT * FROM deploy_targets WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
    [placeId, projectId],
  );
  if (!t) throw notFound('place not found');
  const block = placeBlock(
    t,
    await usageOf(ctx.pool, projectId),
    await followupsUsing(ctx.pool, t.id),
    await inOpenMove(ctx.pool, t.id),
  );
  if (block) throw conflict(block.code, block.message);
  // the key cleanup is started FIRST (it carries everything it needs), then the place goes whatever happens to it
  let keyCleanup: RemovePlaceResult['keyCleanup'] = { state: 'none', commandId: null, reason: null };
  if (req.removeKey && t.kind === 'remote_ssh')
    keyCleanup = await revokeKeyOnRemoval(ctx, user, projectId, t);
  await withAppendTx(ctx.pool, async (tx) => {
    if (await targetInUse(tx, placeId))
      throw conflict('place_in_use', 'a phase follow-up that is not finished yet uses this place');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'DeployTargetRemoved', payload: { targetId: placeId } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
  return { removed: true, keyCleanup };
}

// -------------------------------------------------------------------------------------------- setup draft helpers

/** The setup the person is working on: the draft, else what is saved. */
export async function workingSetup(
  db: Queryable,
  projectId: string,
): Promise<{ setup: Record<string, any> | null; fromDraft: boolean }> {
  const draft = await one(db, 'SELECT setup FROM delivery_setup_drafts WHERE project_id=$1', [projectId]);
  if (draft?.setup) return { setup: structuredClone(draft.setup) as Record<string, any>, fromDraft: true };
  const recipe = await loadRecipeRow(db, projectId);
  const parsed = DeliverySetupSchema.safeParse(recipe?.setup ?? null);
  return {
    setup: parsed.success ? (structuredClone(parsed.data) as Record<string, any>) : null,
    fromDraft: false,
  };
}

async function saveDraft(
  ctx: Ctx,
  user: AuthSession['user'],
  p: Row,
  projectId: string,
  setup: unknown,
): Promise<void> {
  const draft = await one(ctx.pool, 'SELECT custom_scripts, proposal_id FROM delivery_setup_drafts WHERE project_id=$1', [
    projectId,
  ]);
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliverySetupDraftSaved',
        payload: {
          projectId,
          setup,
          ...(draft?.custom_scripts && Object.keys(draft.custom_scripts).length
            ? { customScripts: draft.custom_scripts }
            : {}),
          ...(draft?.proposal_id ? { proposalId: draft.proposal_id } : {}),
          by: user.id,
        },
      },
      actor: userActor(user.id),
      scope: projectScope(p.org_id, projectId),
    },
  ]);
}

/** Points an environment of the working setup at a place. */
export async function setEnvironmentPlace(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  envName: string,
  placeId: string,
): Promise<void> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  const place = await one(
    ctx.pool,
    'SELECT * FROM deploy_targets WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
    [placeId, projectId],
  );
  if (!place) throw notFound('place not found');
  const { setup } = await workingSetup(ctx.pool, projectId);
  const env = (setup?.environments as Array<Record<string, any>> | undefined)?.find((e) => e.name === envName);
  if (!setup || !env) throw notFound('that environment is not in the setup');
  const server = place.kind === 'remote_ssh';
  if ((env.hosting === 'ssh') !== server)
    throw unprocessable(
      'kind_mismatch',
      server
        ? 'this environment runs on a computer; pick a computer, or make a new environment for the server'
        : 'this environment runs on a server; pick a server',
    );
  if (place.role !== 'active')
    throw unprocessable('place_not_active', `${place.name} is not an active place (it is a standby or retired server)`);
  env.target = place.name;
  if (server) env.host = place.host;
  if (place.app_url && env.app && typeof env.app === 'object' && !env.app.appUrl) env.app.appUrl = place.app_url;
  await saveDraft(ctx, user, p, projectId, setup);
}

// ----------------------------------------------------------------------------------------------- merge two places

export async function mergePlaces(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: MergePlacesRequest,
): Promise<MergePlacesResult> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  if (req.fromId === req.toId) throw unprocessable('not_duplicates', 'pick two different places');
  const targets = await targetRows(ctx.pool, projectId);
  const from = targets.find((t) => t.id === req.fromId);
  const to = targets.find((t) => t.id === req.toId);
  if (!from || !to) throw notFound('place not found');
  const same =
    from.kind === to.kind &&
    (from.kind === 'remote_ssh'
      ? from.host && to.host && lc(from.host) === lc(to.host) && from.workstation_id === to.workstation_id
      : from.workstation_id && from.workstation_id === to.workstation_id);
  if (!same)
    throw unprocessable(
      'not_duplicates',
      'these are not the same place: only a server with the same name on the same computer, or the same computer, can be merged',
    );
  if ((await inOpenMove(ctx.pool, from.id)) || (await inOpenMove(ctx.pool, to.id)))
    throw conflict('target_in_move', 'a place that is part of a move cannot be merged');
  const { setup } = await workingSetup(ctx.pool, projectId);
  const repointed: string[] = [];
  for (const e of (setup?.environments ?? []) as Array<Record<string, any>>)
    if (lc(String(e.target)) === lc(from.name)) {
      e.target = to.name;
      if (to.host) e.host = to.host;
      repointed.push(e.name);
    }
  if (setup && repointed.length) await saveDraft(ctx, user, p, projectId, setup);
  const usage = await usageOf(ctx.pool, projectId);
  const stillUsedBySaved = (usage.saved.get(lc(from.name)) ?? []).map((x) => x.env);
  const moved = await withAppendTx(ctx.pool, async (tx) => {
    const r = await tx.query(
      `UPDATE phase_followups f SET target_id=$2, updated_at=$3 FROM phases ph
        WHERE ph.id = f.phase_id AND f.target_id=$1 AND f.status IN ('pending','queued','briefed')`,
      [from.id, to.id, ctx.clock.now()],
    );
    let removed = false;
    if (stillUsedBySaved.length === 0 && !(await targetInUse(tx, from.id))) {
      await ctx.store.append(
        [
          {
            streamId: streamId.project(projectId),
            event: { type: 'DeployTargetRemoved', payload: { targetId: from.id } },
            actor: userActor(user.id),
            scope: projectScope(p.org_id, projectId),
          },
        ],
        { tx },
      );
      removed = true;
    }
    return { n: r.rowCount ?? 0, removed };
  });
  return {
    repointed,
    followupsRepointed: moved.n,
    removed: moved.removed,
    stillUsedBySaved,
  };
}

// ------------------------------------------------------------------------------- remove environment / stop guided

export async function removeEnvironment(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  envName: string,
): Promise<RemoveEnvironmentResult> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  const { setup } = await workingSetup(ctx.pool, projectId);
  const list = (setup?.environments ?? []) as Array<Record<string, any>>;
  const env = list.find((e) => e.name === envName);
  if (!setup || !env) throw notFound('that environment is not in the setup');
  if (list.length === 1)
    throw unprocessable(
      'last_environment',
      'this is the last environment: use "Stop using guided deploys" to leave guided deploys',
    );
  const impact: string[] = [
    `Guildwise stops updating ${env.label ?? envName}. The app that runs there is left exactly as it is.`,
  ];
  setup.environments = list.filter((e) => e.name !== envName);
  for (const other of setup.environments as Array<Record<string, any>>) {
    const gate = other.gate;
    if (gate && typeof gate === 'object' && Array.isArray(gate.requires)) {
      const before = gate.requires.length;
      gate.requires = gate.requires.filter((r: Record<string, unknown>) => r.envHealthy !== envName);
      if (gate.requires.length !== before) {
        impact.push(
          `${other.label ?? other.name} was waiting for ${env.label ?? envName} to be healthy: that rule is dropped.`,
        );
        if (gate.requires.length === 0 && !gate.window && !gate.freeze) other.gate = 'none';
      }
    }
  }
  const queued = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM deploy_runs WHERE project_id=$1 AND env=$2 AND status IN ('waiting_release','queued','requested')`,
    [projectId, envName],
  );
  if ((queued?.n ?? 0) > 0)
    impact.push(`${queued?.n} release waiting for ${env.label ?? envName} will be cancelled when this is approved.`);
  await saveDraft(ctx, user, p, projectId, setup);
  return { impact, lastEnvironment: false };
}

export async function discardDraft(ctx: Ctx, user: AuthSession['user'], projectId: string): Promise<void> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliverySetupDraftSaved',
        payload: { projectId, setup: null, customScripts: {}, by: user.id },
      },
      actor: userActor(user.id),
      scope: projectScope(p.org_id, projectId),
    },
  ]);
}

/** Delivery goes back to instructions; the draft is cleared. Targets, keys and the vault files stay. */
export async function stopGuided(ctx: Ctx, user: AuthSession['user'], projectId: string): Promise<void> {
  const p = await projectOwnerOrThrow(ctx, user, projectId);
  const role = await orgRoleOf(ctx.pool, user.id, p.org_id);
  if (role !== 'owner' && role !== 'admin')
    throw forbidden('only an Owner or an Admin changes how a project delivers');
  const events = [];
  if (p.delivery_mode !== 'instructions')
    events.push({
      streamId: streamId.project(projectId),
      event: {
        type: 'DeliveryModeSet' as const,
        payload: { projectId, orgId: p.org_id, mode: 'instructions' as const, by: user.id },
      },
      actor: userActor(user.id),
      scope: projectScope(p.org_id, projectId),
    });
  events.push({
    streamId: streamId.project(projectId),
    event: {
      type: 'DeliverySetupDraftSaved' as const,
      payload: { projectId, setup: null, customScripts: {}, by: user.id },
    },
    actor: userActor(user.id),
    scope: projectScope(p.org_id, projectId),
  });
  await ctx.store.append(events as never);
}

// ------------------------------------------------------------------------------------------------- environment status

const TRIGGER_TEXT = (triggers: string[], releasedBy: string): string => {
  if (triggers.includes('after_merge')) return 'Updates by itself after each merge';
  if (triggers.includes('phase_done')) return 'Updates when a phase is finished';
  return releasedBy === 'owner' ? 'Updates when you press Release' : 'Updates when it is released';
};

interface EnvView {
  name: string;
  label: string;
  role: 'test' | 'live' | 'other';
  hosting: 'this_computer' | 'ssh';
  runtime: 'docker' | 'direct';
  target: string;
  appUrl: string | null;
  releasedBy: 'owner' | 'ceo' | 'auto';
  triggers: string[];
  gate: unknown;
  custom: boolean;
}

function viewsOf(recipe: Row | undefined, targets: Row[]): EnvView[] {
  const guided = DeliverySetupSchema.safeParse(recipe?.setup ?? null);
  if (guided.success)
    return guided.data.environments.map((e: SetupEnv) => ({
      name: e.name,
      label: e.label,
      role: e.role ?? (targets.find((t) => lc(t.name) === lc(e.target))?.production ? 'live' : e.trigger.includes('after_merge') ? 'test' : 'other'),
      hosting: e.hosting,
      runtime: e.runtime ?? 'docker',
      target: e.target,
      appUrl: e.app.appUrl ?? targets.find((t) => lc(t.name) === lc(e.target))?.app_url ?? null,
      releasedBy: e.releasedBy,
      triggers: e.trigger,
      gate: e.gate,
      custom: e.mode === 'custom',
    }));
  const parsed = (recipe?.parsed ?? null) as {
    environments?: Array<{ name: string; targets: string[]; releasedBy: 'owner' | 'ceo' | 'auto'; triggers: string[]; gate: unknown }>;
  } | null;
  return (parsed?.environments ?? []).map((e) => {
    const t = targets.find((x) => lc(x.name) === lc(e.targets[0] ?? ''));
    return {
      name: e.name,
      label: e.name,
      role: t?.production ? 'live' : e.triggers.includes('after_merge') ? 'test' : 'other',
      hosting: t?.kind === 'remote_ssh' ? 'ssh' : 'this_computer',
      runtime: 'docker',
      target: e.targets[0] ?? '',
      appUrl: t?.app_url ?? null,
      releasedBy: e.releasedBy,
      triggers: e.triggers,
      gate: e.gate,
      custom: true,
    };
  });
}

/** Questions of the open deploy proposal that still need an answer, by the environment they belong to. */
function openQuestionsByEnv(proposals: Array<ReturnType<typeof ProposalDtoSchema.parse>>): {
  total: number;
  byEnv: Map<string, number>;
} {
  const byEnv = new Map<string, number>();
  let total = 0;
  const p = proposals.find((x) => x.area === 'deploy' && x.status === 'open');
  if (!p) return { total, byEnv };
  for (const q of p.proposal.questions) {
    if (q.answer !== undefined || q.optional || q.default !== undefined) continue;
    total++;
    const m = /^\/environments\/(\d+)\//.exec(q.path);
    const name = m ? p.proposal.deploy?.environments[Number(m[1])]?.name : undefined;
    if (name) byEnv.set(name, (byEnv.get(name) ?? 0) + 1);
  }
  return { total, byEnv };
}

export async function environmentsStatus(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<EnvironmentsStatusResponse> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  return buildStatus(ctx, project);
}

export async function buildStatus(ctx: Ctx, project: Row): Promise<EnvironmentsStatusResponse> {
  const projectId = project.id as string;
  const now = ctx.clock.now();
  const recipe = await loadRecipeRow(ctx.pool, projectId);
  const targets = await targetRows(ctx.pool, projectId);
  const draftRow = await one(ctx.pool, 'SELECT * FROM delivery_setup_drafts WHERE project_id=$1', [projectId]);
  const views = viewsOf(recipe, targets);
  const draftEnvs = rawEnvs(draftRow?.setup);
  const draftByName = new Map(
    ((draftRow?.setup as { environments?: Array<Record<string, unknown>> } | null)?.environments ?? []).map((e) => [
      String(e.name),
      e,
    ]),
  );
  const savedByName = new Map(
    ((recipe?.setup as { environments?: Array<Record<string, unknown>> } | null)?.environments ?? []).map((e) => [
      String(e.name),
      e,
    ]),
  );
  const conns = await rows(ctx.pool, 'SELECT * FROM deploy_target_connections WHERE project_id=$1', [projectId]);
  const proposals = await listProposalDtos(ctx.pool, projectId, 'deploy', true);
  const q = openQuestionsByEnv(proposals);
  const runs = await rows(
    ctx.pool,
    `SELECT id, env, target_name, status, commit, deployed_commit, trigger, trial, dry_run, health, summary, waiting_for,
            released_by, finished_at, created_at, started_at, result
       FROM deploy_runs WHERE project_id=$1 AND created_at > $2 ORDER BY created_at DESC LIMIT 400`,
    [projectId, new Date(now.getTime() - 120 * 86_400_000)],
  );
  const presets = new Map<string, Gate>();
  for (const r of await rows(ctx.pool, 'SELECT name, gate FROM gate_presets WHERE org_id=$1', [project.org_id]))
    presets.set(r.name, r.gate as Gate);
  const lp = draftRow?.last_publish as { setupHash?: string } | null | undefined;
  const approvalBase: 'none' | 'unapproved' | 'approved' | 'changed' = !recipe?.present
    ? 'none'
    : !recipe.approved_hash
      ? 'unapproved'
      : recipe.status === 'approved' && recipe.observed_hash === recipe.approved_hash
        ? 'approved'
        : lp?.setupHash && lp.setupHash === recipe.observed_hash
          ? 'unapproved'
          : 'changed';
  const dryMissing: string[] =
    recipe?.observed_hash && recipe.present
      ? await guidedEnvsWithoutDryRun(ctx.pool, projectId, recipe)
      : [];
  const labelOf = (n: string) => views.find((v) => v.name === n)?.label ?? draftEnvs.find((d) => d.name === n)?.label ?? n;
  const names = [...views.map((v) => v.name), ...draftEnvs.map((d) => d.name).filter((n) => !views.some((v) => v.name === n))];
  const out: EnvironmentStatusDto[] = [];
  for (const name of names) {
    const v = views.find((x) => x.name === name);
    const d = draftEnvs.find((x) => x.name === name);
    const t = targets.find((x) => lc(x.name) === lc(v?.target ?? d?.target ?? ''));
    const envRuns = runs.filter((r) => r.env === name && !r.trial && !r.dry_run);
    const done = envRuns.filter((r) => r.status === 'succeeded');
    const cur = done[0];
    const last = envRuns.find((r) => !['requested', 'waiting_release'].includes(r.status) && r.status !== 'cancelled' && r.status !== 'refused') ?? envRuns[0];
    const waiting = envRuns.find((r) => r.status === 'waiting_release');
    const updating = envRuns.some((r) => r.status === 'queued' || r.status === 'running');
    const conn = t
      ? conns
          .filter((c) => c.target_id === t.id && (!t.workstation_id || c.workstation_id === t.workstation_id))
          .sort((a, b) => +b.at - +a.at)[0]
      : undefined;
    const cannotReach =
      !!t &&
      ((t.kind === 'remote_ssh' && !!conn && conn.state !== 'reachable') ||
        (!!t.workstation_id && !t.workstation_connected));
    const inSaved = !!v;
    const changedInDraft =
      !!d && (!inSaved || JSON.stringify(draftByName.get(name)) !== JSON.stringify(savedByName.get(name)));
    const tried = inSaved && !dryMissing.includes(name);
    // the gate in sentences
    let gateObj: Gate | 'none' | string = 'none';
    if (v) gateObj = (v.gate as Gate | 'none' | string) ?? 'none';
    const resolved = typeof gateObj === 'string' && gateObj !== 'none' ? presets.get(gateObj) ?? gateObj : gateObj;
    const rules = describeGate(resolved as Gate | 'none' | string, labelOf);
    let blockedBy: string[] = [];
    if (waiting && v) {
      const rec = (recipe?.approved_parsed ?? recipe?.parsed) as { environments?: Array<{ name: string; gate: any }> } | null;
      const renv = rec?.environments?.find((e) => e.name === name);
      if (renv) {
        const verdict = await evaluateEnvGate(ctx.pool, {
          orgId: project.org_id,
          projectId,
          env: renv as never,
          production: !!t?.production,
          commit: waiting.commit ?? null,
          now,
        });
        blockedBy = verdict.satisfied ? [] : verdict.missing;
      }
    }
    const openQ = q.byEnv.get(name) ?? 0;
    const healthOk = cur?.health ? (cur.health as { ok?: boolean }).ok : undefined;
    const health: EnvironmentStatusDto['health'] = cur
      ? healthOk === false
        ? { state: 'unhealthy', at: iso(cur.finished_at), detail: (cur.health as { detail?: string }).detail ?? null }
        : healthOk === true
          ? { state: 'healthy', at: iso(cur.finished_at), detail: null }
          : { state: 'unknown', at: iso(cur.finished_at), detail: null }
      : { state: 'unknown', at: null, detail: null };
    const failed = last && (last.status === 'failed') && (!cur || +last.created_at > +cur.created_at);
    let state: EnvCardState;
    let text: string;
    const place = t?.name ?? v?.target ?? d?.target ?? '';
    if (updating) {
      state = 'updating';
      text = 'An update is running now.';
    } else if (cannotReach) {
      state = 'cannot_reach';
      text =
        t?.kind === 'remote_ssh'
          ? `Guildwise cannot sign in to ${place} right now.`
          : `The computer that runs ${place} is offline.`;
    } else if (openQ > 0) {
      state = 'needs_answer';
      text = `DevOps asks ${openQ} question${openQ === 1 ? '' : 's'} about this.`;
    } else if (failed) {
      state = 'failed';
      const rolled = /rolled back|went back/i.test(`${last.summary ?? ''} ${JSON.stringify(last.result ?? '')}`);
      text = `The last update did not work${rolled ? ' and went back to the earlier version by itself' : ''}${last.summary ? `: ${String(last.summary).slice(0, 200)}` : '.'}`;
    } else if (inSaved && approvalBase === 'changed') {
      state = 'changed';
      text = 'The deploy files changed outside Guildwise since you approved them. Review them and approve, or go back.';
    } else if (v?.custom) {
      state = 'custom';
      text = 'This is a script that was written or edited by hand.';
    } else if (changedInDraft) {
      state = 'draft';
      text = 'You have changes that are not saved yet. Nothing has changed.';
    } else if (inSaved && !tried && approvalBase !== 'approved') {
      state = 'needs_try';
      text = 'Try it without changing anything before it is approved.';
    } else if (inSaved && approvalBase !== 'approved') {
      state = 'waiting_approval';
      text = 'Tried: it would work. Waiting for the Owner to approve it.';
    } else if (waiting && blockedBy.length) {
      state = 'blocked';
      text = `Waiting for: ${blockedBy.join('; ')}.`;
    } else if (cur && healthOk === false) {
      state = 'unhealthy';
      text = 'The site did not answer its last check.';
    } else if (cur) {
      state = 'healthy';
      text = `Version ${String(cur.deployed_commit ?? cur.commit ?? '').slice(0, 7)} is running.`;
    } else {
      state = 'not_set_up';
      text = 'Nothing has been released here yet.';
    }
    out.push({
      env: name,
      label: v?.label ?? d?.label ?? name,
      role: (v?.role ?? (d?.role as 'test' | 'live' | 'other' | undefined) ?? 'other') as 'test' | 'live' | 'other',
      hosting: v?.hosting ?? 'this_computer',
      runtime: v?.runtime ?? 'docker',
      placeId: t?.id ?? null,
      placeName: place,
      appUrl: v?.appUrl ?? null,
      releasedBy: v?.releasedBy ?? 'owner',
      updates: v ? TRIGGER_TEXT(v.triggers, v.releasedBy) : 'Not saved yet',
      rules,
      current: cur
        ? {
            runId: cur.id,
            commit: cur.deployed_commit ?? cur.commit ?? null,
            version: (cur.deployed_commit ?? cur.commit ?? '').slice(0, 7) || null,
            since: iso(cur.finished_at ?? cur.created_at) as string,
            releasedBy: (cur.released_by as { name?: string } | null)?.name ?? null,
            kind: cur.trigger === 'rollback' ? 'rollback' : 'release',
          }
        : null,
      health,
      lastRun: last
        ? {
            runId: last.id,
            status: last.status,
            at: iso(last.finished_at ?? last.created_at) as string,
            summary: last.summary ?? null,
            rolledBack: /rolled back|went back/i.test(`${last.summary ?? ''}`),
          }
        : null,
      waitingRelease: waiting
        ? { runId: waiting.id, commit: waiting.commit ?? null, waitingFor: waiting.waiting_for ?? 'owner' }
        : null,
      blockedBy,
      savedState: !inSaved ? 'none' : changedInDraft ? 'draft' : 'saved',
      triedState: !inSaved ? 'none' : tried ? 'tried' : 'needs_try',
      approvalState: !inSaved ? 'none' : approvalBase,
      openQuestions: openQ,
      state,
      stateText: text,
    });
  }
  return {
    environments: out,
    openQuestions: q.total,
    deliveryMode: project.delivery_mode === 'recipe' ? 'recipe' : 'instructions',
    generatedAt: now.toISOString(),
  };
}

// ----------------------------------------------------------------------------------------------------- org: live

export async function orgLive(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<OrgLiveResponse> {
  const ids = new Set(await visibleProjectIds(ctx.pool, user.id));
  const projects = await rows(
    ctx.pool,
    `SELECT * FROM projects WHERE org_id=$1 AND kind='project' AND status='active' ORDER BY lower(name)`,
    [orgId],
  );
  const live: LiveRowDto[] = [];
  for (const p of projects) {
    if (!ids.has(p.id)) continue;
    const recipe = await loadRecipeRow(ctx.pool, p.id);
    if (!recipe?.present) continue;
    const s = await buildStatus(ctx, p);
    const waitingCounts = await rows(
      ctx.pool,
      `SELECT env, count(DISTINCT commit)::int AS n FROM deploy_runs WHERE project_id=$1 AND status='waiting_release' GROUP BY env`,
      [p.id],
    );
    for (const e of s.environments) {
      if (e.savedState === 'none' && !e.current) continue;
      live.push({
        projectId: p.id,
        projectKey: p.key,
        projectName: p.name,
        env: e.env,
        label: e.label,
        role: e.role,
        placeName: e.placeName,
        appUrl: e.appUrl,
        commit: e.current?.commit ?? null,
        version: e.current?.version ?? null,
        since: e.current?.since ?? null,
        health: e.health.state,
        waitingReleases: waitingCounts.find((w) => w.env === e.env)?.n ?? 0,
      });
    }
  }
  return { rows: live, generatedAt: ctx.clock.now().toISOString() };
}

// ---------------------------------------------------------------------------------------------------- earlier releases

export async function earlierReleases(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  env: string,
  limit: number,
): Promise<EarlierReleasesResponse> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const role = await orgRoleOf(ctx.pool, user.id, p.org_id);
  if (role !== 'owner' && role !== 'admin') throw forbidden('only an Owner or an Admin can see earlier releases');
  const list = await rows(
    ctx.pool,
    `SELECT id, commit, deployed_commit, trigger, target_name, released_by, finished_at, result, summary
       FROM deploy_runs WHERE project_id=$1 AND env=$2 AND status='succeeded' AND NOT trial AND NOT dry_run
        AND COALESCE(deployed_commit, commit) IS NOT NULL
      ORDER BY finished_at DESC NULLS LAST LIMIT $3`,
    [projectId, env, Math.max(1, Math.min(limit, 20))],
  );
  const releases: EarlierReleaseDto[] = list.map((r, i) => {
    const text = `${r.summary ?? ''} ${(r.result as { log?: string } | null)?.log ?? ''}`;
    const backup = /backup saved: (\S+)/.exec(text)?.[1] ?? null;
    const commit = (r.deployed_commit ?? r.commit) as string;
    return {
      runId: r.id,
      commit,
      version: commit.slice(0, 7),
      at: iso(r.finished_at) as string,
      releasedBy: (r.released_by as { name?: string } | null)?.name ?? null,
      targetName: r.target_name,
      kind: r.trigger === 'rollback' ? 'rollback' : 'release',
      current: i === 0,
      backupNote: backup,
    };
  });
  return { releases, canRollback: true };
}

// ------------------------------------------------------------------------------------------------------- rollback

/** "Go back to an earlier version": an Owner or Admin picks an earlier successful release of the environment. */
export async function requestRollback(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: RollbackRequest,
): Promise<RequestDeployResult> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const role = await orgRoleOf(ctx.pool, user.id, p.org_id);
  if (role !== 'owner' && role !== 'admin') throw forbidden('only an Owner or an Admin can go back to an earlier version');
  const run = await one(
    ctx.pool,
    `SELECT id, env, target_name, commit, deployed_commit, status, trial, dry_run FROM deploy_runs WHERE id=$1 AND project_id=$2`,
    [req.runId, projectId],
  );
  const commit = (run?.deployed_commit ?? run?.commit ?? null) as string | null;
  if (!run || run.env !== req.env || run.status !== 'succeeded' || run.trial || run.dry_run || !commit)
    throw unprocessable('not_a_previous_release', 'that is not an earlier release of this environment that worked');
  const newest = await one(
    ctx.pool,
    `SELECT id FROM deploy_runs WHERE project_id=$1 AND env=$2 AND target_name=$3 AND status='succeeded' AND NOT trial AND NOT dry_run
      ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    [projectId, req.env, run.target_name],
  );
  if (newest?.id === run.id)
    throw unprocessable('not_a_previous_release', 'that is the version that is running now');
  return requestDeployRun(ctx, {
    projectId,
    env: req.env,
    commit,
    targets: req.targets ?? [run.target_name],
    trigger: 'request',
    rollback: { runId: run.id, commit },
    requester: { kind: role, id: user.id, name: user.displayName, provenance: 'session' },
  });
}
