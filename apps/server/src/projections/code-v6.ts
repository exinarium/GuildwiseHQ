import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';
import { mutateCard } from './util.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/** Lean Team v3, workflow lean team: groups, Card Brief, the commit a card is at, test deploy, owner approval policy. */
export const codeV6Projectors: Record<string, Projector> = {
  CardGroupSet: async (tx, e) => {
    const p = ev<'CardGroupSet'>(e).payload;
    await exec(tx, 'UPDATE cards SET group_id=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      p.groupId,
      e.createdAt,
    ]);
  },

  CardBriefSet: async (tx, e) => {
    const p = ev<'CardBriefSet'>(e).payload;
    await exec(tx, 'UPDATE cards SET card_brief=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      p.brief,
      e.createdAt,
    ]);
  },

  GroupBuilderAssigned: async (tx, e) => {
    const p = ev<'GroupBuilderAssigned'>(e).payload;
    await exec(
      tx,
      `INSERT INTO card_groups (project_id, group_id, builder_agent_id, last_card_id, until, assigned_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, group_id) DO UPDATE
         SET builder_agent_id=EXCLUDED.builder_agent_id, last_card_id=EXCLUDED.last_card_id,
             until=EXCLUDED.until, assigned_at=EXCLUDED.assigned_at`,
      [p.projectId, p.groupId, p.agentId, p.cardId, p.until, e.createdAt],
    );
  },

  GroupBuilderCleared: async (tx, e) => {
    const p = ev<'GroupBuilderCleared'>(e).payload;
    await exec(tx, 'DELETE FROM card_groups WHERE project_id=$1 AND group_id=$2', [p.projectId, p.groupId]);
  },

  // The branch is at another commit. A clean rebase (or a bug fix the card's own child made) carries the build evidence over
  // when it was bound to the commit the branch moved from.
  CardHeadObserved: async (tx, e) => {
    const p = ev<'CardHeadObserved'>(e).payload;
    const card = await one<{ head_sha: string | null; build_evidence: { sha?: string } | null }>(
      tx,
      'SELECT head_sha, build_evidence FROM cards WHERE id=$1',
      [p.cardId],
    );
    const from = p.from ?? card?.head_sha ?? null;
    // A clean rebase, a conflict that only merged and a documentation commit keep what was bound to the old commit.
    const carries = p.source === 'rebase' || p.source === 'conflict' || p.source === 'docs';
    const carry = carries && !!from;
    await exec(
      tx,
      `UPDATE cards SET head_sha=$2,
              build_evidence = CASE WHEN $3::boolean AND build_evidence->>'sha' = $4::text THEN build_evidence || jsonb_build_object('sha', $2::text, 'rebasedFrom', $4::text) ELSE build_evidence END,
              owner_approved_sha = CASE WHEN $3::boolean AND owner_approved_sha = $4 THEN $2 ELSE owner_approved_sha END,
              updated_at=$5
        WHERE id=$1`,
      [p.cardId, p.sha, !!carry, from, e.createdAt],
    );
  },

  // Back to Build: the evidence no longer matches the code.
  EvidenceLapsed: async (tx, e) => {
    const p = ev<'EvidenceLapsed'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET stage='build', status='queued', queued_at=$2, updated_at=$2, rework_round = rework_round + 1,
                excluded_agent_ids='{}', review_approvals=0, build_evidence=NULL, head_sha=$3,
                finalize_state=NULL, finalize_error=NULL, finalize_desk_item_id=NULL,
                claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                claimed_at=NULL, lease_expires_at=NULL
          WHERE id=$1`,
        [p.cardId, e.createdAt, p.actualSha],
      ),
    );
  },

  // The approval was for another commit: the card returns to the approval step; the approval is asked again for this commit.
  OwnerApprovalLapsed: async (tx, e) => {
    const p = ev<'OwnerApprovalLapsed'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET stage='owner_approval', status='waiting', updated_at=$2, owner_approved_sha=NULL, head_sha=$3,
                finalize_state=NULL, finalize_error=NULL, finalize_desk_item_id=NULL,
                claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                claimed_at=NULL, lease_expires_at=NULL,
                approval = COALESCE(approval, '{}'::jsonb) || jsonb_build_object('state', 'lapsed')
          WHERE id=$1`,
        [p.cardId, e.createdAt, p.actualSha],
      ),
    );
  },

  TestDeployResolved: async (tx, e) => {
    const p = ev<'TestDeployResolved'>(e).payload;
    await exec(tx, 'UPDATE cards SET test_deploy_state=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      p.result,
      e.createdAt,
    ]);
  },

  ProjectOwnerApprovalSet: async (tx, e) => {
    const p = ev<'ProjectOwnerApprovalSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET owner_approval_policy=$2 WHERE id=$1', [p.projectId, p.policy]);
  },

  ProjectE2eAreasSet: async (tx, e) => {
    const p = ev<'ProjectE2eAreasSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET e2e_areas=$2::jsonb WHERE id=$1', [
      p.projectId,
      p.mapping ? JSON.stringify(p.mapping) : null,
    ]);
  },

  FinalizeConflictHeld: async (tx, e) => {
    const p = ev<'FinalizeConflictHeld'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET finalize_state=NULL, finalize_error=NULL, finalize_desk_item_id=NULL, updated_at=$2 WHERE id=$1`,
      [p.cardId, e.createdAt],
    );
  },

  // Recorded for the thread and the merge review brief; the card's move is a separate event.
  ConflictResolutionRecorded: async (tx, e) => {
    const p = ev<'ConflictResolutionRecorded'>(e).payload;
    await exec(tx, 'UPDATE cards SET merge_review=$2::jsonb, updated_at=$3 WHERE id=$1', [
      p.cardId,
      JSON.stringify({
        mergeOnly: p.mergeOnly ?? null,
        oldHead: p.oldHead ?? null,
        newHead: p.newHead ?? null,
        touched: p.touched,
        at: e.createdAt,
      }),
      e.createdAt,
    ]);
  },
};
