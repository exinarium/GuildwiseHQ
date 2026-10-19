import {
  type GraphIndexPayload,
  GraphIndexResultSchema,
  type GraphScope,
  graphRepoKey,
  type ProjectGraphStatus,
  projectVaultFolder,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, rows } from '../db/sql.ts';
import { forbidden } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, runnerActor, SYSTEM_ACTOR, userActor } from './common.ts';
import { graphVaultFor, vaultAudience } from './vaults.ts';

/**
 * Project graphs, server side (docs/design/project-graphs.md sections 5 and 6): the server asks a workstation to index,
 * records the answer as STATUS (a commit, counts, a version) and nothing else. The graph is built from the customer's code
 * on the workstation and kept in the project vault; no result field of the runner may carry code-derived text (the
 * result schema has numbers, a commit id and fixed reason codes only).
 */

const RETRY_AFTER_MS = 60 * 60_000;

interface RepoRow {
  id: string;
  name: string;
  remote_url_normalized: string;
  working_branch: string | null;
}

/** Whether `projectGraphs` is on for this server. */
export const graphsEnabled = (ctx: Ctx): boolean => ctx.config.projectGraphs.enabled;

/** The workstation that should index `repoId`: it holds the clone and the vault (or is in its audience), and is online. */
async function chooseIndexWorkstation(
  db: Queryable,
  repoId: string,
  vault: {
    id: string;
    org_id: string;
    project_id: string | null;
    storage: 'git' | 'local';
    workstationId: string | null;
  },
): Promise<string | null> {
  // A local vault is a folder on one workstation: only that one can write the graph into it.
  const audience = await vaultAudience(db, vault);
  const r = await one<{ id: string }>(
    db,
    `SELECT w.id FROM workstations w
       JOIN workstation_repos wr ON wr.workstation_id = w.id AND wr.project_repo_id = $1
      WHERE w.status = 'active' AND w.user_id = ANY($2::uuid[])
        AND ($3::uuid IS NULL OR w.id = $3::uuid)
      ORDER BY w.connected DESC, w.last_seen_at DESC NULLS LAST, w.paired_at
      LIMIT 1`,
    [repoId, audience, vault.storage === 'local' ? vault.workstationId : null],
  );
  return r?.id ?? null;
}

/** Builds the command for one repository, or null when the graph cannot be placed (no vault, no workstation). */
export async function graphIndexPayload(
  db: Queryable,
  projectId: string,
  repoId: string,
): Promise<{ workstationId: string; payload: GraphIndexPayload } | null> {
  const project = await one(
    db,
    `SELECT id, org_id, key, vault_folder, vault_dir, working_branch FROM projects WHERE id=$1 AND kind='project'`,
    [projectId],
  );
  const repo = await one<RepoRow>(
    db,
    `SELECT id, name, remote_url_normalized, working_branch FROM project_repos
      WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`,
    [repoId, projectId],
  );
  if (!project || !repo) return null;
  const gv = await graphVaultFor(db, projectId);
  if (!gv) return null;
  const vault = await one(db, 'SELECT id, org_id, project_id FROM vaults WHERE id=$1', [gv.id]);
  if (!vault) return null;
  const workstationId = await chooseIndexWorkstation(db, repoId, {
    ...(vault as { id: string; org_id: string; project_id: string | null }),
    storage: gv.storage,
    workstationId: gv.workstationId,
  });
  if (!workstationId) return null;
  return {
    workstationId,
    payload: {
      projectId,
      repoId,
      repoKey: graphRepoKey(repo.remote_url_normalized),
      remoteUrlNormalized: repo.remote_url_normalized,
      repoName: repo.name,
      projectKey: project.key,
      workingBranch: repo.working_branch ?? project.working_branch ?? null,
      vault: {
        vaultId: gv.id,
        storage: gv.storage,
        kind: gv.kind,
        folder: projectVaultFolder({
          key: project.key,
          vaultFolder: project.vault_folder,
          vaultDir: project.vault_dir,
        }),
      },
    },
  };
}

/** Queues `graph.index` (or `graph.update`) for one repository unless one is already waiting. Returns whether it queued. */
export async function dispatchGraphCommand(
  ctx: Ctx,
  projectId: string,
  repoId: string,
  update?: { fromCommit: string; toCommit: string },
): Promise<boolean> {
  if (!graphsEnabled(ctx)) return false;
  const built = await graphIndexPayload(ctx.pool, projectId, repoId);
  if (!built) return false;
  const pending = await one(
    ctx.pool,
    `SELECT 1 FROM runner_commands WHERE type IN ('graph.index','graph.update') AND status IN ('pending','sent')
        AND payload->>'repoId' = $1 AND workstation_id = $2`,
    [repoId, built.workstationId],
  );
  if (pending) return true;
  await enqueueRunnerCommand(ctx.pool, built.workstationId, update ? 'graph.update' : 'graph.index', {
    ...built.payload,
    ...(update ?? {}),
  } as unknown as Record<string, unknown>);
  void Promise.resolve(ctx.services.gateway.deliverPending(built.workstationId)).catch(() => undefined);
  return true;
}

