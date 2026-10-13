import { randomUUID } from 'node:crypto';
import {
  type ForgeKind,
  type ForgeRepoList,
  type ForgeRepoListRequest,
  ForgeRepoListSchema,
  ForgeReposResultSchema,
  GitConnectionsSchema,
  JiraStatusSchema,
  normalizeProjectPath,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, userActor } from './common.ts';

/**
 * Git hosts (docs/design/cloud-workstations-and-forges.md Part 2). Credentials live on the workstation only. The
 * server learns which providers a workstation is connected to (`git.report`, facts only) and asks the workstation
 * to list the user's repositories for the picker (`forge.repos`); neither carries a secret.
 */

/** `git.report` from the runner: stored as is (validated), shown on the Workstations page and in repository settings. */
export async function applyGitReport(ctx: Ctx, workstationId: string, connections: unknown): Promise<void> {
  const parsed = GitConnectionsSchema.safeParse(connections);
  if (!parsed.success) return;
  await exec(ctx.pool, 'UPDATE workstations SET git_connections=$2, git_checked_at=$3 WHERE id=$1', [
    workstationId,
    JSON.stringify(parsed.data),
    ctx.clock.now(),
  ]);
}

/** `jira.report`: whether the runner holds Jira credentials and whether Jira accepts them (facts only, never the token). */
export async function applyJiraReport(ctx: Ctx, workstationId: string, status: unknown): Promise<void> {
  const parsed = JiraStatusSchema.safeParse(status);
  if (!parsed.success) return;
  await exec(ctx.pool, 'UPDATE workstations SET jira_status=$2, jira_checked_at=$3 WHERE id=$1', [
    workstationId,
    JSON.stringify(parsed.data),
    ctx.clock.now(),
  ]);
}

async function ownWorkstation(ctx: Ctx, userId: string, workstationId: string) {
  const w = await one(
    ctx.pool,
    `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, userId],
  );
  if (!w) throw notFound('workstation not found');
}

/** "Check again": the runner re-reads its logins and reports them. */
export async function requestGitRecheck(ctx: Ctx, user: AuthSession['user'], workstationId: string) {
  await ownWorkstation(ctx, user.id, workstationId);
  await enqueueRunnerCommand(ctx.pool, workstationId, 'git.status', {});
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
}

/** The repository picker: asks the workstation to list the user's repositories on a connected provider. */
export async function requestRepoList(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: ForgeRepoListRequest,
): Promise<ForgeRepoList> {
  await ownWorkstation(ctx, user.id, workstationId);
  const now = ctx.clock.now();
  // Short-lived read-through data: drop what is more than a day old.
  await exec(ctx.pool, `DELETE FROM forge_repo_lists WHERE created_at < $1`, [
    new Date(now.getTime() - 24 * 3_600_000),
  ]);
  const requestId = randomUUID();
  await exec(
    ctx.pool,
    `INSERT INTO forge_repo_lists (request_id, workstation_id, user_id, provider, search, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [requestId, workstationId, user.id, body.provider, body.search ?? null, now],
  );
  await enqueueRunnerCommand(ctx.pool, workstationId, 'forge.repos', {
    requestId,
    provider: body.provider,
    ...(body.search ? { search: body.search } : {}),
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
  return ForgeRepoListSchema.parse({
    requestId,
    provider: body.provider,
    state: 'pending',
    repos: [],
    error: null,
  });
}

export async function readRepoList(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  requestId: string,
): Promise<ForgeRepoList> {
  const r = await one(
    ctx.pool,
    `SELECT * FROM forge_repo_lists WHERE request_id=$1 AND workstation_id=$2 AND user_id=$3`,
    [requestId, workstationId, user.id],
  );
  if (!r) throw notFound('request not found');
  return ForgeRepoListSchema.parse({
    requestId: r.request_id,
    provider: r.provider,
    state: r.state,
    repos: r.repos,
    error: r.error ?? null,
  });
}

/** `command.result` of `forge.repos`. */
export async function applyForgeReposResult(
  ctx: Ctx,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const requestId = String(payload.requestId ?? '');
  const parsed = ForgeReposResultSchema.safeParse(result);
  const good = ok && parsed.success && parsed.data.ok;
  await exec(
    ctx.pool,
    `UPDATE forge_repo_lists SET state=$2, repos=$3, error=$4, updated_at=$5 WHERE request_id=$1`,
    [
      requestId,
      good ? 'done' : 'failed',
      JSON.stringify(good && parsed.success ? parsed.data.repos : []),
      good
        ? null
        : ((parsed.success ? parsed.data.error : undefined) ??
          error ??
          'the workstation could not list repositories'),
      ctx.clock.now(),
    ],
  );
}

/** The project owner picks (or clears, `null`) the git provider of a repository. */
export async function setRepoForge(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  forge: ForgeKind | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectRepoForgeSet', payload: { projectId, repoId, forge } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** The project owner names (or clears, `null`: the repository's default branch) the main branch of a repository. */
export async function setRepoMainBranch(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  mainBranch: string | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id, main_branch FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    if ((r.main_branch ?? null) === mainBranch) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectRepoMainBranchSet',
            payload: { projectId, repoId, mainBranch, setBy: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** The project owner sets (or clears, `null`/empty) the sub directory of a repository the project lives in. */
export async function setRepoProjectPath(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  projectPath: string | null,
): Promise<void> {
  const normalized = normalizeProjectPath(projectPath);
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id, project_path FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    if ((r.project_path ?? null) === normalized) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectRepoPathSet', payload: { projectId, repoId, projectPath: normalized } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}
