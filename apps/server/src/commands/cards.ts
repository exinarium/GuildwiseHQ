import { randomUUID } from 'node:crypto';
import {
  type CardChanges,
  type CardOrigin,
  type CompletionAction,
  type CreateCardRequest,
  canManageCard,
  cardRef,
  DEFAULT_CARD_PRIORITY,
  emptyFields,
  type FillableCard,
  getStage,
  isMockField,
  missingForSpecify,
  type PatchCardRequest,
  parseCardFields,
  requiredMissing,
  resolveOutcome,
  type Stage,
  streamId,
  type WorkflowCardView,
  type WorkflowDefinition,
  workflowHasDesignStage,
  workflowSupportsInvestigationOnly,
  workflowUsesRepos,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import { loadWorkflowById, resolveWorkflow, type WorkflowVersionRow } from '../catalogue/loader.ts';
import { resolveProjectCardWorkflow } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { cardMessage, projectScope, userActor } from './common.ts';
import { openLoopAlerts } from './loop-breaker.ts';

/**
 * The workflow that runs a card of this type in this project (docs/design/restructure.md section 8.1, and
 * docs/design/architect-and-workflows.md 4.1 once a project enables more than one): the explicit `workflowKey` when
 * given, else the project's default for the type, else the cross-project workflow (a research card in a code
 * project), otherwise none. The card carries that workflow version from then on, so the board shows its columns
 * next to the project's own.
 */
export async function resolveCardWorkflow(
  db: Queryable,
  project: Row,
  cardType: string,
  workflowKey?: string,
): Promise<WorkflowVersionRow | null> {
  return resolveProjectCardWorkflow(db, project, cardType, workflowKey);
}

/**
 * The stage a `CardSpecified` moves the card into, and the outcome's resolved stage. With the card (its flags) a target
 * stage whose `when` does not hold is skipped, like every other outcome (`resolveOutcome`): a card without
 * "Investigate & design" goes from Spec straight to Build. Without a card the raw target of the outcome is returned.
 */
export function specifyTarget(
  def: WorkflowDefinition,
  card?: CardView,
): { from: string; to: string; stage: Stage } {
  const initial = getStage(def, def.initialStage) as Stage;
  const o =
    initial.outcomes.find((x) => x.event === 'CardSpecified') ??
    initial.outcomes.find((x) => x.kind === 'success');
  let to = initial.id;
  if (initial.kind === 'manual' && o) to = card ? resolveOutcome(def, card, initial.id, o.id).toStage : o.to;
  return { from: initial.id, to, stage: getStage(def, to) as Stage };
}

/** A card as the workflow engine and the required-field checks see it. */
export type CardView = FillableCard & WorkflowCardView;

/**
 * A card row as the workflow engine reads it (`when` on stages and outcomes): the raw columns plus the camelCase names
 * the workflows use (`docsNeeded`, `designNeeded`, `investigationOnly`, `riskTier`, ...), then `fields`.
 */
export function workflowView(c: Row): WorkflowCardView {
  return { ...c, ...cardView(c) };
}

export function cardView(c: Row): CardView {
  return {
    title: c.title,
    cardType: c.card_type,
    repoId: c.repo_id,
    completionAction: c.completion_action,
    docsNeeded: c.docs_needed,
    designNeeded: c.design_needed ?? false,
    investigationOnly: c.investigation_only ?? false,
    riskTier: c.risk_tier,
    priority: c.priority,
    fields: c.fields,
  };
}

/** True when mock-runtime fields may be used in this project: `AOM_MOCK_UI=true`, or a simulation organization. */
export async function mockFieldsAllowed(ctx: Ctx, db: Queryable, projectId: string): Promise<boolean> {
  if (ctx.config.mockUi) return true;
  const o = await one(
    db,
    'SELECT o.simulation FROM projects p JOIN organizations o ON o.id = p.org_id WHERE p.id=$1',
    [projectId],
  );
  return !!o?.simulation;
}

/** Mock-runtime fields are refused unless the server runs with `AOM_MOCK_UI=true` or the project's org is a simulation. */
export async function assertNoMockFields(
  ctx: Ctx,
  db: Queryable,
  projectId: string,
  fields: Record<string, unknown> | undefined,
) {
  if (ctx.config.mockUi || !fields) return;
  const used = Object.keys(fields).filter(
    (k) => isMockField(k) && fields[k] !== undefined && fields[k] !== null,
  );
  if (!used.length || (await mockFieldsAllowed(ctx, db, projectId))) return;
  throw unprocessable(
    'mock_fields_disabled',
    `mock runtime fields (${used.join(', ')}) are only available when the server runs with AOM_MOCK_UI=true or in a simulation organization`,
    { fields: used },
  );
}

async function assertRepoInProject(tx: Tx, projectId: string, repoId: string) {
  const r = await one(
    tx,
    'SELECT 1 FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
    [repoId, projectId],
  );
  if (!r) throw badRequest('invalid_repo', 'repository does not belong to this project');
}

async function assertDependencies(tx: Tx, projectId: string, deps: string[], selfId?: string) {
  if (deps.length === 0) return;
  if (selfId && deps.includes(selfId))
    throw badRequest('invalid_dependency', 'a card cannot depend on itself');
  const found = await rows(tx, 'SELECT id FROM cards WHERE project_id=$1 AND id = ANY($2::uuid[])', [
    projectId,
    deps,
  ]);
  if (found.length !== new Set(deps).size)
    throw badRequest('invalid_dependency', 'dependencies must be cards of the same project');
}

/** Who a card command acts as, and where the card comes from: the BA's intake chat creates cards as `intake`. */
export interface CardActing {
  origin?: CardOrigin;
  actor?: AppendInput['actor'];
  /** The card that causes this one (a sub-workflow child): `parent_card_id`. */
  parentCardId?: string;
}

/**
 * The Investigate & design flags of a new card: `designNeeded` defaults to the project's design step setting (off unless
 * the project opted in) and only exists in a workflow that has the stage; `investigationOnly` forces `designNeeded`.
 */
export function architectFlags(
  def: WorkflowDefinition,
  project: Row,
  req: { designNeeded?: boolean; investigationOnly?: boolean },
): { designNeeded: boolean; investigationOnly: boolean } {
  const hasStage = workflowHasDesignStage(def);
  const investigationOnly = req.investigationOnly ?? false;
  if (investigationOnly) {
    if (!hasStage || !workflowSupportsInvestigationOnly(def))
      throw badRequest(
        'investigation_not_supported',
        `workflow '${def.key}' has no Investigate & design stage, so a card cannot be investigation-only`,
      );
    if (req.designNeeded === false)
      throw badRequest(
        'investigation_needs_design',
        'an investigation-only card always runs Investigate & design: designNeeded cannot be false',
      );
    return { designNeeded: true, investigationOnly: true };
  }
  if (req.designNeeded === true && !hasStage)
    throw badRequest('design_not_supported', `workflow '${def.key}' has no Investigate & design stage`);
  return {
    designNeeded: hasStage ? (req.designNeeded ?? project.design_step === true) : false,
    investigationOnly: false,
  };
}

export async function createCard(
  ctx: Ctx,
  user: AuthSession['user'],
  req: CreateCardRequest,
): Promise<{ cardId: string; missing?: string[] }> {
  return withAppendTx(ctx.pool, (tx) => createCardIn(ctx, tx, user, req));
}

export async function createCardIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  req: CreateCardRequest,
  acting: CardActing = {},
): Promise<{ cardId: string; ref: string; missing?: string[] }> {
  const actor = acting.actor ?? userActor(user.id);
  const project = await loadVisibleProject(tx, user.id, req.projectId);
  if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
  const projectWf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!projectWf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  const wf = await resolveCardWorkflow(tx, project, req.cardType, req.workflowKey);
  if (!wf) {
    throw badRequest(
      'invalid_card_type',
      `card type '${req.cardType}' is not allowed in workflow '${projectWf.definition.key}'`,
    );
  }
  const def = wf.definition;
  await assertNoMockFields(ctx, tx, project.id, req.fields);
  if (req.interestId) {
    // A research card in a project that cites an interest: the interest must be visible to the user.
    const interest = await one(
      tx,
      `SELECT 1 AS x FROM interests i JOIN project_members pm ON pm.project_id = i.project_id
        AND pm.user_id = $2 AND pm.status = 'active' WHERE i.id = $1`,
      [req.interestId, user.id],
    );
    if (!interest) throw notFound('interest not found');
  }
  const parsed = parseCardFields(def.fieldSet, { ...emptyFields(def.fieldSet), ...req.fields });
  if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);

  let repoId = req.repoId;
  // A card whose workflow works in the vault (research in a code project) never takes a repository.
  if (!workflowUsesRepos(def)) repoId = undefined;
  else if (repoId) await assertRepoInProject(tx, project.id, repoId);
  else {
    const repos = await rows<{ id: string }>(
      tx,
      'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
      [project.id],
    );
    if (repos.length === 1) repoId = repos[0]?.id;
  }
  // No completion action named: the project's default decides how finished work lands (simple mode never asks).
  const completionAction: CompletionAction | undefined =
    req.completionAction ??
    (workflowUsesRepos(def) && project.default_completion
      ? (project.default_completion as CompletionAction)
      : undefined);
  const dependencies = req.dependencies ?? [];
  await assertDependencies(tx, project.id, dependencies);

  const number = Number(
    (await one(tx, 'SELECT next_card_number FROM projects WHERE id=$1 FOR UPDATE', [project.id]))
      ?.next_card_number,
  );
  const cardId = randomUUID();
  const { designNeeded, investigationOnly } = architectFlags(def, project, req);
  const view: CardView = {
    title: req.title,
    cardType: req.cardType,
    repoId: repoId ?? null,
    completionAction: completionAction ?? null,
    docsNeeded: req.docsNeeded ?? false,
    designNeeded,
    investigationOnly,
    riskTier: null,
    priority: req.priority ?? DEFAULT_CARD_PRIORITY,
    fields: parsed.data,
  };
  const target = specifyTarget(def, view);
  const scope = projectScope(project.org_id, project.id);
  const events: AppendInput[] = [
    {
      streamId: streamId.card(cardId),
      event: {
        type: 'CardCreated',
        payload: {
          cardId,
          projectId: project.id,
          number,
          ref: cardRef(project.key, number),
          title: req.title,
          cardType: req.cardType,
          workflowVersionId: wf.id,
          stage: def.initialStage,
          status: 'draft',
          fields: parsed.data,
          ownerUserId: user.id,
          ...(req.interestId ? { interestId: req.interestId } : {}),
          origin: acting.origin ?? 'manual',
          ...(acting.parentCardId ? { parentCardId: acting.parentCardId } : {}),
          scheduled: false,
          repoId,
          priority: req.priority ?? DEFAULT_CARD_PRIORITY,
          docsNeeded: req.docsNeeded ?? false,
          designNeeded,
          investigationOnly,
          ...(req.mergeMainFirst !== undefined && req.mergeMainFirst !== null
            ? { mergeMainFirst: req.mergeMainFirst }
            : {}),
          completionAction,
          dependencies,
          requiredCapabilities: [],
        },
      },
      actor,
      scope,
    },
  ];
  let missing: string[] | undefined;
  if (req.specify) {
    missing = missingForSpecify(def, view);
    if (missing.length === 0) {
      missing = undefined;
      events.push({
        streamId: streamId.card(cardId),
        event: { type: 'CardSpecified', payload: { cardId, fromStage: target.from, toStage: target.to } },
        actor,
        scope,
      });
    }
  }
  await ctx.store.append(events, { tx });
  return { cardId, ref: cardRef(project.key, number), missing };
}

