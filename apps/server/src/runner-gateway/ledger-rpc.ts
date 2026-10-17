import { LedgerSearchParamsSchema, type LedgerSearchResult } from '@aom/shared';
import { agentActor } from '../commands/common.ts';
import { retireLedgerEntryAs } from '../commands/ledger-retire.ts';
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

/**
 * `ledger.retire` RPC: the BA withdraws an entry of its organization with a reason (`aom ledger retire <id> --reason`).
 * Other roles cannot: they ask the BA or the owner. Returns the usual `[ok, result, error]` of the rpc handlers.
 */
export async function ledgerRetireRpc(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<[boolean, unknown, string | undefined]> {
  const agent = await one(ctx.pool, 'SELECT id, role_key, org_id FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent || agent.role_key !== 'ba')
    return [false, undefined, 'only the BA can retire a ledger entry; ask the BA or the owner'];
  const id = String(params.id ?? '');
  const reason = String(params.reason ?? '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return [false, undefined, 'usage: aom ledger retire <entry id> --reason "<why>"'];
  if (!reason) return [false, undefined, 'a reason is required: aom ledger retire <id> --reason "<why>"'];
  const by = params.supersededBy ? String(params.supersededBy) : undefined;
  try {
    const done = await retireLedgerEntryAs(
      ctx,
      id,
      { reason, supersededBy: by },
      { actor: agentActor(agent.id), label: 'ba', orgId: agent.org_id },
    );
    return [
      true,
      { retired: done, message: done ? 'Entry retired.' : 'Entry was already retired.' },
      undefined,
    ];
  } catch (err) {
    return [false, undefined, (err as Error).message];
  }
}
