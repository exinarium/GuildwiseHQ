import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * The one-off "reset for new environments" (owner decision of 2026-10-21): when the Environments page is released, every deploy
 * place (target) of every project is cleared and the guided setup is forgotten, so each owner sets everything up again in the new
 * page. It is an operator script (`node dist/deploy-reset.mjs --dry-run | --confirm`), never a boot migration.
 *
 * It only appends events (nothing is deleted: approvals, run history and the audit stay in the log) and it never contacts a
 * runner or a server, so Guildwise keys that were installed on servers stay there: the plan lists them. Running it twice changes
 * nothing the second time. A projection rebuild reproduces the result.
 */
export const DEPLOY_RESET_REASON = 'reset for new environments';

export interface ResetTarget {
  id: string;
  name: string;
  kind: string;
  host: string | null;
  workstation: string | null;
  keys: Array<{ alias: string; workstation: string; fingerprint: string }>;
}

export interface ResetProject {
  orgId: string;
  orgName: string;
  projectId: string;
  key: string;
  name: string;
  targets: ResetTarget[];
  /** The project has a delivery recipe in force (observed or approved) that is cleared. */
  recipe: { id: string; hash: string | null } | null;
  draft: boolean;
  deliveryMode: string;
  openRuns: Array<{ id: string; env: string; status: string }>;
  runningRuns: number;
  followups: Array<{ id: string; phaseId: string; status: string }>;
  notices: string[];
}

export interface ResetPlan {
  projects: ResetProject[];
}

export async function planDeployReset(
  pool: DataMigrationEnv['pool'],
  opts: { orgId?: string } = {},
): Promise<ResetPlan> {
  const projects = await rows(
    pool,
    `SELECT p.id, p.key, p.name, p.org_id, p.delivery_mode, o.name AS org_name FROM projects p
       JOIN organizations o ON o.id = p.org_id
      WHERE p.kind='project' AND ($1::uuid IS NULL OR p.org_id = $1)
      ORDER BY o.name, p.key`,
    [opts.orgId ?? null],
  );
  const out: ResetProject[] = [];
  for (const p of projects) {
    const targets = await rows(
      pool,
      `SELECT t.id, t.name, t.kind, t.host, w.name AS workstation FROM deploy_targets t
         LEFT JOIN workstations w ON w.id = t.workstation_id
        WHERE t.project_id=$1 AND t.removed_at IS NULL ORDER BY lower(t.name)`,
      [p.id],
    );
    const keys = await rows(
      pool,
      `SELECT k.target_id, k.alias, k.fingerprint, w.name AS workstation FROM deploy_target_keys k
         JOIN workstations w ON w.id = k.workstation_id WHERE k.project_id=$1 AND k.state='active'`,
      [p.id],
    );
    const recipe = (
      await rows(
        pool,
        `SELECT id, observed_hash, approved_hash, present FROM delivery_recipes WHERE project_id=$1 AND (present OR approved_hash IS NOT NULL)`,
        [p.id],
      )
    )[0];
    const draft = (
      await rows(pool, `SELECT 1 AS x FROM delivery_setup_drafts WHERE project_id=$1 AND jsonb_typeof(setup) = 'object'`, [p.id])
    )[0];
    const runs = await rows(
      pool,
      `SELECT id, env, status FROM deploy_runs WHERE project_id=$1 AND NOT trial AND status IN ('requested','waiting_release','queued','running')`,
      [p.id],
    );
    const followups = await rows(
      pool,
      `SELECT f.id, f.phase_id, f.status FROM phase_followups f JOIN phases ph ON ph.id = f.phase_id
        WHERE ph.project_id=$1 AND f.kind='deploy' AND f.status IN ('pending','queued','briefed')
          AND (f.target_id IN (SELECT id FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL) OR f.environment IS NOT NULL)`,
      [p.id],
    );
    const notices = await rows(
      pool,
      `SELECT id FROM desk_items WHERE project_id=$1 AND status='open'
          AND (subject_key LIKE 'deploy_release:%' OR subject_key LIKE 'recipe_approval:%')`,
      [p.id],
    ).catch(() => []);
    const hasAnything = targets.length > 0 || recipe || draft || runs.length > 0 || followups.length > 0;
    if (!hasAnything && p.delivery_mode !== 'recipe') continue;
    out.push({
      orgId: p.org_id,
      orgName: p.org_name,
      projectId: p.id,
      key: p.key,
      name: p.name,
      targets: targets.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        host: t.host ?? null,
        workstation: t.workstation ?? null,
        keys: keys
          .filter((k) => k.target_id === t.id)
          .map((k) => ({ alias: k.alias, workstation: k.workstation, fingerprint: k.fingerprint })),
      })),
      recipe: recipe ? { id: recipe.id, hash: recipe.approved_hash ?? recipe.observed_hash ?? null } : null,
      draft: !!draft,
      deliveryMode: p.delivery_mode,
      openRuns: runs.filter((r) => r.status !== 'running').map((r) => ({ id: r.id, env: r.env, status: r.status })),
      runningRuns: runs.filter((r) => r.status === 'running').length,
      followups: followups.map((f) => ({ id: f.id, phaseId: f.phase_id, status: f.status })),
      notices: notices.map((n) => n.id),
    });
  }
  return { projects: out };
}