export async function loadManageable(tx: Tx, user: AuthSession['user'], idOrRef: string) {
  const { card, role } = await loadVisibleCard(tx, user.id, idOrRef);
  if (!canManageCard({ userId: user.id, projectRole: role, cardOwnerUserId: card.owner_user_id })) {
    throw forbidden('only the card owner or the project owner can do this');
  }
  return card;
}

/** Open cards only; a draft or a queued (unclaimed) card may be edited, any open card may get a risk tier override. */
export function editRefusal(card: Row, patch: PatchCardRequest): { code: string; message: string } | null {
  const { riskTier, reason: _reason, ...rest } = patch;
  const edits = Object.entries(rest).some(([, v]) => v !== undefined);
  if (edits) {
    if (card.claim_id || card.status === 'claimed')
      return {
        code: 'card_claimed',
        message: `${card.ref} is being worked on right now: release the claim (or wait for the shift to end) before editing it`,
      };
    if (card.status !== 'draft' && card.status !== 'queued')
      return {
        code: 'card_not_editable',
        message: `${card.ref} is ${card.status}: only a draft or a queued, unclaimed card can be edited`,
      };
  }
  if (riskTier !== undefined) {
    if (card.finalize_state === 'awaiting_approval' || card.finalize_state === 'running')
      return {
        code: 'finalize_pending',
        message: `${card.ref} has a merge pending: settle it before changing the risk tier`,
      };
  }
  return null;
}

