import {
  type AccountRuntimeView,
  type AccountScope,
  accountScopeOf,
  accountUsable,
  anyAccountUsable,
  isLoginScope,
  MAIN_ACCOUNT,
  ORG_ACCOUNT,
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
  /** The workstation's owner and whether they allow projects they are not on to use their named accounts (see `mayUseNamed`). */
  ws_user_id?: string | null | undefined;
  share_accounts?: boolean | null | undefined;
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

  /** The active members of the projects that name an account (loaded with the settings). */
  private readonly members = new Map<string, Set<string>>();

  setMembers(projectId: string, userIds: Iterable<string>): void {
    this.members.set(projectId, new Set(userIds));
  }

  /**
   * May the project's NAMED account be used on this agent's workstation? A named account is the workstation owner's own key or
   * login, chosen by the project's owner or manager: it is used only when the workstation owner is a member of the project, or
   * switched on "Allow projects to use my accounts" for the workstation. The main account and the organization's key are not
   * personal and are not held back. Unknown workstation owner: not allowed.
   */
  mayUseNamed(projectId: string, setting: ProjectAccountSetting, a: AccountAgent): boolean {
    if (!setting.accountKey || setting.accountKey === MAIN_ACCOUNT || setting.accountKey === ORG_ACCOUNT)
      return true;
    if (a.share_accounts === true) return true;
    return !!a.ws_user_id && (this.members.get(projectId)?.has(a.ws_user_id) ?? false);
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
  const named = [...new Set([...claude.map((p) => p.id), ...other.map((p) => p.project_id)])];
  if (named.length) {
    const members = await rows<{ project_id: string; user_id: string }>(
      db,
      `SELECT project_id, user_id FROM project_members WHERE status='active' AND project_id = ANY ($1::uuid[])`,
      [named],
    );
    const byProject = new Map<string, string[]>();
    for (const m of members) byProject.set(m.project_id, [...(byProject.get(m.project_id) ?? []), m.user_id]);
    for (const id of named) out.setMembers(id, byProject.get(id) ?? []);
  }
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
  let setting = accounts?.settingFor(projectId, scope) ?? null;
  // The project's named account is the workstation owner's: not honored here unless they are on the project or allow it. The ticket
  // then waits, or (when the project allows a fallback) runs on the main account.
  let held = false;
  if (setting && projectId && accounts && !accounts.mayUseNamed(projectId, setting, a)) {
    if (!setting.fallbackToMain) return null;
    setting = null;
    held = true;
  }
  const out = resolveFor(scope, setting, a, now, orgCapped);
  return out && held ? { ...out, viaFallback: true } : out;
}

function resolveFor(
  scope: AccountScope,
  setting: ProjectAccountSetting | null,
  a: AccountAgent,
  now: Date,
  orgCapped: boolean,
): { key: string; viaFallback: boolean } | null {
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
