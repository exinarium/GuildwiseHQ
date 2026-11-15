import {
  type CommitAs,
  type CommitAsResponse,
  CommitAsSchema,
  isOrgManager,
  noAppPlan,
  POST_AS_CAPABILITY,
  POST_AS_V2_CAPABILITY,
  type PostAsPlan,
  RepoIdentityFactSchema,
  streamId,
  type TrackerApp,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden } from '../errors.ts';
import { projectScope, userActor } from './common.ts';
import { loadPostAsPlan, postAsSettings, trackerAppFor } from './post-as.ts';

/**
 * "Commit as" (backlog #65): the name and e-mail every commit of a project carries. The runner resolves the identity
 * (this setting, else the clone's git config, else the workstation's global config, else it refuses) and the setting
 * travels in `shift.start`, `finalize.execute` and `repo.create`.
 */

/** The project's setting, `null` when none (or the stored value is not valid). */
export async function loadCommitAs(
  db: Queryable,
  projectId: string | null | undefined,
): Promise<CommitAs | null> {
  if (!projectId) return null;
  const r = await one<{ commit_as: unknown }>(db, 'SELECT commit_as FROM projects WHERE id=$1', [projectId]);
  const parsed = CommitAsSchema.safeParse(r?.commit_as ?? null);
  return parsed.success ? parsed.data : null;
}

/**
 * The project's identity plan: the Commit as setting and the post-as plan per repository. `postAs` is `null` when no app
 * is selected, so callers spread it only when set and the payloads stay exactly as before.
 */
export async function loadIdentityPlan(
  db: Queryable,
  projectId: string | null | undefined,
): Promise<{ commitAs: CommitAs | null; postAs: PostAsPlan | null }> {
  const commitAs = await loadCommitAs(db, projectId);
  return { commitAs, postAs: await loadPostAsPlan(db, projectId, commitAs) };
}

/** `{ commitAs }` exactly as before (null when unset) plus `postAs` only when an app is selected. */
export async function identityFields(
  db: Queryable,
  projectId: string | null | undefined,
): Promise<{ commitAs: CommitAs | null; postAs?: PostAsPlan }> {
  const { commitAs, postAs } = await loadIdentityPlan(db, projectId);
  return postAs ? { commitAs, postAs } : { commitAs };
}

/** Why a command is not sent: an older runner ignores `postAs` and would commit under the owner's identity. */
export const POST_AS_RUNNER_TOO_OLD_MESSAGE =
  'This project posts as an app, and the runner on the workstation that would do it is too old to use the app. Update the runner and try again; nothing was committed or pushed under another identity.';

async function hasCapability(
  db: Queryable,
  workstationId: string | null | undefined,
  capability: string,
): Promise<boolean> {
  if (!workstationId) return false;
  const r = await one(
    db,
    'SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY (capabilities)',
    [workstationId, capability],
  );
  return !!r;
}

/** Does the workstation's runner honour `postAs` (capability post-as:1)? */
export async function canPostAs(db: Queryable, workstationId: string | null | undefined): Promise<boolean> {
  return hasCapability(db, workstationId, POST_AS_CAPABILITY);
}

/**
 * Does the workstation's runner take an explicit plan everywhere (capability post-as:2)? Such a runner always gets
 * `postAs` (the empty plan when no app is selected) and refuses a plan-carrying command without one for an app
 * repository, so a missing plan never means "no app" there.
 */
export async function canPostAsV2(db: Queryable, workstationId: string | null | undefined): Promise<boolean> {
  return hasCapability(db, workstationId, POST_AS_V2_CAPABILITY);
}

/**
 * {@link identityFields} for a command sent to one workstation. With an app selected and a runner without post-as:1 the
 * command is refused (409 runner_too_old) instead of reaching a runner that would ignore the app (fail closed). A
 * post-as:2 runner always gets a plan (the empty one when no app is selected).
 */
export async function identityFieldsFor(
  db: Queryable,
  projectId: string | null | undefined,
  workstationId: string | null | undefined,
): Promise<{ commitAs: CommitAs | null; postAs?: PostAsPlan }> {
  const fields = await identityFields(db, projectId);
  if (await canPostAsV2(db, workstationId)) return { ...fields, postAs: fields.postAs ?? noAppPlan() };
  if (fields.postAs && !(await canPostAs(db, workstationId)))
    throw conflict('runner_too_old', POST_AS_RUNNER_TOO_OLD_MESSAGE);
  return fields;
}

/**
 * `{ postAs }` for a forge command (pull requests, reviews, fetches, branch deletes) sent to one workstation. A
 * post-as:2 runner always gets the plan (the empty plan when no app is selected). Otherwise `{}` when the project has
 * no app selected, so the payload stays exactly as before. A runner without post-as:1 would act with the owner's
 * credentials: a command that writes to the forge (`write: true`) is refused (409 runner_too_old); a read-only one is
 * sent without the plan, as today. `v2Only`: a command only post-as:2 runners honour the plan on (commit status, PR
 * notice): with an app selected, a post-as:1 runner is refused as well.
 */
export async function postAsFieldFor(
  db: Queryable,
  projectId: string | null | undefined,
  workstationId: string | null | undefined,
  opts: { write: boolean; v2Only?: boolean },
): Promise<{ postAs?: PostAsPlan }> {
  const { postAs } = await loadIdentityPlan(db, projectId);
  if (await canPostAsV2(db, workstationId)) return { postAs: postAs ?? noAppPlan() };
  if (!postAs) return {};
  if (!opts.v2Only && (await canPostAs(db, workstationId))) return { postAs };
  if (opts.write) throw conflict('runner_too_old', POST_AS_RUNNER_TOO_OLD_MESSAGE);
  return {};
}

