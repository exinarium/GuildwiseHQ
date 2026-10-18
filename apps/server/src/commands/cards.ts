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
  workflowHasIntegrationGuard,
  workflowSupportsInvestigationOnly,
  workflowUsesRepos,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject, projectRole } from '../authz/scope.ts';
import { loadWorkflowById, resolveWorkflow, type WorkflowVersionRow } from '../catalogue/loader.ts';
import { resolveProjectCardWorkflow } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { singleRepoDefault } from './card-repo.ts';
import { cardMessage, projectScope, userActor } from './common.ts';
import { integrationTestsDefault } from './integration-tests.ts';
import { openLoopAlerts } from './loop-breaker.ts';
import { NO_VAULT_MESSAGE, projectHasVault } from './vaults.ts';

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
  // A card that has a QA document is in the manual QA flow: its QA stages are active (`when manualQa` / `qaAgent`).
  // The flags for a card that has not left Finalize are derived by `finalizeNext` (commands/qa-flow.ts).
  return {
    ...c,
    ...cardView(c),
    ...(c.qa ? { manualQa: true, qaAgent: true } : {}),
    // code-v6: decided by the last review approval; `mergeReview` is only ever moved to by the server.
    ownerApproval: c.owner_approval_required === true,
  };
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
/**
 * Only people choose how a card lands (#52): an agent that names a completion action is refused, never silently
 * ignored, so the message teaches it. System actors (spawned cards) and people are unaffected.
 */
export function assertActorMaySetCompletionAction(
  actor: AppendInput['actor'] | undefined,
  completionAction: unknown,
): void {
  if (actor?.kind === 'agent' && completionAction !== undefined)
    throw badRequest(
      'completion_action_not_allowed',
      "agents may not set the completion action: the project's default applies to every card you create or update. Leave completionAction out; if this card needs a different landing, ask the manager to change it on the card page.",
    );
}

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
    designNeeded: hasStage
      ? (req.designNeeded ?? def.defaults?.designNeeded ?? project.design_step === true)
      : false,
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
  assertActorMaySetCompletionAction(acting.actor, req.completionAction);
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
  await assertVaultReportPath(tx, project.id, parsed.data);
  // Integration tests (backlog #59): the card follows the project's Run & test setting unless it was told otherwise.
  if (workflowHasIntegrationGuard(def) && parsed.data.integrationTests === undefined)
    parsed.data.integrationTests = await integrationTestsDefault(tx, project.id);

  let repoId = req.repoId;
  // A card whose workflow works in the vault (research in a code project) never takes a repository.
  if (!workflowUsesRepos(def)) repoId = undefined;
  else if (repoId) await assertRepoInProject(tx, project.id, repoId);
  else repoId = await singleRepoDefault(tx, project.id, def);
  // No completion action named: the card inherits the project's default (resolved when it is used), so only a
  // deliberate override is stored on the card.
  const completionAction: CompletionAction | undefined = req.completionAction;
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
          priorityScale: 2,
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

/**
 * What may change on which card. Heavy edits (title, fields, repository, flags, dependencies) need a draft or a queued,
 * unclaimed card. Light keys do not (#54): `priority` and `completionAction` change on any open card, claimed or not;
 * the risk tier changes on any open card. A pending merge (finalize awaiting approval or running) already captured the
 * completion action and the risk tier, so those two wait until it is settled. A done card still takes a priority
 * (it is the priority the card gets if it is reopened); a cancelled card takes nothing.
 */
