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
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { plannedVaultPath } from './decisions.ts';
import { raiseOrCoalesce } from './desk-coalesce.ts';
import { findContradictions, findNearDuplicate } from './ledger-checks.ts';

export interface AddLedgerResult {
  entryId: string;
  /** The wording went into an existing near-duplicate instead of a new entry. */
  merged: boolean;
  /** Live standing orders the new one may contradict (it was saved and flagged). */
  conflictsWith: string[];
}

/** The live standing orders a new order is compared with: the organization's own and the project's. */
async function liveOrdersFor(
  db: Parameters<typeof rows>[0],
  orgId: string,
  projectId: string | undefined,
): Promise<Array<{ id: string; title: string; body: string; project_id: string | null }>> {
  return rows(
    db,
    `SELECT id, title, body, project_id FROM ledger_entries
      WHERE org_id=$1 AND scope='standing_order' AND superseded_by IS NULL AND retired_at IS NULL
        AND (project_id IS NULL OR project_id IS NOT DISTINCT FROM $2::uuid)
      ORDER BY created_at DESC, id`,
    [orgId, projectId ?? null],
  );
}

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
  return (await addLedgerEntryChecked(ctx, user, requestOrg, req)).entryId;
}

/**
 * Adds an entry; a standing order is first compared with the live ones. A near-duplicate is refused with a pointer to the
 * existing entry (409 `duplicate_order`), or merged into it when the caller asks (`onDuplicate: 'merge'`). A possible
 * contradiction (same subject, opposing instruction) is saved but flagged, and one desk item goes to the owner and BA.
 */
export async function addLedgerEntryChecked(
  ctx: Ctx,
  user: AuthSession['user'],
  requestOrg: string | null,
  req: CreateLedgerEntryRequest,
): Promise<AddLedgerResult> {
  let mergeInto: { id: string; title: string } | undefined;
  const result = await withAppendTx(ctx.pool, async (tx): Promise<AddLedgerResult | undefined> => {
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
    const live = req.scope === 'standing_order' && orgId ? await liveOrdersFor(tx, orgId, projectId) : [];
    const dup = findNearDuplicate(req, live);
    if (dup) {
      if (req.onDuplicate === 'merge') {
        mergeInto = { id: dup.id, title: dup.title };
        return undefined;
      }
      throw conflict(
        'duplicate_order',
        `a standing order that says the same already exists: "${dup.title}" (${dup.id}); edit that one, retire it, or merge`,
        { existingId: dup.id, existingTitle: dup.title },
      );
    }
    const clashes = findContradictions(req, live);
    const entryId = randomUUID();
    // Only standing orders are mirrored to the vault from here; decisions come from answered questions.
    const vaultPath =
      req.scope === 'standing_order'
        ? await plannedVaultPath(tx, { scope: req.scope, orgId, projectId })
        : undefined;
    const scope = projectId ? projectScope(orgId, projectId) : orgScope(orgId);
    const events: AppendInput[] = [
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
        scope,
      },
    ];
    if (clashes.length > 0) {
      events.push({
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryFlagged',
          payload: {
            entryId,
            conflictsWith: clashes.map((c) => c.id).slice(0, 10),
            reason: 'same subject, opposing instruction (word heuristic)',
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      });
      await raiseOrCoalesce(
        ctx,
        {
          subjectKey: `ledger_conflict:${entryId}`,
          orgId,
          kind: 'alert',
          subkind: 'ledger_conflict',
          title: `A new standing order may contradict an existing one: ${req.title}`.slice(0, 200),
          body: `"${req.title}" was saved, but it looks like it says the opposite of: ${clashes
            .map((c) => `"${c.title}"`)
            .join(', ')}. Agents get both until one is retired. Open the ledger to retire or reword one.`,
          pinned: false,
          ...(projectId ? { projectId } : {}),
          data: { entryId, conflictsWith: clashes.map((c) => c.id) },
          actor: SYSTEM_ACTOR,
          scope,
        },
        { tx, extra: events },
      );
    } else await ctx.store.append(events, { tx });
    return { entryId, merged: false, conflictsWith: clashes.map((c) => c.id) };
  });
  if (result) return result;
  // Merge: the existing order takes the new wording (its permissions apply; the earlier wording stays in its history).
  const existing = mergeInto as { id: string; title: string };
  await editLedgerEntry(ctx, user, existing.id, { body: req.body, tags: req.tags });
  return { entryId: existing.id, merged: true, conflictsWith: [] };
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
    if (e.retired_at) throw conflict('retired', 'this entry was retired; it cannot be edited');
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
