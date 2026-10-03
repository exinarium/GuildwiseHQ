import { randomUUID } from 'node:crypto';
import {
  type CardChanges,
  type CreateCardRequest,
  canManageCard,
  cardRef,
  emptyFields,
  type FillableCard,
  getStage,
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
import { badRequest, conflict, forbidden, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, userActor } from './common.ts';

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

export async function createCard(
  ctx: Ctx,
  user: AuthSession['user'],
  req: CreateCardRequest,
): Promise<{ cardId: string; missing?: string[] }> {
  return withAppendTx(ctx.pool, async (tx) => {
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
      priority: req.priority ?? 2,
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
            origin: 'manual',
            scheduled: false,
            repoId,
            priority: req.priority ?? 2,
            docsNeeded: req.docsNeeded ?? false,
            completionAction: req.completionAction,
            dependencies,
            requiredCapabilities: [],
          },
        },
        actor: userActor(user.id),
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
          actor: userActor(user.id),
          scope,
        });
      }
    }
    await ctx.store.append(events, { tx });
    return { cardId, missing };
  });
}

async function loadManageable(tx: Tx, user: AuthSession['user'], idOrRef: string) {
  const { card, role } = await loadVisibleCard(tx, user.id, idOrRef);
  if (!canManageCard({ userId: user.id, projectRole: role, cardOwnerUserId: card.owner_user_id })) {
    throw forbidden('only the card owner or the project owner can do this');
  }
  return card;
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
    if (patch.riskTier !== undefined && patch.riskTier !== card.risk_tier) {
      changes.riskTier = patch.riskTier;
      changes.riskTierOverridden = patch.riskTier !== null;
    }
    if (patch.fields !== undefined) {
      const merged = { ...card.fields, ...patch.fields };
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
          event: { type: 'CardUpdated', payload: { cardId: card.id, changes } },
          actor: userActor(user.id),
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
    return card.id as string;
  });
}

export async function specifyCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
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
          actor: userActor(user.id),
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
    return card.id as string;
  });
}

export async function commentOnCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string, body: string) {
  return withAppendTx(ctx.pool, async (tx) => {
    const { card } = await loadVisibleCard(tx, user.id, idOrRef);
    const msg = cardMessage(card, { kind: 'user', userId: user.id }, 'comment', body);
    await ctx.store.append([msg], { tx });
    return { cardId: card.id as string, messageId: (msg.event.payload as { messageId: string }).messageId };
  });
}

function releaseEvents(card: Row, actorUserId: string, reason: 'manual'): AppendInput[] {
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

export async function cancelCard(ctx: Ctx, user: AuthSession['user'], idOrRef: string, reason: string) {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    if (['done', 'cancelled'].includes(card.status))
      throw conflict('card_closed', `card is already ${card.status}`);
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
      ],
      { tx },
    );
    return card.id as string;
  });
}
