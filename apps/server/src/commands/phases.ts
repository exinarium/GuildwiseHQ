import { randomUUID } from 'node:crypto';
import {
  type AssignCardPhaseRequest,
  BranchCheckMergedResultSchema,
  type CreatePhaseRequest,
  type DeskActor,
  FollowupListSchema,
  type FollowupSpec,
  type FollowupSpecWithId,
  GitRefSchema,
  isPhaseFinal,
  type PatchPhaseRequest,
  PHASE_ASSIGNABLE_STATUSES,
  PHASE_DESK_SUBKIND,
  PHASE_FOLLOWUP_EDITABLE_STATUSES,
  parsePhaseRef,
  phaseRef,
  streamId,
  workflowHasTestStage,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { mockFieldsAllowed } from './cards.ts';
import { cardMessage, projectScope, userActor } from './common.ts';
import { liveTarget } from './deploy-targets.ts';
import type { Responder, RpcReply } from './intake.ts';
import {
  actorOf,
  agentBy,
  baTaskCompleted,
  createItemEvent,
  followupRows,
  labelsFor,
  memberRows,
  openItem,
  phaseMessage,
  phaseReportEvents,
  phaseScope,
  queueBaTask,
  resolveItemEvent,
  rowToSpec,
  systemBy,
  userBy,
} from './phase-events.ts';

// ------------------------------------------------------------------------------------- validation

/**
 * Checks a follow-up list against the project (live targets, mock scripts only with AOM_MOCK_UI) and gives every
 * follow-up its id (a given id is kept, so editing the list does not lose track of items).
 */
export async function normalizeFollowups(
  ctx: Ctx,
  db: Queryable,
  projectId: string,
  list: FollowupSpec[],
): Promise<FollowupSpecWithId[]> {
  const seen = new Set<string>();
  const out: FollowupSpecWithId[] = [];
  const can = await followupCapabilities(db, projectId);
  for (const f of list) {
    const id = f.id && !seen.has(f.id) ? f.id : randomUUID();
    seen.add(id);
    if ((f.kind === 'deploy' && !can.deploy) || (f.kind === 'regression' && !can.regression))
      throw badRequest(
        'followup_needs_repos',
        f.kind === 'deploy'
          ? 'a deploy follow-up needs a repository: this project has none (convert it to a delivery project first)'
          : 'a regression follow-up needs a repository and a workflow with a test stage: this project has neither',
      );
    if (f.kind === 'deploy' || (f.kind === 'regression' && f.targetId))
      await liveTarget(db, projectId, f.targetId as string);
    if (f.kind === 'regression' && f.mock && !(await mockFieldsAllowed(ctx, db, projectId)))
      throw unprocessable(
        'mock_fields_disabled',
        'a mock script on a follow-up is only available when the server runs with AOM_MOCK_UI=true or in a simulation organization',
      );
    out.push({ ...f, id } as FollowupSpecWithId);
  }
  return out;
}

/**
 * Which follow-ups the project can run at all: a deploy needs a repository, a regression run a repository and a workflow
 * with a test stage (a research-stage project has neither, docs/design/restructure.md section 9).
 */
export async function followupCapabilities(
  db: Queryable,
  projectId: string,
): Promise<{ deploy: boolean; regression: boolean }> {
  const p = await one(db, 'SELECT org_id, workflow_key FROM projects WHERE id=$1', [projectId]);
  if (!p) return { deploy: false, regression: false };
  const repos = Number(
    (
      await one(db, 'SELECT count(*) AS n FROM project_repos WHERE project_id=$1 AND removed_at IS NULL', [
        projectId,
      ])
    )?.n ?? 0,
  );
  const wf = await resolveWorkflow(db, p.org_id, p.workflow_key);
  return { deploy: repos > 0, regression: repos > 0 && !!wf && workflowHasTestStage(wf.definition) };
}

/** Stored default follow-ups of a project as specs (ids minted per use). */
export function defaultFollowups(project: Row): FollowupSpec[] {
  const parsed = FollowupListSchema.safeParse(project.default_followups ?? []);
  return parsed.success ? parsed.data.map(({ id: _id, ...rest }) => rest as FollowupSpec) : [];
}

const nameTaken = (db: Queryable, projectId: string, name: string, exceptId?: string) =>
  one(
    db,
    `SELECT 1 FROM phases WHERE project_id=$1 AND lower(name)=lower($2) AND status NOT IN ('discarded','cancelled')
        AND ($3::uuid IS NULL OR id <> $3)`,
    [projectId, name, exceptId ?? null],
  );

async function lockPhase(tx: Tx, userId: string, phaseId: string): Promise<{ phase: Row; project: Row }> {
  const phase = await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [phaseId]);
  if (!phase) throw notFound('phase not found');
  const project = await loadVisibleProject(tx, userId, phase.project_id);
  return { phase, project };
}

const assertActive = (project: Row) => {
  if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
};

// ---------------------------------------------------------------------------------- manager commands

