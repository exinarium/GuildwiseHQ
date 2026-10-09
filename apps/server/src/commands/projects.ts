import { randomUUID } from 'node:crypto';
import {
  type AddRepoRequest,
  type CreateProjectRequest,
  canCreateProject,
  isOrgManager,
  isResearchStage,
  normalizeRemoteUrl,
  type OrgRole,
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
import { assertWithinLimit } from '../orgs/limits.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { releaseEvents } from './cards.ts';
import { assertRemoteUrl, cardMessage, orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { cancelConversionEvents } from './convert.ts';
import { cancelPhasesEvents } from './phases.ts';
import {
  deliver,
  projectWorkstations,
  recheckProjectEnvironment,
  repoSetupEvents,
  retryRepoSetup,
} from './workstation-setup.ts';

/** Only the organization's Owner and Admins create projects (owner decision 4). */
export async function createProject(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  input: CreateProjectRequest,
): Promise<string> {
  if (!canCreateProject({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can create projects');
  const projectId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await assertWithinLimit(tx, org.id, 'projects');
    if (!(await resolveWorkflow(tx, org.id, input.workflowKey))) {
      throw badRequest('unknown_workflow', `workflow '${input.workflowKey}' does not exist`);
    }
    if (await one(tx, 'SELECT 1 FROM projects WHERE org_id=$1 AND key=$2', [org.id, input.key])) {
      throw conflict('project_key_taken', `project key ${input.key} is already in use`);
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectCreated',
            payload: { projectId, orgId: org.id, createdByUserId: user.id, ...input },
          },
          actor: userActor(user.id),
          scope: projectScope(org.id, projectId),
        },
      ],
      { tx },
    );
  });
  return projectId;
}

/**
 * The Owner or an Admin orders the organization's active projects (drag and drop on the Projects page). `projectIds`
 * must name every active project of the organization exactly once; a list that is out of date (a project was added,
 * archived or deleted meanwhile) is refused with 409 so the page reloads. Archived projects keep their relative order
 * below the active ones. Appends one `ProjectsRanked` (nothing when the order did not change).
 */
export async function rankProjects(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  projectIds: string[],
): Promise<void> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can rank the projects');
  await withAppendTx(ctx.pool, async (tx) => {
    // Serialize concurrent reorders of one organization: the rows are read under lock.
    const all = await rows<{ id: string; status: string; rank: number | null }>(
      tx,
      `SELECT id, status, rank FROM projects WHERE org_id=$1 AND kind='project'
        ORDER BY rank NULLS LAST, created_at, id FOR UPDATE`,
      [org.id],
    );
    const active = all.filter((p) => p.status === 'active');
    const given = new Set(projectIds);
    if (
      given.size !== projectIds.length ||
      projectIds.length !== active.length ||
      !active.every((p) => given.has(p.id))
    )
      throw conflict(
        'ranking_stale',
        'the projects changed since you loaded the page: reload it and order them again',
      );
    const order = [...projectIds, ...all.filter((p) => p.status !== 'active').map((p) => p.id)];
    if (order.every((id, i) => all[i]?.id === id)) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(org.id),
          event: {
            type: 'ProjectsRanked',
            payload: { orgId: org.id, projectIds: order, rankedBy: user.id, reason: 'manual' },
          },
          actor: userActor(user.id),
          scope: orgScope(org.id),
        },
      ],
      { tx },
    );
  });
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
    if (changes.workflowKey && changes.workflowKey !== p.workflow_key)
      throw badRequest(
        'use_convert',
        'change a project to another workflow with "Convert project" (it handles the open cards and the repositories)',
      );
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

/**
 * Sets (or clears, with null) the cap on shifts running at once on the project, whatever the number of agents. Any
 * project member may change it (docs/design/restructure.md decision 11). Off by default.
 */
export async function setConcurrencyCap(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  cap: number | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if ((p.max_concurrent_shifts ?? null) === cap) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectConcurrencyCapSet', payload: { projectId, cap, by: user.id } },
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
  let stations: string[] = [];
  const id = await withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    if (isResearchStage(p.workflow_key))
      throw conflict(
        'research_stage_no_repos',
        'This project is still in the research stage: convert it to a delivery project first, then add repositories.',
      );
    const repoId = await addRepoIn(ctx, tx, p, input, userActor(user.id));
    // The DevOps engineers put the repository on the project's workstations (clone it, or create it first).
    const repo = (await one(tx, 'SELECT * FROM project_repos WHERE id=$1', [repoId])) as Row;
    const events = await repoSetupEvents(tx, p, repo, { create: input.create, requestedBy: user.id });
    if (events.length) await ctx.store.append(events, { tx });
    stations = (await projectWorkstations(tx, projectId)).map((w) => w.id);
    return repoId;
  });
  deliver(ctx, stations);
  return id;
}

/**
 * The `ProjectRepoAdded` for a repository, after the checks every way of adding one shares (a safe URL, not already
 * on the project). A removed repository with the same remote comes back under its old id.
 */
