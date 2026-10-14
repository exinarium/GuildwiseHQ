import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Queryable } from '../db/sql.ts';
import { one } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { loadCeo } from './state.ts';

/**
 * The owner's standing chat with the CEO (their single entry point; also where the daily report links to). Returns the
 * thread id and the events that create it when it does not exist yet (or its agent was retired).
 */
export async function ensureCeoThread(
  db: Queryable,
  orgId: string,
): Promise<{ threadId: string | null; events: AppendInput[] }> {
  const ceo = await loadCeo(db, orgId);
  if (!ceo?.enabled || !ceo.agentId) return { threadId: null, events: [] };
  if (ceo.chatThreadId) {
    const alive = await one(
      db,
      `SELECT 1 FROM threads t WHERE t.id=$1 AND t.agent_id=$2 AND t.deleted_at IS NULL`,
      [ceo.chatThreadId, ceo.agentId],
    );
    if (alive) return { threadId: ceo.chatThreadId, events: [] };
  }
  const agent = await one(db, 'SELECT name FROM agents WHERE id=$1', [ceo.agentId]);
  const threadId = randomUUID();
  const ownerId = await orgOwnerId(db, orgId);
  return {
    threadId,
    events: [
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'ChatThreadCreated',
          payload: { threadId, agentId: ceo.agentId, title: `Chat with ${agent?.name ?? 'your CEO'}`, createdBy: ownerId },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      },
      {
        streamId: streamId.ceo(orgId),
        event: { type: 'CeoChatLinked', payload: { orgId, threadId } },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      },
    ],
  };
}
