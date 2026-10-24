import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** S-B1 Governance: gates, gated-action requests, ownership transfer and the offboarding purge schedule. Replay-safe. */
export const governanceProjectors: Record<string, Projector> = {
  AgentGateSet: async (tx, e) => {
    const p = (e.event as EventOf<'AgentGateSet'>).payload;
    if (!p.gated) {
      await exec(tx, 'DELETE FROM agent_action_gates WHERE agent_id=$1 AND action_class=$2', [
        p.agentId,
        p.actionClass,
      ]);
      return;
    }
    await exec(
      tx,
      `INSERT INTO agent_action_gates (agent_id, org_id, action_class, set_by, set_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id, action_class) DO UPDATE SET set_by=EXCLUDED.set_by, set_at=EXCLUDED.set_at`,
      [p.agentId, p.orgId, p.actionClass, p.by, e.createdAt],
    );
  },
  GatedActionRequested: async (tx, e) => {
    const p = (e.event as EventOf<'GatedActionRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO gated_actions (request_id, org_id, agent_id, action_class, fingerprint, summary, desk_item_id, project_id,
         card_id, status, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        p.requestId,
        p.orgId,
        p.agentId,
        p.actionClass,
        p.fingerprint,
        p.summary,
        p.deskItemId,
        p.projectId ?? null,
        p.cardId ?? null,
        e.createdAt,
      ],
    );
  },
  GatedActionDecided: async (tx, e) => {
    const p = (e.event as EventOf<'GatedActionDecided'>).payload;
    await exec(
      tx,
      `UPDATE gated_actions SET status=$2, decided_by=$3, decided_at=$4 WHERE request_id=$1 AND status='pending'`,
      [p.requestId, p.decision, p.decidedBy, e.createdAt],
    );
  },
  GatedActionUsed: async (tx, e) => {
    const p = (e.event as EventOf<'GatedActionUsed'>).payload;
    await exec(
      tx,
      `UPDATE gated_actions SET status='used', used_at=$2 WHERE request_id=$1 AND status='approved'`,
      [p.requestId, e.createdAt],
    );
  },
  OwnedItemsTransferred: async (tx, e) => {
    const p = (e.event as EventOf<'OwnedItemsTransferred'>).payload;
    if (p.sessionIds.length)
      await exec(
        tx,
        `UPDATE threads SET created_by=$2 WHERE id = ANY($1::uuid[]) AND org_id=$3 AND created_by=$4`,
        [p.sessionIds, p.toUserId, p.orgId, p.fromUserId],
      );
    if (p.packIds.length)
      await exec(
        tx,
        `UPDATE packs SET owner_user_id=$2 WHERE id = ANY($1::uuid[]) AND org_id=$3 AND owner_user_id=$4`,
        [p.packIds, p.toUserId, p.orgId, p.fromUserId],
      );
  },
  MemberOffboarded: async (tx, e) => {
    const p = (e.event as EventOf<'MemberOffboarded'>).payload;
    if (!p.privatePurgeAfter) return;
    await exec(
      tx,
      `INSERT INTO offboarding_purges (id, org_id, user_id, purge_after, chat_ids, pack_ids, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7) ON CONFLICT (id) DO NOTHING`,
      [e.id, p.orgId, p.userId, p.privatePurgeAfter, p.purge.chatIds, p.purge.packIds, e.createdAt],
    );
  },
  OffboardingPurgeRan: async (tx, e) => {
    const p = (e.event as EventOf<'OffboardingPurgeRan'>).payload;
    await exec(tx, `UPDATE offboarding_purges SET status=$2 WHERE id=$1 AND status='pending'`, [
      p.purgeId,
      p.outcome,
    ]);
  },
};
