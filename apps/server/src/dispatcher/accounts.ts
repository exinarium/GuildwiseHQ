import {
  type AccountRuntimeView,
  type AccountScope,
  accountScopeOf,
  accountUsable,
  anyAccountUsable,
  isLoginScope,
  MAIN_ACCOUNT,
  type ProjectAccountSetting,
  resolveScopeAccount,
  resolveShiftAccount,
} from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

/**
 * Which account a shift runs on (docs/design/claude-accounts.md section 2.4, generalised by S-A). The server chooses, per
 * shift: the ticket's project names an account for the SCOPE the agent's runtime and model spend (Claude Code, Codex, Gemini CLI,
 * or a provider key), else the workstation's main account; when the account is out, fall back to main only if the project
 * allows it, otherwise the ticket waits. Everything that is not tied to a ticket uses main.
 */

export const CLAUDE_RUNTIME = 'claude-code';

/** What a pass reads of a workstation row: its runtimes json. */
export function claudeView(runtimes: unknown): AccountRuntimeView | undefined {
  return (Array.isArray(runtimes) ? (runtimes as Array<AccountRuntimeView & { id?: string }>) : []).find(
    (r) => r?.id === CLAUDE_RUNTIME,
  );
}

/** What the resolver needs of an agent row joined with its workstation. */
export interface AccountAgent {
  runtime: string;
  model: string;
  runtimes: unknown;
  org_id?: string | null | undefined;
}

/** The scope an agent's shifts spend, from its runtime and model (Gemini: the login unless the workstation runs it on a key). */
export function agentScope(a: Pick<AccountAgent, 'runtime' | 'model' | 'runtimes'>): AccountScope | null {
  const authVia = (
    Array.isArray(a.runtimes)
      ? (a.runtimes as Array<{ id?: string; authVia?: 'login' | 'key' }>).find((r) => r?.id === a.runtime)
      : undefined
  )?.authVia;
  return accountScopeOf(a.runtime, a.model, authVia);
}

/**
 * The projects' account settings of one pass: Claude Code's from the project columns, the other scopes from
 * `project_provider_accounts`. Projects without a choice are absent.
 */
export class ProjectAccounts {
  private readonly byScope = new Map<string, Map<string, ProjectAccountSetting>>();

  add(scope: string, projectId: string, setting: ProjectAccountSetting): void {
    const m = this.byScope.get(scope) ?? new Map<string, ProjectAccountSetting>();
    m.set(projectId, setting);
    this.byScope.set(scope, m);
  }

  settingFor(projectId: string | null | undefined, scope: AccountScope | null): ProjectAccountSetting | null {
    if (!projectId || !scope) return null;
    return this.byScope.get(scope)?.get(projectId) ?? null;
  }

  /** The projects that name an account for the scope. */
  projectsWith(scope: AccountScope): string[] {
    return [...(this.byScope.get(scope)?.keys() ?? [])];
  }
}

/** The projects' account settings of all scopes (or of the given projects). */
export async function loadProjectAccounts(
  db: Queryable,
  projectIds?: readonly string[],
): Promise<ProjectAccounts> {
  const out = new ProjectAccounts();
  const claude = await rows<{ id: string; key: string; fallback: boolean }>(
    db,
    projectIds
      ? `SELECT id, claude_account_key AS key, claude_account_fallback AS fallback FROM projects
          WHERE claude_account_key IS NOT NULL AND id = ANY ($1::uuid[])`
      : `SELECT id, claude_account_key AS key, claude_account_fallback AS fallback FROM projects
          WHERE claude_account_key IS NOT NULL`,
    projectIds ? [projectIds] : [],
  );
  for (const p of claude) out.add(CLAUDE_RUNTIME, p.id, { accountKey: p.key, fallbackToMain: p.fallback });
  const other = await rows<{ project_id: string; scope: string; key: string; fallback: boolean }>(
    db,
    projectIds
      ? `SELECT project_id, scope, account_key AS key, fallback_to_main AS fallback
           FROM project_provider_accounts WHERE project_id = ANY ($1::uuid[])`
      : `SELECT project_id, scope, account_key AS key, fallback_to_main AS fallback FROM project_provider_accounts`,
    projectIds ? [projectIds] : [],
  );
  for (const p of other) out.add(p.scope, p.project_id, { accountKey: p.key, fallbackToMain: p.fallback });
  return out;
}

/**
 * The account a shift of this agent uses on its workstation, or null = the ticket waits. `projectId` is the ticket's project
 * (absent: the work is not tied to a ticket, so main). `orgCapped`: the organization's monthly cap for the provider is reached,
 * so the organization's key is not usable (the workstation's own key and the named accounts are never capped).
 */
export function accountForAgent(
  accounts: ProjectAccounts | undefined,
  projectId: string | null | undefined,
  a: AccountAgent,
  now: Date,
  orgCapped = false,
): { key: string; viaFallback: boolean } | null {
  const scope = agentScope(a);
  // a runtime with no accounts (the mock): the old rule, available and not paused
  if (!scope)
    return mainUsable(a.runtimes, a.runtime, now) ? { key: MAIN_ACCOUNT, viaFallback: false } : null;
  const setting = accounts?.settingFor(projectId, scope) ?? null;
  if (isLoginScope(scope)) return resolveShiftAccount(setting, viewOf(a.runtimes, a.runtime), now);
  // a provider key: the runtime that spends it has to be there, and then the key facts decide
  if (!viewOf(a.runtimes, a.runtime)?.available) return null;
  return resolveScopeAccount(
    scope,
    setting,
    { reports: Array.isArray(a.runtimes) ? (a.runtimes as never) : [] },
    a.org_id ?? undefined,
    now,
    orgCapped,
  );
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
 * The projects a workstation's agent cannot run now, as `candidateCards` takes them: their account is out (and no fallback), or
 * main is out so only projects on their own account can run. Keeps the 5-card window from filling with cards that cannot start.
 */
export function accountScope(
  accounts: ProjectAccounts,
  a: AccountAgent,
  now: Date,
  orgCapped = false,
): { excludeProjectIds?: string[]; onlyProjectIds?: string[] } | undefined {
  const scope = agentScope(a);
  if (!scope) return undefined;
  const keyed = accounts.projectsWith(scope);
  const usable = keyed.filter((id) => accountForAgent(accounts, id, a, now, orgCapped));
  if (!accountForAgent(accounts, null, a, now, orgCapped)) return { onlyProjectIds: usable };
  const blocked = keyed.filter((id) => !usable.includes(id));
  return blocked.length > 0 ? { excludeProjectIds: blocked } : undefined;
}
