import {
  DIRECT_PROVIDER_IDS,
  isOrgOwner,
  type OrgModelPrice,
  type OrgModelPricesResponse,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden, notFound, unprocessable } from '../errors.ts';
import { orgScope, userActor } from './common.ts';

/**
 * Owner-set prices for models the built-in tables do not price (R2, docs/ARCHITECTURE.md section 38.6). The Owner only: a price
 * decides what the organization's spend looks like. The price is stamped on a turn when it ends (`costs/stamp.ts`), so changing it
 * never reprices the past, and the turn's cost row is marked `owner_priced`.
 */
async function requireOwner(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<void> {
  const role = await orgRoleOf(ctx.pool, user.id, orgId);
  if (role === null) throw notFound('organization not found');
  if (!isOrgOwner({ orgRole: role })) throw forbidden('only the organization Owner can set model prices');
}

export async function listOrgModelPrices(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
): Promise<OrgModelPricesResponse> {
  const role = await orgRoleOf(ctx.pool, user.id, orgId);
  if (role === null) throw notFound('organization not found');
  const r = await rows(ctx.pool, 'SELECT * FROM org_model_prices WHERE org_id=$1 ORDER BY provider, model', [
    orgId,
  ]);
  return {
    prices: r.map((x) => ({
      provider: x.provider,
      model: x.model,
      inputPerMtok: Number(x.input_per_mtok),
      outputPerMtok: Number(x.output_per_mtok),
      cacheReadPerMtok: x.cache_read_per_mtok === null ? null : Number(x.cache_read_per_mtok),
      setAt: x.set_at ? new Date(x.set_at).toISOString() : null,
    })),
  };
}

export async function setOrgModelPrice(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  price: OrgModelPrice,
): Promise<void> {
  await requireOwner(ctx, user, orgId);
  if (!(DIRECT_PROVIDER_IDS as readonly string[]).includes(price.provider))
    throw unprocessable(
      'not_a_model_provider',
      'prices are set for models of the Anthropic, OpenAI, Gemini and compatible providers',
    );
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one(tx, 'SELECT * FROM org_model_prices WHERE org_id=$1 AND provider=$2 AND model=$3', [
      orgId,
      price.provider,
      price.model,
    ]);
    if (
      cur &&
      Number(cur.input_per_mtok) === price.inputPerMtok &&
      Number(cur.output_per_mtok) === price.outputPerMtok &&
      (cur.cache_read_per_mtok === null ? null : Number(cur.cache_read_per_mtok)) === price.cacheReadPerMtok
    )
      return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: { type: 'OrgModelPriceSet', payload: { orgId, ...price, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}

export async function removeOrgModelPrice(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  provider: OrgModelPrice['provider'],
  model: string,
): Promise<void> {
  await requireOwner(ctx, user, orgId);
  await withAppendTx(ctx.pool, async (tx) => {
    if (
      !(await one(tx, 'SELECT 1 FROM org_model_prices WHERE org_id=$1 AND provider=$2 AND model=$3', [
        orgId,
        provider,
        model,
      ]))
    )
      return;
    await ctx.store.append(
      [
        {
          streamId: streamId.org(orgId),
          event: { type: 'OrgModelPriceRemoved', payload: { orgId, provider, model, by: user.id } },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}
