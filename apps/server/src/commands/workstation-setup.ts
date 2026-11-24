import { randomUUID } from 'node:crypto';
import {
  CommitAsSchema,
  DESK_SUBKIND,
  DevOpsAccessSchema,
  EnvironmentReportSchema,
  parseRemote,
  type RepoCloneResult,
  RepoCloneResultSchema,
  RepoInitialCommitResultSchema,
  RightsReportSchema,
  SEAL_AAD_CAPABILITY,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { postAsFieldFor } from './commit-as.ts';
import { projectScope, SYSTEM_ACTOR, userActor, userScope } from './common.ts';

/** The rights check of a runner that never connected (it announces its key when it does): it has not started yet. */
export const RUNNER_NOT_STARTED =
  'This runner has not started yet: it has never connected to the server. Start it on the machine (the installer prints why it did not), then press Verify now.';

/**
 * What the DevOps engineer does on a workstation when a project changes (docs/RUNNER.md "Repository setup, toolchain
 * and rights"): put a repository added to a project on the project's workstations, make the toolchain ready before
 * build work, check the rights the manager ticked. The work is done by the runner (plain
 * code, commands `repo.clone`, `env.ensure`, `rights.verify`); the server queues the commands durably,
 * records the state as events and gates cards on the environment.
 */

/** A preparing environment older than this is asked again (a lost command or a crashed runner). */
const PREPARE_STALE_MS = 45 * 60_000;

/** Active workstations of the active members of a project: where its repositories belong. */
export async function projectWorkstations(db: Queryable, projectId: string): Promise<Row[]> {
  return rows(
    db,
    `SELECT DISTINCT w.id, w.name, w.user_id, w.connected, w.last_seen_at, w.devops_access
       FROM workstations w
       JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id = $1 AND pm.status = 'active'
      WHERE w.status = 'active'
      ORDER BY w.connected DESC, w.last_seen_at DESC NULLS LAST, w.id`,
    [projectId],
  );
}

// ----------------------------------------------------------------------------------------- repository clone

const DEFAULT_HOSTS = ['github.com', 'gitlab.com'];

/** What the manager chose when adding the repository ("create new"), kept for the retry button. */
export interface CreateChoice {
  name: string;
  visibility: 'private' | 'public';
  description?: string | undefined;
}

/**
 * Queues `repo.clone` for each workstation of the project that has no clone of the repository yet and returns the
 * events that record it. A workstation that already holds a clone is recorded as cloned at once (nothing to do).
 * "Create new" goes to ONE workstation (a connected one, the first); the others clone after it created the repository
 * (`applyRepoCloneResult`). Idempotent: the runner answers "already cloned" for a clone it has.
 */
export async function repoSetupEvents(
  tx: Tx,
  project: Row,
  repo: Row,
  opts: { create?: CreateChoice | undefined; requestedBy?: string | undefined; only?: string[] } = {},
): Promise<AppendInput[]> {
  const events: AppendInput[] = [];
  const stations = (await projectWorkstations(tx, project.id)).filter(
    (w) => !opts.only || opts.only.includes(w.id),
  );
  const scope = projectScope(project.org_id, project.id);
  let creatorGiven = false;
  for (const w of stations) {
    const held = await one(
      tx,
      'SELECT local_path FROM workstation_repos WHERE workstation_id=$1 AND project_repo_id=$2',
      [w.id, repo.id],
    );
    const requestId = randomUUID();
    const base = { requestId, repoId: repo.id, projectId: project.id, workstationId: w.id };
    if (held) {
      events.push(
        {
          streamId: streamId.project(project.id),
          event: {
            type: 'RepoCloneRequested',
            payload: { ...base, mode: 'clone', requestedBy: opts.requestedBy },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        {
          streamId: streamId.project(project.id),
          event: {
            type: 'RepoCloneReported',
            payload: {
              ...base,
              state: 'cloned',
              detail: `Already cloned at ${held.local_path}`,
              localPath: held.local_path,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      );
      continue;
    }
    // Create-new: the repository does not exist, so only one workstation creates it; the rest wait for the result.
    const creates = !!opts.create && !creatorGiven;
    if (opts.create && creatorGiven) continue;
    if (creates) creatorGiven = true;
    const parsed = parseRemote(repo.remote_url, repo.forge_kind);
    await enqueueRunnerCommand(tx, w.id, 'repo.clone', {
      ...base,
      projectKey: project.key,
      projectName: project.name,
      name: repo.name,
      remoteUrl: repo.remote_url,
      ...(repo.working_branch ? { workingBranch: repo.working_branch } : {}),
      ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
      ...(repo.access_method ? { accessMethod: repo.access_method } : {}),
      ...(await postAsFieldFor(tx, project.id, w.id, { write: false })),
      ...(creates && opts.create
        ? {
            create: {
              ...opts.create,
              // The provider (and a self-managed host) the repository is made on, from the repository's own URL.
              ...(parsed && parsed.kind !== 'git' ? { provider: parsed.kind } : {}),
              ...(parsed &&
              (parsed.kind === 'gitlab' || parsed.kind === 'github') &&
              !DEFAULT_HOSTS.includes(parsed.host)
                ? { host: parsed.host }
                : {}),
            },
          }
        : {}),
    });
    events.push({
      streamId: streamId.project(project.id),
      event: {
        type: 'RepoCloneRequested',
        payload: {
          ...base,
          mode: creates ? 'create' : 'clone',
          requestedBy: opts.requestedBy,
          ...(creates && opts.create ? { create: opts.create } : {}),
        },
      },
      actor: opts.requestedBy ? userActor(opts.requestedBy) : SYSTEM_ACTOR,
      scope,
    });
  }
  return events;
}

/** After the transaction that queued commands: hand them to the runners that are connected now. */
export function deliver(ctx: Ctx, workstationIds: string[]): void {
  for (const id of workstationIds)
    void Promise.resolve(ctx.services.gateway.deliverPending(id)).catch((err) =>
      ctx.log.warn({ err }, 'could not deliver queued runner commands'),
    );
}

/** `command.result` of `repo.clone`. */
export async function applyRepoCloneResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = ok ? RepoCloneResultSchema.safeParse(result) : null;
  const r: RepoCloneResult = parsed?.success
    ? parsed.data
    : {
        ok: false,
        state: 'failed',
        error: error ?? 'the runner could not clone this repository (is it up to date?)',
      };
  await withAppendTx(ctx.pool, async (tx) => {
    const repo = await one(tx, 'SELECT * FROM project_repos WHERE id=$1 AND removed_at IS NULL', [
      payload.repoId,
    ]);
    const project = repo
      ? await one(tx, 'SELECT * FROM projects WHERE id=$1', [payload.projectId])
      : undefined;
    if (!repo || !project) return;
    const scope = projectScope(project.org_id, project.id);
    const events: AppendInput[] = [
      {
        streamId: streamId.project(project.id),
        event: {
          type: 'RepoCloneReported',
          payload: {
            requestId: payload.requestId,
            repoId: payload.repoId,
            projectId: payload.projectId,
            workstationId,
            state: r.ok ? r.state : r.state === 'cloning' ? 'failed' : r.state,
            detail: (r.ok ? r.detail : r.error)?.slice(0, 2000),
            ...(r.localPath ? { localPath: r.localPath } : {}),
          },
        },
        actor: { kind: 'runner', id: workstationId },
        scope,
      },
    ];
    if (r.ok) {
      events.push(...(await environmentRequestEvents(ctx, tx, project.id, workstationId, 'repo_cloned')));
      // The repository now exists (it was created): the other workstations clone it.
      if (r.state === 'created') {
        const others = (await projectWorkstations(tx, project.id)).filter((w) => w.id !== workstationId);
        events.push(...(await repoSetupEvents(tx, project, repo, { only: others.map((w) => w.id) })));
      }
    }
    await ctx.store.append(events, { tx });
  });
  ctx.services.dispatcher.trigger();
}

// ------------------------------------------------------------------------------------------- environment

/**
 * Queues `env.ensure` for a project on a workstation (the repositories it holds a clone of) and returns the event that
 * marks the environment as being prepared, which also holds back the project's build and test cards there. Nothing
 * when the workstation has no clone of the project, or the preparation is already running.
 */
export async function environmentRequestEvents(
  _ctx: Ctx,
  tx: Tx,
  projectId: string,
  workstationId: string,
  reason: 'repo_cloned' | 'repo_found' | 'manual' | 'access_changed',
): Promise<AppendInput[]> {
  const project = await one(tx, `SELECT id, org_id FROM projects WHERE id=$1 AND status='active'`, [
    projectId,
  ]);
  if (!project) return [];
  const repos = await rows(
    tx,
    `SELECT pr.id, pr.name, pr.remote_url_normalized, pr.project_path, pr.working_branch FROM project_repos pr
       JOIN workstation_repos wr ON wr.project_repo_id = pr.id AND wr.workstation_id = $2
      WHERE pr.project_id = $1 AND pr.removed_at IS NULL ORDER BY pr.name`,
    [projectId, workstationId],
  );
  if (repos.length === 0) return [];
  // Only a runner that announced its key (a version that can do this) is asked; others are never held back.
  if (!(await one(tx, 'SELECT 1 FROM workstation_keys WHERE workstation_id=$1', [workstationId]))) return [];
  const current = await one(
    tx,
    'SELECT state, updated_at FROM project_environments WHERE project_id=$1 AND workstation_id=$2',
    [projectId, workstationId],
  );
  if (
    current?.state === 'preparing' &&
    reason !== 'manual' &&
    Date.now() - new Date(current.updated_at).getTime() < PREPARE_STALE_MS
  )
    return [];
  const ws = await one(tx, 'SELECT devops_access FROM workstations WHERE id=$1', [workstationId]);
  const access = DevOpsAccessSchema.parse(ws?.devops_access ?? {});
  const requestId = randomUUID();
  await enqueueRunnerCommand(tx, workstationId, 'env.ensure', {
    requestId,
    projectId,
    repos: repos.map((r) => ({
      repoId: r.id,
      name: r.name,
      remoteUrlNormalized: r.remote_url_normalized,
      ...(r.project_path ? { projectPath: r.project_path } : {}),
      ...(r.working_branch ? { workingBranch: r.working_branch } : {}),
    })),
    access,
  });
  return [
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'EnvironmentPrepareRequested',
        payload: { requestId, projectId, workstationId, reason },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(project.org_id, projectId),
    },
  ];
}

/** `command.result` of `env.ensure`. */
export async function applyEnvEnsureResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = ok ? EnvironmentReportSchema.safeParse(result) : null;
  // A runner that cannot do the check at all (too old, crashed) says nothing about the tools: it must not hold the
  // project's cards back. Only a real finding (a tool missing, an install failing) does.
  const report = parsed?.success
    ? parsed.data
    : {
        state: 'ready' as const,
        stacks: [],
        tools: [],
        summary: `Not checked: the runner could not check the environment${error ? ` (${error})` : ''}. Update the runner and check again.`,
        logTail: [],
      };
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await one(tx, 'SELECT id, org_id FROM projects WHERE id=$1', [payload.projectId]);
    if (!project) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(project.id),
          event: {
            type: 'EnvironmentPrepared',
            payload: { requestId: payload.requestId, projectId: project.id, workstationId, report },
          },
          actor: { kind: 'runner', id: workstationId },
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
    // An empty repository is ONE plain item with its one click; the general environment notice would say it twice.
    const empty = report.emptyRepos ?? [];
    await syncEmptyRepoNotices(ctx, tx, project, workstationId, empty);
    if (empty.length === 0) await syncEnvironmentNotice(ctx, tx, project, workstationId, report);
  });
  ctx.services.dispatcher.trigger();
}

/**
 * uat-runner-fixes-3 finding 5: the desk item for a project repository with no commit (one per repository, while it is
 * open nothing is added). Its one click is "Create the first commit on <branch>" (`createInitialCommit`).
 */
export async function emptyRepoNoticeEvents(
  tx: Tx,
  project: Row,
  workstationId: string,
  repo: { repoId: string; name: string; branch: string },
  /** Set after a click that did not work: the new item says why (the old one is resolved by the caller). */
  lastError?: string,
): Promise<AppendInput[]> {
  const open = lastError
    ? null
    : await one(
        tx,
        `SELECT id FROM desk_items WHERE subkind=$1 AND status='open' AND project_id=$2 AND data->>'repoId' = $3`,
        [DESK_SUBKIND.repoEmpty, project.id, repo.repoId],
      );
  if (open) return [];
  const deskItemId = randomUUID();
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: DESK_SUBKIND.repoEmpty,
          title: `${repo.name} has no commits yet`,
          body: `${lastError ? `The first commit was not made: ${lastError.slice(0, 1000)}\n\n` : ''}The repository ${repo.name} is empty, so no card of this project can start: there is no branch to work from yet. Create the first commit on ${repo.branch} with the button below (an empty commit, pushed to the repository), or push one yourself. The cards start by themselves afterwards.`,
          options: [],
          blocking: false,
          pinned: true,
          projectId: project.id,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
          data: { projectId: project.id, repoId: repo.repoId, workstationId, branch: repo.branch },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(project.org_id, project.id),
    },
  ];
}