/**
 * Changes to the Investigate & design flags of an existing card: only until the investigation has happened (the card is
 * still in its first stage or in the investigate stage), and `investigationOnly` always implies `designNeeded`.
 */
function patchArchitectFlags(
  card: Row,
  def: WorkflowDefinition | undefined,
  patch: PatchCardRequest,
): Pick<CardChanges, 'designNeeded' | 'investigationOnly' | 'mergeMainFirst'> {
  const out: Pick<CardChanges, 'designNeeded' | 'investigationOnly' | 'mergeMainFirst'> = {};
  if (patch.mergeMainFirst !== undefined && patch.mergeMainFirst !== (card.merge_main_first ?? null))
    out.mergeMainFirst = patch.mergeMainFirst;
  if (patch.designNeeded === undefined && patch.investigationOnly === undefined) return out;
  if (!def || !workflowHasDesignStage(def))
    throw badRequest('design_not_supported', "this card's workflow has no Investigate & design stage");
  const wf0 = getStage(def, def.initialStage);
  if (card.stage !== wf0?.id && !String(card.stage).startsWith('investigate'))
    throw conflict(
      'design_locked',
      `${card.ref} is past the Investigate & design stage: it can no longer be switched`,
    );
  let design: boolean = patch.designNeeded ?? card.design_needed;
  const only: boolean = patch.investigationOnly ?? card.investigation_only;
  if (only) {
    if (!workflowSupportsInvestigationOnly(def))
      throw badRequest(
        'investigation_not_supported',
        "this card's workflow cannot hold investigation-only cards",
      );
    if (patch.designNeeded === false)
      throw badRequest(
        'investigation_needs_design',
        'an investigation-only card always runs Investigate & design: designNeeded cannot be false',
      );
    design = true;
  }
  if (design !== card.design_needed) out.designNeeded = design;
  if (only !== card.investigation_only) out.investigationOnly = only;
  return out;
}

