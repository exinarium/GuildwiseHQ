import {
  DEFAULT_CARD_PRIORITY,
  type EventOf,
  type EventType,
  LEGACY_DEFAULT_CARD_PRIORITY,
} from '@aom/shared';
import { mergeRisk, type StoredRisk } from '../commands/review-risk.ts';
import { exec, one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';
import { getCard, leaseExpiry, mutateCard, recordTransition } from './util.ts';

/** A timeline row (kind `edited`) for an attachment added or removed. */
function attachmentActivity(tx: Tx, e: StoredEvent, cardId: string, summary: string) {
  return exec(
    tx,
    `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
     VALUES ($1,'edited',$2,NULL,$3,$4,$5,$6)`,
    [
      cardId,
      summary,
      e.actor.kind === 'user' ? e.actor.id : null,
      e.actor.kind === 'agent' ? e.actor.id : null,
      e.seq.toString(),
      e.createdAt,
    ],
  );
}

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

const CARD_CHANGE_COLUMNS: Record<string, string> = {
  title: 'title',
  fields: 'fields',
  priority: 'priority',
  repoId: 'repo_id',
  docsNeeded: 'docs_needed',
  designNeeded: 'design_needed',
  investigationOnly: 'investigation_only',
  mergeMainFirst: 'merge_main_first',
  completionAction: 'completion_action',
  riskTier: 'risk_tier',
  riskTierOverridden: 'risk_tier_overridden',
  ownerUserId: 'owner_user_id',
};

const EDIT_LABELS: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  repoId: 'repository',
  docsNeeded: 'docs needed',
  designNeeded: 'investigate & design',
  investigationOnly: 'investigation only',
  mergeMainFirst: 'merge main first',
  completionAction: 'completion action',
  dependencies: 'dependencies',
};

