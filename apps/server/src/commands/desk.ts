import { randomUUID } from 'node:crypto';
import {
  type AnswerDeskItemRequest,
  BATCH_QUESTION_SUBKIND,
  CEO_PERMISSION_SUBKIND,
  type DeskActor,
  type DeskResolution,
  GATE_DESK_SUBKIND,
  HR_DESK_SUBKIND,
  isOrgManager,
  isPhaseDeskSubkind,
  PLATFORM_APPROVAL_SUBKINDS,
  type ResolveDeskItemRequest,
  type ShipReleaseApproval,
  streamId,
  TOPICS_DESK_SUBKIND,
  UNMAPPED_TICKET_SUBKIND,
  WORKING_BRANCH_SUBKIND,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import { acceptRecommendation, rejectRecommendation } from '../ceo/accept.ts';
import { onOwnerAnswer } from '../ceo/learning.ts';
import { rememberFromDeskAnswer } from '../ceo/memory.ts';
import { resolveCeoPermissionItem } from '../ceo/permissions.ts';
import { mayReviewTopics, reviewAllProposed } from '../ceo/topics.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { resolveGateItemIn } from '../governance/gates.ts';
import { resolvePlatformApprovalIn } from '../platform-team/approvals.ts';
import { canAnswerItem, DESK_VISIBLE } from '../queries/desk.ts';
import { resolveShipReleaseIn } from '../release/approve.ts';
import { dismissReleaseShipIn, retryReleaseShipIn, startReleaseShipIn } from '../release/ship.ts';
import {
  afterPlaybookRunDecision,
  PLAYBOOK_WORKSTATION_SUBKIND,
  resolvePlaybookRunIn,
} from '../sessions/playbooks.ts';
import { cardMessage, orgScope, projectScope, userActor } from './common.ts';
import { plannedVaultPath } from './decisions.ts';
import { resolveDefinitionIn } from './designer.ts';
import { resolveDevOpsApprovalIn } from './devops.ts';
import { mergedAnswerNotes } from './escalation.ts';
import { resolveLargeMergeIn } from './finalize.ts';
import { runHygieneForConfirmedRepo, workingBranchAnsweredEvents } from './hygiene.ts';
import { continueIntake, mappingAnsweredEvents } from './intake.ts';
import { batchAnsweredEvents, batchDismissedEvents } from './intake-batch.ts';
import { editLedgerEntry } from './ledger.ts';
import { findNearDuplicate } from './ledger-checks.ts';
import { resolveOutboundIn } from './outbox.ts';
import { relayAuthoredBundles } from './pack-authoring.ts';
import { afterAssignmentDecision, PACK_ASSIGNMENT_SUBKIND, resolvePackAssignmentIn } from './pack-holders.ts';
import { resolvePhaseDeskItemIn } from './phases.ts';
import { resolveRepoCreateIn, retryRepoCreateIn } from './repo-create.ts';
import { testerLoopAnswered } from './tester-loop.ts';
import { resolveVaultConflictIn } from './vaults.ts';

const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

/** Locks a visible desk item (404 when not visible) with the columns authorization needs. */
async function lockItem(
  tx: Tx,
  user: AuthSession['user'],
  id: string,
): Promise<{ item: Row; mayAct: boolean }> {
  const item = await one(
    tx,
    `SELECT d.*, c.owner_user_id AS card_owner, c.decision_policy AS card_policy, c.status AS card_status
       FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id
      WHERE d.id = $2 AND ${DESK_VISIBLE} FOR UPDATE OF d`,
    [user.id, id],
  );
  if (!item) throw notFound('desk item not found');
  const role = item.project_id ? await projectRole(tx, user.id, item.project_id) : null;
  return { item, mayAct: canAnswerItem(item, user.id, role, await orgRoleOf(tx, user.id, item.org_id)) };
}

const truncate = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Answers a question: one append with `QuestionAnswered` + `LedgerEntryAdded` (+ the answer on the card thread).
 * Every card blocked only by this item goes back to the queue (docs/ARCHITECTURE.md section 15). The decision
 * file for the vault is M3's hook on `QuestionAnswered`.
 */
export async function answerDeskItem(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  req: AnswerDeskItemRequest,
): Promise<{ ledgerEntryId: string; unblockedCardIds: string[] }> {
  const after: {
    mapped?: { intake: Row; projectKey: string };
    hygieneRepo?: string;
    batchQueued?: boolean;
    item?: Row;
  } = {};
  const answered = await withAppendTx(ctx.pool, async (tx) => {
    const { item, mayAct } = await lockItem(tx, user, id);
    if (item.status !== 'open') throw conflict('already_answered', `this item is already ${item.status}`);
    if (item.kind !== 'question' && item.kind !== 'escalation')
      throw badRequest('wrong_kind', 'approvals and alerts are resolved, not answered');
    // Manual QA is decided with the card's own actions (pass, skip, send back), which also close this item.
    if (item.subkind === 'manual_qa')
      throw badRequest(
        'use_qa_actions',
        'manual QA is decided on the card: pass, skip, send back or hand over (POST /api/cards/:id/qa/...)',
      );
    if (item.subkind === 'approval_step')
      throw badRequest(
        'use_approval_actions',
        'an approval is decided on the card: approve or send back (POST /api/cards/:id/approval/...)',
      );
    if (!mayAct) throw forbidden('only the card owner (or any manager, per the decision policy) can answer');
    if (req.optionId && !(item.options as Array<{ id: string }>).some((o) => o.id === req.optionId))
      throw badRequest('unknown_option', 'optionId is not one of the item options');

    const entryId = randomUUID();
    const scope = req.ledger.scope;
    const orgWide = scope === 'standing_order' && req.ledger.orgWide === true;
    // A project that keeps its decisions to itself (the platform project) never promotes an answer to the organization.
    if (orgWide && item.project_id) {
      const flag = await one(tx, 'SELECT decisions_project_only FROM projects WHERE id=$1', [
        item.project_id,
      ]);
      if (flag?.decisions_project_only)
        throw conflict(
          'project_only',
          'this project keeps its decisions at project level: they cannot be made organization-wide',
        );
    }
    // Standing orders bind agents beyond this card: project-wide ones need the project owner, org-wide ones the
    // org owner (the item's org is the project owner's org; other managers are only guests in it).
    if (scope === 'standing_order') {
      if (orgWide && !isOrgManager({ orgRole: await orgRoleOf(tx, user.id, item.org_id) }))
        throw forbidden('only the organization Owner and Admins can add organization-wide standing orders');
      if (!orgWide && item.project_id && (await projectRole(tx, user.id, item.project_id)) !== 'owner')
        throw forbidden('only the project owner can add project standing orders');
    }
    const title = req.ledger.title ?? truncate(item.title, 120);
    const body = `Question: ${item.title.trim()}\n\nAnswer: ${req.answer.trim()}`;

    const blocked = await rows<{ card_id: string }>(
      tx,
      `SELECT b.card_id FROM card_blockers b JOIN cards c ON c.id = b.card_id
        WHERE b.desk_item_id = $1 AND c.status = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM card_blockers o WHERE o.card_id = b.card_id AND o.desk_item_id <> $1)`,
      [item.id],
    );
    const projectId = orgWide || !item.project_id ? undefined : (item.project_id as string);
    const vaultPath = await plannedVaultPath(tx, {
      scope,
      orgId: item.org_id,
      projectId,
      decision: {
        deskItemId: item.id,
        question: item.body?.trim() ? item.body : item.title,
        answeredAt: ctx.clock.now(),
      },
    });
    const by: DeskActor = { kind: 'user', userId: user.id };
    const events: AppendInput[] = [
      {
        streamId: streamId.desk(item.id),
        event: {
          type: 'QuestionAnswered',
          payload: {
            deskItemId: item.id,
            answer: req.answer,
            ...(req.optionId ? { answerOption: req.optionId } : {}),
            answeredBy: by,
            ledgerEntryId: entryId,
            unblockedCardIds: req.keepBlockedUntil ? [] : blocked.map((b) => b.card_id),
            ...(req.keepBlockedUntil ? { keepBlockedUntil: req.keepBlockedUntil } : {}),
          },
        },
        actor: userActor(user.id),
        scope: itemScope(item),
      },
      {
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryAdded',
          payload: {
            entryId,
            scope,
            ...(orgWide || !item.project_id ? {} : { projectId: item.project_id }),
            ...(scope !== 'standing_order' && item.card_id ? { cardId: item.card_id } : {}),
            title,
            body,
            tags: [],
            sourceDeskItemId: item.id,
            ...(vaultPath ? { vaultPath } : {}),
          },
        },
        actor: userActor(user.id),
        scope: scope === 'standing_order' && orgWide ? orgScope(item.org_id) : itemScope(item),
      },
    ];
    if (item.card_id) {
      const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]);
      if (card)
        events.push(
          cardMessage(card, { kind: 'user', userId: user.id }, 'answer', req.answer, {
            deskItemId: item.id,
          }),
        );
    }
    events.push(
      ...(await mergedAnswerNotes(
        tx,
        item,
        blocked.map((b) => b.card_id),
        { kind: 'user', userId: user.id },
        req.answer,
        {},
      )),
    );
    // M7: the answer to a mapping question maps the intake's ticket to the chosen project (the option id).
    if (item.subkind === UNMAPPED_TICKET_SUBKIND) {
      if (!req.optionId) throw badRequest('option_required', 'pick the project this ticket belongs to');
      const m = await mappingAnsweredEvents(tx, item, user, req.optionId);
      if (m) {
        events.push(...m.events);
        after.mapped = { intake: m.intake, projectKey: m.projectKey };
      }
    }
    // Batch intake (#63): the answer goes to the ticket the question was about (the desk item's data names the
    // batch item); the item gets a new BA task that carries it.
    if (item.subkind === BATCH_QUESTION_SUBKIND) {
      const b = await batchAnsweredEvents(tx, item, req.answer);
      events.push(...b.events);
      after.batchQueued = b.queued;
    }
    // Hygiene: the answer to a working-branch question stores the branch on the repository.
    if (item.subkind === WORKING_BRANCH_SUBKIND) {
      const b = await workingBranchAnsweredEvents(tx, item, user, req);
      events.push(...b.events);
      if (b.hygieneForRepo) after.hygieneRepo = b.hygieneForRepo;
    }
    await ctx.store.append(events, { tx });
    // The tester loop: each option of that question performs its action (bug card, back to the tester, cancel).
    await testerLoopAnswered(ctx, tx, item, req.optionId, req.answer, {
      user,
      actor: userActor(user.id),
      author: { kind: 'user', userId: user.id },
    });
    after.item = item;
    return { ledgerEntryId: entryId, unblockedCardIds: blocked.map((b) => b.card_id) };
  });
  if (after.mapped) continueIntake(ctx, after.mapped.intake, after.mapped.projectKey);
  if (after.batchQueued) ctx.services.dispatcher.trigger();
  if (after.hygieneRepo) await runHygieneForConfirmedRepo(ctx, after.hygieneRepo);
  // The CEO learns from the owner's own answers (training observation, pattern candidates) and keeps a rule on request.
  const ans = after.item;
  if (ans && (await orgRoleOf(ctx.pool, user.id, ans.org_id)) === 'owner') {
    await onOwnerAnswer(ctx, ans.org_id, user.id, ans, { optionId: req.optionId, text: req.answer }).catch(
      (err) => ctx.log.error({ err }, 'ceo learning failed'),
    );
    if (req.remember)
      await rememberFromDeskAnswer(
        ctx,
        ans.org_id,
        user.id,
        { id: ans.id, title: ans.title, subkind: ans.subkind },
        req.answer,
      ).catch((err) => ctx.log.error({ err }, 'ceo remember failed'));
  }
  return answered;
}

