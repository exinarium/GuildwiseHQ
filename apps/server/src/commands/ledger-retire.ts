import { isOrgManager, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { voidAuthorityEvents } from '../ceo/orders.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, projectScope, userActor } from './common.ts';

export interface RetireInput {
  reason: string;
  supersededBy?: string | undefined;
}

/**
 * Appends `LedgerEntryRetired` for a live entry (no permission check: callers decide who may). Returns false when the
 * entry was already retired. A retired entry stays in the ledger for the record, is never injected into a prompt and is
 * never found by a search.
 */
export async function retireLedgerEntryAs(
  ctx: Ctx,
  entryId: string,
  input: RetireInput,
  by: { actor: AppendInput['actor']; label: 'owner' | 'ba' | 'ceo' | 'system'; orgId?: string },
): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const e = await one(tx, 'SELECT * FROM ledger_entries WHERE id=$1 FOR UPDATE', [entryId]);
    if (!e || (by.orgId && e.org_id !== by.orgId)) throw notFound('ledger entry not found');
    if (e.retired_at) return false;
    if (input.supersededBy) {
      const repl = await one(tx, 'SELECT org_id FROM ledger_entries WHERE id=$1', [input.supersededBy]);
      if (!repl || repl.org_id !== e.org_id || input.supersededBy === entryId)
        throw conflict(
          'bad_replacement',
          'the replacing entry must be another entry of the same organization',
        );
    }
    const scope = e.project_id ? projectScope(e.org_id, e.project_id) : orgScope(e.org_id);
    await ctx.store.append(
      [
        // A retired order carries no full power (docs/design/ceo-front-door.md section 3.4).
        ...(await voidAuthorityEvents(tx, entryId, 'retired', scope)),
        {
          streamId: streamId.ledger(entryId),
          event: {
            type: 'LedgerEntryRetired',
            payload: {
              entryId,
              reason: input.reason.trim(),
              ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
              by: by.label,
            },
          },
          actor: by.actor,
          scope,
        },
      ],
      { tx },
    );
    return true;
  });
}

/**
 * Who may manage (retire, or set the review date of) an entry: the people who may edit it (org-wide: Owner and Admins;
 * project: the project owner). An entry outside the caller's reach does not exist for them (404).
 */
export async function assertCanManageEntry(
  db: Queryable,
  userId: string,
  e: { org_id: string; project_id: string | null },
  what = 'retire',
): Promise<void> {
  if (e.project_id) {
    const project = await loadVisibleProject(db, userId, e.project_id);
    if (project.my_role !== 'owner') throw forbidden(`only the project owner can ${what} project entries`);
  } else {
    const role = await orgRoleOf(db, userId, e.org_id);
    if (!role) throw notFound('ledger entry not found');
    if (!isOrgManager({ orgRole: role }))
      throw forbidden(`only the organization Owner and Admins can ${what} organization-wide entries`);
  }
}

/** Who may retire an entry: the people who may edit it (org-wide: Owner and Admins; project: the project owner). */
export async function retireLedgerEntry(
  ctx: Ctx,
  user: AuthSession['user'],
  entryId: string,
  req: RetireInput,
): Promise<boolean> {
  const e = await one(ctx.pool, 'SELECT org_id, project_id FROM ledger_entries WHERE id=$1', [entryId]);
  if (!e) throw notFound('ledger entry not found');
  await assertCanManageEntry(ctx.pool, user.id, e);
  return retireLedgerEntryAs(ctx, entryId, req, { actor: userActor(user.id), label: 'owner' });
}