export async function patchCard(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  patch: PatchCardRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status)) throw conflict('card_closed', `card is ${card.status}`);
    if (patch.riskTier !== undefined && !patch.reason)
      throw unprocessable('reason_required', 'a reason is required to override the risk tier');
    const refusal = editRefusal(card, patch);
    if (refusal) throw conflict(refusal.code, refusal.message);
    return patchCardIn(ctx, tx, user, idOrRef, patch);
  });
}

export async function patchCardIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  idOrRef: string,
  patch: PatchCardRequest,
  acting: CardActing = {},
): Promise<string> {
  const card = await loadManageable(tx, user, idOrRef);
  if (['done', 'cancelled'].includes(card.status)) throw conflict('card_closed', `card is ${card.status}`);
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  const changes: CardChanges = {};
  if (patch.title !== undefined && patch.title !== card.title) changes.title = patch.title;
  if (patch.priority !== undefined && patch.priority !== card.priority) changes.priority = patch.priority;
  if (patch.docsNeeded !== undefined && patch.docsNeeded !== card.docs_needed)
    changes.docsNeeded = patch.docsNeeded;
  if (patch.completionAction !== undefined && patch.completionAction !== card.completion_action) {
    changes.completionAction = patch.completionAction;
  }
  if (
    patch.designNeeded !== undefined ||
    patch.investigationOnly !== undefined ||
    patch.mergeMainFirst !== undefined
  ) {
    const flags = patchArchitectFlags(card, wf?.definition, patch);
    Object.assign(changes, flags);
  }
  if (patch.repoId !== undefined && patch.repoId !== card.repo_id) {
    if (patch.repoId) await assertRepoInProject(tx, card.project_id, patch.repoId);
    changes.repoId = patch.repoId;
  }
  // An override sticks even when it names the tier the diff computed: from now on the diff cannot change it.
  if (
    patch.riskTier !== undefined &&
    (patch.riskTier !== card.risk_tier || (patch.riskTier !== null && !card.risk_tier_overridden))
  ) {
    changes.riskTier = patch.riskTier;
    changes.riskTierOverridden = patch.riskTier !== null;
  }
  if (patch.fields !== undefined) {
    await assertNoMockFields(ctx, tx, card.project_id, patch.fields);
    // A field sent as null is removed from the card.
    const merged: Record<string, unknown> = { ...card.fields };
    for (const [k, v] of Object.entries(patch.fields)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    const parsed = parseCardFields(wf?.definition.fieldSet ?? 'code', merged);
    if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);
    changes.fields = parsed.data;
  }
  if (patch.dependencies !== undefined) {
    await assertDependencies(tx, card.project_id, patch.dependencies, card.id);
    changes.dependencies = patch.dependencies;
  }
  if (Object.keys(changes).length === 0) return card.id as string;
  await ctx.store.append(
    [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardUpdated',
          payload: {
            cardId: card.id,
            changes,
            ...(changes.riskTier !== undefined && patch.reason ? { reason: patch.reason } : {}),
          },
        },
        actor: acting.actor ?? userActor(user.id),
        scope: projectScope(card.org_id, card.project_id),
      },
    ],
    { tx },
  );
  return card.id as string;
}

