import { BA_ROLE_KEY, RiskTierRpcParamsSchema } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { editRefusal, patchCardIn } from './cards.ts';
import { agentActor } from './common.ts';
import type { RpcReply } from './intake.ts';

/**
 * The BA's `card.risk` RPC (`aom risk <small|large> --reason "..."`): overrides the card's risk tier from a shift.
 * Same effect as the manager's override on the card page: the tier drives the review tier and the large-merge approval.
 */
export async function riskTierRpc(
  ctx: Ctx,
  shift: Record<string, any>,
  params: Record<string, unknown>,
): Promise<RpcReply> {
  const p = RiskTierRpcParamsSchema.safeParse(params);
  if (!p.success) return [false, undefined, 'usage: aom risk <small|large> --reason "<why>"'];
  if (!shift.card_id || shift.kind !== 'card')
    return [false, undefined, 'the risk tier is set in a card shift'];
  return withAppendTx(ctx.pool, async (tx): Promise<RpcReply> => {
    const agent = await one(tx, 'SELECT role_key FROM agents WHERE id=$1', [shift.agent_id]);
    if (agent?.role_key !== BA_ROLE_KEY)
      return [false, undefined, 'only the business analyst overrides the risk tier from a shift'];
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [shift.card_id]);
    if (!card || card.claim_shift_id !== shift.id)
      return [false, undefined, 'this shift no longer holds the claim'];
    const refusal = editRefusal(card, { riskTier: p.data.tier });
    if (refusal) return [false, undefined, refusal.message];
    await patchCardIn(
      ctx,
      tx,
      { id: card.owner_user_id } as AuthSession['user'],
      card.id,
      { riskTier: p.data.tier, reason: p.data.reason },
      { actor: agentActor(shift.agent_id) },
    );
    return [
      true,
      {
        message: `Risk tier of ${card.ref} is now ${p.data.tier} (override). It drives the review tier and the merge approval.`,
      },
    ];
  });
}
