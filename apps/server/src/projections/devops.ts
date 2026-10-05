import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const devopsProjectors: Record<string, Projector> = {
  DevOpsRequested: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsRequested'>).payload;
    const ws = await one<{ user_id: string }>(tx, 'SELECT user_id FROM workstations WHERE id=$1', [
      p.workstationId,
    ]);
    const card = p.cardId
      ? await one<{ project_id: string }>(tx, 'SELECT project_id FROM cards WHERE id=$1', [p.cardId])
      : undefined;
    await exec(
      tx,
      `INSERT INTO devops_requests (id, org_id, workstation_id, devops_agent_id, thread_id, requested_by_kind,
         requested_by_id, requested_by_name, card_id, summary, hygiene, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$12::jsonb,'queued',$11,$11)`,
      [
        p.requestId,
        ws?.user_id,
        p.workstationId,
        p.devopsAgentId,
        p.threadId,
        p.requestedBy.kind,
        p.requestedBy.id,
        p.requestedBy.name ?? null,
        p.cardId ?? null,
        p.summary,
        e.createdAt,
        p.hygiene ? JSON.stringify(p.hygiene) : null,
      ],
    );
    if (p.hygiene)
      await exec(tx, 'UPDATE workstations SET hygiene_last_at=$2 WHERE id=$1', [
        p.workstationId,
        e.createdAt,
      ]);
    await exec(
      tx,
      `INSERT INTO threads (id, org_id, project_id, card_id, kind, agent_id, title, created_by, created_at)
       VALUES ($1,$2,$3,$4,'devops',$5,$6,$7,$8)`,
      [
        p.threadId,
        ws?.user_id,
        card?.project_id ?? null,
        p.cardId ?? null,
        p.devopsAgentId,
        `DevOps: ${p.summary.replace(/\s+/g, ' ').slice(0, 100)}`,
        p.requestedBy.kind === 'user' ? p.requestedBy.id : null,
        e.createdAt,
      ],
    );
  },
  DevOpsShiftDispatched: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsShiftDispatched'>).payload;
    const a = await one<{ org_id: string; runtime: string; model: string }>(
      tx,
      'SELECT org_id, runtime, model FROM agents WHERE id=$1',
      [p.agentId],
    );
    if (a) {
      await exec(
        tx,
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, overflow, started_at)
         VALUES ($1,$2,$3,$4,NULL,'devops',NULL,'starting',$5,$6,false,$7)
         ON CONFLICT (id) DO NOTHING`,
        [p.shiftId, a.org_id, p.agentId, p.workstationId, a.runtime, a.model, e.createdAt],
      );
    }
    await exec(tx, `UPDATE devops_requests SET status='running', shift_id=$2, updated_at=$3 WHERE id=$1`, [
      p.requestId,
      p.shiftId,
      e.createdAt,
    ]);
  },
  EnvironmentChanged: async (tx, e) => {
    const p = (e.event as EventOf<'EnvironmentChanged'>).payload;
    await exec(
      tx,
      `INSERT INTO environment_changes (id, request_id, workstation_id, summary, commands, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [p.changeId, p.requestId ?? null, p.workstationId, p.summary, p.commands, e.createdAt],
    );
  },
  DevOpsApprovalNeeded: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsApprovalNeeded'>).payload;
    await exec(
      tx,
      `UPDATE devops_requests SET status='needs_approval', shift_id=NULL, updated_at=$2,
              approval = $3::jsonb WHERE id=$1`,
      [
        p.requestId,
        e.createdAt,
        JSON.stringify({
          deskItemId: p.deskItemId,
          action: p.action,
          reason: p.reason,
          commands: p.commands,
          resolution: null,
        }),
      ],
    );
  },
  DevOpsApprovalResolved: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsApprovalResolved'>).payload;
    await exec(
      tx,
      `UPDATE devops_requests
          SET status = CASE WHEN $2 = 'approved' THEN 'queued' ELSE 'failed' END,
              result_summary = CASE WHEN $2 = 'approved' THEN result_summary ELSE 'Approval rejected' || COALESCE(': ' || $4, '') END,
              approval = COALESCE(approval, '{}'::jsonb) || jsonb_build_object('resolution', $2::text, 'note', $4::text),
              updated_at = $3
        WHERE id=$1`,
      [p.requestId, p.resolution, e.createdAt, p.note ?? null],
    );
  },
  DevOpsRequestRequeued: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsRequestRequeued'>).payload;
    await exec(tx, `UPDATE devops_requests SET status='queued', shift_id=NULL, updated_at=$2 WHERE id=$1`, [
      p.requestId,
      e.createdAt,
    ]);
  },
  DevOpsRequestCompleted: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsRequestCompleted'>).payload;
    await exec(
      tx,
      `UPDATE devops_requests SET status=$2, shift_id=NULL, result_summary=$3, updated_at=$4 WHERE id=$1`,
      [p.requestId, p.status, p.summary, e.createdAt],
    );
  },
  DevOpsAccessChanged: async (tx, e) => {
    const p = (e.event as EventOf<'DevOpsAccessChanged'>).payload;
    await exec(tx, 'UPDATE workstations SET devops_access=$2::jsonb WHERE id=$1', [
      p.workstationId,
      JSON.stringify(p.access),
    ]);
  },
};
