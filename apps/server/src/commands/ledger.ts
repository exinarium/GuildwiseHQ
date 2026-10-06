import { randomUUID } from 'node:crypto';
import { type CreateLedgerEntryRequest, isOrgManager, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
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
  requestOrg: string | null,
  req: CreateLedgerEntryRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    let projectId = req.projectId;
    let cardId = req.cardId;
    let orgId = requestOrg;
    let myRole: string | null = null;
    if (cardId) {
      const { card } = await loadVisibleCard(tx, user.id, cardId);
      projectId = card.project_id;
      cardId = card.id;
      orgId = card.org_id;
      myRole = card.my_role;
    } else if (projectId) {
      const project = await loadVisibleProject(tx, user.id, projectId);
      orgId = project.org_id;
      myRole = project.my_role;
    }
    // Standing orders bind the project's agents (a card-scoped request still writes a project-wide order):
    // the project owner (the organization's Owner and Admins) decides, whether or not a cardId was supplied.
    if (projectId && req.scope === 'standing_order' && myRole !== 'owner')
      throw forbidden('only the organization Owner and Admins can add project standing orders');
    if (!orgId) throw forbidden('you do not belong to an organization');
    // An organization-wide entry (no project) is the Owner's and Admins'.
    if (!projectId && !isOrgManager({ orgRole: await orgRoleOf(tx, user.id, orgId) }))
      throw forbidden('only the organization Owner and Admins can add organization-wide entries');
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