/** Creates an open phase (any member). Follow-ups default to the project's default list. */
export async function createPhase(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: CreatePhaseRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    assertActive(project);
    if (await nameTaken(tx, projectId, req.name))
      throw conflict('phase_name_taken', `a phase named '${req.name}' already exists in this project`);
    if (req.workingBranch && !GitRefSchema.safeParse(req.workingBranch).success)
      throw badRequest('invalid_branch', 'not a valid git branch name');
    let followups: FollowupSpecWithId[];
    try {
      const can = await followupCapabilities(tx, projectId);
      // Stale defaults the project cannot run (no repository, no test stage) are left out rather than blocking the phase.
      const defaults = defaultFollowups(project).filter((f) =>
        f.kind === 'deploy' ? can.deploy : f.kind === 'regression' ? can.regression : true,
      );
      followups = await normalizeFollowups(ctx, tx, projectId, req.followups ?? defaults);
    } catch (err) {
      if (!req.followups)
        throw conflict('defaults_invalid', 'the project default follow-ups need fixing first');
      throw err;
    }
    const number = Number(project.next_phase_number);
    const phaseId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phaseId),
          event: {
            type: 'PhaseCreated',
            payload: {
              phaseId,
              projectId,
              number,
              ref: phaseRef(project.key, number),
              name: req.name,
              description: req.description ?? '',
              status: 'open',
              createdBy: { kind: 'user', userId: user.id },
              ...(req.workingBranch ? { workingBranch: req.workingBranch } : {}),
              followups,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, projectId),
        },
      ],
      { tx },
    );
    return phaseId;
  });
}

export async function updatePhase(
  ctx: Ctx,
  user: AuthSession['user'],
  phaseId: string,
  patch: PatchPhaseRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { phase, project } = await lockPhase(tx, user.id, phaseId);
    assertActive(project);
    if (isPhaseFinal(phase.status)) throw conflict('phase_closed', `the phase is ${phase.status}`);
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined && patch.name !== phase.name) {
      if (await nameTaken(tx, phase.project_id, patch.name, phase.id))
        throw conflict('phase_name_taken', `a phase named '${patch.name}' already exists in this project`);
      changes.name = patch.name;
    }
    if (patch.description !== undefined && patch.description !== phase.description)
      changes.description = patch.description;
    if (patch.workingBranch !== undefined && patch.workingBranch !== phase.working_branch) {
      if (patch.workingBranch !== null && !GitRefSchema.safeParse(patch.workingBranch).success)
        throw badRequest('invalid_branch', 'not a valid git branch name');
      if (!PHASE_ASSIGNABLE_STATUSES.includes(phase.status))
        throw conflict(
          'phase_not_open',
          'the working branch can only change while the phase is proposed or open',
        );
      changes.workingBranch = patch.workingBranch;
    }
    if (Object.keys(changes).length === 0) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phase.id),
          event: { type: 'PhaseUpdated', payload: { phaseId: phase.id, changes, by: userBy(user.id) } },
          actor: userActor(user.id),
          scope: phaseScope(phase),
        },
      ],
      { tx },
    );
  });
}

/**
 * Replaces the follow-up list of a phase (any member) in the editable states. Editing while "phase done" waits for
 * the manager is allowed; when the list changes between empty and non-empty the desk item is re-issued in the right
 * form (approve N follow-ups / acknowledge), so what the manager approves is always what the phase page shows.
 */
export async function setPhaseFollowups(
  ctx: Ctx,
  user: AuthSession['user'],
  phaseId: string,
  list: FollowupSpec[],
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { phase, project } = await lockPhase(tx, user.id, phaseId);
    assertActive(project);
    if (!PHASE_FOLLOWUP_EDITABLE_STATUSES.includes(phase.status))
      throw conflict('followups_frozen', 'the follow-ups can no longer be edited');
    const before = await followupRows(tx, phase.id);
    const followups = await normalizeFollowups(ctx, tx, phase.project_id, list);
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseFollowupsSet',
            payload: { phaseId: phase.id, followups, by: userBy(user.id) },
          },
          actor: userActor(user.id),
          scope: phaseScope(phase),
        },
      ],
      { tx },
    );
    if (phase.status === 'awaiting_approval' && (before.length === 0) !== (followups.length === 0)) {
      const asked = phase.report_desk_item_id
        ? await one<{ asked_by_agent_id: string | null }>(
            tx,
            'SELECT asked_by_agent_id FROM desk_items WHERE id=$1',
            [phase.report_desk_item_id],
          )
        : undefined;
      const by = asked?.asked_by_agent_id ? agentBy(asked.asked_by_agent_id) : systemBy;
      await ctx.store.append(
        await phaseReportEvents(tx, phase, {
          report: phase.report ?? '',
          outstanding: phase.outstanding ?? [],
          by,
        }),
        { tx },
      );
    }
  });
}

