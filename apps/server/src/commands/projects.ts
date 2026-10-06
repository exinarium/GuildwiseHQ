import { randomUUID } from 'node:crypto';
import {
  type AddRepoRequest,
  type CreateProjectRequest,
  normalizeRemoteUrl,
  type PatchProjectRequest,
  type ProjectImpact,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { releaseEvents } from './cards.ts';
import { assertRemoteUrl, cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { cancelPhasesEvents } from './phases.ts';

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

/**
 * "Merge large changes without my approval" (owner only; additional managers cannot): recorded as an event with who
 * and when. It does not touch approvals already waiting on the desk (they show a hint and can still be approved).
 */
export async function setMergePolicy(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  mergeLargeWithoutApproval: boolean,
) {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    if (Boolean(p.merge_large_without_approval) === mergeLargeWithoutApproval) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectMergePolicyChanged',
            payload: { projectId, mergeLargeWithoutApproval, changedBy: user.id },
          },
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
  assertRemoteUrl(ctx, input.remoteUrl);
  const normalized = normalizeRemoteUrl(input.remoteUrl);
  if (!normalized.includes('/'))
    throw badRequest('invalid_remote_url', 'remote URL must include a host and a path');
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    return addRepoIn(ctx, tx, p, input, userActor(user.id));
  });
}

/** Adds a repository to a project (the owner in settings, or an approved repository setup): one `ProjectRepoAdded`. */
export async function addRepoIn(
  ctx: Ctx,
  tx: Tx,
  project: Row,
  input: AddRepoRequest,
  actor: Parameters<typeof ctx.store.append>[0][number]['actor'],
): Promise<string> {
  assertRemoteUrl(ctx, input.remoteUrl);
  const normalized = normalizeRemoteUrl(input.remoteUrl);
  if (!normalized.includes('/'))
    throw badRequest('invalid_remote_url', 'remote URL must include a host and a path');
  const existing = await one(
    tx,
    'SELECT id, removed_at FROM project_repos WHERE project_id=$1 AND remote_url_normalized=$2',
    [project.id, normalized],
  );
  if (existing && !existing.removed_at)
    throw conflict('repo_exists', 'this repository is already added to the project');
  const repoId = existing?.id ?? randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.project(project.id),
        event: {
          type: 'ProjectRepoAdded',
          payload: {
            projectId: project.id,
            repoId,
            name: input.name,
            remoteUrl: input.remoteUrl,
            remoteUrlNormalized: normalized,
            workingBranch: input.workingBranch,
          },
        },
        actor,
        scope: projectScope(project.org_id, project.id),
      },
    ],
    { tx },
  );
  return repoId as string;
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

// --------------------------------------------------------------------------- archive, restore, delete

/** What archiving stops: shown in the confirmation dialog (any member may ask). */
export async function projectImpact(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<ProjectImpact> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  const n = async (sql: string) => Number((await one(ctx.pool, sql, [projectId]))?.n ?? 0);
  return {
    activeShifts: await n(
      `SELECT count(*) AS n FROM shifts s JOIN cards c ON c.id = s.card_id
        WHERE c.project_id=$1 AND s.status <> 'ended'`,
    ),
    openCards: await n(
      `SELECT count(*) AS n FROM cards WHERE project_id=$1 AND status NOT IN ('done','cancelled')`,
    ),
    schedules: await n(`SELECT count(*) AS n FROM schedules WHERE project_id=$1 AND enabled`),
    openDeskItems: await n(`SELECT count(*) AS n FROM desk_items WHERE project_id=$1 AND status='open'`),
  };
}

/**
 * Archives a project (any active member). One append: `ProjectArchived`, then for each open card a claim release (the
 * runner gateway stops the shift on it) and `CardCancelled{cause:'project_archived'}`, `ScheduleUpdated{enabled:false}`
 * for each enabled schedule and `DeskItemResolved{dismissed}` for each open desk item. The cards' worktrees are removed
 * with `worktree.remove` (the branches are kept). Agents are not touched: the dispatcher simply finds no work for them.
 */
