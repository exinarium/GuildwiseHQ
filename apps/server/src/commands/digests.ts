import { type DigestItemDto, type RateDigestItemRequest, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { requireProjectMember } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { toDigestDto } from '../queries/digests.ts';
import { projectScope, userActor } from './common.ts';

/**
 * A verdict on one digest item: useful, irrelevant or boring, with an optional reason. Any active member of the
 * project may rate (the owner's taste is explicit in `taste.md`; see `taste.ts` for the write). When the last
 * unrated item of a digest gets its verdict the grouped desk item is closed. Re-rating is allowed; the taste file
 * keeps both lines so the history stays readable.
 */
export async function rateDigestItem(
  ctx: Ctx,
  user: AuthSession['user'],
  itemId: string,
  req: RateDigestItemRequest,
): Promise<DigestItemDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const item = await one(tx, 'SELECT * FROM digest_items WHERE id=$1 FOR UPDATE', [itemId]);
    if (!item) throw notFound('digest item not found');
    await requireProjectMember(tx, user.id, item.project_id, { allowInterest: true });
    const project = await one(tx, 'SELECT org_id FROM projects WHERE id=$1', [item.project_id]);
    const scope = projectScope(project?.org_id, item.project_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.card(item.card_id),
        event: {
          type: 'ItemRated',
          payload: {
            itemId,
            projectId: item.project_id,
            verdict: req.verdict,
            ...(req.reason?.trim() ? { reason: req.reason.trim() } : {}),
            ratedBy: user.id,
          },
        },
        actor: userActor(user.id),
        scope,
      },
    ];
    if (item.desk_item_id) {
      const rest = await one(
        tx,
        'SELECT 1 FROM digest_items WHERE desk_item_id=$1 AND verdict IS NULL AND id <> $2 LIMIT 1',
        [item.desk_item_id, itemId],
      );
      const desk = await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [
        item.desk_item_id,
      ]);
      if (!rest && desk) {
        events.push({
          streamId: streamId.desk(item.desk_item_id),
          event: {
            type: 'DeskItemResolved',
            payload: {
              deskItemId: item.desk_item_id,
              resolution: 'acknowledged',
              note: 'All items rated',
              by: { kind: 'user', userId: user.id },
            },
          },
          actor: userActor(user.id),
          scope,
        });
      }
    }
    await ctx.store.append(events, { tx });
    const row = await one(
      tx,
      `SELECT i.*, c.ref AS card_ref, p.key AS project_key FROM digest_items i
         JOIN cards c ON c.id = i.card_id JOIN projects p ON p.id = i.project_id WHERE i.id=$1`,
      [itemId],
    );
    return toDigestDto(row as never);
  });
}