export async function getFollowupDefaults(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<FollowupSpec[]> {
  return defaultFollowups(await loadVisibleProject(ctx.pool, user.id, projectId));
}

export async function setFollowupDefaults(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  list: FollowupSpec[],
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    assertActive(project);
    const followups = await normalizeFollowups(ctx, tx, projectId, list);
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectFollowupDefaultsSet',
            payload: { projectId, followups, changedBy: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** Cards that may join a phase: not suite or regression cards, and not bug children that share a parent's worktree. */
export function memberRefusal(card: Row): { code: string; message: string } | null {
  if (card.card_type === 'regression' || card.origin === 'regression' || card.phase_followup_id)
    return {
      code: 'not_a_member_card',
      message: `${card.ref} is a suite or regression card: it rides on the work it tests`,
    };
  if (card.worktree_card_id)
    return {
      code: 'not_a_member_card',
      message: `${card.ref} is a bug fix on another card's branch: it rides on that card`,
    };
  return null;
}

/** Events that put `card` in `phase` (or take it out): checks the editable rule, then `CardPhaseChanged`. */
export function assignRefusal(
  card: Row,
  next: Row | null,
  current: Row | null,
): { code: string; message: string } | null {
  const refusal = memberRefusal(card);
  if (refusal) return refusal;
  if (['done', 'cancelled'].includes(card.status))
    return { code: 'card_terminal', message: `${card.ref} is ${card.status}: it can no longer change phase` };
  if (current && !PHASE_ASSIGNABLE_STATUSES.includes(current.status))
    return {
      code: 'phase_not_open',
      message: `${card.ref} belongs to ${current.ref}, which is ${current.status}: it can no longer be changed`,
    };
  if (next) {
    if (next.project_id !== card.project_id)
      return { code: 'wrong_project', message: `${next.ref} belongs to another project` };
    if (!PHASE_ASSIGNABLE_STATUSES.includes(next.status))
      return {
        code: 'phase_not_open',
        message: `${next.ref} is ${next.status}: cards can no longer join it`,
      };
  }
  return null;
}

async function assignIn(
  ctx: Ctx,
  tx: Tx,
  input: { card: Row; phaseId: string | null; assignment: 'proposed' | 'confirmed'; by: DeskActor },
): Promise<{ changed: boolean; phase: Row | null }> {
  const { card } = input;
  const next = input.phaseId
    ? await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [input.phaseId])
    : null;
  if (input.phaseId && !next) throw notFound('phase not found');
  const current = card.phase_id
    ? await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [card.phase_id])
    : null;
  const refusal = assignRefusal(card, next ?? null, current ?? null);
  if (refusal) throw conflict(refusal.code, refusal.message);
  const same =
    (card.phase_id ?? null) === input.phaseId &&
    (input.phaseId === null || card.phase_assignment === input.assignment);
  if (same) return { changed: false, phase: next ?? null };
  const events: AppendInput[] = [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardPhaseChanged',
        payload: {
          cardId: card.id,
          phaseId: input.phaseId,
          ...(card.phase_id ? { previousPhaseId: card.phase_id } : {}),
          assignment: input.phaseId ? input.assignment : null,
          by: input.by,
        },
      },
      actor: actorOf(input.by),
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
  await ctx.store.append(events, { tx });
  return { changed: true, phase: next ?? null };
}

/** `PUT /api/cards/:id/phase`: any member puts a card in a phase (confirmed) or takes it out. */
export async function assignCardToPhase(
  ctx: Ctx,
  user: AuthSession['user'],
  cardIdOrRef: string,
  req: AssignCardPhaseRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { card: found } = await loadVisibleCard(tx, user.id, cardIdOrRef);
    const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [found.id])) as Row;
    await assignIn(ctx, tx, { card, phaseId: req.phaseId, assignment: 'confirmed', by: userBy(user.id) });
  });
  ctx.services.dispatcher.trigger();
}

export async function reopenPhase(
  ctx: Ctx,
  user: AuthSession['user'],
  phaseId: string,
  reason: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { phase, project } = await lockPhase(tx, user.id, phaseId);
    assertActive(project);
    await ctx.store.append(await reopenEvents(tx, phase, userBy(user.id), reason), { tx });
  });
  ctx.services.dispatcher.trigger();
}

/**
 * Reopens a phase before its follow-ups were approved: it waits for its cards again. The open "phase done" item is
 * dismissed and a queued or running report task is cancelled (its shift is told when it reports).
 */
export async function reopenEvents(
  tx: Queryable,
  phase: Row,
  by: DeskActor,
  reason: string,
): Promise<AppendInput[]> {
  if (!['reporting', 'awaiting_approval'].includes(phase.status))
    throw conflict('cannot_reopen', 'a phase can only be reopened before its follow-ups were approved');
  const events: AppendInput[] = [];
  if (phase.report_desk_item_id && (await openItem(tx, phase.report_desk_item_id)))
    events.push(resolveItemEvent(phase, phase.report_desk_item_id, 'dismissed', 'phase reopened'));
  for (const t of await rows(
    tx,
    `SELECT id FROM ba_tasks WHERE phase_id=$1 AND kind='phase_report' AND status IN ('queued','running')`,
    [phase.id],
  ))
    events.push(baTaskCompleted(phase, t.id, 'cancelled', 'phase reopened'));
  events.push(
    {
      streamId: streamId.phase(phase.id),
      event: { type: 'PhaseReopened', payload: { phaseId: phase.id, by, reason } },
      actor: actorOf(by),
      scope: phaseScope(phase),
    },
    phaseMessage(
      phase,
      by.kind === 'user' ? { kind: 'user', userId: by.userId as string } : { kind: 'system' },
      `Phase reopened: ${reason}`,
    ),
  );
  return events;
}