/**
 * Adds the project's `commitAs` and `postAs` to a `shift.start` payload (additive; each absent when not set). Sent to a
 * post-as:2 runner (`workstationId`), the plan is always there: the empty plan when no app is selected.
 */
export async function withCommitAs<T extends { brief: { project: { id: string } } }>(
  ctx: Ctx,
  payload: T,
  workstationId?: string | null,
): Promise<T & { commitAs?: CommitAs; postAs?: PostAsPlan; trackerApp?: TrackerApp }> {
  const { commitAs, postAs: plan } = await loadIdentityPlan(ctx.pool, payload.brief.project.id);
  const postAs = plan ?? ((await canPostAsV2(ctx.pool, workstationId)) ? noAppPlan() : null);
  // GitHub issue reads in the shift (`aom source read`) as the project's GitHub App.
  const trackerApp = await trackerAppFor(ctx.pool, payload.brief.project.id);
  return {
    ...payload,
    ...(commitAs ? { commitAs } : {}),
    ...(postAs ? { postAs } : {}),
    ...(trackerApp ? { trackerApp } : {}),
  };
}

/** Why a DevOps request is not dispatched: its workstation holds app repositories its runner cannot honour. */
export const DEVOPS_POST_AS_RUNNER_TOO_OLD = (projects: string[]): string =>
  `${projects.join(', ')} ${projects.length === 1 ? 'posts' : 'post'} as an app, and the runner on this workstation is too old to do DevOps work as the app. Update the runner; nothing was done under another identity.`;

/** Why a DevOps request is not dispatched: more repositories than one plan holds. */
export const DEVOPS_POST_AS_TOO_MANY =
  'This workstation holds more than 200 project repositories; the DevOps plan cannot name them all, so nothing was done under another identity.';

/**
 * The post-as plan of a DevOps shift: the union of the plans of every project with a repository on the workstation (a
 * DevOps request spans them: hygiene, card conflicts, "fix my checkout"), each entry tagged with its project key. It
 * never adds `commitAs`: DevOps commits on projects without an app keep today's identity. A repository in two projects
 * keeps its app entry (fail closed). Returns `{ plan }`, or `{ refused }` when the request must not be dispatched.
 */
export async function devopsPostAs(
  db: Queryable,
  workstationId: string,
): Promise<{ plan: PostAsPlan | null } | { refused: string }> {
  const projects = await rows<{ id: string; key: string; name: string }>(
    db,
    `SELECT DISTINCT p.id, p.key, p.name FROM workstation_repos wr
       JOIN project_repos pr ON pr.id = wr.project_repo_id
       JOIN projects p ON p.id = pr.project_id
      WHERE wr.workstation_id = $1
      ORDER BY p.key`,
    [workstationId],
  );
  const byUrl = new Map<string, PostAsPlan['repos'][number]>();
  const appProjects: string[] = [];
  for (const p of projects) {
    const plan = await loadPostAsPlan(db, p.id, await loadCommitAs(db, p.id));
    if (!plan) continue;
    if (plan.repos.some((e) => e.source === 'app')) appProjects.push(p.name);
    for (const e of plan.repos) {
      const key = e.remoteUrlNormalized.toLowerCase();
      const prev = byUrl.get(key);
      if (prev?.source === 'app') continue;
      byUrl.set(key, { ...e, projectKey: p.key });
    }
  }
  const v2 = await canPostAsV2(db, workstationId);
  if (appProjects.length > 0 && !v2) return { refused: DEVOPS_POST_AS_RUNNER_TOO_OLD(appProjects) };
  if (byUrl.size > 200) return { refused: DEVOPS_POST_AS_TOO_MANY };
  if (byUrl.size === 0) return { plan: v2 ? noAppPlan() : null };
  return { plan: { repos: [...byUrl.values()] } };
}

export async function getCommitAs(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<CommitAsResponse> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const clones = await rows(
    ctx.pool,
    `SELECT pr.id AS repo_id, pr.name AS repo_name, w.id AS workstation_id, w.name AS workstation_name, wr.git_identity
       FROM workstation_repos wr
       JOIN project_repos pr ON pr.id = wr.project_repo_id AND pr.project_id = $1 AND pr.removed_at IS NULL
       JOIN workstations w ON w.id = wr.workstation_id AND w.status = 'active'
      ORDER BY pr.name, w.name`,
    [projectId],
  );
  const parsed = CommitAsSchema.safeParse(p.commit_as ?? null);
  const commitAs = parsed.success ? parsed.data : null;
  const { postAs, repos } = await postAsSettings(
    ctx.pool,
    user,
    p as Parameters<typeof postAsSettings>[2],
    commitAs,
  );
  return {
    commitAs,
    postAs,
    repos,
    clones: clones.map((c) => {
      const id = RepoIdentityFactSchema.safeParse(c.git_identity ?? null);
      return {
        repoId: c.repo_id,
        repoName: c.repo_name,
        workstationId: c.workstation_id,
        workstationName: c.workstation_name,
        identity: id.success ? id.data : null,
      };
    }),
  };
}

/** The project Owner, or an organization Owner or Admin, sets (or clears, `null`) the setting. */
export async function setCommitAs(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  commitAs: CommitAs | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    const orgAdmin = p.org_id ? isOrgManager({ orgRole: await orgRoleOf(tx, user.id, p.org_id) }) : false;
    if (p.my_role !== 'owner' && !orgAdmin)
      throw forbidden('only the project Owner or an organization Owner or Admin can do this');
    const before = CommitAsSchema.safeParse(p.commit_as ?? null);
    const same =
      (before.success
        ? before.data.name === commitAs?.name && before.data.email === commitAs?.email
        : false) ||
      (!before.success && commitAs === null);
    if (same) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectCommitAsSet', payload: { projectId, commitAs, setBy: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}
