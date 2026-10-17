import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const shiftProjectors: Record<string, Projector> = {
  // The claim creates the shift row ('starting'); the runner's shift.started flips it to running.
  CardClaimed: async (tx, e) => {
    const p = (e.event as EventOf<'CardClaimed'>).payload;
    const a = await one<{ org_id: string; runtime: string; model: string }>(
      tx,
      'SELECT org_id, runtime, model FROM agents WHERE id=$1',
      [p.agentId],
    );
    if (!a) return;
    await exec(
      tx,
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, overflow, started_at)
       VALUES ($1,$2,$3,$4,$5,'card',$6,'starting',$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.shiftId,
        a.org_id,
        p.agentId,
        p.workstationId,
        p.cardId,
        p.stage,
        a.runtime,
        a.model,
        p.overflow,
        e.createdAt,
      ],
    );
  },
  ShiftStarted: async (tx, e) => {
    const p = (e.event as EventOf<'ShiftStarted'>).payload;
    const a = await one<{ org_id: string }>(tx, 'SELECT org_id FROM agents WHERE id=$1', [p.agentId]);
    if (a) {
      await exec(
        tx,
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model,
           runtime_session_id, overflow, started_at, project_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET status = 'running', runtime_session_id = EXCLUDED.runtime_session_id,
           project_id = COALESCE(shifts.project_id, EXCLUDED.project_id)`,
        [
          p.shiftId,
          a.org_id,
          p.agentId,
          p.workstationId,
          p.cardId ?? null,
          p.kind,
          p.stage ?? null,
          p.runtime,
          p.model,
          p.runtimeSessionId ?? null,
          p.overflow,
          e.createdAt,
          p.projectId ?? null,
        ],
      );
      // A shift that started is the end of "the last attempt failed" on the board.
      if (p.cardId)
        await exec(tx, 'UPDATE cards SET last_rejection=NULL WHERE id=$1 AND last_rejection IS NOT NULL', [
          p.cardId,
        ]);
    }
    if (p.worktree && p.cardId) {
      await exec(tx, 'UPDATE shifts SET start_sha=$2 WHERE id=$1', [p.shiftId, p.worktree.headSha]);
      await exec(
        tx,
        `UPDATE cards SET worktree_path = COALESCE(worktree_path, $2), branch_name = COALESCE(branch_name, $3),
                          base_branch = COALESCE(base_branch, $4)
          WHERE id=$1`,
        [p.cardId, p.worktree.path, p.worktree.branchName, p.worktree.baseBranch],
      );
    }
  },
  ShiftUsageRecorded: async (tx, e) => {
    const p = (e.event as EventOf<'ShiftUsageRecorded'>).payload;
    await exec(
      tx,
      `UPDATE shifts SET tokens_input=$2, tokens_output=$3, tokens_cache_read=$4, tokens_cache_write=$5
        WHERE id=$1 AND tokens_input + tokens_output + tokens_cache_read + tokens_cache_write = 0`,
      [
        p.shiftId,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.cacheReadTokens,
        p.usage.cacheWriteTokens,
      ],
    );
  },
  ShiftSessionRecorded: async (tx, e) => {
    const p = (e.event as EventOf<'ShiftSessionRecorded'>).payload;
    await exec(
      tx,
      `UPDATE shifts SET runtime_session_id = COALESCE($2, runtime_session_id),
                         context_tokens = COALESCE($3, context_tokens),
                         resume_state = COALESCE($4, resume_state)
        WHERE id=$1`,
      [p.shiftId, p.runtimeSessionId ?? null, p.contextTokens ?? null, p.resumeState ?? null],
    );
  },
  ShiftEnded: async (tx, e) => {
    const p = (e.event as EventOf<'ShiftEnded'>).payload;
    await exec(
      tx,
      `UPDATE shifts SET status='ended', outcome=CASE WHEN $2 = 'stopped' AND $3::text IS NOT NULL THEN 'reported' ELSE $2 END, report_outcome=$3, ended_at=$4, duration_ms=$5,
              tokens_input=$6, tokens_output=$7, tokens_cache_read=$8, tokens_cache_write=$9,
              rejection_reason=COALESCE($10, rejection_reason)
        WHERE id=$1`,
      [
        p.shiftId,
        p.outcome,
        p.reportOutcome ?? null,
        e.createdAt,
        p.durationMs,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.cacheReadTokens,
        p.usage.cacheWriteTokens,
        p.rejectionReason ?? null,
      ],
    );
    await exec(tx, 'UPDATE agents SET last_shift_ended_at=$2 WHERE id=$1', [p.agentId, e.createdAt]);
  },
};