/** Working branch a card's work must reach: the phase's own, else the card's base, else the repository's, else the project's. */
export async function workingBranchOf(db: Queryable, card: Row, phase?: Row | null): Promise<string> {
  if (phase?.working_branch) return phase.working_branch;
  if (card.base_branch) return card.base_branch;
  const repo = card.repo_id
    ? await one(db, 'SELECT working_branch FROM project_repos WHERE id=$1', [card.repo_id])
    : undefined;
  if (repo?.working_branch) return repo.working_branch;
  const project = (await one(db, 'SELECT working_branch FROM projects WHERE id=$1', [
    card.project_id,
  ])) as Row;
  return project.working_branch;
}

/**
 * A member says a finalized `pr` / `push_branch` card is in the working branch (a squash merge the git check cannot
 * see, a branch that was deleted): the phase stops waiting for the automatic check.
 */
export async function confirmCardMerged(
  ctx: Ctx,
  user: AuthSession['user'],
  cardIdOrRef: string,
  note?: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const { card: found } = await loadVisibleCard(tx, user.id, cardIdOrRef);
    const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [found.id])) as Row;
    if (card.status !== 'done' || !card.finalize_result || card.finalize_action === 'merge')
      throw conflict('not_waiting_for_merge', `${card.ref} is not a finalized pull request or pushed branch`);
    if (card.merged_into_working_at) throw conflict('already_merged', `${card.ref} is already merged`);
    const phase = card.phase_id ? await one(tx, 'SELECT * FROM phases WHERE id=$1', [card.phase_id]) : null;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardMergeVerified',
            payload: {
              cardId: card.id,
              workingBranch: await workingBranchOf(tx, card, phase),
              ...(card.branch_name ? { branchName: card.branch_name } : {}),
              branchDeleted: false,
              remoteBranchDeleted: false,
              manual: true,
              by: userBy(user.id),
            },
          },
          actor: userActor(user.id),
          scope: projectScope(card.org_id, card.project_id),
        },
        cardMessage(
          card,
          { kind: 'user', userId: user.id },
          'system',
          `${user.displayName} confirmed the work is in the working branch${note ? `: ${note}` : ''}.`,
        ),
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
}

// ------------------------------------------------------------------------------- desk resolution

/**
 * Desk resolve of a `phase_proposal`, `phase_done` or `phase_results` item (called inside the desk resolve
 * transaction, any member may act: owner decision A1). The domain events are appended here; the caller appends the
 * `DeskItemResolved`.
 */
export async function resolvePhaseDeskItemIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
): Promise<void> {
  const by = userBy(user.id);
  const sub = item.subkind as string;
  if (sub === PHASE_DESK_SUBKIND.results) {
    if (resolution === 'approved' || resolution === 'rejected')
      throw badRequest('wrong_resolution', 'a results notice is acknowledged');
    return;
  }
  const phase =
    sub === PHASE_DESK_SUBKIND.proposal
      ? await one(tx, 'SELECT * FROM phases WHERE proposal_desk_item_id=$1 FOR UPDATE', [item.id])
      : await one(tx, 'SELECT * FROM phases WHERE report_desk_item_id=$1 FOR UPDATE', [item.id]);
  if (!phase) return; // a superseded item: nothing to act on
  const events: AppendInput[] = [];

  if (sub === PHASE_DESK_SUBKIND.proposal) {
    if (resolution === 'acknowledged')
      throw badRequest('wrong_resolution', 'a phase proposal is approved or rejected');
    if (!['proposed', 'open'].includes(phase.status)) return;
    const listed: string[] = item.affected_card_ids ?? [];
    const pending = (await memberRows(tx, phase.id))
      .filter((c) => c.phase_assignment === 'proposed' && listed.includes(c.id))
      .map((c) => c.id as string);
    if (resolution === 'approved') {
      events.push(
        {
          streamId: streamId.phase(phase.id),
          event: { type: 'PhaseConfirmed', payload: { phaseId: phase.id, by, confirmedCardIds: pending } },
          actor: userActor(user.id),
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'user', userId: user.id },
          `${user.displayName} confirmed the phase${pending.length ? ` with ${pending.length} card(s)` : ''}.`,
        ),
      );
    } else {
      events.push(
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseProposalRejected',
            payload: {
              phaseId: phase.id,
              by,
              ...(note ? { reason: note } : {}),
              clearedCardIds: pending,
              discard: phase.status === 'proposed',
            },
          },
          actor: userActor(user.id),
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'user', userId: user.id },
          `${user.displayName} rejected the proposal${note ? `: ${note}` : ''}.`,
        ),
      );
    }
    await ctx.store.append(events, { tx });
    return;
  }

  // phase_done: approve (or acknowledge, with no follow-ups) / reject / dismiss
  if (item.kind === 'approval' && resolution === 'acknowledged')
    throw badRequest('wrong_resolution', 'the follow-ups are approved or rejected');
  if (item.kind === 'alert' && resolution === 'rejected')
    throw badRequest('wrong_resolution', 'there are no follow-ups to reject: acknowledge or dismiss it');
  if (phase.status !== 'awaiting_approval') return;
  const list = await followupRows(tx, phase.id);
  if (resolution === 'rejected' || resolution === 'dismissed') {
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phase.id),
          event: {
            type: 'PhaseFollowupsRejected',
            payload: { phaseId: phase.id, by, deskItemId: item.id, ...(note ? { note } : {}) },
          },
          actor: userActor(user.id),
          scope: phaseScope(phase),
        },
        phaseMessage(
          phase,
          { kind: 'user', userId: user.id },
          `${user.displayName} rejected the follow-ups${note ? `: ${note}` : ''}. Nothing will run.`,
        ),
      ],
      { tx },
    );
    return;
  }
  // approved / acknowledged: snapshot the current list
  const snapshot = list.map(rowToSpec);
  const task = snapshot.length ? await queueBaTask(tx, phase, 'followups_brief') : null;
  events.push(
    {
      streamId: streamId.phase(phase.id),
      event: {
        type: 'PhaseFollowupsApproved',
        payload: {
          phaseId: phase.id,
          by,
          deskItemId: item.id,
          followups: snapshot,
          ...(task ? { baTaskId: task.taskId } : {}),
        },
      },
      actor: userActor(user.id),
      scope: phaseScope(phase),
    },
    phaseMessage(
      phase,
      { kind: 'user', userId: user.id },
      snapshot.length
        ? `${user.displayName} approved ${snapshot.length} follow-up(s): ${(await labelsFor(tx, list)).join('; ')}.`
        : `${user.displayName} acknowledged the finished phase.`,
    ),
  );
  if (task) events.push(task.event);
  else
    events.push({
      streamId: streamId.phase(phase.id),
      event: { type: 'PhaseFollowupsFinished', payload: { phaseId: phase.id, status: 'done' } },
      actor: userActor(user.id),
      scope: phaseScope(phase),
    });
  await ctx.store.append(events, { tx });
}

// ------------------------------------------------------------------------------------ archive

/** Cancels every phase of a project that is not final (the archive path); the caller appends the events. */
export async function cancelPhasesEvents(
  tx: Queryable,
  projectId: string,
  reason: string,
): Promise<AppendInput[]> {
  const events: AppendInput[] = [];
  const phases = await rows(
    tx,
    `SELECT * FROM phases WHERE project_id=$1 AND status NOT IN ('done','done_with_failures','followups_rejected','discarded','cancelled')
      ORDER BY number FOR UPDATE`,
    [projectId],
  );
  for (const phase of phases) {
    for (const t of await rows(
      tx,
      `SELECT id FROM ba_tasks WHERE phase_id=$1 AND status IN ('queued','running')`,
      [phase.id],
    ))
      events.push(baTaskCompleted(phase, t.id, 'cancelled', reason));
    events.push(
      {
        streamId: streamId.phase(phase.id),
        event: { type: 'PhaseCancelled', payload: { phaseId: phase.id, reason } },
        actor: actorOf(systemBy),
        scope: phaseScope(phase),
      },
      phaseMessage(phase, { kind: 'system' }, `Phase cancelled: ${reason}. Pending follow-ups will not run.`),
    );
  }
  return events;
}

// ------------------------------------------------------------------------------------ bug cards (A6)

/**
 * A bug card filed after finalize joins the phase of the card (or follow-up) it came from, and the phase waits for it
 * (owner decision A6). A phase still waiting for its report or approval is reopened; a running or finished one keeps
 * the bug as a member for the record. `sourceCard` is the suite or regression card whose failure filed the bug.
 */
export async function bugJoinEvents(
  tx: Queryable,
  bugCardId: string,
  bugRef: string,
  sourceCard: Row,
  scope: { orgId: string; projectId: string },
): Promise<AppendInput[]> {
  let phaseId: string | null = null;
  if (sourceCard.phase_followup_id) {
    const f = await one<{ phase_id: string }>(tx, 'SELECT phase_id FROM phase_followups WHERE id=$1', [
      sourceCard.phase_followup_id,
    ]);
    phaseId = f?.phase_id ?? null;
  } else if (sourceCard.parent_card_id) {
    const parent = await one<{ phase_id: string | null; phase_assignment: string | null }>(
      tx,
      'SELECT phase_id, phase_assignment FROM cards WHERE id=$1',
      [sourceCard.parent_card_id],
    );
    if (parent?.phase_assignment === 'confirmed') phaseId = parent.phase_id;
  }
  if (!phaseId) return [];
  const phase = await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [phaseId]);
  if (!phase || isPhaseFinal(phase.status) || phase.status === 'proposed') return [];
  const events: AppendInput[] = [
    {
      streamId: streamId.card(bugCardId),
      event: {
        type: 'CardPhaseChanged',
        payload: { cardId: bugCardId, phaseId, assignment: 'confirmed', by: systemBy, cause: 'bug_filed' },
      },
      actor: actorOf(systemBy),
      scope: { ...scope, audience: 'project' },
    },
    phaseMessage(
      phase,
      { kind: 'system' },
      `Bug ${bugRef} was filed after finalize and joined the phase: the phase waits for it.`,
    ),
  ];
  if (['reporting', 'awaiting_approval'].includes(phase.status))
    events.push(...(await reopenEvents(tx, phase, systemBy, `bug ${bugRef} was filed after finalize`)));
  return events;
}

