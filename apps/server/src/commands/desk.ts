import { randomUUID } from 'node:crypto';
import {
  type AnswerDeskItemRequest,
  type DeskActor,
  type DeskResolution,
  isPhaseDeskSubkind,
  type ResolveDeskItemRequest,
  streamId,
  UNMAPPED_TICKET_SUBKIND,
  WORKING_BRANCH_SUBKIND,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { canAnswerItem, DESK_VISIBLE } from '../queries/desk.ts';
import { cardMessage, orgScope, projectScope, userActor } from './common.ts';
import { plannedVaultPath } from './decisions.ts';
import { resolveDefinitionIn } from './designer.ts';
import { resolveDevOpsApprovalIn } from './devops.ts';
import { mergedAnswerNotes } from './escalation.ts';
import { resolveLargeMergeIn } from './finalize.ts';
import { runHygieneForConfirmedRepo, workingBranchAnsweredEvents } from './hygiene.ts';
import { continueIntake, mappingAnsweredEvents } from './intake.ts';
import { resolveOutboundIn } from './outbox.ts';
import { resolvePhaseDeskItemIn } from './phases.ts';
import { resolveRepoCreateIn, retryRepoCreateIn } from './repo-create.ts';
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
  return { item, mayAct: canAnswerItem(item, user.id, role) };
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
  const after: { mapped?: { intake: Row; projectKey: string }; hygieneRepo?: string } = {};
  const answered = await withAppendTx(ctx.pool, async (tx) => {
    const { item, mayAct } = await lockItem(tx, user, id);
    if (item.status !== 'open') throw conflict('already_answered', `this item is already ${item.status}`);
    if (item.kind !== 'question' && item.kind !== 'escalation')
      throw badRequest('wrong_kind', 'approvals and alerts are resolved, not answered');
    if (!mayAct) throw forbidden('only the card owner (or any manager, per the decision policy) can answer');
    if (req.optionId && !(item.options as Array<{ id: string }>).some((o) => o.id === req.optionId))
      throw badRequest('unknown_option', 'optionId is not one of the item options');

    const entryId = randomUUID();
    const scope = req.ledger.scope;
    const orgWide = scope === 'standing_order' && req.ledger.orgWide === true;
    // Standing orders bind agents beyond this card: project-wide ones need the project owner, org-wide ones the
    // org owner (the item's org is the project owner's org; other managers are only guests in it).
    if (scope === 'standing_order') {
      if (orgWide && item.org_id !== user.id)
        throw forbidden('only the organization owner can add organization-wide standing orders');
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
            unblockedCardIds: blocked.map((b) => b.card_id),
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
    // Hygiene: the answer to a working-branch question stores the branch on the repository.
    if (item.subkind === WORKING_BRANCH_SUBKIND) {
      const b = await workingBranchAnsweredEvents(tx, item, user, req);
      events.push(...b.events);
      if (b.hygieneForRepo) after.hygieneRepo = b.hygieneForRepo;
    }
    await ctx.store.append(events, { tx });
    return { ledgerEntryId: entryId, unblockedCardIds: blocked.map((b) => b.card_id) };
  });
  if (after.mapped) continueIntake(ctx, after.mapped.intake, after.mapped.projectKey);
  if (after.hygieneRepo) await runHygieneForConfirmedRepo(ctx, after.hygieneRepo);
  return answered;
}

/** Approves, rejects or acknowledges a non-question item. The domain event it triggers is the owning milestone's. */
export async function resolveDeskItem(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  req: ResolveDeskItemRequest,
): Promise<void> {
  await closeItem(ctx, user, id, req.resolution, req.note, req.editedBody);
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
) {
  let workstationToDeliver: string | undefined;
  let devops = false;
  let phases = false;
  await withAppendTx(ctx.pool, async (tx) => {
    const { item, mayAct } = await lockItem(tx, user, id);
    // Acknowledging a "repository not created" alert is not giving up on the request: Retry still works on it while
    // the request is failed (retryRepoCreateIn enforces that), and the alert is not resolved a second time.
    const retryClosedAlert =
      item.status !== 'open' &&
      item.kind === 'alert' &&
      item.subkind === 'repo_create_failed' &&
      resolution === 'approved';
    if (item.status !== 'open' && !retryClosedAlert)
      throw conflict('already_resolved', `this item is already ${item.status}`);
    if (item.kind === 'question' && resolution !== 'dismissed')
      throw badRequest('wrong_kind', 'questions are answered (POST /api/desk/:id/answer) or dismissed');
    if (!mayAct) throw forbidden('only the card owner (or any manager, per the decision policy) can do this');
    // M3 kinds: resolving the item acts on the DevOps request / paused vault in the same transaction.
    if (item.kind === 'approval' && item.subkind === 'devops') {
      if (resolution === 'acknowledged')
        throw badRequest('wrong_resolution', 'a DevOps approval is approved or rejected');
      const req = await one(tx, `SELECT id FROM devops_requests WHERE approval->>'deskItemId' = $1`, [
        item.id,
      ]);
      if (!req) throw notFound('devops request not found');
      await resolveDevOpsApprovalIn(
        ctx,
        tx,
        user,
        req.id,
        resolution === 'approved' ? 'approved' : 'rejected',
        note,
      );
      devops = true;
    } else if (item.kind === 'approval' && item.subkind === 'large_merge' && resolution !== 'dismissed') {
      if (resolution === 'acknowledged')
        throw badRequest('wrong_resolution', 'a merge approval is approved or rejected');
      workstationToDeliver = (await resolveLargeMergeIn(ctx, tx, user, item, resolution, note)) ?? undefined;
    } else if (isPhaseDeskSubkind(item.subkind)) {
      // Phases: confirm a BA proposal, approve or reject the follow-ups, acknowledge the results (any member).
      await resolvePhaseDeskItemIn(ctx, tx, user, item, resolution, note);
      phases = true;
    } else if (item.kind === 'approval' && item.subkind === 'definition') {
      // M10: approving makes the role or workflow available; only the owner decides.
      await resolveDefinitionIn(ctx, tx, user, item, resolution, note);
    } else if (item.kind === 'approval' && item.subkind === 'outbound') {
      // M8: only the card's owner decides; an approved draft is posted by their own workstation, exactly as approved.
      workstationToDeliver =
        (await resolveOutboundIn(ctx, tx, user, item, resolution, note, editedBody)) ?? undefined;
    } else if (item.kind === 'approval' && item.subkind === 'repo_create') {
      // Approved repository setup: only the project owner decides; their own workstation creates it with their gh login.
      workstationToDeliver = (await resolveRepoCreateIn(ctx, tx, user, item, resolution, note)) ?? undefined;
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
    if (!retryClosedAlert)
      await ctx.store.append(
        [
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
  if (devops || phases) ctx.services.dispatcher.trigger();
  if (workstationToDeliver) await ctx.services.gateway.deliverPending(workstationToDeliver);
}