export async function archiveProject(ctx: Ctx, user: AuthSession['user'], projectId: string): Promise<void> {
  const workstations = new Set<string>();
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.status === 'archived') throw conflict('already_archived', 'this project is already archived');
    const scope = projectScope(p.org_id, projectId);
    const actor = userActor(user.id);
    const events: AppendInput[] = [
      {
        streamId: streamId.project(projectId),
        event: { type: 'ProjectArchived', payload: { projectId, archivedBy: user.id } },
        actor,
        scope,
      },
    ];
    const cards = await rows(
      tx,
      `SELECT * FROM cards WHERE project_id=$1 AND status NOT IN ('done','cancelled') ORDER BY number FOR UPDATE`,
      [projectId],
    );
    const removed = new Set<string>();
    for (const card of cards) {
      events.push(
        ...releaseEvents(card, user.id, 'manual'),
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardCancelled',
            payload: { cardId: card.id, reason: 'Project archived', cause: 'project_archived' },
          },
          actor,
          scope,
        },
        cardMessage(card, { kind: 'system' }, 'system', `Closed: ${user.displayName} archived the project.`),
      );
      if (card.worktree_path && card.home_workstation_id) {
        const key = `${card.home_workstation_id}:${card.worktree_path}`;
        if (!removed.has(key)) {
          removed.add(key);
          workstations.add(card.home_workstation_id);
          await enqueueRunnerCommand(tx, card.home_workstation_id, 'worktree.remove', {
            repoId: card.repo_id ?? undefined,
            path: card.worktree_path,
            branchName: card.branch_name ?? undefined,
            deleteBranch: false,
          });
        }
      }
    }
    for (const s of await rows(tx, 'SELECT * FROM schedules WHERE project_id=$1 AND enabled FOR UPDATE', [
      projectId,
    ])) {
      events.push({
        streamId: streamId.schedule(s.id),
        event: {
          type: 'ScheduleUpdated',
          payload: {
            scheduleId: s.id,
            projectId,
            name: s.name,
            kind: s.kind,
            cron: s.cron,
            timezone: s.timezone,
            cardTemplate: s.card_template,
            enabled: false,
            nextFireAt: null,
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      });
    }
    for (const d of await rows(tx, `SELECT id FROM desk_items WHERE project_id=$1 AND status='open'`, [
      projectId,
    ])) {
      events.push({
        streamId: streamId.desk(d.id),
        event: {
          type: 'DeskItemResolved',
          payload: {
            deskItemId: d.id,
            resolution: 'dismissed',
            note: 'The project was archived.',
            by: { kind: 'user', userId: user.id },
          },
        },
        actor,
        scope,
      });
    }
    // Phases: pending follow-ups and BA tasks are cancelled (a running DevOps request is left to finish).
    events.push(...(await cancelPhasesEvents(tx, projectId, 'Project archived')));
    await ctx.store.append(events, { tx });
  });
  for (const ws of workstations) await ctx.services.gateway.deliverPending(ws);
}

/** Restores an archived project (any active member). Closed cards stay closed; schedules stay disabled. */
export async function restoreProject(ctx: Ctx, user: AuthSession['user'], projectId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.status !== 'archived') throw conflict('not_archived', 'this project is not archived');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectRestored', payload: { projectId, restoredBy: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/**
 * Deletes an archived project permanently (owner only; the caller types the project key). Appends `ProjectDeleted`;
 * its projector removes every row of the project. Agents belong to the organization: one that was scoped to the
 * project is kept and becomes org-wide (owner decision, 2026-10-06). The vault folder is never touched.
 */
export async function deleteProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  confirmKey: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    if (p.status !== 'archived')
      throw conflict('not_archived', 'archive the project first: only an archived project can be deleted');
    if (confirmKey !== p.key) throw badRequest('key_mismatch', 'type the project key to confirm');
    const scope = projectScope(p.org_id, projectId);
    const events: AppendInput[] = [];
    events.push({
      streamId: streamId.project(projectId),
      event: {
        type: 'ProjectDeleted',
        payload: { projectId, key: p.key, name: p.name, deletedBy: user.id },
      },
      actor: userActor(user.id),
      scope,
    });
    await ctx.store.append(events, { tx });
  });
}
