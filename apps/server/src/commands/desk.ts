import { randomUUID } from 'node:crypto';
import {
  type AnswerDeskItemRequest,
  type DeskActor,
  type DeskResolution,
  type ResolveDeskItemRequest,
  streamId,
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
  return withAppendTx(ctx.pool, async (tx) => {
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
    const title = req.ledger.title ?? truncate(item.title, 120);
    const body = `Question: ${item.title.trim()}\n\nAnswer: ${req.answer.trim()}`;

    const blocked = await rows<{ card_id: string }>(
      tx,
      `SELECT b.card_id FROM card_blockers b JOIN cards c ON c.id = b.card_id
        WHERE b.desk_item_id = $1 AND c.status = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM card_blockers o WHERE o.card_id = b.card_id AND o.desk_item_id <> $1)`,
      [item.id],
    );
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
    await ctx.store.append(events, { tx });
    return { ledgerEntryId: entryId, unblockedCardIds: blocked.map((b) => b.card_id) };
  });
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
  await withAppendTx(ctx.pool, async (tx) => {
    const { item, mayAct } = await lockItem(tx, user, id);
    if (item.status !== 'open') throw conflict('already_resolved', `this item is already ${item.status}`);
    if (item.kind === 'question' && resolution !== 'dismissed')
      throw badRequest('wrong_kind', 'questions are answered (POST /api/desk/:id/answer) or dismissed');
    if (!mayAct) throw forbidden('only the card owner (or any manager, per the decision policy) can do this');
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
}
