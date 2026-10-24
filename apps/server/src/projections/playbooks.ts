import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Playbook grants (docs/ARCHITECTURE.md section 38.10): one row per agent and playbook; a revoke deletes it. Replay-safe upserts. */
export const playbookProjectors: Record<string, Projector> = {
  PlaybookRunRequested: async (tx, e) => {
    const p = (e.event as EventOf<'PlaybookRunRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO playbook_run_requests (request_id, org_id, agent_id, chat_user_id, playbook_key, input, chat_thread_id,
         desk_item_id, workstation_ids, status, requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        p.requestId,
        p.orgId,
        p.agentId,
        p.chatUserId,
        p.playbookKey,
        p.input,
        p.chatThreadId ?? null,
        p.deskItemId,
        p.workstationIds,
        e.createdAt,
      ],
    );
  },
  PlaybookRunDecided: async (tx, e) => {
    const p = (e.event as EventOf<'PlaybookRunDecided'>).payload;
    await exec(
      tx,
      `UPDATE playbook_run_requests SET status=$2, workstation_id=$3, decided_at=$4 WHERE request_id=$1 AND status='pending'`,
      [p.requestId, p.decision, p.workstationId ?? null, e.createdAt],
    );
  },
  PlaybookRunStarted: async (tx, e) => {
    const p = (e.event as EventOf<'PlaybookRunStarted'>).payload;
    await exec(
      tx,
      `UPDATE playbook_run_requests SET status='started', session_thread_id=$2 WHERE request_id=$1 AND status='accepted'`,
      [p.requestId, p.sessionThreadId],
    );
  },
  AgentPlaybookGranted: async (tx, e) => {
    const p = (e.event as EventOf<'AgentPlaybookGranted'>).payload;
    if (!p.granted) {
      await exec(tx, 'DELETE FROM agent_playbook_grants WHERE agent_id=$1 AND playbook_key=$2', [
        p.agentId,
        p.playbookKey,
      ]);
      return;
    }
    await exec(
      tx,
      `INSERT INTO agent_playbook_grants (agent_id, org_id, playbook_key, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id, playbook_key) DO UPDATE SET granted_by=EXCLUDED.granted_by, granted_at=EXCLUDED.granted_at`,
      [p.agentId, p.orgId, p.playbookKey, p.grantedBy, e.createdAt],
    );
  },
};
