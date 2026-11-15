import {
  APP_PROVIDER_FORGE,
  type AppAccessCheckResult,
  AppAccessCheckResultSchema,
  type AppProviderId,
  appInstance,
  type CommitAs,
  detectForgeKind,
  type ForgeKind,
  isOrgManager,
  oneAppPerProviderMessage,
  POST_AS_CAPABILITY,
  type PostAsAccessState,
  type PostAsAppOption,
  type PostAsAppRef,
  PostAsAppRefSchema,
  type PostAsPlan,
  type PostAsRepoRow,
  type PostAsSettings,
  resolvePostAsRepo,
  type SelectedAppState,
  streamId,
  TRACKER_POST_AS_CAPABILITY,
  type TrackerApp,
} from '@aom/shared';
import { z } from 'zod';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, userActor } from './common.ts';
import { stateOf } from './org-apps.ts';
import { deliver } from './workstation-setup.ts';

/**
 * "Post as" (GWP-212.2): which organization app integration a project's shifts act as. The project stores references
 * only; the bot identity and the removed state are read live from org_app_integrations, and coverage of each repository
 * is a runner fact (project_app_access). Every repository is resolved by the shared resolvePostAsRepo, for the panel and
 * for every payload alike.
 */

// ------------------------------------------------------------------------------------------- registry adapter

interface AppRow {
  id: string;
  org_id: string;
  provider: string;
  label: string;
  host: string;
  app_id: string;
  installation_id: string;
  commit_name: string | null;
  commit_email: string | null;
  bot_login: string | null;
  status: string;
}

const identityOf = (a: AppRow): SelectedAppState['identity'] => ({
  integrationId: a.id,
  provider: a.provider as AppProviderId,
  label: a.label,
  botName: a.commit_name ?? `${a.bot_login ?? a.label}`,
  botEmail: a.commit_email ?? '',
  instance: appInstance(a.app_id, a.installation_id),
  host: a.host,
});

/** The selected references with their integration rows, removed ones included (an id with no row counts as removed). */
export async function selectedAppStates(
  db: Queryable,
  orgId: string | null,
  refs: readonly PostAsAppRef[],
): Promise<SelectedAppState[]> {
  if (!refs.length) return [];
  const found = orgId
    ? await rows<AppRow>(db, `SELECT * FROM org_app_integrations WHERE org_id=$1 AND id = ANY($2::uuid[])`, [
        orgId,
        refs.map((r) => r.integrationId),
      ])
    : [];
  return refs.map((ref) => {
    const a = found.find((f) => f.id === ref.integrationId);
    return a
      ? { ref, identity: identityOf(a), removed: a.status !== 'active' }
      : { ref, identity: null, removed: true };
  });
}

/**
 * The project's selected github.com GitHub App for GitHub issue traffic (approved posts, polling, issue reads), or null:
 * no project, no GitHub App selected, the app was removed, or it lives on another host (issue references are github.com
 * only). A disconnected or failing app is still returned: the runner then fails closed when it cannot get a token.
 */
export async function trackerAppFor(
  db: Queryable,
  projectId: string | null | undefined,
): Promise<TrackerApp | null> {
  if (!projectId) return null;
  const p = await one<{ post_as: unknown; org_id: string | null }>(
    db,
    'SELECT post_as, org_id FROM projects WHERE id=$1',
    [projectId],
  );
  if (!p) return null;
  const refs = storedPostAs(p.post_as).filter((r) => APP_PROVIDER_FORGE[r.provider] === 'github');
  if (!refs.length) return null;
  // One app per provider (GWP-212.2).
  const [s] = await selectedAppStates(db, p.org_id, refs.slice(0, 1));
  if (!s || s.removed || !s.identity) return null;
  if (s.identity.host.toLowerCase() !== 'github.com') return null;
  return s.identity;
}

/** Does this workstation's runner post to and read GitHub issues as the `trackerApp` it is sent? */
export async function canTrackerPostAs(
  db: Queryable,
  workstationId: string | null | undefined,
): Promise<boolean> {
  if (!workstationId) return false;
  const r = await one(
    db,
    'SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY (capabilities)',
    [workstationId, TRACKER_POST_AS_CAPABILITY],
  );
  return !!r;
}

/**
 * `integration.run` fields for a schedule's poll: `trackerApp` for a GitHub poll of a project with a GitHub App
 * selected. Throws 409 runner_too_old when the workstation's runner would ignore the app (fail closed).
 */
export async function trackerAppForPoll(
  db: Queryable,
  s: { project_id?: string | null },
  integration: string,
  workstationId: string,
): Promise<{ trackerApp?: TrackerApp }> {
  if (integration !== 'github') return {};
  const trackerApp = await trackerAppFor(db, s.project_id);
  if (!trackerApp) return {};
  if (!(await canTrackerPostAs(db, workstationId)))
    throw conflict(
      'runner_too_old',
      `Update the runner on this workstation so it can poll GitHub as the GitHub App ${trackerApp.label}.`,
    );
  return { trackerApp };
}