/** Records the request (an event, no content) and asks a workstation. */
export async function requestProjectGraph(
  ctx: Ctx,
  projectId: string,
  repoId: string,
  reason: 'attached' | 'manual' | 'backfill' | 'retry',
  actor: ReturnType<typeof userActor> | typeof SYSTEM_ACTOR = SYSTEM_ACTOR,
): Promise<boolean> {
  if (!graphsEnabled(ctx)) return false;
  const repo = await one<RepoRow & { org_id: string }>(
    ctx.pool,
    `SELECT pr.id, pr.name, pr.remote_url_normalized, pr.working_branch, p.org_id
       FROM project_repos pr JOIN projects p ON p.id = pr.project_id AND p.kind = 'project'
      WHERE pr.id=$1 AND pr.project_id=$2 AND pr.removed_at IS NULL`,
    [repoId, projectId],
  );
  if (!repo) return false;
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: {
        type: 'ProjectGraphRequested',
        payload: {
          projectId,
          orgId: repo.org_id,
          repoId,
          repoKey: graphRepoKey(repo.remote_url_normalized),
          reason,
        },
      },
      actor,
      scope: projectScope(repo.org_id, projectId),
    },
  ]);
  return dispatchGraphCommand(ctx, projectId, repoId);
}

/**
 * A workstation connected and its repositories were matched: asks for the graphs that are missing for the projects whose
 * clones it holds (a repository was attached, or the first index was never answered), retries failures that are an hour
 * old, and sends again a request that no command waits for. Cheap when everything is indexed.
 */
export async function seedProjectGraphs(ctx: Ctx, workstationId: string): Promise<number> {
  if (!graphsEnabled(ctx)) return 0;
  const repos = await rows<{
    project_id: string;
    repo_id: string;
    status: string | null;
    updated_at: Date | null;
  }>(
    ctx.pool,
    `SELECT pr.project_id, pr.id AS repo_id, g.status, g.updated_at
       FROM workstation_repos wr
       JOIN project_repos pr ON pr.id = wr.project_repo_id AND pr.removed_at IS NULL
       JOIN projects p ON p.id = pr.project_id AND p.kind = 'project' AND p.status = 'active'
       LEFT JOIN project_graphs g ON g.project_id = pr.project_id AND g.repo_id = pr.id
      WHERE wr.workstation_id = $1
      ORDER BY pr.project_id, pr.id`,
    [workstationId],
  );
  let n = 0;
  const now = ctx.clock.now().getTime();
  for (const r of repos) {
    if (r.status === 'indexed') continue;
    if (r.status === null) {
      if (await requestProjectGraph(ctx, r.project_id, r.repo_id, 'attached')) n++;
    } else if (r.status === 'failed') {
      if (r.updated_at && now - r.updated_at.getTime() >= RETRY_AFTER_MS) {
        if (await requestProjectGraph(ctx, r.project_id, r.repo_id, 'retry')) n++;
      }
    } else if (await dispatchGraphCommand(ctx, r.project_id, r.repo_id)) n++;
  }
  return n;
}

/** The runner answered `graph.index` / `graph.update`: the answer becomes status (an event), never content. */
export async function applyGraphResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
): Promise<void> {
  const projectId = String(payload.projectId ?? '');
  const repoId = String(payload.repoId ?? '');
  const repoKey = String(payload.repoKey ?? '');
  const vaultId = String((payload.vault as { vaultId?: string } | undefined)?.vaultId ?? '');
  const project = await one(ctx.pool, 'SELECT org_id FROM projects WHERE id=$1', [projectId]);
  if (!project) return;
  const parsed = ok ? GraphIndexResultSchema.safeParse(result) : null;
  const base = { projectId, orgId: project.org_id, repoId, repoKey };
  const scope = projectScope(project.org_id, projectId);
  const actor = runnerActor(workstationId);
  if (parsed?.success && parsed.data.ok) {
    const r = parsed.data;
    await ctx.store.append([
      {
        streamId: streamId.project(projectId),
        event: {
          type: 'ProjectGraphIndexed',
          payload: {
            ...base,
            commit: r.commit,
            files: r.files,
            nodes: r.nodes,
            edges: r.edges,
            modules: r.modules,
            indexerVersion: r.indexerVersion,
            durationMs: r.durationMs,
            workstationId,
            vaultId,
          },
        },
        actor,
        scope,
      },
    ]);
    return;
  }
  const reason = parsed?.success && !parsed.data.ok ? parsed.data.reason : 'error';
  await ctx.store.append([
    {
      streamId: streamId.project(projectId),
      event: { type: 'ProjectGraphFailed', payload: { ...base, reason, workstationId } },
      actor,
      scope,
    },
  ]);
}

