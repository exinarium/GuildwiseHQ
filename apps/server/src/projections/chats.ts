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
};
