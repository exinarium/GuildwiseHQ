import { randomUUID } from 'node:crypto';
import {
  type AddRepoRequest,
  type CreateProjectRequest,
  normalizeRemoteUrl,
  type PatchProjectRequest,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

export async function createProject(
  ctx: Ctx,
  user: AuthSession['user'],
  input: CreateProjectRequest,
): Promise<string> {
  const projectId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    if (!(await resolveWorkflow(tx, user.id, input.workflowKey))) {
      throw badRequest('unknown_workflow', `workflow '${input.workflowKey}' does not exist`);
    }
    if (await one(tx, 'SELECT 1 FROM projects WHERE org_id=$1 AND key=$2', [user.id, input.key])) {
      throw conflict('project_key_taken', `project key ${input.key} is already in use`);
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectCreated', payload: { projectId, orgId: user.id, ...input } },
          actor: userActor(user.id),
          scope: projectScope(user.id, projectId),
        },
      ],
      { tx },
    );
  });
  return projectId;
}

async function ownedProject(tx: Parameters<typeof loadVisibleProject>[0], userId: string, projectId: string) {
  const p = await loadVisibleProject(tx, userId, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
  return p;
}

export async function updateProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  changes: PatchProjectRequest,
) {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    if (changes.workflowKey && !(await resolveWorkflow(tx, p.org_id, changes.workflowKey))) {
      throw badRequest('unknown_workflow', `workflow '${changes.workflowKey}' does not exist`);
    }
    if (Object.keys(changes).length === 0) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectUpdated', payload: { projectId, changes } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

export async function addRepo(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  input: AddRepoRequest,
): Promise<string> {
  const normalized = normalizeRemoteUrl(input.remoteUrl);
  if (!normalized.includes('/'))
    throw badRequest('invalid_remote_url', 'remote URL must include a host and a path');
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    const existing = await one(
      tx,
      'SELECT id, removed_at FROM project_repos WHERE project_id=$1 AND remote_url_normalized=$2',
      [projectId, normalized],
    );
    if (existing && !existing.removed_at)
      throw conflict('repo_exists', 'this repository is already added to the project');
    const repoId = existing?.id ?? randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectRepoAdded',
            payload: {
              projectId,
              repoId,
              name: input.name,
              remoteUrl: input.remoteUrl,
              remoteUrlNormalized: normalized,
              workingBranch: input.workingBranch,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return repoId as string;
  });
}

export async function removeRepo(ctx: Ctx, user: AuthSession['user'], projectId: string, repoId: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    const r = await one(tx, 'SELECT removed_at FROM project_repos WHERE id=$1 AND project_id=$2', [
      repoId,
      projectId,
    ]);
    if (!r || r.removed_at) throw notFound('repository not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectRepoRemoved', payload: { projectId, repoId } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}
