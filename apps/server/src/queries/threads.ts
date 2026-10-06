import type { ThreadMessagesQuery, ThreadMessagesResponse } from '@aom/shared';
import { iso, one, type Queryable, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

/**
 * Messages of a thread the user may read: their own chats, card threads of projects they are an active member of,
 * and org-level (devops, intake) threads of their own org. Returned oldest first; `before` pages backwards.
 */
export async function threadMessages(
  db: Queryable,
  userId: string,
  threadId: string,
  q: ThreadMessagesQuery,
): Promise<ThreadMessagesResponse> {
  const t = await one(
    db,
    `SELECT t.* FROM threads t
      WHERE t.id = $1 AND t.deleted_at IS NULL AND (
        (t.kind = 'chat' AND (t.created_by = $2 OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id=$2 AND status='active')))
        OR (t.kind IN ('card','phase') AND t.project_id IN (SELECT project_id FROM project_members WHERE user_id=$2 AND status='active'))
        OR (t.kind IN ('devops','intake') AND t.org_id = $2))`,
    [threadId, userId],
  );
  if (!t) throw notFound('thread not found');
  const list = await rows(
    db,
    `SELECT m.*, u.display_name AS user_name, a.name AS agent_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id = $1 AND ($2::timestamptz IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC, m.event_seq DESC LIMIT $3`,
    [threadId, q.before ?? null, q.limit + 1],
  );
  const page = list.slice(0, q.limit).reverse();
  return {
    threadId,
    kind: t.kind,
    hasMore: list.length > q.limit,
    messages: page.map((m) => ({
      id: m.id,
      threadId,
      authorKind: m.author_kind,
      authorUserId: m.author_user_id,
      authorAgentId: m.author_agent_id,
      authorName: m.user_name ?? m.agent_name ?? null,
      kind: m.kind,
      body: m.body,
      data: m.data,
      createdAt: iso(m.created_at) as string,
    })),
  };
}
