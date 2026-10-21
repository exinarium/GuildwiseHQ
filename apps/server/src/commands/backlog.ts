import { randomUUID } from 'node:crypto';
import {
  BACKLOG_CARD_PRIORITY,
  BACKLOG_SEND_MAX,
  type BacklogFilter,
  type BacklogItemDto,
  type BacklogSendResult,
  backlogContextBlock,
  type CreateBacklogItemRequest,
  filterBacklog,
  isOrgManager,
  type PatchBacklogItemRequest,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject, visibleProjectIds } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { orgRoleOf } from '../auth/org-context.ts';
import { conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { baIntakeIn } from './ba-intake.ts';
import { projectScope, userActor } from './common.ts';
import { hasActiveBa } from './spec-card.ts';

const ITEM_SELECT = `SELECT b.*, p.key AS project_key FROM backlog_items b JOIN projects p ON p.id = b.project_id`;

export function backlogItemDto(r: Row): BacklogItemDto {
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project_key,
    title: r.title,
    description: r.description,
    priority: r.priority,
    tags: r.tags ?? [],
    flagged: r.flagged,
    status: r.status,
    source:
      r.source_kind === 'agent'
        ? {
            kind: 'agent',
            agentId: r.source_agent_id,
            agentName: r.source_agent_name ?? 'An agent',
            cardRef: r.source_card_ref ?? null,
          }
        : { kind: 'owner' },
    cardRef: r.card_ref ?? null,
    cardId: r.card_id ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Reading needs project membership; writing needs the organization Owner or an Admin (the people who start an intake). */
async function assertManager(db: Queryable, user: AuthSession['user'], orgId: string): Promise<void> {
  if (!isOrgManager({ orgRole: await orgRoleOf(db, user.id, orgId) }))
    throw forbidden('only the organization Owner and Admins can change the backlog');
}

/** The one status guard: edit, flag, drop and send need an Open item. Done is set only by Send to BA. */
export function assertOpen(item: Row): void {
  if (item.status === 'done')
    throw conflict('backlog_not_open', `"${item.title}" already became ${item.card_ref ?? 'a card'}`);
  if (item.status === 'dropped') throw conflict('backlog_not_open', `"${item.title}" was dropped`);
}

/** The item, only when the user can see its project (404 otherwise: project A's items never show through project B). */
async function loadItem(db: Queryable, user: AuthSession['user'], itemId: string, lock = false): Promise<Row> {
  const item = await one(db, `${ITEM_SELECT} WHERE b.id = $1${lock ? ' FOR UPDATE OF b' : ''}`, [itemId]);
  if (!item) throw notFound('backlog item not found');
  try {
    await loadVisibleProject(db, user.id, item.project_id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw notFound('backlog item not found');
    throw e;
  }
  return item;
}

export async function listBacklog(
  ctx: Ctx,
  user: AuthSession['user'],
  scope: { projectId: string } | { orgId: string },
  filter: BacklogFilter,
): Promise<{ items: BacklogItemDto[]; tags: string[] }> {
  let all: Row[];
  if ('projectId' in scope) {
    await loadVisibleProject(ctx.pool, user.id, scope.projectId);
    all = await rows(ctx.pool, `${ITEM_SELECT} WHERE b.project_id = $1`, [scope.projectId]);
  } else {
    const visible = await visibleProjectIds(ctx.pool, user.id);
    all = await rows(ctx.pool, `${ITEM_SELECT} WHERE b.org_id = $1 AND b.project_id = ANY($2::uuid[])`, [
      scope.orgId,
      visible,
    ]);
  }
  const dtos = all.map(backlogItemDto);
  const tags = [...new Set(dtos.flatMap((i) => i.tags))].sort();
  return { items: filterBacklog(dtos, filter), tags };
}

export async function getBacklogItem(ctx: Ctx, user: AuthSession['user'], itemId: string): Promise<BacklogItemDto> {
  return backlogItemDto(await loadItem(ctx.pool, user, itemId));
}

export type BacklogActor =
  | { kind: 'owner'; user: AuthSession['user'] }
  | {
      kind: 'agent';
      agentId: string;
      agentName: string;
      shiftId: string;
      cardId?: string;
      cardRef?: string;
    };

/** Appends `BacklogItemAdded` in `tx`. Creates no card, no desk item and wakes nothing (R2). */
export async function addBacklogItemIn(
  ctx: Ctx,
  tx: Tx,
  by: BacklogActor,
  projectId: string,
  req: CreateBacklogItemRequest,
): Promise<BacklogItemDto> {
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [projectId]);
  if (!project) throw notFound('project not found');
  if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
  const itemId = randomUUID();
  const source =
    by.kind === 'owner'
      ? ({ kind: 'owner', userId: by.user.id } as const)
      : ({
          kind: 'agent',
          agentId: by.agentId,
          agentName: by.agentName,
          shiftId: by.shiftId,
          ...(by.cardId ? { cardId: by.cardId } : {}),
          ...(by.cardRef ? { cardRef: by.cardRef } : {}),
        } as const);
  await ctx.store.append(
    [
      {
        streamId: streamId.backlog(itemId),
        event: {
          type: 'BacklogItemAdded',
          payload: {
            itemId,
            projectId,
            title: req.title,
            description: req.description,
            priority: req.priority,
            tags: req.tags,
            flagged: req.flagged,
            source,
          },
        },
        actor: by.kind === 'owner' ? userActor(by.user.id) : { kind: 'agent', id: by.agentId },
        scope: projectScope(project.org_id, projectId),
      },
    ],
    { tx },
  );
  return backlogItemDto((await one(tx, `${ITEM_SELECT} WHERE b.id=$1`, [itemId])) as Row);
}

export async function addBacklogItem(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: CreateBacklogItemRequest,
): Promise<BacklogItemDto> {
  const project = await loadVisibleProject(ctx.pool, user.id, projectId);
  await assertManager(ctx.pool, user, project.org_id);
  return withAppendTx(ctx.pool, (tx) => addBacklogItemIn(ctx, tx, { kind: 'owner', user }, projectId, req));
}

export async function editBacklogItem(
  ctx: Ctx,
  user: AuthSession['user'],
  itemId: string,
  patch: PatchBacklogItemRequest,
): Promise<BacklogItemDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const item = await loadItem(tx, user, itemId, true);
    await assertManager(tx, user, item.org_id);
    assertOpen(item);
    const events: AppendInput[] = [];
    const scope = projectScope(item.org_id, item.project_id);
    const edit: Record<string, unknown> = {};
    if (patch.title !== undefined && patch.title !== item.title) edit.title = patch.title;
    if (patch.description !== undefined && patch.description !== item.description)
      edit.description = patch.description;
    if (patch.priority !== undefined && patch.priority !== item.priority) edit.priority = patch.priority;
    if (patch.tags !== undefined && patch.tags.join('\n') !== (item.tags as string[]).join('\n'))
      edit.tags = patch.tags;
    if (Object.keys(edit).length)
      events.push({
        streamId: streamId.backlog(itemId),
        event: { type: 'BacklogItemEdited', payload: { itemId, ...edit } },
        actor: userActor(user.id),
        scope,
      });
    if (patch.flagged !== undefined && patch.flagged !== item.flagged)
      events.push({
        streamId: streamId.backlog(itemId),
        event: { type: 'BacklogItemFlagged', payload: { itemId, flagged: patch.flagged } },
        actor: userActor(user.id),
        scope,
      });
    if (events.length) await ctx.store.append(events, { tx });
    return backlogItemDto((await one(tx, `${ITEM_SELECT} WHERE b.id=$1`, [itemId])) as Row);
  });
}