/** Connected = at least one active workstation holding the key reports connected. */
export async function appConnectionStates(
  db: Queryable,
  integrationIds: readonly string[],
): Promise<Map<string, 'connected' | 'error' | 'not_connected'>> {
  const out = new Map<string, 'connected' | 'error' | 'not_connected'>();
  for (const id of integrationIds) out.set(id, 'not_connected');
  if (!integrationIds.length) return out;
  const held = await rows<{ integration_id: string; status: { state?: string } | null }>(
    db,
    `SELECT w.integration_id, wi.status
       FROM org_app_integration_workstations w
       JOIN org_app_integrations i ON i.id = w.integration_id
       JOIN workstations ws ON ws.id = w.workstation_id AND ws.status = 'active'
       LEFT JOIN workstation_integrations wi
         ON wi.workstation_id = w.workstation_id AND wi.kind = i.provider AND wi.instance = i.app_id || ':' || i.installation_id
      WHERE w.integration_id = ANY($1::uuid[])`,
    [integrationIds],
  );
  for (const h of held) {
    const s = stateOf(h.status);
    if (s === 'connected') out.set(h.integration_id, 'connected');
    else if (s === 'error' && out.get(h.integration_id) !== 'connected') out.set(h.integration_id, 'error');
  }
  return out;
}

// ------------------------------------------------------------------------------------------- plan

const StoredRefsSchema = z.array(PostAsAppRefSchema);

export function storedPostAs(value: unknown): PostAsAppRef[] {
  const parsed = StoredRefsSchema.safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

interface RepoRow {
  id: string;
  name: string;
  remote_url: string;
  remote_url_normalized: string;
  forge_kind: ForgeKind | null;
}

async function projectRepos(db: Queryable, projectId: string): Promise<RepoRow[]> {
  return rows<RepoRow>(
    db,
    `SELECT id, name, remote_url, remote_url_normalized, forge_kind FROM project_repos
      WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id`,
    [projectId],
  );
}

interface AccessRow {
  repo_id: string;
  integration_id: string;
  state: PostAsAccessState;
  detail: string | null;
  checked_at: Date;
}

async function accessRows(db: Queryable, projectId: string): Promise<AccessRow[]> {
  return rows<AccessRow>(
    db,
    'SELECT repo_id, integration_id, state, detail, checked_at FROM project_app_access WHERE project_id=$1',
    [projectId],
  );
}

const accessFn =
  (rs: AccessRow[]) =>
  (integrationId: string, repoId: string): PostAsAccessState | null =>
    rs.find((r) => r.integration_id === integrationId && r.repo_id === repoId)?.state ?? null;

/** The project's plan, or `null` when no app is selected (the payloads then stay exactly as before). */
export async function loadPostAsPlan(
  db: Queryable,
  projectId: string | null | undefined,
  commitAs: CommitAs | null,
): Promise<PostAsPlan | null> {
  if (!projectId) return null;
  const p = await one<{ post_as: unknown; org_id: string | null }>(
    db,
    'SELECT post_as, org_id FROM projects WHERE id=$1',
    [projectId],
  );
  const refs = storedPostAs(p?.post_as);
  if (!refs.length) return null;
  const [selected, repos, access] = await Promise.all([
    selectedAppStates(db, p?.org_id ?? null, refs),
    projectRepos(db, projectId),
    accessRows(db, projectId),
  ]);
  return {
    repos: repos.map((r) =>
      resolvePostAsRepo({
        repo: {
          repoId: r.id,
          remoteUrlNormalized: r.remote_url_normalized,
          forge: detectForgeKind(r.remote_url, r.forge_kind),
        },
        selected,
        access: accessFn(access),
        commitAs,
      }),
    ),
  };
}

// ------------------------------------------------------------------------------------------- settings response

async function optionsFor(db: Queryable, states: SelectedAppState[]): Promise<PostAsAppOption[]> {
  const conn = await appConnectionStates(
    db,
    states.filter((s) => !s.removed).map((s) => s.ref.integrationId),
  );
  return states.map((s) => {
    const identity = s.identity ?? {
      ...s.ref,
      label: 'Removed app',
      botName: '',
      botEmail: '',
      instance: '',
      host: '',
    };
    return { ...identity, state: s.removed ? 'removed' : (conn.get(s.ref.integrationId) ?? 'not_connected') };
  });
}

/** The `postAs` and `repos` parts of the Commit as response. */
export async function postAsSettings(
  db: Queryable,
  user: AuthSession['user'],
  project: {
    id: string;
    org_id: string | null;
    post_as?: unknown;
    post_as_set_by?: string | null;
    post_as_set_at?: Date | null;
  },
  commitAs: CommitAs | null,
): Promise<{ postAs: PostAsSettings; repos: PostAsRepoRow[] }> {
  const refs = storedPostAs(project.post_as);
  const selectedStates = await selectedAppStates(db, project.org_id, refs);
  const activeRows = project.org_id
    ? await rows<AppRow>(
        db,
        `SELECT * FROM org_app_integrations WHERE org_id=$1 AND status='active' ORDER BY created_at, id`,
        [project.org_id],
      )
    : [];
  const activeStates: SelectedAppState[] = activeRows.map((a) => ({
    ref: { integrationId: a.id, provider: a.provider as AppProviderId },
    identity: identityOf(a),
    removed: false,
  }));
  const canSelect = project.org_id
    ? isOrgManager({ orgRole: await orgRoleOf(db, user.id, project.org_id) })
    : false;
  const by = project.post_as_set_by
    ? await one<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id=$1', [
        project.post_as_set_by,
      ])
    : null;
  const [repos, access] = await Promise.all([projectRepos(db, project.id), accessRows(db, project.id)]);
  return {
    postAs: {
      selected: await optionsFor(db, selectedStates),
      available: await optionsFor(db, activeStates),
      canSelect,
      lastChange:
        project.post_as_set_at && by
          ? { by: by.display_name, at: new Date(project.post_as_set_at).toISOString() }
          : null,
    },
    repos: repos.map((r) => {
      const forge = detectForgeKind(r.remote_url, r.forge_kind);
      const resolved = resolvePostAsRepo({
        repo: { repoId: r.id, remoteUrlNormalized: r.remote_url_normalized, forge },
        selected: selectedStates,
        access: accessFn(access),
        commitAs,
      });
      const appId = resolved.app?.integrationId ?? selectedStates.find((s) => !s.removed)?.ref.integrationId;
      const a = access.find((x) => x.repo_id === r.id && x.integration_id === appId);
      return {
        repoId: r.id,
        repoName: r.name,
        forge,
        resolved,
        access: a
          ? {
              state: a.state,
              ...(a.detail ? { detail: a.detail.slice(0, 400) } : {}),
              checkedAt: new Date(a.checked_at).toISOString(),
            }
          : null,
      };
    }),
  };
}

