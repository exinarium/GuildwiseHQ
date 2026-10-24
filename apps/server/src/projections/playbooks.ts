import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Playbook grants (docs/ARCHITECTURE.md section 38.10): one row per agent and playbook; a revoke deletes it. Replay-safe upserts. */
export const playbookProjectors: Record<string, Projector> = {
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
