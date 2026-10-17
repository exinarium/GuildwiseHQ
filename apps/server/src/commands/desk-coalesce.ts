import { randomUUID } from 'node:crypto';
import type { Actor, Scope } from '@aom/shared';
import { streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

export interface CoalescedItem {
  /** Identifies the subject; an open item with the same key and org takes a counter instead of a second item. */
  subjectKey: string;
  orgId: string;
  kind: 'approval' | 'escalation' | 'alert';
  subkind: string;
  title: string;
  body: string;
  pinned?: boolean;
  blocking?: boolean;
  projectId?: string;
  cardId?: string;
  data?: Record<string, unknown>;
  askedBy?: { kind: 'agent' | 'user' | 'system'; agentId?: string; userId?: string; role?: string };
  actor: Actor;
  scope: Scope;
}

/** The open item of this subject, if any. */
export async function openItemForSubject(
  db: Queryable,
  orgId: string,
  subjectKey: string,
): Promise<{ id: string; repeat_count: number } | undefined> {
  return one(
    db,
    `SELECT id, repeat_count FROM desk_items WHERE org_id=$1 AND subject_key=$2 AND status='open'
      ORDER BY created_at DESC LIMIT 1`,
    [orgId, subjectKey],
  );
}

/**
 * Raises a desk item about a subject, or counts the repeat on the item that is still open for it (Lean Team v3: the same
 * thing does not fill the desk again and again). Returns the item and whether it was new.
 */
export async function raiseOrCoalesce(
  ctx: Ctx,
  item: CoalescedItem,
  opts: { tx?: Tx; extra?: AppendInput[] } = {},
): Promise<{ deskItemId: string; created: boolean; count: number }> {
  const db: Queryable = opts.tx ?? ctx.pool;
  const open = await openItemForSubject(db, item.orgId, item.subjectKey);
  const append = (events: AppendInput[]) =>
    opts.tx ? ctx.store.append(events, { tx: opts.tx }) : ctx.store.append(events);
  if (open) {
    const count = Number(open.repeat_count) + 1;
    await append([
      {
        streamId: streamId.desk(open.id),
        event: { type: 'DeskItemRepeated', payload: { deskItemId: open.id, count } },
        actor: item.actor,
        scope: item.scope,
      },
      ...(opts.extra ?? []),
    ]);
    return { deskItemId: open.id, created: false, count };
  }
  const deskItemId = randomUUID();
  await append([
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: item.kind,
          subkind: item.subkind,
          title: item.title.slice(0, 300),
          body: item.body,
          options: [],
          blocking: item.blocking ?? false,
          pinned: item.pinned ?? false,
          affectedCardIds: [],
          ...(item.projectId ? { projectId: item.projectId } : {}),
          ...(item.cardId ? { cardId: item.cardId } : {}),
          ...(item.data ? { data: item.data } : {}),
          askedBy: item.askedBy ?? { kind: 'system' },
          subjectKey: item.subjectKey,
        },
      },
      actor: item.actor,
      scope: item.scope,
    },
    ...(opts.extra ?? []),
  ]);
  return { deskItemId, created: true, count: 1 };
}
