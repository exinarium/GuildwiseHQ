import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const threadProjectors: Record<string, Projector> = {
  CardCreated: async (tx, e) => {
    const p = (e.event as EventOf<'CardCreated'>).payload;
    const proj = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId]);
    // The card thread id is the card id (deterministic, no extra id in the event).
    await exec(
      tx,
      `INSERT INTO threads (id, org_id, project_id, card_id, kind, title, created_by, created_at)
       VALUES ($1,$2,$3,$1,'card',$4,$5,$6)`,
      [p.cardId, proj?.org_id, p.projectId, `${p.ref} ${p.title}`, p.ownerUserId, e.createdAt],
    );
  },
  ThreadMessagePosted: async (tx, e) => {
    const p = (e.event as EventOf<'ThreadMessagePosted'>).payload;
    await exec(
      tx,
      `INSERT INTO thread_messages (id, thread_id, author_kind, author_user_id, author_agent_id, kind, body, data, event_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        p.messageId,
        p.threadId,
        p.authorKind,
        p.authorUserId ?? null,
        p.authorAgentId ?? null,
        p.kind,
        p.body,
        JSON.stringify(p.data),
        e.seq.toString(),
        e.createdAt,
      ],
    );
  },
  // Handoffs also appear in the card thread; the message id is the handoff id.
  HandoffWritten: async (tx, e) => {
    const p = (e.event as EventOf<'HandoffWritten'>).payload;
    const kind = p.data && 'score' in p.data ? 'review' : 'handoff';
    await exec(
      tx,
      `INSERT INTO thread_messages (id, thread_id, author_kind, author_agent_id, kind, body, data, event_seq, created_at)
       VALUES ($1,$2,'agent',$3,$4,$5,$6,$7,$8)`,
      [
        p.handoffId,
        p.cardId,
        p.agentId,
        kind,
        p.note,
        JSON.stringify({ stage: p.stage, outcome: p.outcome, ...p.data }),
        e.seq.toString(),
        e.createdAt,
      ],
    );
  },
};