export async function specifyCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string): Promise<string> {
  return withAppendTx(ctx.pool, (tx) => specifyCardIn(ctx, tx, user, idOrRef));
}

export async function specifyCardIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  idOrRef: string,
  acting: CardActing = {},
): Promise<string> {
  const card = await loadManageable(tx, user, idOrRef);
  if (card.status !== 'draft') throw conflict('not_draft', 'only draft cards can be specified');
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  if (!wf) throw conflict('unknown_workflow', 'card workflow is missing');
  const target = specifyTarget(wf.definition, cardView(card));
  const missing = missingForSpecify(wf.definition, cardView(card));
  if (missing.length) {
    throw unprocessable('missing_fields', `missing required fields: ${missing.join(', ')}`, { missing });
  }
  await ctx.store.append(
    [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardSpecified',
          payload: { cardId: card.id, fromStage: card.stage, toStage: target.to },
        },
        actor: acting.actor ?? userActor(user.id),
        scope: projectScope(card.org_id, card.project_id),
      },
    ],
    { tx },
  );
  return card.id as string;
}

export async function commentOnCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string, body: string) {
  return withAppendTx(ctx.pool, async (tx) => {
    const { card } = await loadVisibleCard(tx, user.id, idOrRef);
    const msg = cardMessage(card, { kind: 'user', userId: user.id }, 'comment', body);
    await ctx.store.append([msg], { tx });
    return { cardId: card.id as string, messageId: (msg.event.payload as { messageId: string }).messageId };
  });
}

export function releaseEvents(card: Row, actorUserId: string, reason: 'manual'): AppendInput[] {
  if (!card.claim_id) return [];
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'ClaimReleased',
        payload: { cardId: card.id, claimId: card.claim_id, agentId: card.claimed_by_agent_id, reason },
      },
      actor: userActor(actorUserId),
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

export async function moveCard(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  toStage: string,
  reason: string,
) {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status)) throw conflict('card_closed', `card is ${card.status}`);
    const wf = await loadWorkflowById(tx, card.workflow_version_id);
    const stage = wf ? getStage(wf.definition, toStage) : undefined;
    if (!stage)
      throw badRequest('unknown_stage', `stage '${toStage}' does not exist in this card's workflow`);
    if (stage.kind === 'terminal')
      throw badRequest('invalid_stage', 'use cancel or finalize to close a card');
    const missing = stage.kind === 'agent' ? requiredMissing(cardView(card), stage) : [];
    if (missing.length)
      throw unprocessable('missing_fields', `missing required fields: ${missing.join(', ')}`, { missing });
    const status = stage.kind === 'manual' ? 'draft' : 'queued';
    const events: AppendInput[] = [
      ...releaseEvents(card, user.id, 'manual'),
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardMovedByManager',
          payload: { cardId: card.id, fromStage: card.stage, toStage, status, reason },
        },
        actor: userActor(user.id),
        scope: projectScope(card.org_id, card.project_id),
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Moved from ${card.stage} to ${toStage} by ${user.displayName}: ${reason}`,
      ),
    ];
    await ctx.store.append(events, { tx });
    return card.id as string;
  });
}

export async function releaseCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string, reason?: string) {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (!card.claim_id) throw conflict('not_claimed', 'card is not claimed');
    await ctx.store.append(
      [
        ...releaseEvents(card, user.id, 'manual'),
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `Claim released by ${user.displayName}${reason ? `: ${reason}` : ''}`,
        ),
      ],
      { tx },
    );
    return card.id as string;
  });
}

/** Releases the loop breaker's back-off by hand: the card is dispatchable at once (docs/design/phases.md B0). */
export async function releaseBackoff(ctx: Ctx, user: AuthSession['user'], idOrRef: string, reason?: string) {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (!card.retry_after || !card.retry_episode_id)
      throw conflict('not_backing_off', 'card is not in back-off');
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardRetryReleased',
          payload: { cardId: card.id, episodeId: card.retry_episode_id, releasedBy: user.id, reason },
        },
        actor: userActor(user.id),
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Back-off released by ${user.displayName}${reason ? `: ${reason}` : ''}; the card can be dispatched again.`,
      ),
    ];
    for (const deskItemId of await openLoopAlerts(tx, card.id))
      events.push({
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemResolved',
          payload: {
            deskItemId,
            resolution: 'acknowledged',
            note: 'The manager released the back-off.',
            by: { kind: 'user', userId: user.id },
          },
        },
        actor: userActor(user.id),
        scope,
      });
    await ctx.store.append(events, { tx });
    return card.id as string;
  });
}