/** The status the project settings show (and the CEO can read): counts and commits, nothing derived from code. */
export async function projectGraphStatus(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<ProjectGraphStatus> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  const repos = await rows(
    ctx.pool,
    `SELECT pr.id, pr.name, g.status, g.commit_id, g.files, g.nodes, g.edges, g.modules, g.indexer_version,
            g.duration_ms, g.indexed_at, g.fail_reason
       FROM project_repos pr LEFT JOIN project_graphs g ON g.project_id = pr.project_id AND g.repo_id = pr.id
      WHERE pr.project_id=$1 AND pr.removed_at IS NULL ORDER BY pr.name, pr.id`,
    [projectId],
  );
  const gv = await graphVaultFor(ctx.pool, projectId);
  return {
    enabled: graphsEnabled(ctx),
    vault: gv ? { storage: gv.storage, kind: gv.kind } : null,
    repos: repos.map((r) => ({
      repoId: r.id,
      repoName: r.name,
      status: (r.status ?? 'none') as 'none' | 'requested' | 'indexed' | 'failed',
      commit: r.commit_id ?? null,
      files: r.files ?? 0,
      nodes: r.nodes ?? 0,
      edges: r.edges ?? 0,
      modules: r.modules ?? 0,
      indexerVersion: r.indexer_version ?? null,
      durationMs: r.duration_ms ?? null,
      indexedAt: iso(r.indexed_at) ?? null,
      failReason: (r.fail_reason ?? null) as ProjectGraphStatus['repos'][number]['failReason'],
    })),
  };
}

/** "Index again" (the project's owner): records the request and asks a workstation. */
export async function reindexProjectGraph(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<{ queued: number }> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can ask for a new index');
  const repos = await rows<{ id: string }>(
    ctx.pool,
    'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY id',
    [projectId],
  );
  let queued = 0;
  for (const r of repos)
    if (await requestProjectGraph(ctx, projectId, r.id, 'manual', userActor(user.id))) queued++;
  return { queued };
}

/**
 * A project vault appeared (registered, or the local one created): the project's repositories that wait for a graph are
 * asked for now, after the vault configuration reached the workstation.
 */
export async function seedProjectGraphsOfProject(ctx: Ctx, projectId: string): Promise<void> {
  if (!graphsEnabled(ctx)) return;
  const repos = await rows<{ id: string; status: string | null }>(
    ctx.pool,
    `SELECT pr.id, g.status FROM project_repos pr
       LEFT JOIN project_graphs g ON g.project_id = pr.project_id AND g.repo_id = pr.id
      WHERE pr.project_id = $1 AND pr.removed_at IS NULL ORDER BY pr.id`,
    [projectId],
  );
  for (const r of repos) {
    if (r.status === null) await requestProjectGraph(ctx, projectId, r.id, 'attached');
    else if (r.status === 'requested') await dispatchGraphCommand(ctx, projectId, r.id);
  }
}

/**
 * Where a project's code graph is, for a shift or chat that works on it (docs/design/project-graphs.md section 7): the
 * vault and folder the runner reads it from, and the measurement arm. Undefined when graphs are off or the project has no
 * graph yet (no section and no verbs are offered, and nothing is measured).
 */
export async function graphScopeFor(
  ctx: Ctx,
  projectId: string,
  cardId?: string | null,
): Promise<GraphScope | undefined> {
  if (!graphsEnabled(ctx)) return undefined;
  const ready = await one(
    ctx.pool,
    `SELECT 1 FROM project_graphs WHERE project_id=$1 AND status='indexed' LIMIT 1`,
    [projectId],
  );
  if (!ready) return undefined;
  const gv = await graphVaultFor(ctx.pool, projectId);
  const p = await one(ctx.pool, 'SELECT key, vault_folder, vault_dir FROM projects WHERE id=$1', [projectId]);
  if (!gv || !p) return undefined;
  return {
    vaultId: gv.id,
    folder: projectVaultFolder({ key: p.key, vaultFolder: p.vault_folder, vaultDir: p.vault_dir }),
    arm: await graphArmFor(ctx, projectId, cardId ?? null),
  };
}

/** `on` or `off` for a card's shifts. Always `on` until the holdout of the measurement phase (section 11) assigns arms. */
export async function graphArmFor(
  _ctx: Ctx,
  _projectId: string,
  _cardId: string | null,
): Promise<'on' | 'off'> {
  return 'on';
}
