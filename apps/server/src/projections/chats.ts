import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const chatProjectors: Record<string, Projector> = {
  ChatThreadCreated: async (tx, e) => {
    const p = (e.event as EventOf<'ChatThreadCreated'>).payload;
    await exec(
      tx,
      `INSERT INTO threads (id, org_id, project_id, card_id, kind, agent_id, title, created_by, created_at)
       VALUES ($1,$2,$3,$4,'chat',$5,$6,$7,$8)`,
      [
        p.threadId,
        e.scope.orgId,
        p.projectId ?? null,
        p.cardId ?? null,
        p.agentId,
        p.title,
        p.createdBy,
        e.createdAt,
      ],
    );
  },
  ChatArchived: async (tx, e) => {
    const p = (e.event as EventOf<'ChatArchived'>).payload;
    await exec(
      tx,
      `INSERT INTO chat_archives (thread_id, user_id, archived_at) VALUES ($1,$2,$3)
       ON CONFLICT (thread_id, user_id) DO NOTHING`,
      [p.threadId, p.userId, e.createdAt],
    );
  },
  ChatRestored: async (tx, e) => {
    const p = (e.event as EventOf<'ChatRestored'>).payload;
    await exec(tx, 'DELETE FROM chat_archives WHERE thread_id=$1 AND user_id=$2', [p.threadId, p.userId]);
  },
  ChatDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'ChatDeleted'>).payload;
    // Messages go; the thread row stays as a tombstone so a late message event cannot break the projections.
    await exec(tx, 'DELETE FROM thread_messages WHERE thread_id=$1', [p.threadId]);
    await exec(tx, 'DELETE FROM chat_archives WHERE thread_id=$1', [p.threadId]);
    await exec(tx, 'UPDATE threads SET deleted_at=$2 WHERE id=$1', [p.threadId, e.createdAt]);
  },
};