/** Opens the item of each empty repository, and closes the ones of this workstation whose repository is no longer empty. */
async function syncEmptyRepoNotices(
  ctx: Ctx,
  tx: Tx,
  project: Row,
  workstationId: string,
  empty: ReadonlyArray<{ repoId: string; name: string; branch: string }>,
): Promise<void> {
  const events: AppendInput[] = [];
  for (const e of empty) events.push(...(await emptyRepoNoticeEvents(tx, project, workstationId, e)));
  const stale = await rows(
    tx,
    `SELECT id FROM desk_items WHERE subkind=$1 AND status='open' AND project_id=$2
        AND data->>'workstationId' = $3 AND NOT (data->>'repoId' = ANY($4::text[]))`,
    [DESK_SUBKIND.repoEmpty, project.id, workstationId, empty.map((e) => e.repoId)],
  );
  for (const s of stale)
    events.push(resolveDeskItem(project, s.id, 'The repository has its first commit now.'));
  if (events.length) await ctx.store.append(events, { tx });
}

const resolveDeskItem = (project: Row, deskItemId: string, note: string): AppendInput => ({
  streamId: streamId.desk(deskItemId),
  event: {
    type: 'DeskItemResolved',
    payload: { deskItemId, resolution: 'acknowledged', note, by: { kind: 'system' } },
  },
  actor: SYSTEM_ACTOR,
  scope: projectScope(project.org_id, project.id),
});

