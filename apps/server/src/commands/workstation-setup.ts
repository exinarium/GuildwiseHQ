import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  DevOpsAccessSchema,
  EnvironmentReportSchema,
  parseRemote,
  type RepoCloneResult,
  RepoCloneResultSchema,
  RightsReportSchema,
  type SetSudoPasswordRequest,
  type SudoSetResult,
  SudoSetResultSchema,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR, userActor, userScope } from './common.ts';

/**
 * What the DevOps engineer does on a workstation when a project changes (docs/RUNNER.md "Repository setup, toolchain
 * and rights"): put a repository added to a project on the project's workstations, make the toolchain ready before
 * build work, check the rights the manager ticked and keep the sudo password. The work is done by the runner (plain
 * code, commands `repo.clone`, `env.ensure`, `rights.verify`, `sudo.set`); the server queues the commands durably,
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
    `SELECT pr.id, pr.name, pr.remote_url_normalized FROM project_repos pr
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
    repos: repos.map((r) => ({ repoId: r.id, name: r.name, remoteUrlNormalized: r.remote_url_normalized })),
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
    await syncEnvironmentNotice(ctx, tx, project, workstationId, report);
  });
  ctx.services.dispatcher.trigger();
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
): Promise<void> {
  const parsed = ok ? RightsReportSchema.safeParse(result) : null;
  if (!parsed?.success) return;
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [workstationId]);
  if (!ws) return;
  await ctx.store.append([
    {
      streamId: streamId.workstation(workstationId),
      event: { type: 'DevOpsRightsVerified', payload: { workstationId, report: parsed.data } },
      actor: { kind: 'runner', id: workstationId },
      scope: userScope(ws.user_id),
    },
  ]);
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
    `SELECT id, devops_access FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!ws) throw notFound('workstation not found');
  await queueRightsVerify(ctx.pool, workstationId, ws.devops_access ?? {});
  deliver(ctx, [workstationId]);
}

// ------------------------------------------------------------------------------------------ sudo password

/** The runner's public key for the sudo password (what the browser encrypts with). */
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
  return { keyId: k.key_id as string, publicKey: k.public_key as string };
}

/**
 * Relays the sudo password to the runner. The server only ever holds the ciphertext (encrypted in the browser with the
 * runner's own public key): it travels in the durable command queue until the runner confirms (the payload is then
 * emptied), it is never an event or a log line. Only the fact that a password was set is recorded.
 */
export async function setSudoPassword(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: SetSudoPasswordRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(
      tx,
      `SELECT id, devops_access FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
      [workstationId, user.id],
    );
    if (!ws) throw notFound('workstation not found');
    const k = await one(tx, 'SELECT key_id FROM workstation_keys WHERE workstation_id=$1', [workstationId]);
    if (!k || k.key_id !== body.keyId)
      throw conflict(
        'sudo_key_changed',
        "the runner's key changed: reload the page and enter the password again",
      );
    // Only one password is ever pending: drop an earlier one that has not been delivered.
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb WHERE workstation_id=$1 AND type='sudo.set' AND status IN ('pending','sent')`,
      [workstationId],
    );
    await enqueueRunnerCommand(tx, workstationId, 'sudo.set', {
      ciphertext: body.ciphertext,
      keyId: body.keyId,
    });
  });
  deliver(ctx, [workstationId]);
}

export async function clearSudoPassword(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
      workstationId,
      user.id,
    ]);
    if (!ws) throw notFound('workstation not found');
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb WHERE workstation_id=$1 AND type='sudo.set' AND status IN ('pending','sent')`,
      [workstationId],
    );
    await enqueueRunnerCommand(tx, workstationId, 'sudo.clear', {});
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: { type: 'DevOpsSudoPasswordCleared', payload: { workstationId, by: user.id } },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
  });
  deliver(ctx, [workstationId]);
}

/** `command.result` of `sudo.set`: forget the ciphertext, record the fact, verify the rights again. */
export async function applySudoSetResult(
  ctx: Ctx,
  workstationId: string,
  commandId: string,
  ok: boolean,
  result: unknown,
  keyId: string,
): Promise<void> {
  await exec(ctx.pool, `UPDATE runner_commands SET payload='{}'::jsonb WHERE id=$1`, [commandId]);
  const parsed: SudoSetResult | null = ok ? (SudoSetResultSchema.safeParse(result).data ?? null) : null;
  if (!parsed?.stored) return;
  const ws = await one(ctx.pool, 'SELECT user_id, devops_access FROM workstations WHERE id=$1', [
    workstationId,
  ]);
  if (!ws) return;
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: {
            type: 'DevOpsSudoPasswordSet',
            payload: {
              workstationId,
              by: ws.user_id,
              keyId,
              ...(parsed.works !== undefined ? { works: parsed.works } : {}),
            },
          },
          actor: { kind: 'runner', id: workstationId },
          scope: userScope(ws.user_id),
        },
      ],
      { tx },
    );
    await queueRightsVerify(tx, workstationId, ws.devops_access ?? {});
    const waiting = await rows(
      tx,
      `SELECT project_id FROM project_environments WHERE workstation_id=$1 AND state IN ('needs_access','failed')`,
      [workstationId],
    );
    const events: AppendInput[] = [];
    for (const w of waiting)
      events.push(
        ...(await environmentRequestEvents(ctx, tx, w.project_id, workstationId, 'access_changed')),
      );
    if (events.length) await ctx.store.append(events, { tx });
  });
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
