import { randomUUID } from 'node:crypto';
import {
  type CreateLedgerEntryRequest,
  type EditLedgerEntryRequest,
  isOrgManager,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
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

/**
 * Edits the wording of a live standing order in place (backlog #74): the title, the text and the tags. The people who may
 * add one may edit it (an organization-wide order: the Owner and Admins; a project's: the project owner). The earlier
 * wording stays in the entry's history, and the next brief any agent gets carries the new one. Returns false when
 * nothing changed.
 */
export async function editLedgerEntry(
  ctx: Ctx,
  user: AuthSession['user'],
  entryId: string,
  req: EditLedgerEntryRequest,
): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const e = await one(tx, 'SELECT * FROM ledger_entries WHERE id=$1 FOR UPDATE', [entryId]);
    if (!e) throw notFound('ledger entry not found');
    if (e.project_id) {
      // Not a member of the project: it does not exist for the caller.
      const project = await loadVisibleProject(tx, user.id, e.project_id);
      if (e.scope === 'standing_order' && project.my_role !== 'owner')
        throw forbidden('only the organization Owner and Admins can edit project standing orders');
    } else {
      const role = await orgRoleOf(tx, user.id, e.org_id);
      if (!role) throw notFound('ledger entry not found');
      if (!isOrgManager({ orgRole: role }))
        throw forbidden('only the organization Owner and Admins can edit organization-wide standing orders');
    }
    if (e.scope !== 'standing_order') throw conflict('not_editable', 'only standing orders can be edited');
    if (e.superseded_by)
      throw conflict('superseded', 'this standing order was replaced; edit the current one');
    const title = req.title?.trim() ?? e.title;
    const body = req.body?.trim() ?? e.body;
    const tags = req.tags ?? e.tags;
    if (title === e.title && body === e.body && JSON.stringify(tags) === JSON.stringify(e.tags)) return false;
    await ctx.store.append(
      [
        {
          streamId: streamId.ledger(entryId),
          event: { type: 'LedgerEntryEdited', payload: { entryId, title, body, tags } },
          actor: userActor(user.id),
          scope: e.project_id ? projectScope(e.org_id, e.project_id) : orgScope(e.org_id),
        },
      ],
      { tx },
    );
    return true;
  });
}
