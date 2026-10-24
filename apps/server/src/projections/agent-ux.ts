import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** S-B2 agent UX (docs/ARCHITECTURE.md section 38.13): mention policy and runs, the chase window, nudges and snoozes. */
export const agentUxProjectors: Record<string, Projector> = {
  AgentMentionPolicySet: async (tx, e) => {
    const p = (e.event as EventOf<'AgentMentionPolicySet'>).payload;
    await exec(
      tx,
      `INSERT INTO agent_mention_policy (agent_id, org_id, allow_members, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id) DO UPDATE SET allow_members=EXCLUDED.allow_members, changed_by=EXCLUDED.changed_by, changed_at=EXCLUDED.changed_at`,
      [p.agentId, p.orgId, p.allowMembers, p.changedBy, e.createdAt],
    );
  },
  CardMentionRequested: async (tx, e) => {
    const p = (e.event as EventOf<'CardMentionRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO card_mentions (id, org_id, project_id, card_id, agent_id, requested_by, comment_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [p.mentionId, p.orgId, p.projectId, p.cardId, p.agentId, p.requestedBy, p.commentId, e.createdAt],
    );
  },
  CardMentionEnded: async (tx, e) => {
    const p = (e.event as EventOf<'CardMentionEnded'>).payload;
    await exec(
      tx,
      `UPDATE card_mentions SET status=$2, reason=$3, ended_at=$4 WHERE id=$1 AND status='running'`,
      [p.mentionId, p.outcome, p.reason ?? null, e.createdAt],
    );
  },
  FollowUpDaysSet: async (tx, e) => {
    const p = (e.event as EventOf<'FollowUpDaysSet'>).payload;
    await exec(
      tx,
      `INSERT INTO org_follow_up (org_id, days, changed_by, changed_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id) DO UPDATE SET days=EXCLUDED.days, changed_by=EXCLUDED.changed_by, changed_at=EXCLUDED.changed_at`,
      [p.orgId, p.days, p.by, e.createdAt],
    );
  },
  DeskItemNudged: async (tx, e) => {
    const p = (e.event as EventOf<'DeskItemNudged'>).payload;
    await exec(
      tx,
      `INSERT INTO desk_follow_ups (desk_item_id, org_id, last_nudge_at, nudge_count, updated_at) VALUES ($1,$2,$3,$4,$3)
       ON CONFLICT (desk_item_id) DO UPDATE SET last_nudge_at=EXCLUDED.last_nudge_at,
         nudge_count=GREATEST(desk_follow_ups.nudge_count, EXCLUDED.nudge_count), updated_at=EXCLUDED.updated_at`,
      [p.deskItemId, p.orgId, e.createdAt, p.nudgeNumber],
    );
    // a re-queue gives the agent a fresh window to answer: the question loop measures its stall from `updated_at`
    if (p.mode === 'requeue')
      await exec(tx, `UPDATE desk_items SET updated_at=$2 WHERE id=$1 AND status='open'`, [
        p.deskItemId,
        e.createdAt,
      ]);
  },
  DeskItemSnoozed: async (tx, e) => {
    const p = (e.event as EventOf<'DeskItemSnoozed'>).payload;
    await exec(
      tx,
      `INSERT INTO desk_follow_ups (desk_item_id, org_id, snoozed_until, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (desk_item_id) DO UPDATE SET snoozed_until=EXCLUDED.snoozed_until, updated_at=EXCLUDED.updated_at`,
      [p.deskItemId, p.orgId, p.until, e.createdAt],
    );
  },
};