/**
 * The owner's one click: the runner that reported the empty repository makes an empty first commit on the branch and
 * pushes it (`repo.initial_commit`, never forced; it refuses when the repository has a commit by then). Project owner
 * only. Returns the workstation to deliver to.
 */
export async function queueInitialCommit(
  tx: Tx,
  project: Row,
  repoId: string,
  workstationId: string,
): Promise<void> {
  const repo = await one(
    tx,
    'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
    [repoId, project.id],
  );
  if (!repo) throw notFound('repository not found');
  const item = await one(
    tx,
    `SELECT data FROM desk_items WHERE subkind=$1 AND status='open' AND project_id=$2 AND data->>'repoId' = $3
        AND data->>'workstationId' = $4`,
    [DESK_SUBKIND.repoEmpty, project.id, repoId, workstationId],
  );
  if (!item)
    throw conflict(
      'not_empty',
      'this repository is not reported empty on that workstation (check again first)',
    );
  const branch = String(repo.working_branch || item.data?.branch || 'main');
  const commitAs = CommitAsSchema.safeParse(project.commit_as ?? null);
  await enqueueRunnerCommand(tx, workstationId, 'repo.initial_commit', {
    requestId: randomUUID(),
    projectId: project.id,
    repoId,
    remoteUrlNormalized: repo.remote_url_normalized,
    branch,
    ...(commitAs.success ? { commitAs: commitAs.data } : {}),
  });
}

