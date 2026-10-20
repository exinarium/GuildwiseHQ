import {
  type AccountRuntimeView,
  accountUsable,
  anyAccountUsable,
  MAIN_ACCOUNT,
  type ProjectAccountSetting,
  resolveShiftAccount,
} from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

/**
 * Which Claude account a shift runs on (docs/design/claude-accounts.md section 2.4). The server chooses, per shift:
 * the ticket's project names a key, else the workstation's main account; when the key is out, fall back to main only
 * if the project allows it, otherwise the ticket waits. Everything that is not tied to a ticket uses main.
 */

export const CLAUDE_RUNTIME = 'claude-code';

/** What a pass reads of a workstation row: its runtimes json. */
export function claudeView(runtimes: unknown): AccountRuntimeView | undefined {
  return (Array.isArray(runtimes) ? (runtimes as Array<AccountRuntimeView & { id?: string }>) : []).find(
    (r) => r?.id === CLAUDE_RUNTIME,
  );
}

/** The projects' account settings, by project id (projects without an account are absent). */
export async function loadProjectAccounts(
  db: Queryable,
  projectIds?: readonly string[],
): Promise<Map<string, ProjectAccountSetting>> {
  const list = await rows<{ id: string; key: string; fallback: boolean }>(
    db,
    projectIds
      ? `SELECT id, claude_account_key AS key, claude_account_fallback AS fallback FROM projects
          WHERE claude_account_key IS NOT NULL AND id = ANY ($1::uuid[])`
      : `SELECT id, claude_account_key AS key, claude_account_fallback AS fallback FROM projects
          WHERE claude_account_key IS NOT NULL`,
    projectIds ? [projectIds] : [],
  );
  return new Map(list.map((p) => [p.id, { accountKey: p.key, fallbackToMain: p.fallback }]));
}

/**
 * The account a shift of agent runtime `runtime` on a workstation with these `runtimes` uses, or null = the ticket
 * waits. A runtime other than Claude Code has no accounts: it is never paused by them (`key` is `main`, which the
 * dispatcher then leaves out of the shift). `setting` is the ticket's project setting (absent: main).
 */
export function accountFor(
  setting: ProjectAccountSetting | null | undefined,
  runtimes: unknown,
  runtime: string,
  now: Date,
): { key: string; viaFallback: boolean } | null {
  if (runtime !== CLAUDE_RUNTIME)
    return mainUsable(runtimes, runtime, now) ? { key: MAIN_ACCOUNT, viaFallback: false } : null;
  return resolveShiftAccount(setting, claudeView(runtimes), now);
}

const viewOf = (runtimes: unknown, runtime: string): AccountRuntimeView | undefined =>
  (Array.isArray(runtimes) ? (runtimes as Array<AccountRuntimeView & { id?: string }>) : []).find(
    (r) => r?.id === runtime,
  );

/**
 * Is this workstation's main account usable? (DevOps, CEO and chats always use main.) For a runtime without accounts
 * this is the old rule: available, login not expired, no usage limit in force.
 */
export function mainUsable(runtimes: unknown, runtime: string, now: Date): boolean {
  return accountUsable(viewOf(runtimes, runtime), MAIN_ACCOUNT, now);
}

/** The freeAgents gate: some account of the agent's runtime is usable. */
export function runtimeUsable(runtimes: unknown, runtime: string, now: Date): boolean {
  return anyAccountUsable(viewOf(runtimes, runtime), now);
}

/**
 * The projects a workstation's agent of `runtime` cannot run now, as `candidateCards` takes them: their account is out
 * (and no fallback), or main is out so only projects on their own account can run. Keeps the 5-card window from filling
 * with cards that cannot start.
 */
export function accountScope(
  settings: Map<string, ProjectAccountSetting>,
  runtimes: unknown,
  runtime: string,
  now: Date,
): { excludeProjectIds?: string[]; onlyProjectIds?: string[] } | undefined {
  if (runtime !== CLAUDE_RUNTIME) return undefined;
  const keyed = [...settings.keys()];
  const usable = keyed.filter((id) => accountFor(settings.get(id), runtimes, runtime, now));
  if (!mainUsable(runtimes, runtime, now)) return { onlyProjectIds: usable };
  const blocked = keyed.filter((id) => !usable.includes(id));
  return blocked.length > 0 ? { excludeProjectIds: blocked } : undefined;
}