/** Timeline rows for a CardUpdated: a risk tier override, and/or a list of what was edited. */
async function recordActivity(
  tx: Tx,
  e: StoredEvent,
  p: EventOf<'CardUpdated'>['payload'],
  before: Row | undefined,
) {
  const userId = e.actor.kind === 'user' ? e.actor.id : null;
  const agentId = e.actor.kind === 'agent' ? e.actor.id : null;
  const add = (kind: 'edited' | 'risk_tier', summary: string, reason: string | null) =>
    exec(
      tx,
      `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.cardId, kind, summary, reason, userId, agentId, e.seq.toString(), e.createdAt],
    );
  const c = p.changes;
  const edited: string[] = [];
  for (const [k, label] of Object.entries(EDIT_LABELS))
    if ((c as Record<string, unknown>)[k] !== undefined) edited.push(label);
  if (c.fields) {
    const was = (before?.fields ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(c.fields), ...Object.keys(was)]))
      if (JSON.stringify(c.fields[k]) !== JSON.stringify(was[k])) edited.push(k);
  }
  if (edited.length > 0) await add('edited', `Edited ${edited.join(', ')}`, null);
  if (c.riskTier !== undefined) {
    const was = before?.risk_tier ?? 'not set';
    await add(
      'risk_tier',
      c.riskTier === null
        ? `Risk tier override cleared (was ${was}); it is computed from the diff again`
        : `Risk tier set to ${c.riskTier} by override (was ${was})`,
      p.reason ?? null,
    );
  }
}

/** Moves a card to a stage and queue state (the shape most outcome events share). */
async function moveTo(
  tx: Tx,
  e: StoredEvent,
  cardId: string,
  toStage: string,
  extra = '',
  extraParams: unknown[] = [],
) {
  const params = [cardId, toStage, e.createdAt, ...extraParams];
  await mutateCard(tx, e, cardId, () =>
    exec(
      tx,
      `UPDATE cards SET stage=$2, status='queued', queued_at=$3, updated_at=$3 ${extra ? `, ${extra}` : ''} WHERE id=$1`,
      params,
    ),
  );
}

/** Merges `patch` into the card's `qa` document. */
function qaMerge(tx: Tx, cardId: string, patch: Record<string, unknown>) {
  return exec(tx, `UPDATE cards SET qa = COALESCE(qa, '{}'::jsonb) || $2::jsonb WHERE id=$1`, [
    cardId,
    JSON.stringify(patch),
  ]);
}

function qaActivity(
  tx: Tx,
  e: StoredEvent,
  cardId: string,
  kind: 'qa',
  summary: string,
  reason: string | null,
  userId: string | null,
) {
  return exec(
    tx,
    `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
     VALUES ($1,$2,$3,$4,$5,NULL,$6,$7)`,
    [cardId, kind, summary, reason, userId, e.seq.toString(), e.createdAt],
  );
}

/**
 * QaPassed / QaSkipped: the card is done (the held outgoing comment is released in the same append). A custom workflow's
 * QA step may lead on to another step (`toStage`): the card goes there instead, and is done only at a final step.
 */
async function qaFinish(
  tx: Tx,
  e: StoredEvent,
  cardId: string,
  kind: 'passed' | 'skipped',
  by: string,
  note: string | null,
  toStage?: string,
) {
  const card = toStage ? await getCard(tx, cardId) : undefined;
  const dest =
    toStage && card
      ? await one<{ kind: string }>(
          tx,
          'SELECT kind FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id=$2',
          [card.workflow_version_id, toStage],
        )
      : undefined;
  if (toStage && dest && dest.kind !== 'terminal') {
    await mutateCard(
      tx,
      e,
      cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET stage=$2, status=$3, queued_at = CASE WHEN $3 = 'queued' THEN $4::timestamptz ELSE queued_at END,
                  updated_at=$4, excluded_agent_ids='{}', review_approvals=0,
                  claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                  claimed_at=NULL, lease_expires_at=NULL
            WHERE id=$1`,
          [cardId, toStage, dest.kind === 'human' ? 'waiting' : 'queued', e.createdAt],
        ),
      { agentId: null, userId: by },
    );
  } else {
    await mutateCard(
      tx,
      e,
      cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET stage=$3, status='done', finalized_at=$2, updated_at=$2,
                claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                claimed_at=NULL, lease_expires_at=NULL
          WHERE id=$1`,
          [cardId, e.createdAt, toStage ?? 'done'],
        ),
      { agentId: null, userId: by },
    );
  }
  await qaMerge(tx, cardId, { state: kind, decision: { kind, by, note, at: e.createdAt } });
  await qaActivity(
    tx,
    e,
    cardId,
    'qa',
    kind === 'passed' ? 'Manual QA passed' : 'Manual QA skipped (not tested)',
    note,
    by,
  );
}

/** Merges `patch` into the card's `approval` document. */
function approvalMerge(tx: Tx, cardId: string, patch: Record<string, unknown>) {
  return exec(tx, `UPDATE cards SET approval = COALESCE(approval, '{}'::jsonb) || $2::jsonb WHERE id=$1`, [
    cardId,
    JSON.stringify(patch),
  ]);
}

function approvalActivity(
  tx: Tx,
  e: StoredEvent,
  cardId: string,
  summary: string,
  reason: string | null,
  userId: string | null,
) {
  return exec(
    tx,
    `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
     VALUES ($1,'approval',$2,$3,$4,NULL,$5,$6)`,
    [cardId, summary, reason, userId, e.seq.toString(), e.createdAt],
  );
}

const DISTINCT_EXCLUDED = `ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[original_builder_agent_id, last_agent_id]) AS x WHERE x IS NOT NULL)`;

export const cardProjectors: Record<string, Projector> = {
  CardCreated: async (tx, e) => {
    const p = ev<'CardCreated'>(e).payload;
    const proj = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId]);
    await exec(
      tx,
      `INSERT INTO cards (id, org_id, project_id, number, ref, title, card_type, workflow_version_id, stage, status, fields,
         owner_user_id, risk_tier, docs_needed, completion_action, repo_id, parent_card_id, origin, scheduled,
         schedule_id, priority, required_capabilities, worktree_card_id, queued_at, created_at, updated_at, interest_id,
         interest_run_id, preferred_agents, design_needed, investigation_only, merge_main_first)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25,$26,$27,$28,$29,$30,$31)`,
      [
        p.cardId,
        proj?.org_id,
        p.projectId,
        p.number,
        p.ref,
        p.title,
        p.cardType,
        p.workflowVersionId,
        p.stage,
        p.status,
        JSON.stringify(p.fields),
        p.ownerUserId,
        p.riskTier ?? null,
        p.docsNeeded,
        p.completionAction ?? null,
        p.repoId ?? null,
        p.parentCardId ?? null,
        p.origin,
        p.scheduled,
        p.scheduleId ?? null,
        p.priority === LEGACY_DEFAULT_CARD_PRIORITY ? DEFAULT_CARD_PRIORITY : p.priority,
        p.requiredCapabilities,
        p.worktreeCardId ?? null,
        p.status === 'queued' ? e.createdAt : null,
        e.createdAt,
        p.interestId ?? null,
        p.interestRunId ?? null,
        p.preferredAgents ? JSON.stringify(p.preferredAgents) : null,
        p.designNeeded,
        p.investigationOnly,
        p.mergeMainFirst ?? null,
      ],
    );
    for (const dep of p.dependencies) {
      await exec(tx, 'INSERT INTO card_dependencies (card_id, depends_on_card_id) VALUES ($1,$2)', [
        p.cardId,
        dep,
      ]);
    }
    await exec(tx, 'UPDATE projects SET next_card_number = GREATEST(next_card_number, $2) WHERE id=$1', [
      p.projectId,
      p.number + 1,
    ]);
    await recordTransition(tx, undefined, await getCard(tx, p.cardId), e, {
      userId: p.ownerUserId,
      agentId: null,
    });
  },

  CardUpdated: async (tx, e) => {
    const p = ev<'CardUpdated'>(e).payload;
    const sets: string[] = [];
    const params: unknown[] = [p.cardId, e.createdAt];
    for (const [k, v] of Object.entries(p.changes)) {
      const col = CARD_CHANGE_COLUMNS[k];
      if (!col || v === undefined) continue;
      params.push(k === 'fields' ? JSON.stringify(v) : v);
      sets.push(`${col} = $${params.length}`);
    }
    const before = await getCard(tx, p.cardId);
    await exec(tx, `UPDATE cards SET ${[...sets, 'updated_at = $2'].join(', ')} WHERE id=$1`, params);
    await recordActivity(tx, e, p, before);
    if (p.changes.dependencies) {
      await exec(tx, 'DELETE FROM card_dependencies WHERE card_id=$1', [p.cardId]);
      for (const dep of p.changes.dependencies) {
        await exec(tx, 'INSERT INTO card_dependencies (card_id, depends_on_card_id) VALUES ($1,$2)', [
          p.cardId,
          dep,
        ]);
      }
    }
  },

  CardAttachmentAdded: async (tx, e) => {
    const p = ev<'CardAttachmentAdded'>(e).payload;
    const card = await getCard(tx, p.cardId);
    await exec(
      tx,
      `INSERT INTO card_attachments (id, card_id, org_id, name, content_type, size, sha256, source, added_by_user, added_by_agent, event_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        p.attachmentId,
        p.cardId,
        card?.org_id ?? null,
        p.name,
        p.contentType,
        p.size,
        p.sha256,
        p.source ?? null,
        e.actor.kind === 'user' ? e.actor.id : null,
        e.actor.kind === 'agent' ? e.actor.id : null,
        e.seq.toString(),
        e.createdAt,
      ],
    );
    await attachmentActivity(tx, e, p.cardId, `attached ${p.name}`);
  },

  CardAttachmentRemoved: async (tx, e) => {
    const p = ev<'CardAttachmentRemoved'>(e).payload;
    await exec(tx, 'DELETE FROM card_attachments WHERE id=$1', [p.attachmentId]);
    await attachmentActivity(tx, e, p.cardId, `removed attachment ${p.name}`);
  },

  InvestigationReported: async (tx, e) => {
    const p = ev<'InvestigationReported'>(e).payload;
    const prev = await one<{ investigation: { assumptions?: unknown } | null }>(
      tx,
      'SELECT investigation FROM cards WHERE id=$1',
      [p.cardId],
    );
    await exec(tx, 'UPDATE cards SET investigation=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      JSON.stringify({
        reportPath: p.reportPath,
        location: p.location,
        summary: p.summary,
        commit: p.commit ?? null,
        ...(p.body ? { body: p.body } : {}),
        // a revised report keeps the assumptions it was reviewed against
        assumptions: p.assumptions ?? prev?.investigation?.assumptions ?? [],
        at: e.createdAt,
      }),
      e.createdAt,
    ]);
  },

  DesignHeld: async (tx, e) => {
    const p = ev<'DesignHeld'>(e).payload;
    await exec(tx, 'UPDATE cards SET design_review=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      JSON.stringify({ state: 'waiting', dependencies: p.dependencies, agentId: p.agentId ?? null }),
      e.createdAt,
    ]);
    await attachmentActivity(
      tx,
      e,
      p.cardId,
      `Design made before ${p.dependencies.join(', ')} landed: the assumptions are reviewed once they have`,
    );
  },

  DesignReviewed: async (tx, e) => {
    const p = ev<'DesignReviewed'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET design_review = COALESCE(design_review, '{}'::jsonb) || $2::jsonb, updated_at=$3 WHERE id=$1`,
      [
        p.cardId,
        JSON.stringify({
          state: 'reviewed',
          result: { confirmed: p.confirmed, revised: p.revised, note: p.note },
        }),
        e.createdAt,
      ],
    );
    await attachmentActivity(
      tx,
      e,
      p.cardId,
      `Assumptions reviewed: ${p.confirmed} confirmed, ${p.revised} revised`,
    );
  },

  CardMainSynced: async (tx, e) => {
    const p = ev<'CardMainSynced'>(e).payload;
    await exec(tx, 'UPDATE cards SET main_sync=$2 WHERE id=$1', [
      p.cardId,
      JSON.stringify({
        result: p.result,
        mainBranch: p.mainBranch ?? null,
        workingBranch: p.workingBranch ?? null,
        files: p.files ?? [],
        at: e.createdAt,
      }),
    ]);
  },

  CardSpecified: async (tx, e) => {
    const p = ev<'CardSpecified'>(e).payload;
    await moveTo(tx, e, p.cardId, p.toStage);
  },

  DecisionPolicyChanged: async (tx, e) => {
    const p = ev<'DecisionPolicyChanged'>(e).payload;
    await exec(tx, 'UPDATE cards SET decision_policy=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      p.policy,
      e.createdAt,
    ]);
  },

  CardClaimed: async (tx, e) => {
    const p = ev<'CardClaimed'>(e).payload;
    const role = await one<{ claim_role: string | null }>(
      tx,
      `SELECT st.claim_role FROM cards c JOIN workflow_stages st
         ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = $2 WHERE c.id=$1`,
      [p.cardId, p.stage],
    );
    // The claim SQL already set these columns (idempotent here); the transition is recorded from the
    // queued state explicitly so live handling and replay agree.
    await exec(
      tx,
      `UPDATE cards SET claim_id=$2, claimed_by_agent_id=$3, claim_workstation_id=$4, claim_shift_id=$5,
              claimed_at=$6, lease_expires_at=$7, claim_overflow=$8, status='claimed', last_agent_id=$3,
              original_builder_agent_id = CASE WHEN $9 AND original_builder_agent_id IS NULL THEN $3 ELSE original_builder_agent_id END,
              updated_at=$6
        WHERE id=$1`,
      [
        p.cardId,
        p.claimId,
        p.agentId,
        p.workstationId,
        p.shiftId,
        e.createdAt,
        leaseExpiry(e.createdAt),
        p.overflow,
        role?.claim_role === 'builder',
      ],
    );
    await recordTransition(
      tx,
      { id: p.cardId, stage: p.stage, status: 'queued' },
      await getCard(tx, p.cardId),
      e,
      {
        agentId: p.agentId,
      },
    );
    if (p.worktree) {
      await exec(
        tx,
        `UPDATE cards SET base_branch = $2, branch_name = COALESCE(branch_name, $3),
                worktree_path = COALESCE(NULLIF($4, ''), worktree_path),
                home_workstation_id = COALESCE(home_workstation_id, $5),
                repo_id = COALESCE(repo_id, $6)
          WHERE id=$1`,
        [
          p.cardId,
          p.worktree.baseBranch,
          p.worktree.branchName,
          p.worktree.worktreePath,
          p.worktree.homeWorkstationId,
          p.worktree.repoId,
        ],
      );
    }
  },

  ClaimReleased: async (tx, e) => {
    const p = ev<'ClaimReleased'>(e).payload;
    await mutateCard(
      tx,
      e,
      p.cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                  claimed_at=NULL, lease_expires_at=NULL, claim_overflow=false,
                  queued_at = CASE WHEN status='claimed' THEN $3::timestamptz ELSE queued_at END,
                  status = CASE WHEN status='claimed' THEN 'queued' ELSE status END,
                  home_workstation_id = CASE WHEN $4 = 'workstation_unlinked' THEN NULL ELSE home_workstation_id END,
                  worktree_path = CASE WHEN $4 = 'workstation_unlinked' THEN NULL ELSE worktree_path END,
                  last_rejection = COALESCE($5::jsonb, last_rejection),
                  updated_at=$3
            WHERE id=$1 AND claim_id=$2`,
          [p.cardId, p.claimId, e.createdAt, p.reason, p.rejection ? JSON.stringify(p.rejection) : null],
        ),
      { agentId: p.agentId },
    );
  },

  HandoffWritten: async (tx, e) => {
    const p = ev<'HandoffWritten'>(e).payload;
    await exec(
      tx,
      `INSERT INTO card_handoffs (id, card_id, shift_id, agent_id, stage, outcome, note, data, event_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        p.handoffId,
        p.cardId,
        p.shiftId,
        p.agentId,
        p.stage,
        p.outcome,
        p.note,
        JSON.stringify(p.data),
        e.seq.toString(),
        e.createdAt,
      ],
    );
    // A report is a successful shift: the loop breaker's episode ends.
    await exec(
      tx,
      'UPDATE cards SET retry_after=NULL, retry_failures=0, retry_episode_id=NULL WHERE id=$1 AND retry_failures > 0',
      [p.cardId],
    );
  },

  CardRetryDeferred: async (tx, e) => {
    const p = ev<'CardRetryDeferred'>(e).payload;
    await exec(tx, 'UPDATE cards SET retry_after=$2, retry_failures=$3, retry_episode_id=$4 WHERE id=$1', [
      p.cardId,
      p.until,
      p.failures,
      p.episodeId,
    ]);
  },

  // Released by hand: dispatchable now. The failure count stays, so the next failure backs off longer.
  CardRetryReleased: async (tx, e) => {
    const p = ev<'CardRetryReleased'>(e).payload;
    await exec(tx, 'UPDATE cards SET retry_after=NULL WHERE id=$1', [p.cardId]);
  },

  ReviewRequested: async (tx, e) => {
    const p = ev<'ReviewRequested'>(e).payload;
    await moveTo(
      tx,
      e,
      p.cardId,
      p.toStage,
      `risk_tier = CASE WHEN risk_tier_overridden THEN risk_tier ELSE $4 END, review_approvals = 0, review_risk = NULL,
       excluded_agent_ids = ${DISTINCT_EXCLUDED},
       head_sha = COALESCE($5, head_sha), build_evidence = COALESCE($6::jsonb, build_evidence),
       high_risk = COALESCE($7::boolean, high_risk), high_risk_paths = COALESCE($8::jsonb, high_risk_paths),
       owner_approval_required = NULL, owner_approval_reason = NULL, owner_approved_sha = NULL,
       test_deploy_state = NULL, merge_review = NULL`,
      [
        p.riskTier,
        p.headSha ?? null,
        p.evidence ? JSON.stringify(p.evidence) : null,
        p.highRisk ?? null,
        p.highRiskPaths ? JSON.stringify(p.highRiskPaths) : null,
      ],
    );
  },

  ChangesRequested: async (tx, e) => {
    const p = ev<'ChangesRequested'>(e).payload;
    await moveTo(
      tx,
      e,
      p.cardId,
      p.toStage,
      `rework_round = rework_round + 1, excluded_agent_ids = '{}', review_approvals = 0`,
    );
  },

  ReviewApproved: async (tx, e) => {
    const p = ev<'ReviewApproved'>(e).payload;
    // The reviewer's risk call (backlog #70): the highest risk of this round's approvals, with every analysis.
    {
      const cur = (await one(tx, 'SELECT review_risk FROM cards WHERE id=$1', [p.cardId])) as Row | null;
      const merged = mergeRisk(cur?.review_risk as StoredRisk | null, p);
      await exec(tx, 'UPDATE cards SET review_risk=$2::jsonb WHERE id=$1', [
        p.cardId,
        JSON.stringify(merged),
      ]);
    }
    // A card on an older built-in `code` version moves to the version that has the integration test guard when it leaves
    // Review (docs/design/run-and-integration-tests.md D8); the project's setting decides `integrationTests` then.
    if (p.workflowVersionId || p.integrationTests !== undefined)
      await mutateCard(tx, e, p.cardId, () =>
        exec(
          tx,
          `UPDATE cards SET workflow_version_id = COALESCE($2::uuid, workflow_version_id),
                  fields = CASE WHEN $3::boolean IS NULL THEN fields
                                ELSE jsonb_set(COALESCE(fields, '{}'::jsonb), '{integrationTests}', to_jsonb($3::boolean)) END
            WHERE id=$1`,
          [p.cardId, p.workflowVersionId ?? null, p.integrationTests ?? null],
        ),
      );
    if (p.toStage === 'review') {
      await mutateCard(tx, e, p.cardId, () =>
        exec(
          tx,
          `UPDATE cards SET status='queued', queued_at=$3, review_approvals = review_approvals + 1,
                  excluded_agent_ids = CASE WHEN $4::boolean THEN excluded_agent_ids || $2::uuid ELSE excluded_agent_ids END,
                  updated_at=$3 WHERE id=$1`,
          [p.cardId, p.reviewerAgentId, e.createdAt, p.excludeReviewer !== false],
        ),
      );
    } else {
      await moveTo(
        tx,
        e,
        p.cardId,
        p.toStage,
        `excluded_agent_ids = '{}', owner_approval_required = COALESCE($4::boolean, owner_approval_required),
         owner_approval_reason = COALESCE($5, owner_approval_reason)`,
        [p.ownerApproval?.required ?? null, p.ownerApproval?.reason ?? null],
      );
    }
  },

  TestPassed: async (tx, e) => {
    const p = ev<'TestPassed'>(e).payload;
    await moveTo(tx, e, p.cardId, p.toStage, `excluded_agent_ids = '{}'`);
  },

  TestFailed: async (tx, e) => {
    const p = ev<'TestFailed'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(tx, `UPDATE cards SET status='waiting', updated_at=$2 WHERE id=$1`, [p.cardId, e.createdAt]),
    );
  },

  ChildCardResolved: async (tx, e) => {
    const p = ev<'ChildCardResolved'>(e).payload;
    await moveTo(tx, e, p.cardId, p.toStage);
  },

  RebaseConflict: async (tx, e) => {
    const p = ev<'RebaseConflict'>(e).payload;
    await moveTo(tx, e, p.cardId, 'build', `rework_round = rework_round + 1`);
  },

  StageCompleted: async (tx, e) => {
    const p = ev<'StageCompleted'>(e).payload;
    const card = await getCard(tx, p.cardId);
    const st = card
      ? await one<{ kind: string }>(
          tx,
          'SELECT kind FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id=$2',
          [card.workflow_version_id, p.toStage],
        )
      : undefined;
    if (st?.kind === 'human') {
      // A step for a person (manual QA): the card waits in the step's column, nobody claims it.
      await mutateCard(tx, e, p.cardId, () =>
        exec(
          tx,
          `UPDATE cards SET stage=$2, status='waiting', excluded_agent_ids='{}', updated_at=$3 WHERE id=$1`,
          [p.cardId, p.toStage, e.createdAt],
        ),
      );
    } else if (st?.kind === 'terminal') {
      await mutateCard(tx, e, p.cardId, () =>
        exec(tx, `UPDATE cards SET stage=$2, status='done', finalized_at=$3, updated_at=$3 WHERE id=$1`, [
          p.cardId,
          p.toStage,
          e.createdAt,
        ]),
      );
    } else {
      await moveTo(
        tx,
        e,
        p.cardId,
        p.toStage,
        `excluded_agent_ids = '{}'${p.rework ? ', rework_round = rework_round + 1' : ''}`,
      );
    }
  },

  CardMovedByManager: async (tx, e) => {
    const p = ev<'CardMovedByManager'>(e).payload;
    await mutateCard(
      tx,
      e,
      p.cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET stage=$2, status=$3, queued_at = CASE WHEN $3 = 'queued' THEN $4::timestamptz ELSE queued_at END,
                  excluded_agent_ids='{}', review_approvals=0, updated_at=$4,
                  retry_after=NULL, retry_failures=0, retry_episode_id=NULL WHERE id=$1`,
          [p.cardId, p.toStage, p.status, e.createdAt],
        ),
      { agentId: null },
    );
    // Lean Team v3: moving the card to the queue ends a park that an answer asked for ("keep blocked until ...").
    if (p.status === 'queued')
      await exec(
        tx,
        `DELETE FROM card_blockers WHERE card_id=$1 AND desk_item_id IN (
           SELECT id FROM desk_items WHERE (keep_blocked_until IS NOT NULL AND status='answered') OR subkind='loop_parked')`,
        [p.cardId],
      );
  },

  // A done or cancelled card goes back to work. The branch, worktree and the earlier finalize result (`finalize_action`,
  // `finalize_result`: the PR url) stay as history; `finalized_at`, a failed or pending finalize and the claim are cleared.
  CardReopened: async (tx, e) => {
    const p = ev<'CardReopened'>(e).payload;
    await mutateCard(
      tx,
      e,
      p.cardId,
      async () => {
        await exec(
          tx,
          `UPDATE cards SET stage=$2, status=$3, queued_at = CASE WHEN $3 = 'queued' THEN $4::timestamptz ELSE queued_at END,
                  excluded_agent_ids='{}', review_approvals=0, updated_at=$4, finalized_at=NULL,
                  finalize_state=NULL, finalize_error=NULL, finalize_desk_item_id=NULL, last_rejection=NULL,
                  claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                  claimed_at=NULL, lease_expires_at=NULL,
                  retry_after=NULL, retry_failures=0, retry_episode_id=NULL WHERE id=$1`,
          [p.cardId, p.toStage, p.status, e.createdAt],
        );
        const who = await one<{ display_name: string }>(tx, 'SELECT display_name FROM users WHERE id=$1', [
          p.by,
        ]);
        const wf = await one<{ definition: { stages?: Array<{ id: string; label: string }> } }>(
          tx,
          `SELECT v.definition FROM workflow_versions v JOIN cards c ON c.workflow_version_id = v.id WHERE c.id=$1`,
          [p.cardId],
        );
        const label = wf?.definition.stages?.find((x) => x.id === p.toStage)?.label ?? p.toStage;
        await exec(
          tx,
          `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
           VALUES ($1,'reopened',$2,$3,$4,NULL,$5,$6)`,
          [
            p.cardId,
            `Reopened by ${who?.display_name ?? 'a manager'} into ${label} (was ${p.fromStatus})`,
            p.reason,
            p.by,
            e.seq.toString(),
            e.createdAt,
          ],
        );
      },
      { agentId: null, userId: p.by },
    );
  },

  FinalizeRequested: async (tx, e) => {
    const p = ev<'FinalizeRequested'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(tx, `UPDATE cards SET status='waiting', updated_at=$2 WHERE id=$1`, [p.cardId, e.createdAt]),
    );
    if (p.withoutApproval)
      await exec(
        tx,
        `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
         VALUES ($1,'merge_policy','Large change merged without manager approval (project setting)',NULL,$2,$3,$4,$5)`,
        [
          p.cardId,
          e.actor.kind === 'user' ? e.actor.id : null,
          e.actor.kind === 'agent' ? e.actor.id : null,
          e.seq.toString(),
          e.createdAt,
        ],
      );
  },

  CardFinalized: async (tx, e) => {
    const p = ev<'CardFinalized'>(e).payload;
    if (p.toStage !== 'done') {
      // Manual QA follows (docs/design/manual-qa.md): the work is merged, the card is not done. An agent writes the QA
      // steps (`qa_steps`, queued) or the person is waited for at once (`manual_qa`, waiting). `finalized_at` and the
      // done status come with QaPassed / QaSkipped.
      await mutateCard(tx, e, p.cardId, () =>
        exec(
          tx,
          `UPDATE cards SET stage=$2, status=$3, queued_at = CASE WHEN $3 = 'queued' THEN $4::timestamptz ELSE queued_at END,
                  updated_at=$4, excluded_agent_ids='{}', review_approvals=0,
                  workflow_version_id = COALESCE($5::uuid, workflow_version_id),
                  claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                  claimed_at=NULL, lease_expires_at=NULL
            WHERE id=$1`,
          [
            p.cardId,
            p.toStage,
            p.toStage === 'qa_steps' ? 'queued' : 'waiting',
            e.createdAt,
            p.workflowVersionId ?? null,
          ],
        ),
      );
      return;
    }
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET stage='done', status='done', finalized_at=$2, updated_at=$2,
                claim_id=NULL, claimed_by_agent_id=NULL, claim_workstation_id=NULL, claim_shift_id=NULL,
                claimed_at=NULL, lease_expires_at=NULL
          WHERE id=$1`,
        [p.cardId, e.createdAt],
      ),
    );
  },

  // ---- manual QA (docs/design/manual-qa.md): `cards.qa` holds the assignee, the steps and the last decision.
  QaOpened: async (tx, e) => {
    const p = ev<'QaOpened'>(e).payload;
    await qaMerge(tx, p.cardId, {
      state: p.toStage === 'qa_steps' ? 'steps' : 'open',
      assigneeUserId: p.assigneeUserId,
      source: p.source,
      openedAt: e.createdAt,
      steps: null,
      stepsBy: null,
      decision: null,
      deskItemId: p.deskItemId,
    });
    await qaActivity(tx, e, p.cardId, 'qa', 'Moved to manual QA', null, null);
  },

  QaStepsPosted: async (tx, e) => {
    const p = ev<'QaStepsPosted'>(e).payload;
    await qaMerge(tx, p.cardId, { steps: p.steps, stepsBy: p.agentId ?? null, state: 'open' });
  },

  QaAssigned: async (tx, e) => {
    const p = ev<'QaAssigned'>(e).payload;
    await qaMerge(tx, p.cardId, {
      assigneeUserId: p.assigneeUserId,
      source: 'reassigned',
      deskItemId: p.deskItemId,
    });
    await qaActivity(tx, e, p.cardId, 'qa', 'Manual QA handed to another member', null, p.by);
  },

  QaPassed: async (tx, e) => {
    const p = ev<'QaPassed'>(e).payload;
    await qaFinish(tx, e, p.cardId, 'passed', p.by, p.note ?? null, p.toStage);
  },

  QaSkipped: async (tx, e) => {
    const p = ev<'QaSkipped'>(e).payload;
    await qaFinish(tx, e, p.cardId, 'skipped', p.by, p.reason ?? null, p.toStage);
  },

  QaSentBack: async (tx, e) => {
    const p = ev<'QaSentBack'>(e).payload;
    // Like a reopen: the first run's finalize state is cleared; branch, worktree path and the merge stay as history.
    await mutateCard(
      tx,
      e,
      p.cardId,
      () =>
        exec(
          tx,
          `UPDATE cards SET stage=$2, status='queued', queued_at=$3, updated_at=$3, rework_round = rework_round + 1,
                  excluded_agent_ids='{}', review_approvals=0, finalized_at=NULL,
                  finalize_state=NULL, finalize_error=NULL, finalize_desk_item_id=NULL, last_rejection=NULL,
                  retry_after=NULL, retry_failures=0, retry_episode_id=NULL
            WHERE id=$1`,
          [p.cardId, p.toStage, e.createdAt],
        ),
      { agentId: null, userId: p.by },
    );
    const sentBack = (await getCard(tx, p.cardId))?.qa?.sentBackCount ?? 0;
    await qaMerge(tx, p.cardId, {
      state: 'sent_back',
      sentBackCount: Number(sentBack) + 1,
      lastSendBack: { by: p.by, comment: p.comment, at: e.createdAt },
      decision: { kind: 'sent_back', by: p.by, note: p.comment, at: e.createdAt },
    });
    await qaActivity(tx, e, p.cardId, 'qa', 'Sent back from manual QA', p.comment, p.by);
  },

  // ---- approval steps (#16): `cards.approval` holds the approver, the desk item, the last decision, the send-back count.
  ApprovalRequested: async (tx, e) => {
    const p = ev<'ApprovalRequested'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='waiting', updated_at=$2, claim_id=NULL, claimed_by_agent_id=NULL,
                claim_workstation_id=NULL, claim_shift_id=NULL, claimed_at=NULL, lease_expires_at=NULL
          WHERE id=$1`,
        [p.cardId, e.createdAt],
      ),
    );
    await approvalMerge(tx, p.cardId, {
      state: 'open',
      stageId: p.stageId,
      approverUserId: p.approverUserId,
      approverKind: p.approverKind,
      fellBack: p.fellBack === true,
      openedAt: e.createdAt,
      deskItemId: p.deskItemId,
      entrySeq: p.entrySeq ?? null,
      sha: p.sha ?? null,
      decision: null,
    });
    await approvalActivity(tx, e, p.cardId, 'Waiting for approval', null, null);
  },

  ApprovalDecided: async (tx, e) => {
    const p = ev<'ApprovalDecided'>(e).payload;
    const prior = (await getCard(tx, p.cardId))?.approval as { sentBackCount?: number } | null | undefined;
    const sentBack = p.decision === 'sent_back';
    await approvalMerge(tx, p.cardId, {
      state: p.decision,
      decision: { kind: p.decision, by: p.by, note: p.note ?? null, at: e.createdAt },
      ...(sentBack
        ? {
            sentBackCount: Number(prior?.sentBackCount ?? 0) + 1,
            lastSendBack: { by: p.by, comment: p.note ?? '', at: e.createdAt },
          }
        : {}),
    });
    if (p.decision === 'approved' && p.sha)
      await exec(tx, 'UPDATE cards SET owner_approved_sha=$2 WHERE id=$1', [p.cardId, p.sha]);
    await approvalActivity(
      tx,
      e,
      p.cardId,
      sentBack ? 'Sent back from the approval step' : 'Approved',
      p.note ?? null,
      p.by,
    );
  },

  CardCancelled: async (tx, e) => {
    const p = ev<'CardCancelled'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='cancelled', updated_at=$2, claim_id=NULL, claimed_by_agent_id=NULL,
                claim_workstation_id=NULL, claim_shift_id=NULL, claimed_at=NULL, lease_expires_at=NULL
          WHERE id=$1`,
        [p.cardId, e.createdAt],
      ),
    );
  },
};
