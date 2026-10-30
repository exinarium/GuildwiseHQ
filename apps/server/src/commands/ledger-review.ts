import { ledgerToday, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, projectScope, userActor } from './common.ts';
import { assertCanManageEntry } from './ledger-retire.ts';

/** A review date given when an entry is added: today or later. */
export function assertReviewDateNotPast(reviewDate: string | null | undefined, today: string): void {
  if (reviewDate && reviewDate < today)
    throw badRequest('review_date_past', 'the review date is in the past; pick today or a later date');
}

export interface ReviewRow extends Row {
  id: string;
  org_id: string;
  project_id: string | null;
  retired_at: unknown;
  superseded_by: string | null;
  /** `review_date::text` (never the parsed Date: pg reads a date as local midnight). */
  review_date_text: string | null;
}

/**
 * The events that set, change, clear or confirm the review date of a loaded entry; `[]` when nothing changes. Pure over
 * the row. A date change is its own event: it never goes through `LedgerEntryEdited`, so full power is untouched.
 */
export function reviewDateEvents(
  e: ReviewRow,
  reviewDate: string | null,
  opts: { confirmed: boolean; today: string; actor: AppendInput['actor'] },
): AppendInput[] {
  if (e.retired_at) throw conflict('retired', 'this entry was retired; its review date cannot be changed');
  if (e.superseded_by) throw conflict('superseded', 'this entry was replaced; change the current one');
  const due = !!e.review_date_text && e.review_date_text <= opts.today;
  if (opts.confirmed) {
    if (!due) throw conflict('not_due', 'this entry is not due for review');
    if (reviewDate && reviewDate <= opts.today)
      throw badRequest(
        'review_date_past',
        'the review date is in the past; pick a date after today, or no date',
      );
  } else {
    if (reviewDate === e.review_date_text) return [];
    assertReviewDateNotPast(reviewDate, opts.today);
  }
  return [
    {
      streamId: streamId.ledger(e.id),
      event: {
        type: 'LedgerEntryReviewDateSet',
        payload: { entryId: e.id, reviewDate, confirmed: opts.confirmed },
      },
      actor: opts.actor,
      scope: e.project_id ? projectScope(e.org_id, e.project_id) : orgScope(e.org_id),
    },
  ];
}

/** Sets, changes or clears (null) the review date of an entry, or confirms a due one. Returns whether anything was written. */
export async function setLedgerReviewDate(
  ctx: Ctx,
  user: AuthSession['user'],
  entryId: string,
  req: { reviewDate: string | null; confirmed: boolean },
): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const e = await one<ReviewRow>(
      tx,
      'SELECT *, review_date::text AS review_date_text FROM ledger_entries WHERE id=$1 FOR UPDATE',
      [entryId],
    );
    if (!e) throw notFound('ledger entry not found');
    await assertCanManageEntry(tx, user.id, e, 'change the review date of');
    const events = reviewDateEvents(e, req.reviewDate, {
      confirmed: req.confirmed,
      today: ledgerToday(ctx.clock.now()),
      actor: userActor(user.id),
    });
    if (events.length === 0) return false;
    await ctx.store.append(events, { tx });
    return true;
  });
}