/** `command.result` of `repo.initial_commit`: done -> the item closes and the environment is checked again; else why. */
export async function applyInitialCommitResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = ok ? RepoInitialCommitResultSchema.safeParse(result) : null;
  const r = parsed?.success ? parsed.data : { ok: false, error: error ?? 'the runner could not do it' };
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [payload.projectId]);
    if (!project) return;
    const item = await one(
      tx,
      `SELECT id FROM desk_items WHERE subkind=$1 AND status='open' AND project_id=$2 AND data->>'repoId' = $3`,
      [DESK_SUBKIND.repoEmpty, project.id, payload.repoId],
    );
    const events: AppendInput[] = [];
    if (r.ok) {
      if (item)
        events.push(
          resolveDeskItem(project, item.id, `The first commit is on ${r.branch ?? payload.branch}.`),
        );
      events.push(...(await environmentRequestEvents(ctx, tx, project.id, workstationId, 'manual')));
    } else if (item) {
      const repo = await one(tx, 'SELECT name FROM project_repos WHERE id=$1', [payload.repoId]);
      events.push(
        resolveDeskItem(project, item.id, 'The first commit was not made (see the new item).'),
        ...(await emptyRepoNoticeEvents(
          tx,
          project,
          workstationId,
          { repoId: payload.repoId, name: repo?.name ?? 'The repository', branch: String(payload.branch) },
          String(r.error ?? 'unknown reason'),
        )),
      );
    }
    if (events.length) await ctx.store.append(events, { tx });
  });
  ctx.services.dispatcher.trigger();
  deliver(ctx, [workstationId]);
}

