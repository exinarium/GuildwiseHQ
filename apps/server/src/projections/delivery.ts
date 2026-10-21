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

  DeliveryRecipeReset: async (tx, e) => {
    const p = ev<'DeliveryRecipeReset'>(e).payload;
    await exec(
      tx,
      `UPDATE delivery_recipes SET status='absent', present=false, observed_hash=NULL, observed_commit=NULL, parsed=NULL,
         lint='[]'::jsonb, file_count=0, files='[]'::jsonb, setup=NULL, hand_edited='{}', approved_hash=NULL,
         approved_commit=NULL, approved_parsed=NULL, approved_files='[]'::jsonb, reset_hash=$2, reset_hashes=$4::text[],
         updated_at=$3
       WHERE project_id=$1`,
      [p.projectId, p.hash, e.createdAt, [...new Set([...(p.hashes ?? []), ...(p.hash ? [p.hash] : [])])]],
    );
  },
  DeployProbesCleared: async (tx, e) => {
    const p = ev<'DeployProbesCleared'>(e).payload;
    await exec(tx, 'DELETE FROM deploy_probes WHERE project_id=$1', [p.projectId]);
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
         parsed, lint, file_count, files, observed_at, created_at, updated_at, setup, hand_edited)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$14::jsonb,$13,$13,$13,$15::jsonb,$16::text[])
       ON CONFLICT (project_id) DO UPDATE SET vault_id=EXCLUDED.vault_id, path=EXCLUDED.path, status=$6, present=EXCLUDED.present,
         observed_hash=EXCLUDED.observed_hash, observed_commit=EXCLUDED.observed_commit, parsed=EXCLUDED.parsed,
         lint=EXCLUDED.lint, file_count=EXCLUDED.file_count, files=EXCLUDED.files, observed_at=EXCLUDED.observed_at, updated_at=EXCLUDED.updated_at,
         setup=EXCLUDED.setup, hand_edited=EXCLUDED.hand_edited`,
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
        p.setup === undefined ? null : j(p.setup),
        p.handEdited ?? [],
      ],
    );
  },

  DeliverySetupDraftSaved: async (tx, e) => {
    const p = ev<'DeliverySetupDraftSaved'>(e).payload;
    await exec(
      tx,
      `INSERT INTO delivery_setup_drafts (project_id, org_id, setup, custom_scripts, proposal_id, updated_by, updated_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)
       ON CONFLICT (project_id) DO UPDATE SET setup=EXCLUDED.setup, custom_scripts=EXCLUDED.custom_scripts,
         proposal_id=EXCLUDED.proposal_id, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [
        p.projectId,
        e.scope.orgId,
        j(p.setup),
        j(p.customScripts ?? {}),
        p.proposalId ?? null,
        p.by,
        e.createdAt,
      ],
    );
  },
  DeliverySetupPublished: async (tx, e) => {
    const p = ev<'DeliverySetupPublished'>(e).payload;
    // saving again (even the same files) starts fresh after an operator reset
    await exec(tx, `UPDATE delivery_recipes SET reset_hash=NULL, reset_hashes='{}' WHERE project_id=$1`, [
      p.projectId,
    ]);
    await exec(tx, `UPDATE delivery_setup_drafts SET last_publish=$2::jsonb WHERE project_id=$1`, [
      p.projectId,
      j({
        setupHash: p.setupHash,
        commandId: p.commandId,
        generator: p.generator,
        at: e.createdAt,
        by: p.by,
        status: 'pending',
      }),
    ]);
  },
  DeliverySetupPublishResult: async (tx, e) => {
    const p = ev<'DeliverySetupPublishResult'>(e).payload;
    await exec(
      tx,
      `UPDATE delivery_setup_drafts SET last_publish = last_publish || $3::jsonb
        WHERE project_id=$1 AND last_publish->>'commandId' = $2`,
      [
        p.projectId,
        p.commandId,
        j({
          status: p.ok ? 'written' : 'failed',
          error: p.error,
          vaultCommit: p.vaultCommit,
          finishedAt: e.createdAt,
        }),
      ],
    );
  },
  DeployTargetProbed: async (tx, e) => {
    const p = ev<'DeployTargetProbed'>(e).payload;
    await exec(
      tx,
      `INSERT INTO deploy_probes (id, org_id, project_id, target_id, workstation_id, scope, host, report, error, detail, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       ON CONFLICT (project_id, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid), workstation_id, scope, COALESCE(host, ''))
       DO UPDATE SET id=EXCLUDED.id, report=EXCLUDED.report, error=EXCLUDED.error, detail=EXCLUDED.detail, at=EXCLUDED.at`,
      [
        p.probeId,
        e.scope.orgId,
        p.projectId,
        p.targetId,
        p.workstationId,
        p.scope,
        p.host,
        j(p.report),
        p.error,
        p.detail,
        p.at,
      ],
    );
  },
  DeployTargetConnectionChecked: async (tx, e) => {
    const p = ev<'DeployTargetConnectionChecked'>(e).payload;
    await exec(
      tx,
      `INSERT INTO deploy_target_connections (target_id, workstation_id, project_id, state, method, host, detail, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (target_id, workstation_id) DO UPDATE SET state=EXCLUDED.state, method=EXCLUDED.method, host=EXCLUDED.host,
         detail=EXCLUDED.detail, at=EXCLUDED.at`,
      [p.targetId, p.workstationId, p.projectId, p.state, p.method, p.host, p.detail, p.at],
    );
  },

  DeployOpFinished: async (tx, e) => {
    const p = ev<'DeployOpFinished'>(e).payload;
    await exec(
      tx,
      `INSERT INTO deploy_ops (command_id, org_id, project_id, target_id, workstation_id, kind, ok, result, error, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (command_id) DO UPDATE SET ok=EXCLUDED.ok, result=EXCLUDED.result, error=EXCLUDED.error, at=EXCLUDED.at`,
      [
        p.opId,
        e.scope.orgId,
        p.projectId,
        p.targetId,
        p.workstationId,
        p.kind,
        p.ok,
        j(p.result),
        p.error,
        p.at,
      ],
    );
  },
  DeployTargetConnected: async (tx, e) => {
    const p = ev<'DeployTargetConnected'>(e).payload;
    await exec(
      tx,
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, address,
         ssh_user, port, host_key_fingerprint, state, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13)
       ON CONFLICT (target_id, workstation_id) DO UPDATE SET fingerprint=EXCLUDED.fingerprint, public_key=EXCLUDED.public_key,
         alias=EXCLUDED.alias, method=EXCLUDED.method, address=EXCLUDED.address, ssh_user=EXCLUDED.ssh_user, port=EXCLUDED.port,
         host_key_fingerprint=EXCLUDED.host_key_fingerprint, state='active', added_at=EXCLUDED.added_at, revoked_at=NULL,
         revoked_by_workstation=NULL`,
      [
        p.targetId,
        p.workstationId,
        p.projectId,
        e.scope.orgId,
        p.fingerprint,
        p.publicKey,
        p.alias,
        p.method,
        p.address,
        p.user,
        p.port,
        p.hostKeyFingerprint,
        p.at,
      ],
    );
  },
  DeployKeyRevoked: async (tx, e) => {
    const p = ev<'DeployKeyRevoked'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_target_keys SET state='revoked', revoked_at=$4, revoked_by_workstation=$5
        WHERE target_id=$1 AND workstation_id=$2 AND fingerprint=$3`,
      [p.targetId, p.workstationId, p.fingerprint, p.at, p.byWorkstationId],
    );
  },
  DeployTargetPrepared: async () => {
    // audit only: the event is the record
  },

  // ---- moving to a new server (v3): every statement is a function of the event and the row, so a replay gives the same rows
  DeployTargetMoveStarted: async (tx, e) => {
    const p = ev<'DeployTargetMoveStarted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO deploy_target_moves (id, org_id, project_id, env_name, from_target_id, to_target_id, workstation_id, spec, domain,
         state, current_step, started_by, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'preparing','check',$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.moveId,
        e.scope.orgId,
        p.projectId,
        p.envName,
        p.fromTargetId,
        p.toTargetId,
        p.workstationId,
        j(p.spec),
        p.domain,
        p.by,
        p.at,
      ],
    );
  },
  DeployTargetMoveStepDone: async (tx, e) => {
    const p = ev<'DeployTargetMoveStepDone'>(e).payload;
    const row = await one<{ steps: Array<{ step: string }> }>(
      tx,
      'SELECT steps FROM deploy_target_moves WHERE id=$1',
      [p.moveId],
    );
    if (!row) return;
    const entry = { step: p.step, ok: p.ok, detail: p.detail, checks: p.checks, at: p.at };
    const steps = [...(row.steps ?? []).filter((s) => s.step !== p.step), entry];
    const done = p.state === 'completed' || p.state === 'cancelled';
    await exec(
      tx,
      `UPDATE deploy_target_moves SET steps=$2::jsonb, state=$3, error=$4, old_app_stopped=$5, facts = facts || $6::jsonb,
              current_step=$7, finished_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE NULL END
        WHERE id=$1`,
      [p.moveId, j(steps), p.state, p.error, p.oldAppStopped, j(p.facts), p.step, done, p.at],
    );
  },
  DeployTargetMoveResumed: async (tx, e) => {
    const p = ev<'DeployTargetMoveResumed'>(e).payload;
    const prepare = ['check', 'copy_config', 'copy_image', 'start_database'].includes(p.step);
    await exec(
      tx,
      `UPDATE deploy_target_moves SET state=$2, current_step=$3, error=NULL, finished_at=NULL WHERE id=$1`,
      [p.moveId, prepare ? 'preparing' : 'moving', p.step],
    );
  },
  DeployTargetMoveCompleted: async (tx, e) => {
    const p = ev<'DeployTargetMoveCompleted'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_target_moves SET state='completed', current_step=NULL, error=NULL, dns=$2, finished_at=$3 WHERE id=$1`,
      [p.moveId, p.dns, p.at],
    );
    // the old server is renamed first (names are unique), then the new one takes the name the approved deploy files use
    await exec(tx, `UPDATE deploy_targets SET name=$2, role='standby', updated_at=$3 WHERE id=$1`, [
      p.fromTargetId,
      p.fromNewName,
      p.at,
    ]);
    await exec(
      tx,
      `UPDATE deploy_targets SET name=$2, role='active', production=$3, app_url=COALESCE($4, app_url), updated_at=$5 WHERE id=$1`,
      [p.toTargetId, p.toNewName, p.production, p.appUrl, p.at],
    );
    // a deploy step of a phase that has not run yet goes to the server that is live now
    await exec(
      tx,
      `UPDATE phase_followups SET target_id=$2 WHERE target_id=$1 AND status IN ('pending','queued','briefed','running')`,
      [p.fromTargetId, p.toTargetId],
    );
  },
  DeployTargetMoveCancelled: async (tx, e) => {
    const p = ev<'DeployTargetMoveCancelled'>(e).payload;
    await exec(
      tx,
      `UPDATE deploy_target_moves SET state='cancelled', current_step=NULL, old_app_stopped=false, finished_at=$2 WHERE id=$1`,
      [p.moveId, p.at],
    );
  },
  DeployTargetRetired: async (tx, e) => {
    const p = ev<'DeployTargetRetired'>(e).payload;
    await exec(tx, `UPDATE deploy_targets SET role='retired', retired_at=$2, updated_at=$2 WHERE id=$1`, [
      p.targetId,
      p.at,
    ]);
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
