import {
  parseBoardConfig,
  type ThreadMessageDto,
  type ThreadMessagesQuery,
  type ThreadMessagesResponse,
} from '@aom/shared';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

/** The display name of the participant a persona message came from (a persona has no agent row). */
const PERSONA_NAME_SQL = `(SELECT tp.display_name FROM thread_participants tp
   WHERE m.author_persona_key IS NOT NULL AND tp.thread_id = m.thread_id AND tp.kind = 'persona' AND tp.ref_id = m.author_persona_key
   ORDER BY tp.added_at LIMIT 1)`;

/**
 * Messages of a thread the user may read: their own chats, card threads of projects they are an active member of,
 * DevOps threads of their own workstations and the intake threads of organizations they are Owner or Admin of. Returned oldest first; `before` pages backwards.
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
        OR (t.kind = 'devops' AND EXISTS (SELECT 1 FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id
              WHERE r.thread_id = t.id AND w.user_id = $2))
        OR (t.kind = 'intake' AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = t.org_id AND om.user_id = $2
              AND om.status = 'active' AND om.role IN ('owner','admin')))
        OR (t.kind IN ('discovery','boardroom') AND (t.created_by = $2 OR EXISTS (SELECT 1 FROM thread_participants tp
              WHERE tp.thread_id = t.id AND tp.kind = 'user' AND tp.ref_id = $2::text AND tp.removed_at IS NULL))))`,
    [threadId, userId],
  );
  if (!t) throw notFound('thread not found');
  // A boardroom's first round is sealed until every seat has answered (independent-first): until it is revealed its
  // answers are not returned to anyone, the session's own participants included. A read-time filter, so a replay is unaffected.
  const sealedIds = await sealedBoardMessageIds(db, t);
  const list = await rows(
    db,
    `SELECT m.*, u.display_name AS user_name, a.name AS agent_name, ${PERSONA_NAME_SQL} AS persona_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id = $1
        AND NOT (m.id = ANY($5::uuid[]))
        AND CASE
              WHEN $4::uuid IS NOT NULL THEN (m.created_at, m.event_seq, m.id) < (
                SELECT c.created_at, c.event_seq, c.id FROM thread_messages c WHERE c.id = $4 AND c.thread_id = $1)
              ELSE ($2::timestamptz IS NULL OR m.created_at < $2)
            END
      ORDER BY m.created_at DESC, m.event_seq DESC, m.id DESC LIMIT $3`,
    [threadId, q.before ?? null, q.limit + 1, q.beforeId ?? null, sealedIds],
  );
  const page = list.slice(0, q.limit).reverse();
  return {
    threadId,
    kind: t.kind,
    hasMore: list.length > q.limit,
    messages: page.map(messageDto),
  };
}

/** The speakers' messages of a boardroom's round 1 while that round is sealed (none for any other thread). */
async function sealedBoardMessageIds(db: Queryable, t: Row): Promise<string[]> {
  if (t.kind !== 'boardroom') return [];
  const cfg = parseBoardConfig(t.session_config);
  if (!(cfg.round >= 1 && cfg.revealedRound < 1 && cfg.stage !== 'setup')) return [];
  const turns = await rows(
    db,
    `SELECT message_id FROM session_turns
      WHERE thread_id=$1 AND round=1 AND meta->>'purpose'='board_speaker' AND message_id IS NOT NULL`,
    [t.id],
  );
  return turns.map((r) => r.message_id as string);
}

// biome-ignore lint/suspicious/noExplicitAny: a raw row
function messageDto(m: any): ThreadMessageDto {
  return {
    id: m.id,
    threadId: m.thread_id,
    authorKind: m.author_kind,
    authorUserId: m.author_user_id,
    authorAgentId: m.author_agent_id,
    ...(m.author_persona_key ? { authorPersonaKey: m.author_persona_key } : {}),
    authorName: m.user_name ?? m.persona_name ?? m.agent_name ?? null,
    kind: m.kind,
    body: m.body,
    data: m.data,
    createdAt: iso(m.created_at) as string,
  };
}

/** One stored message as `threadMessages` returns it (no access check: the caller just wrote it). */
export async function threadMessageById(
  db: Queryable,
  messageId: string,
): Promise<ThreadMessageDto | undefined> {
  const m = await one(
    db,
    `SELECT m.*, u.display_name AS user_name, a.name AS agent_name, ${PERSONA_NAME_SQL} AS persona_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.id = $1`,
    [messageId],
  );
  return m ? messageDto(m) : undefined;
}