export function formatResetPlan(plan: ResetPlan): string {
  if (plan.projects.length === 0) return 'Nothing to reset: no project has deploy places or a delivery setup.';
  const lines: string[] = [];
  let org = '';
  const keyLines: string[] = [];
  for (const p of plan.projects) {
    if (p.orgName !== org) {
      org = p.orgName;
      lines.push(`\nOrganization ${org}`);
    }
    lines.push(
      `  ${p.key} ${p.name}: ${p.targets.length} place${p.targets.length === 1 ? '' : 's'} removed${
        p.recipe ? ', delivery setup cleared' : ''
      }${p.draft ? ', draft discarded' : ''}${p.deliveryMode === 'recipe' ? ', delivery back to instructions' : ''}${
        p.openRuns.length ? `, ${p.openRuns.length} waiting/queued release${p.openRuns.length === 1 ? '' : 's'} cancelled` : ''
      }${p.followups.length ? `, ${p.followups.length} phase follow-up${p.followups.length === 1 ? '' : 's'} skipped` : ''}`,
    );
    if (p.runningRuns) lines.push(`    ${p.runningRuns} release is running right now and is NOT stopped`);
    for (const t of p.targets) {
      lines.push(`    - ${t.name} (${t.kind}${t.host ? `, ssh alias ${t.host}` : ''}${t.workstation ? `, via ${t.workstation}` : ''})`);
      for (const k of t.keys)
        keyLines.push(`${p.key} ${t.name}: server ${k.alias}, key ${k.fingerprint}, installed from ${k.workstation}`);
    }
  }
  lines.push(
    '\nServers where a Guildwise key may remain (nothing was removed from any server; take the lines starting with "guildwise-deploy:" out of authorized_keys by hand if you want them gone):',
  );
  lines.push(...(keyLines.length ? keyLines.map((l) => `  ${l}`) : ['  none recorded']));
  return lines.join('\n');
}

/** Appends the events of the reset for every project of the plan. Returns the number of projects changed. */
export async function applyDeployReset(env: DataMigrationEnv, plan: ResetPlan): Promise<number> {
  let changed = 0;
  for (const p of plan.projects) {
    const scope = projectScope(p.orgId, p.projectId);
    const owner = (await rows(env.pool, 'SELECT owner_user_id FROM organizations WHERE id=$1', [p.orgId]))[0];
    const by = owner?.owner_user_id as string | undefined;
    await withAppendTx(env.pool, async (tx) => {
      const events: AppendInput[] = [];
      for (const r of p.openRuns)
        events.push({
          streamId: streamId.project(p.projectId),
          event: { type: 'DeployRunCancelled', payload: { runId: r.id, orgId: p.orgId, projectId: p.projectId, by: null } },
          actor: SYSTEM_ACTOR,
          scope,
        });
      for (const f of p.followups)
        events.push({
          streamId: streamId.phase(f.phaseId),
          event: {
            type: 'PhaseFollowupFinished',
            payload: {
              phaseId: f.phaseId,
              followupId: f.id,
              status: 'skipped',
              summary: 'The deploy places were cleared for the new Environments page. Choose the environment again.',
              evidence: {},
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      if (p.draft && by)
        events.push({
          streamId: streamId.project(p.projectId),
          event: { type: 'DeliverySetupDraftSaved', payload: { projectId: p.projectId, setup: null, customScripts: {}, by } },
          actor: SYSTEM_ACTOR,
          scope,
        });
      if (p.recipe)
        events.push({
          streamId: streamId.project(p.projectId),
          event: {
            type: 'DeliveryRecipeReset',
            payload: {
              recipeId: p.recipe.id,
              orgId: p.orgId,
              projectId: p.projectId,
              hash: p.recipe.hash,
              reason: DEPLOY_RESET_REASON,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      if (p.deliveryMode === 'recipe')
        events.push({
          streamId: streamId.project(p.projectId),
          event: { type: 'DeliveryModeSet', payload: { projectId: p.projectId, orgId: p.orgId, mode: 'instructions', by: null } },
          actor: SYSTEM_ACTOR,
          scope,
        });
      for (const t of p.targets)
        events.push({
          streamId: streamId.project(p.projectId),
          event: { type: 'DeployTargetRemoved', payload: { targetId: t.id, reason: DEPLOY_RESET_REASON } },
          actor: SYSTEM_ACTOR,
          scope,
        });
      for (const id of p.notices)
        events.push({
          streamId: streamId.desk(id),
          event: { type: 'DeskItemResolved', payload: { deskItemId: id, resolution: 'acknowledged', by: { kind: 'system' } } },
          actor: SYSTEM_ACTOR,
          scope,
        });
      if (events.length) await env.store.append(events, { tx });
      // queued commands that were never delivered are dropped from the queue; nothing is sent to any runner
      for (const r of p.openRuns)
        await tx.query(
          `UPDATE runner_commands SET status='failed', last_error=$2, payload='{}'::jsonb
            WHERE type='deploy.exec' AND status='pending' AND payload->>'runId'=$1`,
          [r.id, DEPLOY_RESET_REASON],
        );
    });
    changed++;
    env.log(`${p.key}: reset`);
  }
  return changed;
}