/**
 * D5: a desk notice while a project's environment on a workstation is `needs_access` or `failed`. One open notice per
 * project and workstation (a repeated finding only refreshes nothing, it does not add another), and it is closed again
 * once the environment is ready.
 */
export async function syncEnvironmentNotice(
  ctx: Ctx,
  tx: Tx,
  project: Row,
  workstationId: string,
  report: { state: string; summary: string },
): Promise<void> {
  const open = await one(
    tx,
    `SELECT id FROM desk_items WHERE subkind=$1 AND status='open' AND project_id=$2
        AND data->>'workstationId' = $3 FOR UPDATE`,
    [DESK_SUBKIND.environmentAttention, project.id, workstationId],
  );
  const scope = projectScope(project.org_id, project.id);
  if (report.state === 'ready') {
    if (!open) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(open.id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: open.id,
              resolution: 'acknowledged',
              note: 'The development environment is ready.',
              by: { kind: 'system' },
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ],
      { tx },
    );
    return;
  }
  if (open || (report.state !== 'needs_access' && report.state !== 'failed')) return;
  const ws = await one(tx, 'SELECT name FROM workstations WHERE id=$1', [workstationId]);
  const deskItemId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: DESK_SUBKIND.environmentAttention,
            title:
              report.state === 'needs_access'
                ? `The development environment needs your help on ${ws?.name ?? 'a workstation'}`
                : `The development environment could not be prepared on ${ws?.name ?? 'a workstation'}`,
            body: `${report.summary}\n\nCards of this project wait on that workstation until it is ready. Open the project's Development environment, follow the steps, then press Check again.`,
            options: [],
            blocking: false,
            pinned: false,
            projectId: project.id,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
            data: { projectId: project.id, workstationId, state: report.state },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ],
    { tx },
  );
}

/** The manager asks to check a project's environment again (or the access changed). */
export async function recheckProjectEnvironment(
  ctx: Ctx,
  projectId: string,
  workstationId?: string,
): Promise<number> {
  let n = 0;
  await withAppendTx(ctx.pool, async (tx) => {
    const stations = (await projectWorkstations(tx, projectId)).filter(
      (w) => !workstationId || w.id === workstationId,
    );
    const events: AppendInput[] = [];
    for (const w of stations)
      events.push(...(await environmentRequestEvents(ctx, tx, projectId, w.id, 'manual')));
    n = events.length;
    if (events.length) await ctx.store.append(events, { tx });
  });
  return n;
}

// ------------------------------------------------------------------------------------------------- rights

/** Queues `rights.verify` with the access as it is now. */
export async function queueRightsVerify(
  db: Queryable,
  workstationId: string,
  access: unknown,
): Promise<void> {
  // Only a runner that announced its key can check rights (older ones would answer with an error).
  if (!(await one(db, 'SELECT 1 FROM workstation_keys WHERE workstation_id=$1', [workstationId]))) return;
  await enqueueRunnerCommand(db, workstationId, 'rights.verify', {
    access: DevOpsAccessSchema.parse(access),
  });
}

