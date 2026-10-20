import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;
const j = (v: unknown) => JSON.stringify(v ?? null);

/** Delivery recipes, gates and deploy runs (docs/design/ceo-front-door.md section 9.7). Replay-safe: every statement is a function of the event and the row. */
export const deliveryProjectors: Record<string, Projector> = {
  DeliveryModeSet: async (tx, e) => {
    const p = ev<'DeliveryModeSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET delivery_mode=$2 WHERE id=$1', [p.projectId, p.mode]);
  },

  DeliveryRecipeObserved: async (tx, e) => {
    const p = ev<'DeliveryRecipeObserved'>(e).payload;
    const cur = await one<{ approved_hash: string | null; status: string }>(
      tx,
      'SELECT approved_hash, status FROM delivery_recipes WHERE project_id=$1',
      [p.projectId],
    );
    const status = !p.present
      ? 'absent'
      : cur?.approved_hash
        ? cur.approved_hash === p.hash
          ? 'approved'
          : 'changed_unapproved'
        : 'observed';
    await exec(
      tx,
      `INSERT INTO delivery_recipes (id, org_id, project_id, vault_id, path, status, present, observed_hash, observed_commit,
         parsed, lint, file_count, files, observed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$14::jsonb,$13,$13,$13)
       ON CONFLICT (project_id) DO UPDATE SET vault_id=EXCLUDED.vault_id, path=EXCLUDED.path, status=$6, present=EXCLUDED.present,
         observed_hash=EXCLUDED.observed_hash, observed_commit=EXCLUDED.observed_commit, parsed=EXCLUDED.parsed,
         lint=EXCLUDED.lint, file_count=EXCLUDED.file_count, files=EXCLUDED.files, observed_at=EXCLUDED.observed_at, updated_at=EXCLUDED.updated_at`,
      [
        p.recipeId,
        p.orgId,
        p.projectId,
        p.vaultId,
        p.path,
        status,
        p.present,
        p.present ? p.hash : null,
        p.vaultCommit,
        j(p.recipe),
        j(p.lint),
        p.fileCount,
        e.createdAt,
        j(p.files),
      ],
    );
  },

  DeliveryRecipeDrifted: async (tx, e) => {
    const p = ev<'DeliveryRecipeDrifted'>(e).payload;
    await exec(
      tx,
      `UPDATE delivery_recipes SET status='changed_unapproved', updated_at=$2 WHERE id=$1 AND approved_hash IS NOT NULL`,
      [p.recipeId, e.createdAt],
    );
  },

  DeliveryRecipeApproved: async (tx, e) => {
    const p = ev<'DeliveryRecipeApproved'>(e).payload;
    await exec(
      tx,
      `UPDATE delivery_recipes SET status='approved', approved_hash=$2, approved_commit=$3, approved_by=$4, approved_at=$5,
              version=$6, approved_parsed = CASE WHEN observed_hash = $2 THEN parsed ELSE approved_parsed END,
              approved_files = CASE WHEN observed_hash = $2 THEN files ELSE approved_files END, updated_at=$5
        WHERE id=$1`,
      [p.recipeId, p.hash, p.vaultCommit, p.by, e.createdAt, p.version],
    );
  },

  DeliveryRecipeRejected: async (tx, e) => {
    const p = ev<'DeliveryRecipeRejected'>(e).payload;
    await exec(
      tx,
      `UPDATE delivery_recipes SET status = CASE WHEN approved_hash = $2 THEN 'approved' ELSE 'rejected' END, updated_at=$3
        WHERE id=$1 AND observed_hash = $2`,
      [p.recipeId, p.hash, e.createdAt],
    );
  },

  GatePresetSet: async (tx, e) => {
    const p = ev<'GatePresetSet'>(e).payload;
    await exec(
      tx,
      `INSERT INTO gate_presets (org_id, name, gate, updated_by, updated_at) VALUES ($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT (org_id, name) DO UPDATE SET gate=EXCLUDED.gate, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [p.orgId, p.name, j(p.gate), p.by, e.createdAt],
    );
  },
  GatePresetRemoved: async (tx, e) => {
    const p = ev<'GatePresetRemoved'>(e).payload;
    await exec(tx, 'DELETE FROM gate_presets WHERE org_id=$1 AND name=$2', [p.orgId, p.name]);
  },
  GateBindingSet: async (tx, e) => {
    const p = ev<'GateBindingSet'>(e).payload;
    const scope = [p.orgId, p.projectId, p.repoId, p.envMatch];
    await exec(
      tx,
      `DELETE FROM gate_bindings WHERE org_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND repo_id IS NOT DISTINCT FROM $3 AND env_match=$4`,
      scope,
    );
    if (p.preset)
      await exec(
        tx,
        `INSERT INTO gate_bindings (id, org_id, project_id, repo_id, env_match, preset, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.bindingId, p.orgId, p.projectId, p.repoId, p.envMatch, p.preset, p.by, e.createdAt],
      );
  },

  DeployRunRequested: async (tx, e) => {
    const p = ev<'DeployRunRequested'>(e).payload;
    await exec(
      tx,
      `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_id, target_name, workstation_id, hash,
         vault_commit, commit, trigger, requested_by, origin, status, released_by_policy, trial, dry_run,
         phase_followup_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,'requested',$15,$16,$17,$18,$19,$19)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.runId,
        p.orgId,
        p.projectId,
        p.recipeId,
        p.env,
        p.targetId,
        p.targetName,
        p.workstationId,
        p.hash,
        p.vaultCommit,
        p.commit,
        p.trigger,
        j(p.requestedBy),
        j(p.origin),
        p.releasedBy,
        p.trial,
        p.dryRun,
        p.phaseFollowupId ?? null,
        e.createdAt,
      ],
    );
  },
  DeployGateSatisfied: async (tx, e) => {
    const p = ev<'DeployGateSatisfied'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_runs SET status='queued', waiting_for=NULL, gate=$2::jsonb, evidence=$3::jsonb, released_by=$4::jsonb, updated_at=$5
        WHERE id=$1 AND status IN ('requested','waiting_release')`,
      [p.runId, j(p.gate), j(p.evidence), j(p.releasedBy), e.createdAt],
    );
  },
  DeployRunQueued: async (tx, e) => {
    const p = ev<'DeployRunQueued'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_runs SET status='waiting_release', waiting_for=$2, updated_at=$3 WHERE id=$1 AND status IN ('requested','waiting_release')`,
      [p.runId, p.waitingFor, e.createdAt],
    );
  },
  DeployRunStarted: async (tx, e) => {
    const p = ev<'DeployRunStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_runs SET status='running', started_at=$2, workstation_id=$3, updated_at=$2 WHERE id=$1 AND status IN ('queued','running')`,
      [p.runId, e.createdAt, p.workstationId],
    );
  },
  DeployRunFinished: async (tx, e) => {
    const p = ev<'DeployRunFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_runs SET status=$2, health=$3::jsonb, smoke=$4::jsonb, url=$5, deployed_commit=$6, summary=$7, log_tail=$8,
              refusal = CASE WHEN $2 = 'refused' THEN COALESCE(refusal, $7) ELSE refusal END, finished_at=$9, updated_at=$9,
              result=$10::jsonb
        WHERE id=$1 AND status IN ('queued','running','requested','waiting_release')`,
      [
        p.runId,
        p.outcome,
        j(p.health),
        j(p.smoke),
        p.url ?? null,
        p.deployedCommit,
        p.summary,
        p.logTail,
        e.createdAt,
        j({ exitCode: p.exitCode }),
      ],
    );
  },
  DeployRunRefused: async (tx, e) => {
    const p = ev<'DeployRunRefused'>(e).payload;
    const r = p.request;
    if (r)
      await exec(
        tx,
        `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_id, target_name, hash, commit, trigger,
           requested_by, origin, status, released_by_policy, trial, refusal, refusal_detail, missing, phase_followup_id, created_at, finished_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,'refused',$13,$14,$15,$16,$17::jsonb,$19,$18,$18,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.runId,
          p.orgId,
          p.projectId,
          r.recipeId ?? '00000000-0000-0000-0000-000000000000',
          p.env,
          r.targetId,
          r.targetName,
          r.hash,
          r.commit,
          r.trigger,
          j(r.requestedBy),
          j(r.origin),
          r.releasedBy,
          r.trial,
          p.reason,
          p.detail,
          j(p.missing),
          e.createdAt,
          r.phaseFollowupId ?? null,
        ],
      );
    await exec(
      tx,
      `UPDATE deploy_runs SET status='refused', refusal=$2, refusal_detail=$3, missing=$4::jsonb, finished_at=$5, updated_at=$5
        WHERE id=$1 AND status IN ('requested','waiting_release','queued')`,
      [p.runId, p.reason, p.detail, j(p.missing), e.createdAt],
    );
  },
  DeployRunCancelled: async (tx, e) => {
    const p = ev<'DeployRunCancelled'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_runs SET status='cancelled', finished_at=$2, updated_at=$2 WHERE id=$1 AND status IN ('requested','waiting_release','queued')`,
      [p.runId, e.createdAt],
    );
  },
};