export async function dropBacklogItem(
  ctx: Ctx,
  user: AuthSession['user'],
  itemId: string,
): Promise<BacklogItemDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    const item = await loadItem(tx, user, itemId, true);
    await assertManager(tx, user, item.org_id);
    assertOpen(item);
    await ctx.store.append(
      [
        {
          streamId: streamId.backlog(itemId),
          event: { type: 'BacklogItemDropped', payload: { itemId } },
          actor: userActor(user.id),
          scope: projectScope(item.org_id, item.project_id),
        },
      ],
      { tx },
    );
    return backlogItemDto((await one(tx, `${ITEM_SELECT} WHERE b.id=$1`, [itemId])) as Row);
  });
}

/**
 * Send to BA: the CEO's intake path (a draft card and a `spec_card` task for the BA) and the item's `BacklogItemSent` in
 * one transaction, so the item is Done and linked only when the card exists. Any failure rolls both back.
 */
export async function sendBacklogItem(
  ctx: Ctx,
  user: AuthSession['user'],
  itemId: string,
): Promise<{ item: BacklogItemDto; result: BacklogSendResult }> {
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const row = await loadItem(tx, user, itemId, true);
    await assertManager(tx, user, row.org_id);
    assertOpen(row);
    if (!(await hasActiveBa(tx, row.org_id)))
      throw conflict('no_ba', 'Hire a business analyst (BA) first: Send to BA needs one.');
    const dto = backlogItemDto(row);
    const r = await baIntakeIn(ctx, tx, row.org_id, user, {
      projectId: row.project_id,
      title: row.title,
      text: backlogContextBlock(dto),
      priority: BACKLOG_CARD_PRIORITY[dto.priority],
    });
    const ref = r.ref ?? '';
    await ctx.store.append(
      [
        {
          streamId: streamId.backlog(itemId),
          event: { type: 'BacklogItemSent', payload: { itemId, cardId: r.cardId, cardRef: ref } },
          actor: userActor(user.id),
          scope: projectScope(row.org_id, row.project_id),
        },
      ],
      { tx },
    );
    const item = backlogItemDto((await one(tx, `${ITEM_SELECT} WHERE b.id=$1`, [itemId])) as Row);
    const result: BacklogSendResult = {
      itemId,
      title: row.title,
      ok: true,
      cardRef: ref,
      cardId: r.cardId,
      ...(r.next && !r.next.queued ? { note: `${ref}: ${r.next.text}` } : {}),
    };
    return { item, result };
  });
  ctx.services.dispatcher.trigger();
  return out;
}

/** Bulk: one transaction per item, so a failed item leaves the others alone. Results come back in input order. */
export async function sendBacklogItems(
  ctx: Ctx,
  user: AuthSession['user'],
  itemIds: string[],
): Promise<BacklogSendResult[]> {
  const ids = [...new Set(itemIds)].slice(0, BACKLOG_SEND_MAX);
  const results: BacklogSendResult[] = [];
  for (const id of ids) {
    try {
      results.push((await sendBacklogItem(ctx, user, id)).result);
    } catch (err) {
      const title = (await one(ctx.pool, 'SELECT title FROM backlog_items WHERE id=$1', [id]))?.title ?? id;
      results.push({
        itemId: id,
        title,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof HttpError ? { code: err.code } : {}),
      });
    }
  }
  return results;
}