export async function repoAddedEvent(
  ctx: Ctx,
  tx: Tx,
  project: Row,
  input: AddRepoRequest,
  actor: Parameters<typeof ctx.store.append>[0][number]['actor'],
): Promise<{ repoId: string; event: AppendInput }> {
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
  const repoId = (existing?.id ?? randomUUID()) as string;
  return {
    repoId,
    event: {
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
  };
}

/** Adds a repository to a project (the owner in settings, or an approved repository setup): one `ProjectRepoAdded`. */
export async function addRepoIn(
  ctx: Ctx,
  tx: Tx,
  project: Row,
  input: AddRepoRequest,
  actor: Parameters<typeof ctx.store.append>[0][number]['actor'],
): Promise<string> {
  const { repoId, event } = await repoAddedEvent(ctx, tx, project, input, actor);
  await ctx.store.append([event], { tx });
  return repoId;
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
export async function archiveProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  /** The interest whose backing project this is: archiving it is the interest's own command. */
  opts: { interestId?: string } = {},
): Promise<void> {
  const workstations = new Set<string>();
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId, { allowInterest: !!opts.interestId });
    if (p.status === 'archived') throw conflict('already_archived', 'this project is already archived');
    const scope = projectScope(p.org_id, projectId);
    const actor = userActor(user.id);
    const events: AppendInput[] = [
      ...(opts.interestId
        ? [
            {
              streamId: streamId.interest(opts.interestId),
              event: { type: 'InterestArchived', payload: { interestId: opts.interestId, by: user.id } },
              actor,
              scope,
            } as AppendInput,
          ]
        : []),
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
            ...(s.card_template ? { cardTemplate: s.card_template } : {}),
            ...(s.trigger ? { trigger: s.trigger } : {}),
            ...(s.action ? { action: s.action } : {}),
            ...(s.owner_user_id ? { ownerUserId: s.owner_user_id } : {}),
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
    // A conversion that waits for its repositories ends with the project.
    events.push(...(await cancelConversionEvents(tx, p, user.id, 'The project was archived.', false)));
    // Phases: pending follow-ups and BA tasks are cancelled (a running DevOps request is left to finish).
    events.push(...(await cancelPhasesEvents(tx, projectId, 'Project archived')));
    await ctx.store.append(events, { tx });
  });
  for (const ws of workstations) await ctx.services.gateway.deliverPending(ws);
}

/** Restores an archived project (any active member). Closed cards stay closed; schedules stay disabled. */
export async function restoreProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  opts: { interestId?: string } = {},
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId, { allowInterest: !!opts.interestId });
    if (p.status !== 'archived') throw conflict('not_archived', 'this project is not archived');
    if (!opts.interestId) await assertWithinLimit(tx, p.org_id, 'projects');
    await ctx.store.append(
      [
        ...(opts.interestId
          ? [
              {
                streamId: streamId.interest(opts.interestId),
                event: { type: 'InterestRestored', payload: { interestId: opts.interestId, by: user.id } },
                actor: userActor(user.id),
                scope: projectScope(p.org_id, projectId),
              } as AppendInput,
            ]
          : []),
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
 * its projector removes every row of the project. Agents belong to the organization: one that was allowed on
 * this project only is kept but benched (empty allow-list), and one org-level desk notice names it. The vault folder is never touched.
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
    // Agents allowed on this project only end up benched (empty allow-list). One org-level notice (it must not hang
    // on the project, whose desk items go with it) lists them so the manager can reassign them.
    const benched = await rows<{ name: string }>(
      tx,
      `SELECT name FROM agents WHERE allowed_project_ids = ARRAY[$1::uuid] AND status <> 'retired' ORDER BY name`,
      [projectId],
    );
    if (benched.length) {
      const deskItemId = randomUUID();
      const names = benched.map((a) => a.name);
      const many = names.length !== 1;
      events.push({
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: 'agents_benched',
            title: `${names.length} agent${many ? 's' : ''} benched: ${p.key} was deleted`,
            body: `${names.join(', ')} ${many ? 'were' : 'was'} allowed to work on ${p.name} (${p.key}) only. With the project gone the allow-list is empty, so ${many ? 'they take' : 'it takes'} no work. Open the agent's Projects dialog to reassign.`,
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(p.org_id),
      });
    }
    await ctx.store.append(events, { tx });
  });
}

/** The manager asks the DevOps engineers to try putting a repository on the project's workstations again. */
export async function retryRepoClone(ctx: Ctx, user: AuthSession['user'], projectId: string, repoId: string) {
  let stations: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await ownedProject(tx, user.id, projectId);
    stations = await retryRepoSetup(ctx, tx, p, repoId, user.id);
  });
  deliver(ctx, stations);
}

/** The manager asks to check the project's development environment again (after fixing something by hand). */
export async function recheckEnvironment(ctx: Ctx, user: AuthSession['user'], projectId: string) {
  await withAppendTx(ctx.pool, (tx) => ownedProject(tx, user.id, projectId));
  await recheckProjectEnvironment(ctx, projectId);
  deliver(
    ctx,
    (await projectWorkstations(ctx.pool, projectId)).map((w) => w.id),
  );
}