// ------------------------------------------------------------------------------------- BA rpcs

const zodText = (issues: Array<{ path: PropertyKey[]; message: string }>): string =>
  issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ');

/** Finds a phase of the project by ref (`WEB-P2`) or by name. */
export async function findPhase(
  db: Queryable,
  projectId: string,
  refOrName: string,
): Promise<Row | undefined> {
  const parsed = parsePhaseRef(refOrName.toUpperCase());
  if (parsed)
    return one(db, 'SELECT * FROM phases WHERE project_id=$1 AND number=$2', [projectId, parsed.number]);
  return one(
    db,
    `SELECT * FROM phases WHERE project_id=$1 AND lower(name)=lower($2) AND status NOT IN ('discarded','cancelled')`,
    [projectId, refOrName],
  );
}

/** The BA writes `target: "<name>"`: resolve it to the target's id. */
async function resolveTargetNames(db: Queryable, projectId: string, raw: unknown): Promise<unknown> {
  if (!Array.isArray(raw)) return raw;
  const out: unknown[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && 'target' in item && typeof item.target === 'string') {
      const { target, ...rest } = item as Record<string, unknown> & { target: string };
      const t = await one(
        db,
        'SELECT id FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL AND (lower(name)=lower($2) OR id::text=$2)',
        [projectId, target],
      );
      if (!t)
        throw new Error(`unknown deploy target '${target}' (see \`aom phase list\`; never invent targets)`);
      out.push({ ...rest, targetId: t.id });
    } else out.push(item);
  }
  return out;
}

async function rpcProject(ctx: Ctx, who: Responder, params: Record<string, unknown>): Promise<Row> {
  const { intake } = who;
  const key = typeof params.project === 'string' ? params.project.toUpperCase() : undefined;
  if (!key && !intake.mapped_project_id)
    throw new Error('map the ticket to a project first (`aom intake map`), or pass --project <KEY>');
  const project = await one(
    ctx.pool,
    `SELECT p.* FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 AND m.status = 'active'
      WHERE p.status = 'active' AND p.kind = 'project' AND ($2::uuid IS NULL OR p.id = $2) AND ($3::text IS NULL OR p.key = $3)
      ORDER BY (p.org_id = $1) DESC LIMIT 1`,
    [intake.started_by, key ? null : intake.mapped_project_id, key ?? null],
  );
  if (!project)
    throw new Error(
      key
        ? `unknown project '${key}'`
        : 'map the ticket to a project first (`aom intake map`), or pass --project <KEY>',
    );
  return project;
}

/** `phase.list`, `phase.propose`, `phase.assign`, `phase.submit`: the BA's phase proposals in its chat. */
export async function phaseChatRpc(
  ctx: Ctx,
  who: Responder,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const project = await rpcProject(ctx, who, params);
  switch (method) {
    case 'phase.list':
      return [true, await phaseList(ctx, project)];
    case 'phase.propose':
      return propose(ctx, who, project, params);
    case 'phase.assign':
      return assignProposed(ctx, who, project, params);
    case 'phase.submit':
      return submit(ctx, who, project, params);
    default:
      return [false, undefined, `${method} is not available`];
  }
}

async function phaseList(ctx: Ctx, project: Row) {
  const phases = await rows(
    ctx.pool,
    `SELECT p.*, (SELECT count(*)::int FROM cards c WHERE c.phase_id = p.id) AS members FROM phases p
      WHERE p.project_id=$1 AND p.status NOT IN ('discarded','cancelled') ORDER BY p.number`,
    [project.id],
  );
  const out = [];
  for (const p of phases)
    out.push({
      ref: p.ref,
      name: p.name,
      status: p.status,
      members: p.members,
      followups: await labelsFor(ctx.pool, await followupRows(ctx.pool, p.id)),
    });
  const targets = await rows(
    ctx.pool,
    `SELECT t.*, w.name AS workstation_name,
            EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = t.workstation_id AND a.role_key='tester' AND a.status='active') AS has_tester
       FROM deploy_targets t LEFT JOIN workstations w ON w.id = t.workstation_id
      WHERE t.project_id=$1 AND t.removed_at IS NULL ORDER BY lower(t.name)`,
    [project.id],
  );
  return {
    project: project.key,
    phases: out,
    deployTargets: targets.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      host: t.host,
      appUrl: t.app_url,
      workstation: t.workstation_name,
      testerOnWorkstation: t.workstation_id ? t.has_tester : null,
      notes: t.notes,
    })),
    defaultFollowups: defaultFollowups(project),
  };
}

