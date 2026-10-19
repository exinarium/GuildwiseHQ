import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

type Followups = EventOf<'PhaseCreated'>['payload']['followups'];

/** Inserts follow-up rows for the given status (positions 1..n in list order). */
async function insertFollowups(
  tx: Tx,
  phaseId: string,
  list: Followups,
  status: 'pending' | 'queued',
  at: Date,
): Promise<void> {
  for (const [i, f] of list.entries()) {
    await exec(
      tx,
      `INSERT INTO phase_followups (id, phase_id, position, kind, target_id, platform, instruction, note, status, mock,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [
        f.id,
        phaseId,
        i + 1,
        f.kind,
        f.kind === 'custom' ? null : (f.targetId ?? null),
        f.kind === 'regression' ? f.platform : null,
        f.kind === 'custom' ? f.instruction : '',
        f.note,
        status,
        f.kind === 'regression' && f.mock ? JSON.stringify(f.mock) : null,
        at,
      ],
    );
  }
}

const cancelOpenFollowups = (tx: Tx, phaseId: string, at: Date) =>
  exec(
    tx,
    `UPDATE phase_followups SET status='cancelled', finished_at=$2, updated_at=$2
      WHERE phase_id=$1 AND status IN ('pending','queued','briefed')`,
    [phaseId, at],
  );

const activity = (tx: Tx, e: StoredEvent, cardId: string, kind: string, summary: string) =>
  exec(
    tx,
    `INSERT INTO card_activity (card_id, kind, summary, reason, user_id, agent_id, event_seq, at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`,
    [
      cardId,
      kind,
      summary,
      e.actor.kind === 'user' ? e.actor.id : null,
      e.actor.kind === 'agent' ? e.actor.id : null,
      e.seq.toString(),
      e.createdAt,
    ],
  );

export const phaseProjectors: Record<string, Projector> = {
  PhaseCreated: async (tx, e) => {
    const p = ev<'PhaseCreated'>(e).payload;
    const proj = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId]);
    await exec(
      tx,
      `INSERT INTO phases (id, org_id, project_id, number, ref, name, description, status, working_branch,
         created_by_kind, created_by_user_id, created_by_agent_id, intake_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [
        p.phaseId,
        proj?.org_id,
        p.projectId,
        p.number,
        p.ref,
        p.name,
        p.description,
        p.status,
        p.workingBranch ?? null,
        p.createdBy.kind === 'agent' ? 'agent' : 'user',
        p.createdBy.userId ?? null,
        p.createdBy.agentId ?? null,
        p.intakeId ?? null,
        e.createdAt,
      ],
    );
    await insertFollowups(tx, p.phaseId, p.followups, 'pending', e.createdAt);
    await exec(tx, 'UPDATE projects SET next_phase_number = GREATEST(next_phase_number, $2) WHERE id=$1', [
      p.projectId,
      p.number + 1,
    ]);
    // The phase thread (thread id = phase id): agent comments and system notes on the follow-ups' progress.
    await exec(
      tx,
      `INSERT INTO threads (id, org_id, project_id, card_id, kind, agent_id, title, created_by, created_at)
       VALUES ($1,$2,$3,NULL,'phase',NULL,$4,$5,$6)`,
      [p.phaseId, proj?.org_id, p.projectId, `${p.ref} ${p.name}`, p.createdBy.userId ?? null, e.createdAt],
    );
  },

  PhaseUpdated: async (tx, e) => {
    const p = ev<'PhaseUpdated'>(e).payload;
    const c = p.changes;
    await exec(
      tx,
      `UPDATE phases SET name = COALESCE($2, name), description = COALESCE($3, description),
              working_branch = CASE WHEN $4::boolean THEN $5 ELSE working_branch END, updated_at=$6
        WHERE id=$1`,
      [
        p.phaseId,
        c.name ?? null,
        c.description ?? null,
        c.workingBranch !== undefined,
        c.workingBranch ?? null,
        e.createdAt,
      ],
    );
    if (c.name)
      await exec(
        tx,
        `UPDATE threads SET title = (SELECT ref || ' ' || name FROM phases WHERE id=$1) WHERE id=$1`,
        [p.phaseId],
      );
  },

  PhaseFollowupsSet: async (tx, e) => {
    const p = ev<'PhaseFollowupsSet'>(e).payload;
    await exec(tx, `DELETE FROM phase_followups WHERE phase_id=$1 AND status='pending'`, [p.phaseId]);
    await insertFollowups(tx, p.phaseId, p.followups, 'pending', e.createdAt);
    await exec(tx, 'UPDATE phases SET updated_at=$2 WHERE id=$1', [p.phaseId, e.createdAt]);
  },

  CardPhaseChanged: async (tx, e) => {
    const p = ev<'CardPhaseChanged'>(e).payload;
    await exec(tx, 'UPDATE cards SET phase_id=$2, phase_assignment=$3, updated_at=$4 WHERE id=$1', [
      p.cardId,
      p.phaseId,
      p.phaseId ? p.assignment : null,
      e.createdAt,
    ]);
    const next = p.phaseId
      ? await one<{ ref: string; name: string }>(tx, 'SELECT ref, name FROM phases WHERE id=$1', [p.phaseId])
      : undefined;
    const prev = p.previousPhaseId
      ? await one<{ ref: string }>(tx, 'SELECT ref FROM phases WHERE id=$1', [p.previousPhaseId])
      : undefined;
    const summary = next
      ? `${p.assignment === 'proposed' ? 'Proposed for' : 'Put in'} phase ${next.ref} (${next.name})${p.cause === 'bug_filed' ? ': a bug filed after finalize joins the phase it came from' : ''}${prev ? `, moved from ${prev.ref}` : ''}`
      : `Taken out of phase${prev ? ` ${prev.ref}` : ''}`;
    await activity(tx, e, p.cardId, 'phase', summary);
  },

  // A `merge` finalize puts the card's work in the working branch at once.
  CardFinalized: async (tx, e) => {
    const p = ev<'CardFinalized'>(e).payload;
    if (p.action === 'merge')
      await exec(
        tx,
        'UPDATE cards SET merged_into_working_at = COALESCE(merged_into_working_at, $2) WHERE id=$1',
        [p.cardId, e.createdAt],
      );
  },

  CardMergeVerified: async (tx, e) => {
    const p = ev<'CardMergeVerified'>(e).payload;
    await exec(
      tx,
      'UPDATE cards SET merged_into_working_at = COALESCE(merged_into_working_at, $2), updated_at=$2 WHERE id=$1',
      [p.cardId, e.createdAt],
    );
    await activity(
      tx,
      e,
      p.cardId,
      'merge_verified',
      p.manual
        ? `Confirmed by hand: the work is in ${p.workingBranch}`
        : `The branch is merged into ${p.workingBranch}${p.branchDeleted ? '; the card branch was deleted' : ''}`,
    );
  },

  // Regression cards of a follow-up: where they run and which follow-up created them.
  CardCreated: async (tx, e) => {
    const p = ev<'CardCreated'>(e).payload;
    if (!p.homeWorkstationId && !p.phaseFollowupId) return;
    await exec(
      tx,
      `UPDATE cards SET home_workstation_id = COALESCE($2, home_workstation_id), phase_followup_id = $3 WHERE id=$1`,
      [p.cardId, p.homeWorkstationId ?? null, p.phaseFollowupId ?? null],
    );
  },

  PhaseProposalSubmitted: async (tx, e) => {
    const p = ev<'PhaseProposalSubmitted'>(e).payload;
    await exec(tx, 'UPDATE phases SET proposal_desk_item_id=$2, updated_at=$3 WHERE id=$1', [
      p.phaseId,
      p.deskItemId,
      e.createdAt,
    ]);
  },

  PhaseConfirmed: async (tx, e) => {
    const p = ev<'PhaseConfirmed'>(e).payload;
    await exec(tx, `UPDATE phases SET status='open', updated_at=$2 WHERE id=$1 AND status='proposed'`, [
      p.phaseId,
      e.createdAt,
    ]);
    await exec(
      tx,
      `UPDATE cards SET phase_assignment='confirmed', updated_at=$3
        WHERE phase_id=$1 AND phase_assignment='proposed' AND id = ANY($2::uuid[])`,
      [p.phaseId, p.confirmedCardIds, e.createdAt],
    );
  },

  PhaseProposalRejected: async (tx, e) => {
    const p = ev<'PhaseProposalRejected'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET phase_id=NULL, phase_assignment=NULL, updated_at=$3
        WHERE phase_id=$1 AND phase_assignment='proposed' AND id = ANY($2::uuid[])`,
      [p.phaseId, p.clearedCardIds, e.createdAt],
    );
    if (p.discard) {
      await exec(tx, `UPDATE phases SET status='discarded', updated_at=$2 WHERE id=$1`, [
        p.phaseId,
        e.createdAt,
      ]);
      await cancelOpenFollowups(tx, p.phaseId, e.createdAt);
    }
  },

  PhaseCompleted: async (tx, e) => {
    const p = ev<'PhaseCompleted'>(e).payload;
    await exec(
      tx,
      `UPDATE phases SET status='reporting', card_outcomes=$2, completed_at=$3, updated_at=$3 WHERE id=$1`,
      [p.phaseId, JSON.stringify(p.cardOutcomes), e.createdAt],
    );
  },

  PhaseReportPosted: async (tx, e) => {
    const p = ev<'PhaseReportPosted'>(e).payload;
    await exec(
      tx,
      `UPDATE phases SET status='awaiting_approval', report=$2, outstanding=$3, report_desk_item_id=$4, updated_at=$5
        WHERE id=$1`,
      [p.phaseId, p.report, JSON.stringify(p.outstanding), p.deskItemId, e.createdAt],
    );
  },

  PhaseReopened: async (tx, e) => {
    const p = ev<'PhaseReopened'>(e).payload;
    await exec(
      tx,
      `UPDATE phases SET status='open', completed_at=NULL, card_outcomes='[]', report=NULL, outstanding='[]',
              report_desk_item_id=NULL, updated_at=$2 WHERE id=$1`,
      [p.phaseId, e.createdAt],
    );
  },

  PhaseFollowupsApproved: async (tx, e) => {
    const p = ev<'PhaseFollowupsApproved'>(e).payload;
    // The approved snapshot replaces the list (it may differ from the rows if the manager edited while deciding).
    await exec(tx, `DELETE FROM phase_followups WHERE phase_id=$1 AND status='pending'`, [p.phaseId]);
    await insertFollowups(tx, p.phaseId, p.followups, 'queued', e.createdAt);
    await exec(
      tx,
      `UPDATE phases SET status='running_followups', approved_by=$2, approved_at=$3, updated_at=$3 WHERE id=$1`,
      [p.phaseId, p.by.userId ?? null, e.createdAt],
    );
  },

  PhaseFollowupsRejected: async (tx, e) => {
    const p = ev<'PhaseFollowupsRejected'>(e).payload;
    await exec(
      tx,
      `UPDATE phases SET status='followups_rejected', finished_at=$2, updated_at=$2 WHERE id=$1`,
      [p.phaseId, e.createdAt],
    );
    await cancelOpenFollowups(tx, p.phaseId, e.createdAt);
  },

  PhaseFollowupBriefed: async (tx, e) => {
    const p = ev<'PhaseFollowupBriefed'>(e).payload;
    await exec(
      tx,
      `UPDATE phase_followups SET status='briefed', delegate=$2, brief=$3, updated_at=$4
        WHERE id=$1 AND status IN ('queued','briefed')`,
      [p.followupId, p.delegate, p.brief, e.createdAt],
    );
  },

  PhaseFollowupStarted: async (tx, e) => {
    const p = ev<'PhaseFollowupStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE phase_followups SET status='running', delegate=$2, devops_request_ids=$3, regression_card_ids=$4,
              ba_task_id=$5, started_at=$6, updated_at=$6,
              evidence = COALESCE(evidence, '{}'::jsonb) || $7::jsonb WHERE id=$1`,
      [
        p.followupId,
        p.delegate,
        p.devopsRequestIds,
        p.regressionCardIds,
        p.baTaskId ?? null,
        e.createdAt,
        JSON.stringify(p.skippedOffline?.length ? { skippedOffline: p.skippedOffline } : {}),
      ],
    );
  },

  PhaseFollowupFinished: async (tx, e) => {
    const p = ev<'PhaseFollowupFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE phase_followups SET status=$2, result_summary=$3, evidence=$4, finished_at=$5,
              started_at = COALESCE(started_at, CASE WHEN $2 IN ('succeeded','failed') THEN $5::timestamptz END),
              updated_at=$5
        WHERE id=$1 AND status NOT IN ('succeeded','failed','skipped','cancelled')`,
      [p.followupId, p.status, p.summary, JSON.stringify(p.evidence), e.createdAt],
    );
  },

  PhaseFollowupsFinished: async (tx, e) => {
    const p = ev<'PhaseFollowupsFinished'>(e).payload;
    // With a results report to write the phase waits for it; without follow-ups it is simply done.
    if (p.baTaskId)
      await exec(tx, `UPDATE phases SET status='reporting_results', updated_at=$2 WHERE id=$1`, [
        p.phaseId,
        e.createdAt,
      ]);
    else
      await exec(tx, `UPDATE phases SET status=$2, finished_at=$3, updated_at=$3 WHERE id=$1`, [
        p.phaseId,
        p.status,
        e.createdAt,
      ]);
  },

  PhaseResultsReported: async (tx, e) => {
    const p = ev<'PhaseResultsReported'>(e).payload;
    await exec(
      tx,
      `UPDATE phases SET status=$2, results_report=$3, results_desk_item_id=$4, finished_at=$5, updated_at=$5 WHERE id=$1`,
      [p.phaseId, p.finalStatus, p.report, p.deskItemId, e.createdAt],
    );
  },

  PhaseCancelled: async (tx, e) => {
    const p = ev<'PhaseCancelled'>(e).payload;
    await exec(tx, `UPDATE phases SET status='cancelled', finished_at=$2, updated_at=$2 WHERE id=$1`, [
      p.phaseId,
      e.createdAt,
    ]);
    await cancelOpenFollowups(tx, p.phaseId, e.createdAt);
    await exec(
      tx,
      `UPDATE phase_followups SET status='cancelled', finished_at=$2, updated_at=$2 WHERE phase_id=$1 AND status='running'`,
      [p.phaseId, e.createdAt],
    );
  },

  ProjectFollowupDefaultsSet: async (tx, e) => {
    const p = ev<'ProjectFollowupDefaultsSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET default_followups=$2 WHERE id=$1', [
      p.projectId,
      JSON.stringify(p.followups.map(({ id: _id, ...rest }) => rest)),
    ]);
  },

  DeployTargetAdded: async (tx, e) => {
    const p = ev<'DeployTargetAdded'>(e).payload;
    const proj = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId]);
    await exec(
      tx,
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, host, app_url, notes, created_by,
         created_at, updated_at, test_enabled, production, destructive_ok, test_hosts, secret_names)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15::text[],$16::text[])`,
      [
        p.targetId,
        proj?.org_id,
        p.projectId,
        p.name,
        p.kind,
        p.workstationId,
        p.host ?? null,
        p.appUrl ?? null,
        p.notes,
        p.createdBy,
        e.createdAt,
        p.testEnabled ?? false,
        p.production ?? false,
        p.destructiveOk ?? false,
        p.testHosts ?? [],
        p.secretNames ?? [],
      ],
    );
  },

  DeployTargetUpdated: async (tx, e) => {
    const p = ev<'DeployTargetUpdated'>(e).payload;
    const c = p.changes;
    await exec(
      tx,
      `UPDATE deploy_targets SET name = COALESCE($2, name), kind = COALESCE($3, kind),
              workstation_id = CASE WHEN $4::boolean THEN $5 ELSE workstation_id END,
              host = CASE WHEN $6::boolean THEN $7 ELSE host END,
              app_url = CASE WHEN $8::boolean THEN $9 ELSE app_url END,
              notes = COALESCE($10, notes), updated_at=$11,
              test_enabled = COALESCE($12, test_enabled), production = COALESCE($13, production),
              destructive_ok = COALESCE($14, destructive_ok), test_hosts = COALESCE($15::text[], test_hosts),
              secret_names = COALESCE($16::text[], secret_names)
        WHERE id=$1`,
      [
        p.targetId,
        c.name ?? null,
        c.kind ?? null,
        c.workstationId !== undefined,
        c.workstationId ?? null,
        c.host !== undefined,
        c.host ?? null,
        c.appUrl !== undefined,
        c.appUrl ?? null,
        c.notes ?? null,
        e.createdAt,
        c.testEnabled ?? null,
        c.production ?? null,
        c.destructiveOk ?? null,
        c.testHosts ?? null,
        c.secretNames ?? null,
      ],
    );
  },

  DeployTargetRemoved: async (tx, e) => {
    const p = ev<'DeployTargetRemoved'>(e).payload;
    await exec(tx, 'UPDATE deploy_targets SET removed_at=$2, updated_at=$2 WHERE id=$1', [
      p.targetId,
      e.createdAt,
    ]);
  },

  BaTaskQueued: async (tx, e) => {
    const p = ev<'BaTaskQueued'>(e).payload;
    const org = e.scope.orgId;
    await exec(
      tx,
      `INSERT INTO ba_tasks (id, org_id, project_id, phase_id, followup_id, kind, status, preferred_agent_id,
         signal_ids, desk_item_ids, local_date, instructions, deliver, schedule_id, schedule_name, org_level, created_at, updated_at,
         batch_id, batch_item_id, mail_draft_id, card_id)
       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19,$20)`,
      [
        p.taskId,
        org,
        p.projectId ?? null,
        p.phaseId ?? null,
        p.followupId ?? null,
        p.kind,
        p.preferredAgentId ?? null,
        p.signalIds ?? [],
        p.deskItemIds ?? [],
        p.localDate ?? null,
        p.instructions ?? null,
        p.deliver ?? null,
        p.scheduleId ?? null,
        p.scheduleName ?? null,
        p.orgLevel ?? false,
        e.createdAt,
        p.batchId ?? null,
        p.batchItemId ?? null,
        p.mailDraftId ?? null,
        p.cardId ?? null,
      ],
    );
    // A floor report is queued once per local day: remember the day on the owner.
    if (p.kind === 'floor_report' && p.localDate)
      await exec(
        tx,
        `UPDATE users SET floor_report_day=$2
          WHERE id = COALESCE((SELECT owner_user_id FROM organizations WHERE id = $1), $1)`,
        [org, p.localDate],
      );
  },

  BaTaskDispatched: async (tx, e) => {
    const p = ev<'BaTaskDispatched'>(e).payload;
    const a = await one<{ org_id: string; runtime: string; model: string }>(
      tx,
      'SELECT org_id, runtime, model FROM agents WHERE id=$1',
      [p.agentId],
    );
    if (a)
      await exec(
        tx,
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, overflow,
           started_at, ba_task_id)
         VALUES ($1,$2,$3,$4,NULL,'ba_task',NULL,'starting',$5,$6,false,$7,$8)
         ON CONFLICT (id) DO NOTHING`,
        [p.shiftId, a.org_id, p.agentId, p.workstationId, a.runtime, a.model, e.createdAt, p.taskId],
      );
    await exec(
      tx,
      `UPDATE ba_tasks SET status='running', agent_id=$2, shift_id=$3, updated_at=$4 WHERE id=$1`,
      [p.taskId, p.agentId, p.shiftId, e.createdAt],
    );
    // Batch intake: the item is being read by the BA.
    await exec(
      tx,
      `UPDATE intake_batch_items SET status='reading', updated_at=$2 WHERE task_id=$1 AND status='queued'`,
      [p.taskId, e.createdAt],
    );
  },

  BaTaskRequeued: async (tx, e) => {
    const p = ev<'BaTaskRequeued'>(e).payload;
    await exec(
      tx,
      `UPDATE ba_tasks SET status='queued', shift_id=NULL, agent_id=NULL, attempts = attempts + $4::int, note=$2, updated_at=$3
        WHERE id=$1`,
      [p.taskId, p.reason, e.createdAt, p.attempt ? 1 : 0],
    );
    await exec(
      tx,
      `UPDATE intake_batch_items SET status='queued', updated_at=$2 WHERE task_id=$1 AND status='reading'`,
      [p.taskId, e.createdAt],
    );
  },

  BaTaskCompleted: async (tx, e) => {
    const p = ev<'BaTaskCompleted'>(e).payload;
    await exec(tx, `UPDATE ba_tasks SET status=$2, note=COALESCE($3, note), updated_at=$4 WHERE id=$1`, [
      p.taskId,
      p.status,
      p.note ?? null,
      e.createdAt,
    ]);
    // Batch intake: a task the server gave up on (no BA, failed attempts) fails its item; the owner can retry.
    if (p.status === 'fallback' || p.status === 'failed')
      await exec(
        tx,
        `UPDATE intake_batch_items SET status='failed', reason=COALESCE($3, 'the BA could not work on this ticket'), updated_at=$2
          WHERE task_id=$1 AND status IN ('queued','reading')`,
        [p.taskId, e.createdAt, p.note ?? null],
      );
  },
};
