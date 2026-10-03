import { randomUUID } from 'node:crypto';
import { type CreateLedgerEntryRequest, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden } from '../errors.ts';
import { orgScope, projectScope, userActor } from './common.ts';
import { plannedVaultPath } from './decisions.ts';

/**
 * The manager adds a requirement, decision or standing order directly (no question needed). Standing orders
 * without a project apply to every agent of the user's organization.
 */
export async function addLedgerEntry(
  ctx: Ctx,
  user: AuthSession['user'],
  req: CreateLedgerEntryRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    let projectId = req.projectId;
    let cardId = req.cardId;
    let orgId = user.id;
    if (cardId) {
      const { card } = await loadVisibleCard(tx, user.id, cardId);
      projectId = card.project_id;
      cardId = card.id;
      orgId = card.org_id;
    } else if (projectId) {
      const project = await loadVisibleProject(tx, user.id, projectId);
      orgId = project.org_id;
    }
    if (projectId && !cardId && req.scope === 'standing_order') {
      // Project standing orders bind the project's agents: the project owner decides.
      const p = await loadVisibleProject(tx, user.id, projectId);
      if (p.my_role !== 'owner') throw forbidden('only the project owner can add project standing orders');
    }
    const entryId = randomUUID();
    // Only standing orders are mirrored to the vault from here; decisions come from answered questions.
    const vaultPath =
      req.scope === 'standing_order'
        ? await plannedVaultPath(tx, { scope: req.scope, orgId, projectId })
        : undefined;
    await ctx.store.append(
      [
        {
          streamId: streamId.ledger(entryId),
          event: {
            type: 'LedgerEntryAdded',
            payload: {
              entryId,
              scope: req.scope,
              ...(projectId ? { projectId } : {}),
              ...(cardId ? { cardId } : {}),
              title: req.title,
              body: req.body,
              tags: req.tags,
              ...(vaultPath ? { vaultPath } : {}),
            },
          },
          actor: userActor(user.id),
          scope: projectId ? projectScope(orgId, projectId) : orgScope(orgId),
        },
      ],
      { tx },
    );
    return entryId;
  });
}