/** Approves, rejects or acknowledges a non-question item. The domain event it triggers is the owning milestone's. */
export async function resolveDeskItem(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  req: ResolveDeskItemRequest,
): Promise<void> {
  await closeItem(
    ctx,
    user,
    id,
    req.resolution,
    req.note,
    req.editedBody,
    req.onDuplicate,
    req.workstationId,
    req.release,
  );
}

export async function dismissDeskItem(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  note?: string,
): Promise<void> {
  await closeItem(ctx, user, id, 'dismissed', note);
}

async function closeItem(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  resolution: DeskResolution,
  note?: string,
  editedBody?: string,
  onDuplicate?: 'merge',
  workstationId?: string,
  release?: ShipReleaseApproval,
) {
  let mergeInto: { id: string; body: string } | undefined;
  let workstationToDeliver: string | undefined;
  let devops = false;
  let partial = false;
  let phases = false;
  let ceoItem: Row | undefined;
  let topicsItem: Row | undefined;
  let packWorkstation: string | undefined;
  let packAccepted = false;
  let packId: string | undefined;
  let playbookRun: { requestId: string; accepted: boolean } | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    const { item, mayAct } = await lockItem(tx, user, id);
    // Acknowledging a "repository not created" alert is not giving up on the request: Retry still works on it while
    // the request is failed (retryRepoCreateIn enforces that), and the alert is not resolved a second time.
    const retryClosedAlert =
      item.status !== 'open' &&
      item.kind === 'alert' &&
      (item.subkind === 'repo_create_failed' || item.subkind === 'release_failed') &&
      resolution === 'approved';
    if (item.status !== 'open' && !retryClosedAlert)
      throw conflict('already_resolved', `this item is already ${item.status}`);
    if (item.kind === 'question' && resolution !== 'dismissed')
      throw badRequest('wrong_kind', 'questions are answered (POST /api/desk/:id/answer) or dismissed');
    if (!mayAct) throw forbidden('only the card owner (or any manager, per the decision policy) can do this');
    // The CEO's recommendations are the Owner's to accept (docs/design/ceo-agent-v2.md: Admins read only).
    if (item.subkind === 'ceo_recommendation') {
      if ((await orgRoleOf(tx, user.id, item.org_id)) !== 'owner')
        throw forbidden('only the organization Owner can accept or decline the CEO recommendations');
      ceoItem = item;
    }
    // The batch of research topics: only who may review them answers (in a customer organization, the Owner alone).
    if (item.subkind === TOPICS_DESK_SUBKIND) {
      if (!(await mayReviewTopics(tx, user.id, item.org_id)))
        throw forbidden('only the organization Owner can decide what is sent to Guildwise');
      topicsItem = item;
    }
    // M3 kinds: resolving the item acts on the DevOps request / paused vault in the same transaction.
    if (item.kind === 'approval' && item.subkind === 'devops') {
      if (resolution === 'acknowledged')
        throw badRequest('wrong_resolution', 'a DevOps approval is approved or rejected');
      const req = await one(tx, `SELECT id FROM devops_requests WHERE approval->>'deskItemId' = $1`, [
        item.id,
      ]);
      if (!req) throw notFound('devops request not found');
      const r = await resolveDevOpsApprovalIn(
        ctx,
        tx,
        user,
        req.id,
        resolution === 'approved' ? 'approved' : 'rejected',
        note,
      );
      devops = true;
      // G-Q8: one of the two parties said yes; the item stays open for the other.
      partial = !r.final;
    } else if (item.kind === 'approval' && item.subkind === CEO_PERMISSION_SUBKIND) {
      // "Authorize this execution": approved = once, rejected = deny; the waiting turn reads the answer on its next poll.
      if (resolution === 'acknowledged')
        throw badRequest('wrong_resolution', 'an execution is authorized or denied');
      await resolveCeoPermissionItem(ctx, tx, user, item, resolution);
    } else if (item.kind === 'approval' && item.subkind === 'large_merge' && resolution !== 'dismissed') {
      if (resolution === 'acknowledged')
        throw badRequest('wrong_resolution', 'a merge approval is approved or rejected');
      workstationToDeliver = (await resolveLargeMergeIn(ctx, tx, user, item, resolution, note)) ?? undefined;
    } else if (item.kind === 'approval' && PLATFORM_APPROVAL_SUBKINDS.has(item.subkind)) {
      // Platform team (Lean Team v3): deploy and downtime approvals and stop-loss decisions on the platform organisation's
      // desk, a grant request on the client organisation's desk.
      await resolvePlatformApprovalIn(ctx, tx, user, item, resolution, note);
    } else if (isPhaseDeskSubkind(item.subkind)) {
      // Phases: confirm a BA proposal, approve or reject the follow-ups, acknowledge the results (any member).
      await resolvePhaseDeskItemIn(ctx, tx, user, item, resolution, note);
      phases = true;
    } else if (item.kind === 'approval' && item.subkind === GATE_DESK_SUBKIND) {
      // S-B1: an agent paused on a gated action; approved lets its next attempt go through (once)
      await resolveGateItemIn(ctx, tx, user, item, resolution);
    } else if (item.kind === 'approval' && item.subkind === PACK_ASSIGNMENT_SUBKIND) {
      // R3a: the member decides whether a pack may be placed on their workstation; approved lets the runner clone it.
      if (resolution === 'acknowledged')
        throw badRequest('wrong_resolution', 'a pack is allowed on your workstation or declined');
      packWorkstation = await resolvePackAssignmentIn(ctx, tx, user, item, resolution);
      packAccepted = resolution === 'approved';
      packId = (item.data as { packId?: string } | null)?.packId;
    } else if (item.kind === 'approval' && item.subkind === PLAYBOOK_WORKSTATION_SUBKIND) {
      // Q69: the chat person picks one of their workstations for an agent-started playbook, or declines
      playbookRun = await resolvePlaybookRunIn(ctx, tx, user, item, resolution as never, workstationId);
    } else if (item.kind === 'approval' && item.subkind === 'definition') {
      // M10: approving makes the role or workflow available; only the owner decides.
      await resolveDefinitionIn(ctx, tx, user, item, resolution, note);
    } else if (item.kind === 'approval' && item.subkind === 'outbound') {
      // M8: only the card's owner decides; an approved draft is posted by their own workstation, exactly as approved.
      workstationToDeliver =
        (await resolveOutboundIn(ctx, tx, user, item, resolution, note, editedBody)) ?? undefined;
    } else if (item.kind === 'approval' && item.subkind === 'ship_release') {
      // Ship release: only the project owner decides; approving records the version, components and notes (nothing is pushed).
      await resolveShipReleaseIn(ctx, tx, user, item, resolution, release);
      // Approved: the release commit goes to a workstation in the same transaction (none available: the approval rolls back).
      if (resolution === 'approved') workstationToDeliver = await startReleaseShipIn(ctx, tx, user, item);
    } else if (item.kind === 'approval' && item.subkind === 'repo_create') {
      // Approved repository setup: only the project owner decides; their own workstation creates it with their gh login.
      workstationToDeliver = (await resolveRepoCreateIn(ctx, tx, user, item, resolution, note)) ?? undefined;
    } else if (item.kind === 'alert' && item.subkind === 'release_failed') {
      // A stopped release: Retry sends the stored command again; Dismiss abandons the release.
      if (resolution === 'approved') workstationToDeliver = await retryReleaseShipIn(ctx, tx, user, item);
      else if (resolution === 'dismissed') await dismissReleaseShipIn(ctx, tx, user, item);
    } else if (item.kind === 'alert' && item.subkind === 'repo_create_failed' && resolution === 'approved') {
      // Retry of a failed repository creation (works for alerts stored without options, too): owner only, and the
      // request must still be failed; the same request goes to the owner's workstation again.
      workstationToDeliver = await retryRepoCreateIn(ctx, tx, user, item);
    } else if (
      item.kind === 'escalation' &&
      item.subkind === 'vault_conflict' &&
      resolution !== 'dismissed'
    ) {
      if (resolution !== 'acknowledged')
        throw badRequest('wrong_resolution', 'a vault conflict is acknowledged once you have resolved it');
      const wv = await one(
        tx,
        'SELECT workstation_id, vault_id FROM workstation_vaults WHERE desk_item_id = $1',
        [item.id],
      );
      if (!wv) throw notFound('vault conflict not found');
      await resolveVaultConflictIn(ctx, tx, user, wv.vault_id, wv.workstation_id);
      workstationToDeliver = wv.workstation_id;
    }
    // An approved standing-order proposal (HR, the CEO, a card's answer) becomes a ledger entry in the same transaction as
    // the approval: a near-duplicate of a live order refuses the approval (409, the item stays open) unless the owner asks
    // to merge it into that order, so "Approved" always means "it is in the ledger".
    const orderEvents: AppendInput[] = [];
    if (
      item.kind === 'approval' &&
      item.subkind === HR_DESK_SUBKIND.standingOrder &&
      resolution === 'approved'
    ) {
      const body = (editedBody?.trim() || item.body || '').trim();
      const projectId: string | undefined = item.project_id ?? undefined;
      const title =
        String(item.title)
          .replace(/^Add a standing order: /, '')
          .slice(0, 120) || 'Standing order';
      const live = await rows<{ id: string; title: string; body: string }>(
        tx,
        `SELECT id, title, body FROM ledger_entries
          WHERE org_id=$1 AND scope='standing_order' AND superseded_by IS NULL AND retired_at IS NULL
            AND (project_id IS NULL OR project_id IS NOT DISTINCT FROM $2::uuid)
          ORDER BY created_at DESC, id`,
        [item.org_id, projectId ?? null],
      );
      const dup = findNearDuplicate({ title, body }, live);
      if (dup && onDuplicate !== 'merge')
        throw conflict(
          'duplicate_order',
          `a standing order that says the same already exists: "${dup.title}" (${dup.id}); merge this wording into it, or dismiss this proposal`,
          { existingId: dup.id, existingTitle: dup.title },
        );
      if (dup) mergeInto = { id: dup.id, body };
      else {
        const entryId = randomUUID();
        const vaultPath = await plannedVaultPath(tx, {
          scope: 'standing_order',
          orgId: item.org_id,
          projectId,
        });
        orderEvents.push({
          streamId: streamId.ledger(entryId),
          event: {
            type: 'LedgerEntryAdded',
            payload: {
              entryId,
              scope: 'standing_order',
              ...(projectId ? { projectId } : {}),
              title,
              body,
              tags: ['hr'],
              sourceDeskItemId: item.id,
              ...(vaultPath ? { vaultPath } : {}),
            },
          },
          actor: userActor(user.id),
          scope: itemScope(item),
        });
      }
    }
    const batchEvents =
      item.subkind === BATCH_QUESTION_SUBKIND && resolution === 'dismissed'
        ? await batchDismissedEvents(tx, item)
        : [];
    if (!retryClosedAlert && !partial)
      await ctx.store.append(
        [
          ...batchEvents,
          ...orderEvents,
          {
            streamId: streamId.desk(item.id),
            event: {
              type: 'DeskItemResolved',
              payload: {
                deskItemId: item.id,
                resolution,
                ...(note ? { note } : {}),
                ...(editedBody ? { editedBody } : {}),
                by: { kind: 'user', userId: user.id },
              },
            },
            actor: userActor(user.id),
            scope: itemScope(item),
          },
        ],
        { tx },
      );
  });
  // Merge: the existing order takes the new wording (its permissions apply; the earlier wording stays in its history).
  if (mergeInto) await editLedgerEntry(ctx, user, mergeInto.id, { body: mergeInto.body });
  if (devops || phases) ctx.services.dispatcher.trigger();
  if (topicsItem && (resolution === 'approved' || resolution === 'rejected'))
    await reviewAllProposed(
      ctx,
      user.id,
      topicsItem.org_id,
      resolution === 'approved' ? 'accepted' : 'rejected',
    );
  if (ceoItem) {
    if (resolution === 'approved') await acceptRecommendation(ctx, user, ceoItem);
    else await rejectRecommendation(ctx, user, ceoItem, note);
  }
  if (workstationToDeliver) await ctx.services.gateway.deliverPending(workstationToDeliver);
  if (playbookRun) await afterPlaybookRunDecision(ctx, playbookRun);
  if (packWorkstation) {
    await afterAssignmentDecision(ctx, packWorkstation);
    if (packAccepted && packId) await relayAuthoredBundles(ctx, packId);
  }
}