async function propose(
  ctx: Ctx,
  who: Responder,
  project: Row,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const { intake, agent } = who;
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (!name || name.length > 120)
    return [false, undefined, 'usage: aom phase propose --name "<name>" (1-120 characters)'];
  const description = typeof params.description === 'string' ? params.description : '';
  const rawFollowups =
    params.followups === undefined
      ? undefined
      : await resolveTargetNames(ctx.pool, project.id, params.followups);
  const parsed = rawFollowups === undefined ? undefined : FollowupListSchema.safeParse(rawFollowups);
  if (parsed && !parsed.success)
    return [false, undefined, `invalid follow-ups: ${zodText(parsed.error.issues)}`];
  const by = agentBy(agent.id);
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const existing = await nameTaken(tx, project.id, name);
    if (existing) {
      const phase = (await one(
        tx,
        `SELECT * FROM phases WHERE project_id=$1 AND lower(name)=lower($2) AND status NOT IN ('discarded','cancelled')`,
        [project.id, name],
      )) as Row;
      if (!['proposed', 'open'].includes(phase.status))
        throw new Error(`a phase named '${name}' already exists and is ${phase.status}: pick another name`);
      if (phase.status === 'proposed' && parsed?.success) {
        const followups = await normalizeFollowups(ctx, tx, project.id, parsed.data);
        await ctx.store.append(
          [
            {
              streamId: streamId.phase(phase.id),
              event: { type: 'PhaseFollowupsSet', payload: { phaseId: phase.id, followups, by } },
              actor: actorOf(by),
              scope: phaseScope(phase),
            },
          ],
          { tx },
        );
      }
      return { ref: phase.ref, name: phase.name, status: phase.status, existing: true };
    }
    const followups = await normalizeFollowups(
      ctx,
      tx,
      project.id,
      parsed?.success ? parsed.data : defaultFollowups(project),
    );
    const number = Number(project.next_phase_number);
    const phaseId = randomUUID();
    const ref = phaseRef(project.key, number);
    await ctx.store.append(
      [
        {
          streamId: streamId.phase(phaseId),
          event: {
            type: 'PhaseCreated',
            payload: {
              phaseId,
              projectId: project.id,
              number,
              ref,
              name,
              description,
              status: 'proposed',
              createdBy: { kind: 'agent', agentId: agent.id, role: 'ba' },
              intakeId: intake.id,
              followups,
            },
          },
          actor: actorOf(by),
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
    return { ref, name, status: 'proposed', existing: false };
  }).catch((err: unknown) => {
    if (err instanceof Error) return { error: err.message };
    throw err;
  });
  if ('error' in out) return [false, undefined, out.error];
  return [
    true,
    {
      ...out,
      message: out.existing
        ? `Phase ${out.ref} already exists (${out.status}); use it. Put cards in it with "phase": "${out.ref}" in the draft, then \`aom phase submit ${out.ref}\`.`
        : `Proposed phase ${out.ref}. Put each card in it ("phase": "${out.ref}" in the draft, or \`aom phase assign <REF> --phase ${out.ref}\`), then \`aom phase submit ${out.ref}\` so the manager confirms.`,
    },
  ];
}

/** `CardPhaseChanged{proposed}` for a card the BA creates or updates with a `phase` (called by the draft RPCs). */
export async function proposeCardPhaseIn(
  ctx: Ctx,
  tx: Tx,
  who: Responder,
  cardId: string,
  phaseRefOrName: string | null,
): Promise<void> {
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardId])) as Row;
  let phaseId: string | null = null;
  if (phaseRefOrName !== null) {
    const phase = await findPhase(tx, card.project_id, phaseRefOrName);
    if (!phase)
      throw new Error(`unknown phase '${phaseRefOrName}' (propose it first: \`aom phase propose\`)`);
    phaseId = phase.id;
  }
  await assignIn(ctx, tx, { card, phaseId, assignment: 'proposed', by: agentBy(who.agent.id) });
}

async function assignProposed(
  ctx: Ctx,
  who: Responder,
  project: Row,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const ref = typeof params.card === 'string' ? params.card.toUpperCase() : '';
  if (!ref) return [false, undefined, 'usage: aom phase assign <CARD-REF> --phase <ref|name> | --none'];
  const target = params.phase === null || params.phase === undefined ? null : String(params.phase);
  try {
    const out = await withAppendTx(ctx.pool, async (tx) => {
      const card = await one(tx, 'SELECT * FROM cards WHERE project_id=$1 AND ref=$2 FOR UPDATE', [
        project.id,
        ref,
      ]);
      if (!card) throw new Error(`unknown card ${ref} in project ${project.key}`);
      await proposeCardPhaseIn(ctx, tx, who, card.id, target);
      return { card: ref, phase: target };
    });
    return [
      true,
      {
        ...out,
        message: target
          ? `${ref} is proposed for ${target}; submit the phase for confirmation.`
          : `${ref} is no longer in a phase.`,
      },
    ];
  } catch (err) {
    return [false, undefined, err instanceof Error ? err.message : String(err)];
  }
}

