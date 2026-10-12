import { parseCardFields, streamId } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { devopsCardBrief } from '../runner-gateway/brief.ts';
import { assertNoMockFields } from './cards.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';

type RpcReply = [boolean, unknown?, string?];

/**
 * The card verbs of a DevOps shift (`aom card show|comment|update`). A DevOps shift has no claim on a card; its only card
 * is the one its request was filed for (`devops_requests.card_id` of the request this shift works), looked up here on the
 * server, never taken from the caller. A ref the caller names must be that card's, so no other card is readable or
 * writable. Only fields and comments: the title, stage, status and claim of the card are not touched.
 */
export async function devopsCardRpc(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const req = await one(ctx.pool, 'SELECT id, card_id, org_id FROM devops_requests WHERE shift_id=$1', [
    shift.id,
  ]);
  if (!req?.card_id) return [false, undefined, 'this DevOps request was not filed for a card'];
  const card = await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1 AND org_id=$2', [
    req.card_id,
    req.org_id,
  ]);
  if (!card) return [false, undefined, 'the card of this request is gone'];
  const ref = typeof params.ref === 'string' ? params.ref.trim() : '';
  if (ref && ref.toUpperCase() !== String(card.ref).toUpperCase())
    return [
      false,
      undefined,
      `this request is for ${card.ref}: DevOps can only read or change that card, not ${ref}`,
    ];
  switch (method) {
    case 'card.get': {
      const view = await devopsCardBrief(ctx, card.id, req.org_id);
      return view ? [true, view] : [false, undefined, 'card unavailable'];
    }
    case 'card.comment': {
      const body = String(params.body ?? params.note ?? '').trim();
      if (!body) return [false, undefined, 'a comment text is required'];
      if (body.length > 20000) return [false, undefined, 'the comment is too long'];
      const m = cardMessage(card, { kind: 'agent', agentId: shift.agent_id }, 'comment', body);
      await ctx.store.append([m]);
      return [true, { messageId: (m.event.payload as { messageId: string }).messageId }];
    }
    case 'card.update': {
      const fields = params.fields;
      const others = Object.keys(params).filter((k) => k !== 'ref' && k !== 'fields');
      if (
        others.length > 0 ||
        !fields ||
        typeof fields !== 'object' ||
        Array.isArray(fields) ||
        Object.keys(fields).length === 0
      )
        return [
          false,
          undefined,
          'DevOps can only update the fields of the card: aom card update <REF> --json \'{"fields":{"<name>":"<value>"}}\'',
        ];
      if (['done', 'cancelled'].includes(card.status))
        return [false, undefined, `${card.ref} is ${card.status}: it can no longer be changed`];
      const patch = fields as Record<string, unknown>;
      try {
        await withAppendTx(ctx.pool, async (tx) => {
          const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [card.id])) as Row;
          await assertNoMockFields(ctx, tx, fresh.project_id, patch);
          const wf = await loadWorkflowById(tx, fresh.workflow_version_id);
          const merged: Record<string, unknown> = { ...fresh.fields };
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          const parsed = parseCardFields(wf?.definition.fieldSet ?? 'code', merged);
          if (!parsed.success)
            throw new Error(
              `invalid fields: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
            );
          await ctx.store.append(
            [
              {
                streamId: streamId.card(fresh.id),
                event: {
                  type: 'CardUpdated',
                  payload: { cardId: fresh.id, changes: { fields: parsed.data } },
                },
                actor: agentActor(shift.agent_id),
                scope: projectScope(fresh.org_id, fresh.project_id),
              },
            ],
            { tx },
          );
        });
        const names = Object.keys(patch);
        return [
          true,
          { ref: card.ref, updated: names, message: `Updated ${card.ref}: ${names.join(', ')}.` },
        ];
      } catch (err) {
        return [false, undefined, err instanceof Error ? err.message : String(err)];
      }
    }
    default:
      return [false, undefined, `${method} is not available in a DevOps request`];
  }
}
