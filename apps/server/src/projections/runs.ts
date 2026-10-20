import { type EventOf, IntegrationTestsSchema } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** Run & test settings (migration 1880) and run plans (migration 1890). `run_environments` is operational, not projected. */
export const runProjectors: Record<string, Projector> = {
  ProjectRunSettingsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectRunSettingsSet'>).payload;
    await exec(tx, 'UPDATE projects SET run_instructions=$2, run_settings=$3::jsonb WHERE id=$1', [
      p.projectId,
      p.runInstructions,
      JSON.stringify(p.settings),
    ]);
    // The whole list: a repository not named has no instructions.
    await exec(tx, `UPDATE project_repos SET run_instructions='' WHERE project_id=$1`, [p.projectId]);
    for (const r of p.repoInstructions)
      await exec(tx, 'UPDATE project_repos SET run_instructions=$3 WHERE id=$2 AND project_id=$1', [
        p.projectId,
        r.repoId,
        r.runInstructions,
      ]);
  },
  ProjectIntegrationTestsSet: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectIntegrationTestsSet'>).payload;
    await exec(tx, 'UPDATE projects SET integration_tests=$2::jsonb WHERE id=$1', [
      p.projectId,
      JSON.stringify(p.settings),
    ]);
  },
  IntegrationSuitesProposed: async (tx, e) => {
    const p = (e.event as EventOf<'IntegrationSuitesProposed'>).payload;
    const row = await one<{ integration_tests: unknown }>(
      tx,
      'SELECT integration_tests FROM projects WHERE id=$1',
      [p.projectId],
    );
    const settings = IntegrationTestsSchema.parse(row?.integration_tests ?? {});
    const known = new Set(settings.suites.map((s) => s.name.toLowerCase()));
    const added = p.suites
      .filter((s) => !known.has(s.name.toLowerCase()))
      .map((s) => ({ ...s, confirmed: false }));
    if (added.length === 0 || settings.suites.length + added.length > 30) return;
    await exec(tx, 'UPDATE projects SET integration_tests=$2::jsonb WHERE id=$1', [
      p.projectId,
      JSON.stringify({ ...settings, suites: [...settings.suites, ...added] }),
    ]);
  },
  TestSuiteReported: async (tx, e) => {
    const p = (e.event as EventOf<'TestSuiteReported'>).payload;
    await exec(
      tx,
      `INSERT INTO test_suite_results (id, org_id, project_id, card_id, shift_id, agent_id, suite, kind, env_mode, env_id,
          deploy_target_id, commit, status, passed, failed, skipped, duration_ms, attempts, failures, attachment_id,
          note, event_seq, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb,
          $19, $20, $21, $22)`,
      [
        e.scope.orgId,
        e.scope.projectId,
        p.cardId,
        p.shiftId,
        p.testerAgentId,
        p.suite,
        p.kind,
        p.envMode,
        p.envId,
        p.deployTargetId,
        p.commit,
        p.status,
        p.passed,
        p.failed,
        p.skipped,
        p.durationMs,
        p.attempts,
        JSON.stringify(p.failures),
        p.attachmentId,
        p.note,
        e.seq.toString(),
        e.createdAt,
      ],
    );
  },
  RunPlanSaved: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanSaved'>).payload;
    const req = p.requestId
      ? await one<{ devops_agent_id: string }>(
          tx,
          'SELECT devops_agent_id FROM devops_requests WHERE id=$1',
          [p.requestId],
        )
      : undefined;
    // One live plan per (project, workstation); workstation null is the project-wide plan.
    await exec(
      tx,
      `UPDATE run_plans SET status='superseded' WHERE project_id=$1 AND workstation_id IS NOT DISTINCT FROM $2::uuid AND status <> 'superseded'`,
      [p.projectId, p.workstationId],
    );
    await exec(
      tx,
      `INSERT INTO run_plans (id, org_id, project_id, workstation_id, version, status, plan, fingerprint,
                              devops_request_id, saved_by_agent_id, created_at, build_hash, settings_hash,
                              source, saved_by, proposal_id)
       VALUES ($1,$2,$3,$4,$5,'active',$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        p.planId,
        e.scope.orgId,
        p.projectId,
        p.workstationId,
        p.version,
        JSON.stringify(p.plan),
        p.fingerprint,
        p.requestId,
        req?.devops_agent_id ?? null,
        e.createdAt,
        p.buildHash ?? null,
        p.settingsHash ?? null,
        p.source ?? 'devops',
        p.savedBy ?? null,
        p.proposalId ?? null,
      ],
    );
  },
  RunPlanMarkedStale: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanMarkedStale'>).payload;
    await exec(tx, `UPDATE run_plans SET status='stale' WHERE id=$1 AND status='active'`, [p.planId]);
  },
  RunPlanFailureNoted: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanFailureNoted'>).payload;
    await exec(tx, `UPDATE run_plans SET last_failure=$2::jsonb WHERE id=$1 AND status <> 'superseded'`, [
      p.planId,
      JSON.stringify({ reason: p.reason, at: e.createdAt.toISOString() }),
    ]);
  },
  RunPlanFailureCleared: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanFailureCleared'>).payload;
    await exec(tx, `UPDATE run_plans SET last_failure=NULL WHERE id=$1`, [p.planId]);
  },
  RunPlanConsentGiven: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanConsentGiven'>).payload;
    await exec(
      tx,
      `INSERT INTO run_plan_consents (plan_id, workstation_id, project_id, allowed_by, allowed_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (plan_id, workstation_id) DO NOTHING`,
      [p.planId, p.workstationId, p.projectId, p.by, e.createdAt],
    );
  },
  RunPlanDiscarded: async (tx, e) => {
    const p = (e.event as EventOf<'RunPlanDiscarded'>).payload;
    await exec(tx, `UPDATE run_plans SET status='superseded' WHERE id=$1`, [p.planId]);
  },
  SetupProposalSubmitted: async (tx, e) => {
    const p = (e.event as EventOf<'SetupProposalSubmitted'>).payload;
    // A newer proposal replaces the older open one of the same area.
    await exec(
      tx,
      `UPDATE setup_proposals SET status='superseded', resolved_at=$3 WHERE project_id=$1 AND area=$2 AND status='open'`,
      [p.projectId, p.area, e.createdAt],
    );
    await exec(
      tx,
      `INSERT INTO setup_proposals (id, org_id, project_id, area, request_id, workstation_id, proposal, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'open',$8)`,
      [
        p.proposalId,
        e.scope.orgId,
        p.projectId,
        p.area,
        p.requestId,
        p.workstationId,
        JSON.stringify(p.proposal),
        e.createdAt,
      ],
    );
  },
  SetupProposalResolved: async (tx, e) => {
    const p = (e.event as EventOf<'SetupProposalResolved'>).payload;
    await exec(
      tx,
      `UPDATE setup_proposals SET status=$2, resolved_at=$3, resolved_by=$4 WHERE id=$1 AND status='open'`,
      [p.proposalId, p.outcome, e.createdAt, p.by],
    );
  },
};