// ------------------------------------------------------------------------------------------- selection

const sameSet = (a: readonly PostAsAppRef[], b: readonly PostAsAppRef[]) =>
  a.length === b.length && a.every((x) => b.some((y) => y.integrationId === x.integrationId));

/**
 * An organization Owner or Admin ticks the apps a project posts as. A newly ticked app must be active in this org and
 * connected on at least one workstation; one app per provider. Unticking is always allowed.
 */
export async function setPostAsApps(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  apps: ReadonlyArray<{ integrationId: string }>,
): Promise<void> {
  const changed = await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    const manager = p.org_id ? isOrgManager({ orgRole: await orgRoleOf(tx, user.id, p.org_id) }) : false;
    if (!p.org_id || !manager)
      throw forbidden('only an organization Owner or Admin can choose the app a project posts as');
    const previous = storedPostAs((p as { post_as?: unknown }).post_as);
    const ids = [...new Set(apps.map((a) => a.integrationId))];
    const kept = previous.filter((r) => ids.includes(r.integrationId));
    const added = ids.filter((id) => !previous.some((r) => r.integrationId === id));
    const addedRows = added.length
      ? await rows<AppRow>(
          tx,
          `SELECT * FROM org_app_integrations WHERE org_id=$1 AND id = ANY($2::uuid[])`,
          [p.org_id, added],
        )
      : [];
    const conn = await appConnectionStates(tx, added);
    const next: PostAsAppRef[] = [...kept];
    const labels = new Map<string, string>();
    for (const s of await selectedAppStates(tx, p.org_id, kept))
      labels.set(s.ref.integrationId, s.identity?.label ?? 'the removed app');
    for (const id of added) {
      const a = addedRows.find((r) => r.id === id);
      if (!a || a.status !== 'active')
        throw badRequest('app_not_registered', 'that app is not registered in this organization');
      if (conn.get(id) !== 'connected')
        throw badRequest(
          'app_not_connected',
          `${a.label} is not connected; connect it on the Apps tab of Organization settings first`,
        );
      labels.set(id, a.label);
      next.push({ integrationId: id, provider: a.provider as AppProviderId });
    }
    for (const r of next) {
      const other = next.find((o) => o !== r && o.provider === r.provider);
      if (other) {
        const otherLabel =
          next.indexOf(other) < next.indexOf(r)
            ? labels.get(other.integrationId)
            : labels.get(r.integrationId);
        throw badRequest(
          'one_app_per_provider',
          oneAppPerProviderMessage(r.provider, otherLabel ?? 'the other app'),
        );
      }
    }
    if (sameSet(previous, next)) return false;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectPostAsAppsSet',
            payload: { projectId, apps: next, previous, setBy: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return true;
  });
  if (changed) await requestPostAsChecks(ctx, projectId);
}