export function editRefusal(card: Row, patch: PatchCardRequest): { code: string; message: string } | null {
  const {
    riskTier,
    reason: _reason,
    priority: _priority,
    completionAction,
    integrationTests,
    ...rest
  } = patch;
  const edits = Object.entries(rest).some(([, v]) => v !== undefined);
  if (
    card.status === 'cancelled' ||
    (card.status === 'done' &&
      (edits || riskTier !== undefined || completionAction !== undefined || integrationTests !== undefined))
  )
    return { code: 'card_closed', message: `card is ${card.status}` };
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
  const pending = card.finalize_state === 'awaiting_approval' || card.finalize_state === 'running';
  if (riskTier !== undefined && pending)
    return {
      code: 'finalize_pending',
      message: `${card.ref} has a merge pending: settle it before changing the risk tier`,
    };
  if (completionAction !== undefined && completionAction !== card.completion_action && pending)
    return {
      code: 'finalize_pending',
      message: `${card.ref} is being finalised with the completion action it had when the finalise was requested: settle it first; the new action applies to the next finalise`,
    };
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
  if (card.status === 'cancelled' || card.status === 'done') {
    const closed = editRefusal(card, patch);
    if (closed) throw conflict(closed.code, closed.message);
  }
  assertActorMaySetCompletionAction(acting.actor, patch.completionAction);
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
    // Only a path that is new on this card is checked: a card that already has one can still be edited.
    if ((parsed.data as Record<string, unknown>).reportPath !== (card.fields as Row | null)?.reportPath)
      await assertVaultReportPath(tx, card.project_id, parsed.data);
    changes.fields = parsed.data;
  }
  if (patch.dependencies !== undefined) {
    await assertDependencies(tx, card.project_id, patch.dependencies, card.id);
    changes.dependencies = patch.dependencies;
  }
  if (patch.integrationTests !== undefined) {
    const current = (changes.fields ?? card.fields ?? {}) as Record<string, unknown>;
    if (current.integrationTests !== patch.integrationTests) {
      // A light key like the priority (any open card), but only until the Test stage has started: after that the
      // environment, the shift and the suite results exist.
      const stages = wf?.definition.stages ?? [];
      const testAt = stages.findIndex((s) => s.id === 'test');
      const at = stages.findIndex((s) => s.id === card.stage);
      if (testAt >= 0 && at >= testAt)
        throw conflict('test_started', `${card.ref} has reached its Test stage: the choice is made`);
      changes.fields = { ...current, integrationTests: patch.integrationTests };
    }
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

/** A card report path `vault:...` needs a knowledge vault for the project (the runner refuses the report otherwise). */
async function assertVaultReportPath(db: Queryable, projectId: string, fields: unknown): Promise<void> {
  const p = (fields as { reportPath?: unknown } | null | undefined)?.reportPath;
  if (typeof p === 'string' && p.trim().startsWith('vault:') && !(await projectHasVault(db, projectId)))
    throw badRequest(
      'no_vault',
      `the report path '${p.trim()}' needs a knowledge vault. ${NO_VAULT_MESSAGE}`,
    );
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
  await assertVaultReportPath(tx, card.project_id, card.fields);
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
    // A person's step (manual QA, an approval) opens by itself when the card reaches it: it is not a place to move to.
    if (
      stage.kind === 'human' ||
      stage.kind === 'server' ||
      (stage.id === 'qa_steps' && (wf?.definition.key === 'code' || wf?.definition.key === 'code-v6'))
    )
      throw badRequest('invalid_stage', 'a step for a person starts by itself when the card reaches it');
    const missing = stage.kind === 'agent' ? requiredMissing(cardView(card), stage) : [];
    if (missing.length)
      throw unprocessable('missing_fields', `missing required fields: ${missing.join(', ')}`, { missing });
    const status = stage.kind === 'manual' ? 'draft' : 'queued';
    // Moving a card out of manual QA closes the person's desk item.
    const approval = card.approval as { deskItemId?: string | null; stageId?: string; state?: string } | null;
    const qa =
      card.stage === 'qa_steps' || card.stage === 'manual_qa'
        ? (card.qa as { deskItemId?: string | null } | null)
        : approval?.state === 'open' && approval.stageId === card.stage
          ? approval
          : null;
    const qaItem = qa?.deskItemId
      ? await one(tx, 'SELECT status FROM desk_items WHERE id=$1', [qa.deskItemId])
      : undefined;
    const events: AppendInput[] = [
      ...(qaItem?.status === 'open' && qa?.deskItemId
        ? [
            {
              streamId: streamId.desk(qa.deskItemId),
              event: {
                type: 'DeskItemResolved' as const,
                payload: {
                  deskItemId: qa.deskItemId,
                  resolution: 'dismissed' as const,
                  note: `Moved to ${toStage} by ${user.displayName}`,
                  by: { kind: 'user' as const, userId: user.id },
                },
              },
              actor: userActor(user.id),
              scope: projectScope(card.org_id, card.project_id),
            },
          ]
        : []),
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

/**
 * Puts a done or cancelled card back to work in an agent or manual stage of its pinned workflow (owner/manager only,
 * like a move). The card keeps its branch and worktree record and the earlier finalize result (a PR url stays in the
 * history); the next shift reuses the branch and a later `pr` finalize reuses the open pull request. Open cards that
 * depend on it are held again by the dependency gate; the ones that already started get a note.
 */
export async function reopenCard(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  toStage: string,
  reason: string,
) {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (!['done', 'cancelled'].includes(card.status))
      throw conflict(
        'not_closed',
        `only a done or cancelled card can be reopened (this one is ${card.status})`,
      );
    const wf = await loadWorkflowById(tx, card.workflow_version_id);
    const stage = wf ? getStage(wf.definition, toStage) : undefined;
    if (!stage)
      throw badRequest('unknown_stage', `stage '${toStage}' does not exist in this card's workflow`);
    if (stage.kind !== 'agent' && stage.kind !== 'manual')
      throw badRequest('invalid_stage', 'a card is reopened into a work stage (an agent or manual stage)');
    const missing = stage.kind === 'agent' ? requiredMissing(cardView(card), stage) : [];
    if (missing.length)
      throw unprocessable('missing_fields', `missing required fields: ${missing.join(', ')}`, { missing });
    const status = stage.kind === 'manual' ? 'draft' : 'queued';
    const earlier = (card.finalize_result ?? {}) as { prUrl?: string; pushedBranch?: string };
    const earlierNote = earlier.prUrl
      ? ` An earlier pull request exists: ${earlier.prUrl} (finalizing again reuses it while it is open).`
      : earlier.pushedBranch
        ? ` The branch ${earlier.pushedBranch} was pushed earlier.`
        : '';
    const scope = projectScope(card.org_id, card.project_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardReopened',
          payload: {
            cardId: card.id,
            fromStage: card.stage,
            fromStatus: card.status,
            toStage,
            status,
            reason,
            by: user.id,
          },
        },
        actor: userActor(user.id),
        scope,
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `Reopened by ${user.displayName} into ${stage.label}: ${reason}. The card branch${card.branch_name ? ` ${card.branch_name}` : ''} is kept and the next shift continues on it.${earlierNote}`,
      ),
    ];
    const dependents = await rows(
      tx,
      `SELECT c.* FROM card_dependencies d JOIN cards c ON c.id = d.card_id
        WHERE d.depends_on_card_id = $1 AND c.status NOT IN ('done','cancelled')`,
      [card.id],
    );
    for (const dep of dependents) {
      const started = dep.claim_id || dep.worktree_path || dep.rework_round > 0;
      if (started)
        events.push(
          cardMessage(
            dep,
            { kind: 'system' },
            'system',
            `${card.ref} (a card this one depends on) was reopened by ${user.displayName}: ${reason}. Its work may change; check the result again before you finish.`,
          ),
        );
    }
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

/**
 * The open sub-workflow children of a waiting card that `user` may cancel (their own project role decides, like any
 * cancel), nested children included. Children the user may not manage are left alone.
 */
async function cancellableChildren(
  tx: Tx,
  user: AuthSession['user'],
  parentId: string,
  seen = new Set<string>(),
): Promise<Row[]> {
  const out: Row[] = [];
  const kids = await rows(
    tx,
    `SELECT ch.* FROM subworkflow_runs r JOIN cards ch ON ch.id = r.child_card_id
      WHERE r.parent_card_id=$1 AND r.status='open' AND ch.status NOT IN ('done','cancelled')
      ORDER BY r.started_at FOR UPDATE OF ch`,
    [parentId],
  );
  for (const ch of kids) {
    if (seen.has(ch.id)) continue;
    seen.add(ch.id);
    const role = await projectRole(tx, user.id, ch.project_id);
    if (!canManageCard({ userId: user.id, projectRole: role, cardOwnerUserId: ch.owner_user_id })) continue;
    out.push(ch, ...(await cancellableChildren(tx, user, ch.id, seen)));
  }
  return out;
}

export async function cancelCard(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  reason: string,
  opts: { alsoCancelChildren?: boolean } = {},
) {
  const workstations = new Set<string>();
  const id = await withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status))
      throw conflict('card_closed', `card is already ${card.status}`);
    // Read the children first: once the parent is cancelled nothing links them to it but the run rows.
    const children =
      opts.alsoCancelChildren && card.status === 'waiting'
        ? await cancellableChildren(tx, user, card.id)
        : [];
    const ws = await cancelCardIn(ctx, tx, user, card, reason);
    if (ws) workstations.add(ws);
    for (const child of children) {
      const w = await cancelCardIn(
        ctx,
        tx,
        user,
        child,
        `Cancelled together with ${card.ref} (${card.title}): ${reason}`,
      );
      if (w) workstations.add(w);
    }
    return card.id as string;
  });
  for (const w of workstations) await ctx.services.gateway.deliverPending(w);
  return id;
}
