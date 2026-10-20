import { CLAUDE_ACCOUNTS_CAPABILITY, MAIN_ACCOUNT } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

/**
 * Per-project Claude accounts (docs/design/claude-accounts.md section 2.3): asking a workstation's runner to provision
 * an account (`claude.account.ensure`). The runner is idempotent, so a repeat is harmless; the server throttles it.
 */

/** A workstation is asked again for the same key at most this often when it reports the key missing at hello. */
export const ENSURE_THROTTLE_MS = 24 * 3600_000;

/**
 * Active workstations that serve the project's organization, host at least one active Claude Code agent allowed on
 * the project, and run a runner that understands accounts.
 */
export async function ensureTargets(
  db: Queryable,
  project: { id: string; org_id: string },
): Promise<Array<{ id: string }>> {
  return rows<{ id: string }>(
    db,
    `SELECT DISTINCT ws.id
       FROM workstations ws
       JOIN agents a ON a.workstation_id = ws.id
       JOIN workstation_capabilities wc ON wc.workstation_id = ws.id
      WHERE ws.status = 'active' AND a.org_id = $1 AND a.status = 'active' AND a.runtime = 'claude-code'
        AND (a.allowed_project_ids IS NULL OR $2::uuid = ANY (a.allowed_project_ids))
        AND ${wsServesOrgSql('ws', '$1::uuid')}
        AND $3 = ANY (wc.capabilities)`,
    [project.org_id, project.id, CLAUDE_ACCOUNTS_CAPABILITY],
  );
}

/** Is an ensure for this key already waiting for (or in flight to) the workstation? */
async function ensurePending(db: Queryable, workstationId: string, key: string): Promise<boolean> {
  const r = await one(
    db,
    `SELECT 1 AS x FROM runner_commands
      WHERE workstation_id=$1 AND type='claude.account.ensure' AND status IN ('pending','sent')
        AND payload->>'key' = $2 LIMIT 1`,
    [workstationId, key],
  );
  return !!r;
}

/** A project just named `key`: ask every eligible workstation to provision it. Returns the workstation ids asked. */
export async function queueAccountEnsure(
  db: Queryable,
  project: { id: string; org_id: string },
  key: string,
): Promise<string[]> {
  const asked: string[] = [];
  for (const w of await ensureTargets(db, project)) {
    if (await ensurePending(db, w.id, key)) continue;
    await enqueueRunnerCommand(db, w.id, 'claude.account.ensure', { key });
    asked.push(w.id);
  }
  return asked;
}

/**
 * After `hello`: every key that a project this workstation works for names but the runner does not report is asked
 * for, at most once per workstation and key per 24 hours. Only runners with the capability are asked.
 */
export async function queueMissingAccountEnsures(
  ctx: Ctx,
  workstationId: string,
  reported: ReadonlySet<string>,
  capabilities: readonly string[],
): Promise<string[]> {
  if (!capabilities.includes(CLAUDE_ACCOUNTS_CAPABILITY)) return [];
  const keys = await rows<{ key: string }>(
    ctx.pool,
    `SELECT DISTINCT p.claude_account_key AS key
       FROM projects p
       JOIN agents a ON a.org_id = p.org_id AND a.workstation_id = $1 AND a.status = 'active'
                    AND a.runtime = 'claude-code'
                    AND (a.allowed_project_ids IS NULL OR p.id = ANY (a.allowed_project_ids))
       JOIN workstations ws ON ws.id = a.workstation_id AND ws.status = 'active'
      WHERE p.claude_account_key IS NOT NULL AND p.status = 'active' AND ${wsServesOrgSql('ws', 'p.org_id')}`,
    [workstationId],
  );
  const since = new Date(ctx.clock.now().getTime() - ENSURE_THROTTLE_MS);
  const asked: string[] = [];
  for (const { key } of keys) {
    if (key === MAIN_ACCOUNT || reported.has(key)) continue;
    if (await ensurePending(ctx.pool, workstationId, key)) continue;
    const recent = await one(
      ctx.pool,
      `SELECT 1 AS x FROM runner_commands
        WHERE workstation_id=$1 AND type='claude.account.ensure' AND payload->>'key'=$2 AND created_at > $3 LIMIT 1`,
      [workstationId, key, since],
    );
    if (recent) continue;
    await enqueueRunnerCommand(ctx.pool, workstationId, 'claude.account.ensure', { key });
    asked.push(key);
  }
  return asked;
}

export interface EnsureRecord {
  state: string;
  configDir?: string;
  detail?: string;
  aliasAdded?: boolean;
  at: string;
}

/** Keeps the last `claude.account.ensure` answer of a workstation, per key (operational; shown in the project view). */
export async function recordEnsureResult(
  db: Queryable,
  workstationId: string,
  key: string,
  record: EnsureRecord,
): Promise<void> {
  await exec(
    db,
    `UPDATE workstations SET claude_account_ensure = claude_account_ensure || jsonb_build_object($2::text, $3::jsonb) WHERE id=$1`,
    [workstationId, key, JSON.stringify(record)],
  );
}