/** Forbidden for anyone who is not an organization Owner or Admin. */
export async function assertCanCheckPostAs(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<void> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (!p.org_id || !isOrgManager({ orgRole: await orgRoleOf(ctx.pool, user.id, p.org_id) }))
    throw forbidden('only an organization Owner or Admin can do this');
}

// ------------------------------------------------------------------------------------------- access checks

/** Asks one connected, post-as capable workstation per selected app which project repositories it can reach. */
export async function requestPostAsChecks(ctx: Ctx, projectId: string): Promise<number> {
  const p = await one<{ post_as: unknown; org_id: string | null }>(
    ctx.pool,
    'SELECT post_as, org_id FROM projects WHERE id=$1',
    [projectId],
  );
  const states = (await selectedAppStates(ctx.pool, p?.org_id ?? null, storedPostAs(p?.post_as))).filter(
    (s) => !s.removed && s.identity,
  );
  if (!states.length) return 0;
  const repos = await projectRepos(ctx.pool, projectId);
  let sent = 0;
  for (const s of states) {
    const identity = s.identity;
    if (!identity) continue;
    const forgeRepos = repos.filter(
      (r) => detectForgeKind(r.remote_url, r.forge_kind) === APP_PROVIDER_FORGE[s.ref.provider],
    );
    if (!forgeRepos.length) continue;
    const targets = await rows<{ workstation_id: string; status: { state?: string } | null }>(
      ctx.pool,
      `SELECT w.workstation_id, wi.status
         FROM org_app_integration_workstations w
         JOIN org_app_integrations i ON i.id = w.integration_id
         JOIN workstations ws ON ws.id = w.workstation_id AND ws.status = 'active'
         JOIN workstation_capabilities wc ON wc.workstation_id = w.workstation_id AND $2 = ANY (wc.capabilities)
         LEFT JOIN workstation_integrations wi
           ON wi.workstation_id = w.workstation_id AND wi.kind = i.provider AND wi.instance = i.app_id || ':' || i.installation_id
        WHERE w.integration_id = $1`,
      [s.ref.integrationId, POST_AS_CAPABILITY],
    );
    const target = targets.find(
      (t) => stateOf(t.status) === 'connected' && ctx.services.runners.isOnline(t.workstation_id),
    );
    if (!target) continue;
    await enqueueRunnerCommand(ctx.pool, target.workstation_id, 'app.access_check', {
      projectId,
      integrationId: s.ref.integrationId,
      instance: identity.instance,
      host: identity.host,
      repos: forgeRepos.map((r) => ({ repoId: r.id, remoteUrlNormalized: r.remote_url_normalized })),
    });
    deliver(ctx, [target.workstation_id]);
    sent++;
  }
  return sent;
}

/** Stores the runner's answer; a failed command marks every repository of the payload `error`. */
export async function applyAppAccessCheckResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error?: string,
): Promise<void> {
  const projectId = String(payload.projectId ?? '');
  const integrationId = String(payload.integrationId ?? '');
  const repos = Array.isArray(payload.repos) ? (payload.repos as Array<{ repoId?: string }>) : [];
  if (!projectId || !integrationId) return;
  const parsed = ok ? AppAccessCheckResultSchema.safeParse(result) : null;
  const answer: AppAccessCheckResult = parsed?.success
    ? parsed.data
    : {
        repos: repos
          .filter((r): r is { repoId: string } => typeof r.repoId === 'string')
          .map((r) => ({
            repoId: r.repoId,
            state: 'error' as const,
            detail: (error ?? 'The check failed.').slice(0, 400),
          })),
      };
  // Only the repositories this command asked about: a runner cannot write rows for other repositories or projects.
  const asked = new Set(repos.map((r) => r.repoId).filter((id): id is string => typeof id === 'string'));
  const now = ctx.clock.now();
  for (const r of answer.repos.filter((x) => asked.has(x.repoId)))
    await exec(
      ctx.pool,
      `INSERT INTO project_app_access (project_id, repo_id, integration_id, state, code, detail, checked_at, workstation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (project_id, repo_id, integration_id)
       DO UPDATE SET state=EXCLUDED.state, code=EXCLUDED.code, detail=EXCLUDED.detail,
                     checked_at=EXCLUDED.checked_at, workstation_id=EXCLUDED.workstation_id`,
      [projectId, r.repoId, integrationId, r.state, r.code ?? null, r.detail ?? null, now, workstationId],
    );
}