/** `command.result` of `rights.verify`. */
export async function applyRightsResult(
  ctx: Ctx,
  workstationId: string,
  ok: boolean,
  result: unknown,
  error?: string,
): Promise<string | null> {
  if (!ok) return error || 'The runner could not check the rights.';
  const parsed = RightsReportSchema.safeParse(result);
  if (!parsed.success) return 'The runner sent a rights report this server does not understand.';
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  if (!ws) return null;
  await ctx.store.append([
    {
      streamId: streamId.workstation(workstationId),
      event: { type: 'DevOpsRightsVerified', payload: { workstationId, report: parsed.data } },
      actor: { kind: 'runner', id: workstationId },
      scope: userScope(ws.user_id),
    },
  ]);
  return null;
}

/** After the access changed (inside its transaction): verify the new ticks and retry environments waiting for access. */
export async function afterAccessChangedIn(
  ctx: Ctx,
  tx: Tx,
  workstationId: string,
  access: unknown,
): Promise<void> {
  await queueRightsVerify(tx, workstationId, access);
  const waiting = await rows(
    tx,
    `SELECT project_id FROM project_environments WHERE workstation_id=$1 AND state IN ('needs_access','failed')`,
    [workstationId],
  );
  const events: AppendInput[] = [];
  for (const w of waiting)
    events.push(...(await environmentRequestEvents(ctx, tx, w.project_id, workstationId, 'access_changed')));
  if (events.length) await ctx.store.append(events, { tx });
}

/** `POST /api/workstations/:id/verify-rights`. */
export async function verifyRightsNow(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<void> {
  const ws = await one(
    ctx.pool,
    `SELECT id, devops_access, last_seen_at FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!ws) throw notFound('workstation not found');
  // A runner that never announced its key is older than the rights check, or has never connected (it announces the key
  // when it does): say so instead of queueing into the void.
  if (!(await one(ctx.pool, 'SELECT 1 FROM workstation_keys WHERE workstation_id=$1', [workstationId])))
    throw ws.last_seen_at
      ? conflict(
          'runner_outdated',
          'This workstation runner is too old to check rights. Update the runner on the machine, then try again.',
        )
      : conflict('runner_not_started', RUNNER_NOT_STARTED);
  // An earlier check that never got an answer is replaced by this one.
  await exec(
    ctx.pool,
    `UPDATE runner_commands SET status='failed', last_error='replaced by a newer check'
      WHERE workstation_id=$1 AND type='rights.verify' AND status IN ('pending','sent')`,
    [workstationId],
  );
  await queueRightsVerify(ctx.pool, workstationId, ws.devops_access ?? {});
  deliver(ctx, [workstationId]);
}

// ------------------------------------------------------------------------------------------ sealing key

/**
 * The runner's public key (still named the sudo key): the browser seals provider and target secrets with it. The sudo
 * password it once sealed was removed in 1.10.0.
 */
export async function sudoKeyOf(ctx: Ctx, user: AuthSession['user'], workstationId: string) {
  const ws = await one(
    ctx.pool,
    `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!ws) throw notFound('workstation not found');
  const k = await one(ctx.pool, 'SELECT key_id, public_key FROM workstation_keys WHERE workstation_id=$1', [
    workstationId,
  ]);
  if (!k)
    throw conflict(
      'no_sudo_key',
      'this runner has not announced a key yet: connect it (a runner of this version or newer) and try again',
    );
  const caps = await one(
    ctx.pool,
    'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId],
  );
  return {
    keyId: k.key_id as string,
    publicKey: k.public_key as string,
    ...((caps?.capabilities ?? []).includes(SEAL_AAD_CAPABILITY) ? { sealAad: true } : {}),
  };
}

/**
 * The manager retries a clone that failed (or asks again): the same choices as when the repository was added, to the
 * workstations that do not hold a clone. "Create new" is retried on one workstation.
 */
export async function retryRepoSetup(
  ctx: Ctx,
  tx: Tx,
  project: Row,
  repoId: string,
  userId: string,
): Promise<string[]> {
  const repo = await one(
    tx,
    'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
    [repoId, project.id],
  );
  if (!repo) throw notFound('repository not found');
  const failedCreate = await one(
    tx,
    `SELECT create_spec FROM repo_clones WHERE project_repo_id=$1 AND create_spec IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`,
    [repoId],
  );
  const events = await repoSetupEvents(tx, project, repo, {
    create: failedCreate?.create_spec ?? undefined,
    requestedBy: userId,
  });
  if (events.length) await ctx.store.append(events, { tx });
  return (await projectWorkstations(tx, project.id)).map((w) => w.id);
}
