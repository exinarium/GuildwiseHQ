import { CLAUDE_ACCOUNTS_CAPABILITY, ClaudeAccountEnsureResultSchema, MAIN_ACCOUNT } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { syncClaudeAccountNotices } from './claude-account-notices.ts';
import { syncProviderAccountNotices } from './provider-account-notices.ts';
import { syncClaudeUsageNotice } from './workstation-notices.ts';

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

/**
 * The runner answered `claude.account.ensure`: keep the answer (the project settings show it) and raise or close the
 * sign-in notice (`awaiting_login`, `needs_owner` and `failed` need the owner; `ready` closes it).
 */
export async function applyAccountEnsureResult(
  ctx: Ctx,
  workstationId: string,
  payload: { key?: string },
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const key = payload.key;
  if (!key) return;
  const parsed = ClaudeAccountEnsureResultSchema.safeParse(result);
  const answer = ok && parsed.success ? parsed.data : undefined;
  await recordEnsureResult(ctx.pool, workstationId, key, {
    state: answer?.state ?? 'failed',
    ...(answer?.configDir ? { configDir: answer.configDir } : {}),
    ...(answer?.aliasAdded !== undefined ? { aliasAdded: answer.aliasAdded } : {}),
    ...((answer?.detail ?? error) ? { detail: (answer?.detail ?? error) as string } : {}),
    at: ctx.clock.now().toISOString(),
  });
  const ws = await one<{ user_id: string; runtimes: unknown }>(
    ctx.pool,
    'SELECT user_id, runtimes FROM workstations WHERE id=$1',
    [workstationId],
  );
  if (!ws) return;
  await syncClaudeAccountNotices(
    ctx,
    { id: workstationId, userId: ws.user_id },
    Array.isArray(ws.runtimes) ? (ws.runtimes as never) : [],
  ).catch(() => {});
}

/**
 * The runner turned a shift away because its account is out (`usage_limited`, `auth_expired`, or an account it does not
 * have): patch the stored runtime now so the next dispatch pass already knows, before `runtimes.report` arrives
 * (docs/design/claude-accounts.md 2.4). Operational data, the same way the report writes it.
 */
export async function markAccountOut(
  db: Queryable,
  workstationId: string,
  accountKey: string,
  how: { usage: 'limited'; limitedUntil: string } | { login: 'expired' | 'none' },
  /** The runtime the account belongs to (Claude Code by default; Codex and the Gemini CLI since S-A). */
  runtimeId = 'claude-code',
): Promise<void> {
  const ws = await one<{ runtimes: unknown }>(
    db,
    'SELECT runtimes FROM workstations WHERE id=$1 FOR UPDATE',
    [workstationId],
  );
  if (!Array.isArray(ws?.runtimes)) return;
  const runtimes = ws.runtimes as Array<Record<string, any>>;
  const rt = runtimes.find((r) => r.id === runtimeId);
  if (!rt) return;
  const patch = (o: Record<string, any>) => {
    if ('usage' in how) Object.assign(o, { usage: 'limited', limitedUntil: how.limitedUntil });
  };
  const entry = (rt.accounts as Array<Record<string, any>> | undefined)?.find((a) => a.key === accountKey);
  if (entry) {
    patch(entry);
    if ('login' in how) entry.login = how.login;
  }
  // The top-level fields describe main.
  if (accountKey === MAIN_ACCOUNT) {
    patch(rt);
    if ('login' in how) rt.auth = 'expired';
  }
  if (!entry && accountKey !== MAIN_ACCOUNT) return;
  await exec(db, 'UPDATE workstations SET runtimes=$2 WHERE id=$1', [
    workstationId,
    JSON.stringify(runtimes),
  ]);
}

/**
 * A project's account setting changed: the sign-in and usage notices depend on which accounts projects name, so they are
 * worked out again for the organization's workstations from what the runners last reported.
 */
export async function resyncAccountNotices(ctx: Ctx, orgId: string): Promise<void> {
  const list = await rows<{ id: string; user_id: string; runtimes: unknown }>(
    ctx.pool,
    `SELECT DISTINCT ws.id, ws.user_id, ws.runtimes FROM workstations ws
       JOIN agents a ON a.workstation_id = ws.id AND a.org_id = $1 AND a.status = 'active'
      WHERE ws.status = 'active'`,
    [orgId],
  );
  for (const w of list) {
    const runtimes = Array.isArray(w.runtimes) ? (w.runtimes as never[]) : [];
    const ref = { id: w.id, userId: w.user_id };
    await syncClaudeAccountNotices(ctx, ref, runtimes).catch(() => {});
    await syncClaudeUsageNotice(ctx, ref, runtimes).catch(() => {});
    await syncProviderAccountNotices(ctx, ref, runtimes as never).catch(() => {});
  }
}