/**
 * Cancels one open card inside the caller's transaction: releases its claim, appends `CardCancelled` (and, for a bug
 * child, puts a waiting parent back in the Test queue unless it is cancelled too), and queues the removal of its
 * worktree (the branch is kept). Returns the workstation to deliver the queued command to.
 */
export async function cancelCardIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string; displayName: string },
  card: Row,
  reason: string,
  opts: { cause?: 'project_archived' | 'project_converted'; alsoCancelling?: ReadonlySet<string> } = {},
): Promise<string | undefined> {
  // A cancelled bug child will never pass review: the parent waiting on it goes back to the Test queue
  // (unless another bug child of the same parent is still open).
  const resume: AppendInput[] = [];
  if (
    card.parent_card_id &&
    card.origin === 'test_failure' &&
    !opts.alsoCancelling?.has(card.parent_card_id)
  ) {
    const parent = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [card.parent_card_id]);
    const open = await one(
      tx,
      `SELECT 1 FROM cards WHERE parent_card_id=$1 AND origin='test_failure' AND id<>$2
          AND status NOT IN ('done','cancelled') LIMIT 1`,
      [card.parent_card_id, card.id],
    );
    if (parent && parent.status === 'waiting' && !open) {
      resume.push(
        {
          streamId: streamId.card(parent.id),
          event: {
            type: 'ChildCardResolved',
            payload: { cardId: parent.id, childCardId: card.id, toStage: 'test' },
          },
          actor: userActor(user.id),
          scope: projectScope(parent.org_id, parent.project_id),
        },
        cardMessage(
          parent,
          { kind: 'system' },
          'system',
          `${card.ref} (${card.title}) was cancelled: ${parent.ref} is back in the Test queue.`,
        ),
      );
    }
  }
  await ctx.store.append(
    [
      ...releaseEvents(card, user.id, 'manual'),
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardCancelled',
          payload: { cardId: card.id, reason, ...(opts.cause ? { cause: opts.cause } : {}) },
        },
        actor: userActor(user.id),
        scope: projectScope(card.org_id, card.project_id),
      },
      cardMessage(card, { kind: 'system' }, 'system', `Cancelled by ${user.displayName}: ${reason}`),
      ...resume,
    ],
    { tx },
  );
  // A card that ends without a merge gives its worktree back (the branch is kept and listed in the phase report).
  if (card.worktree_path && card.home_workstation_id && !card.worktree_card_id) {
    await enqueueRunnerCommand(tx, card.home_workstation_id, 'worktree.remove', {
      repoId: card.repo_id ?? undefined,
      path: card.worktree_path,
      branchName: card.branch_name ?? undefined,
      deleteBranch: false,
    });
    return card.home_workstation_id as string;
  }
  return undefined;
}

export async function cancelCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string, reason: string) {
  let workstation: string | undefined;
  const id = await withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status))
      throw conflict('card_closed', `card is already ${card.status}`);
    workstation = await cancelCardIn(ctx, tx, user, card, reason);
    return card.id as string;
  });
  if (workstation) await ctx.services.gateway.deliverPending(workstation);
  return id;
}
