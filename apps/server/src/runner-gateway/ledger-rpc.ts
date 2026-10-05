import { LedgerSearchParamsSchema, type LedgerSearchResult } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { searchLedger } from '../queries/ledger.ts';

/** `ledger.search` RPC: the agent's org, narrowed to the shift's project (plus org-wide standing orders). */
export async function ledgerSearchRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<LedgerSearchResult> {
  const p = LedgerSearchParamsSchema.safeParse({ ...params, query: String(params.query ?? '') });
  if (!p.success) return { entries: [] };
  // A question shift searches the project of the question it answers.
  const card = shift.card_id
    ? await one(ctx.pool, 'SELECT project_id FROM cards WHERE id=$1', [shift.card_id])
    : shift.desk_item_id
      ? await one(ctx.pool, 'SELECT project_id FROM desk_items WHERE id=$1', [shift.desk_item_id])
      : shift.ba_task_id
        ? await one(ctx.pool, 'SELECT project_id FROM ba_tasks WHERE id=$1', [shift.ba_task_id])
        : undefined;
  const entries = await searchLedger(ctx.pool, p.data.query, {
    orgId: shift.org_id,
    projectId: card?.project_id ?? null,
    scope: p.data.scope,
    limit: 10,
  });
  return { entries };
}