async function submit(
  ctx: Ctx,
  who: Responder,
  project: Row,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const key = typeof params.phase === 'string' ? params.phase : '';
  if (!key) return [false, undefined, 'usage: aom phase submit <ref>'];
  try {
    const out = await withAppendTx(ctx.pool, async (tx) => {
      const found = await findPhase(tx, project.id, key);
      if (!found) throw new Error(`unknown phase '${key}'`);
      const phase = (await one(tx, 'SELECT * FROM phases WHERE id=$1 FOR UPDATE', [found.id])) as Row;
      if (!['proposed', 'open'].includes(phase.status))
        throw new Error(`${phase.ref} is ${phase.status}: it can no longer be proposed`);
      const proposed = (await memberRows(tx, phase.id)).filter((c) => c.phase_assignment === 'proposed');
      if (phase.status === 'open' && proposed.length === 0)
        throw new Error(`${phase.ref} is already confirmed and no card is waiting to join it`);
      const followups = await followupRows(tx, phase.id);
      const labels = await labelsFor(tx, followups);
      const confirmed = (await memberRows(tx, phase.id)).filter((c) => c.phase_assignment === 'confirmed');
      const body = [
        phase.description.trim() || '(no description)',
        '',
        phase.status === 'proposed' ? 'Proposed cards:' : 'Cards waiting to join:',
        ...(proposed.length ? proposed.map((c) => `- ${c.ref} ${c.title}`) : ['- none']),
        ...(confirmed.length
          ? ['', 'Already in the phase:', ...confirmed.map((c) => `- ${c.ref} ${c.title}`)]
          : []),
        '',
        'Follow-ups after the phase is done (they run only after you approve them then):',
        ...(labels.length ? labels.map((l, i) => `${i + 1}. ${l}`) : ['- none']),
      ].join('\n');
      const item = createItemEvent(phase, {
        kind: 'approval',
        subkind: PHASE_DESK_SUBKIND.proposal,
        title:
          phase.status === 'proposed'
            ? `Confirm phase ${phase.ref}: ${phase.name} (${proposed.length} card${proposed.length === 1 ? '' : 's'})`
            : `Add ${proposed.length} card${proposed.length === 1 ? '' : 's'} to phase ${phase.ref}: ${phase.name}`,
        body,
        askedBy: agentBy(who.agent.id),
        affectedCardIds: proposed.map((c) => c.id),
      });
      const events: AppendInput[] = [];
      if (phase.proposal_desk_item_id && (await openItem(tx, phase.proposal_desk_item_id)))
        events.push(
          resolveItemEvent(phase, phase.proposal_desk_item_id, 'dismissed', 'superseded by a newer proposal'),
        );
      events.push(item.event, {
        streamId: streamId.phase(phase.id),
        event: {
          type: 'PhaseProposalSubmitted',
          payload: {
            phaseId: phase.id,
            deskItemId: item.deskItemId,
            proposedCardIds: proposed.map((c) => c.id),
            newPhase: phase.status === 'proposed',
          },
        },
        actor: actorOf(agentBy(who.agent.id)),
        scope: phaseScope(phase),
      });
      await ctx.store.append(events, { tx });
      return { ref: phase.ref, deskItemId: item.deskItemId, cards: proposed.map((c) => c.ref) };
    });
    return [
      true,
      {
        ...out,
        message: `Submitted ${out.ref} for the manager's confirmation on the desk. Tell the manager in this conversation what you proposed and why.`,
      },
    ];
  } catch (err) {
    return [false, undefined, err instanceof Error ? err.message : String(err)];
  }
}

// ------------------------------------------------------------------------- merge check (A2)

/**
 * `command.result` of `branch.check_merged`: the card's branch is (or is not yet) merged into the working branch. A
 * merged answer appends `CardMergeVerified`; anything else changes nothing (the check repeats on a timer).
 */
export async function applyBranchCheckResult(
  ctx: Ctx,
  cardId: string,
  workingBranch: string,
  ok: boolean,
  raw: unknown,
): Promise<void> {
  const parsed = BranchCheckMergedResultSchema.safeParse(raw);
  if (!ok || !parsed.success || !parsed.data.merged) return;
  const result = parsed.data;
  await withAppendTx(ctx.pool, async (tx) => {
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardId]);
    if (!card || card.merged_into_working_at) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardMergeVerified',
            payload: {
              cardId: card.id,
              workingBranch,
              ...(card.branch_name ? { branchName: card.branch_name } : {}),
              branchDeleted: result.branchDeleted,
              remoteBranchDeleted: result.remoteBranchDeleted,
              manual: false,
            },
          },
          actor: actorOf(systemBy),
          scope: projectScope(card.org_id, card.project_id),
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `The branch is merged into ${workingBranch}${result.branchDeleted ? '; the card branch was deleted' : ''}${result.remoteBranchDeleted ? ' (also on the remote)' : ''}.`,
        ),
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
}
