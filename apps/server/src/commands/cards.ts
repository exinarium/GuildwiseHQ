import { randomUUID } from 'node:crypto';
import {
  type CardChanges,
  type CardOrigin,
  type CreateCardRequest,
  canManageCard,
  cardRef,
  DEFAULT_CARD_PRIORITY,
  emptyFields,
  type FillableCard,
  getStage,
  isMockField,
  type PatchCardRequest,
  parseCardFields,
  requiredMissing,
  type Stage,
  streamId,
  type WorkflowDefinition,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import { loadWorkflowById, resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { cardMessage, projectScope, userActor } from './common.ts';
import { openLoopAlerts } from './loop-breaker.ts';

/** The stage a `CardSpecified` moves the card into, and the outcome's resolved stage. */
export function specifyTarget(def: WorkflowDefinition): { from: string; to: string; stage: Stage } {
  const initial = getStage(def, def.initialStage) as Stage;
  const o =
    initial.outcomes.find((x) => x.event === 'CardSpecified') ??
    initial.outcomes.find((x) => x.kind === 'success');
  const to = initial.kind === 'manual' && o ? o.to : initial.id;
  return { from: initial.id, to, stage: getStage(def, to) as Stage };
}

export function cardView(c: Row): FillableCard {
  return {
    title: c.title,
    cardType: c.card_type,
    repoId: c.repo_id,
    completionAction: c.completion_action,
    docsNeeded: c.docs_needed,
    riskTier: c.risk_tier,
    priority: c.priority,
    fields: c.fields,
  };
}

/** Mock-runtime fields are refused unless the server runs with `AOM_MOCK_UI=true`. */
function assertNoMockFields(ctx: Ctx, fields: Record<string, unknown> | undefined) {
  if (ctx.config.mockUi || !fields) return;
  const used = Object.keys(fields).filter(
    (k) => isMockField(k) && fields[k] !== undefined && fields[k] !== null,
  );
  if (used.length)
    throw unprocessable(
      'mock_fields_disabled',
      `mock runtime fields (${used.join(', ')}) are only available when the server runs with AOM_MOCK_UI=true`,
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
  const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key);
  if (!wf) throw badRequest('unknown_workflow', `workflow '${project.workflow_key}' is not available`);
  const def = wf.definition;
  if (!def.cardTypes.includes(req.cardType)) {
    throw badRequest(
      'invalid_card_type',
      `card type '${req.cardType}' is not allowed in workflow '${def.key}'`,
    );
  }
  assertNoMockFields(ctx, req.fields);
  if (req.interestId) {
    // "Research this": the interest must be visible and its research (or feed) project must be the card's project.
    const interest = await one(
      tx,
      `SELECT feed_project_id, research_project_id FROM interests WHERE id=$1
          AND (feed_project_id IN (SELECT project_id FROM project_members WHERE user_id=$2 AND status='active')
            OR research_project_id IN (SELECT project_id FROM project_members WHERE user_id=$2 AND status='active'))`,
      [req.interestId, user.id],
    );
    if (!interest) throw notFound('interest not found');
    if (interest.feed_project_id !== project.id && interest.research_project_id !== project.id)
      throw badRequest('interest_project_mismatch', "the card's project is not a project of this interest");
  }
  const parsed = parseCardFields(def.fieldSet, { ...emptyFields(def.fieldSet), ...req.fields });
  if (!parsed.success) throw badRequest('invalid_fields', 'card fields are invalid', parsed.error.issues);

  let repoId = req.repoId;
  if (repoId) await assertRepoInProject(tx, project.id, repoId);
  else {
    const repos = await rows<{ id: string }>(
      tx,
      'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
      [project.id],
    );
    if (repos.length === 1) repoId = repos[0]?.id;
  }
  const dependencies = req.dependencies ?? [];
  await assertDependencies(tx, project.id, dependencies);

  const number = Number(
    (await one(tx, 'SELECT next_card_number FROM projects WHERE id=$1 FOR UPDATE', [project.id]))
      ?.next_card_number,
  );
  const cardId = randomUUID();
  const target = specifyTarget(def);
  const view: FillableCard = {
    title: req.title,
    cardType: req.cardType,
    repoId: repoId ?? null,
    completionAction: req.completionAction ?? null,
    docsNeeded: req.docsNeeded ?? false,
    riskTier: null,
    priority: req.priority ?? DEFAULT_CARD_PRIORITY,
    fields: parsed.data,
  };
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
          scheduled: false,
          repoId,
          priority: req.priority ?? DEFAULT_CARD_PRIORITY,
          docsNeeded: req.docsNeeded ?? false,
          completionAction: req.completionAction,
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
    missing = requiredMissing(view, target.stage);
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
    assertNoMockFields(ctx, patch.fields);
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
  const target = specifyTarget(wf.definition);
  const missing = requiredMissing(cardView(card), target.stage);
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

export async function cancelCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string, reason: string) {
  let workstation: string | undefined;
  const id = await withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status))
      throw conflict('card_closed', `card is already ${card.status}`);
    // A cancelled bug child will never pass review: the parent waiting on it goes back to the Test queue
    // (unless another bug child of the same parent is still open).
    const resume: AppendInput[] = [];
    if (card.parent_card_id && card.origin === 'test_failure') {
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
          event: { type: 'CardCancelled', payload: { cardId: card.id, reason } },
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
      workstation = card.home_workstation_id;
    }
    return card.id as string;
  });
  if (workstation) await ctx.services.gateway.deliverPending(workstation);
  return id;
}
