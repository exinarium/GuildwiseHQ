import {
  type AccountScope,
  accountScopeDef,
  type ClaudeAccountInfo,
  isKeyScope,
  isLoginScope,
  keyAccountSource,
  keyAccountUsable,
  MAIN_ACCOUNT,
  ORG_ACCOUNT,
  PROVIDER_ACCOUNTS_CAPABILITY,
  type ProjectClaudeAccountsView,
  type ProjectProviderAccountsView,
  type ProviderAccountStatus,
  type ProviderKeyId,
} from '@aom/shared';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { agentScope } from '../dispatcher/accounts.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';
import { getProjectClaudeAccounts } from './claude-accounts.ts';

interface Report {
  id?: string;
  available?: boolean;
  auth?: string;
  usage?: string;
  limitedUntil?: string;
  limitedLabel?: string;
  accounts?: ClaudeAccountInfo[];
  keys?: Array<{
    provider: string;
    source: 'org' | 'workstation';
    orgIds?: string[];
    accounts?: string[];
    main?: boolean;
  }>;
}

const reportsOf = (runtimes: unknown): Report[] => (Array.isArray(runtimes) ? (runtimes as Report[]) : []);

const fromInfo = (a: ClaudeAccountInfo): ProviderAccountStatus => ({
  key: a.key,
  main: a.main,
  kind: 'login',
  login: a.login,
  usage: a.usage,
  ...(a.limitedUntil ? { limitedUntil: a.limitedUntil } : {}),
  ...(a.email ? { email: a.email } : {}),
  ...(a.detail ? { detail: a.detail } : {}),
});

/** A key account as the runner's key facts describe it. */
function keyStatus(
  reports: Report[],
  provider: ProviderKeyId,
  account: string,
  orgId: string,
): ProviderAccountStatus {
  const usable = keyAccountUsable(reports as never, provider, account, orgId);
  const source = keyAccountSource(reports as never, provider, account) ?? undefined;
  return {
    key: account,
    main: account === MAIN_ACCOUNT,
    kind: 'key',
    login: usable ? 'ok' : 'none',
    usage: 'ok',
    ...(usable && source ? { source } : {}),
    ...(usable
      ? {}
      : {
          detail:
            account === MAIN_ACCOUNT
              ? 'No key is set for the main account on this workstation.'
              : account === ORG_ACCOUNT
                ? 'The organization has no key for this provider on this workstation.'
                : `The account ${account} has no key on this workstation.`,
        }),
  };
}

/** Claude Code's view in the generic shape (the project settings panel of every scope reads one shape). */
function fromClaude(scope: AccountScope, v: ProjectClaudeAccountsView): ProjectProviderAccountsView {
  return {
    scope,
    label: accountScopeDef(scope)?.label ?? scope,
    kind: 'login',
    setting: v.setting,
    knownKeys: v.knownKeys,
    orgKey: false,
    workstations: v.workstations.map((w) => ({
      workstationId: w.workstationId,
      name: w.name,
      connected: w.connected,
      supportsAccounts: w.supportsAccounts,
      ...(w.main ? { main: fromInfo(w.main) } : {}),
      ...(w.account ? { account: fromInfo(w.account) } : {}),
    })),
  };
}

/**
 * The project's account for one provider or runtime and, per workstation that can serve it, the chosen account and the main
 * account as the runner last reported them (S-A). Feeds the project settings panel and its "sign in / add a key" hints.
 */
export async function getProjectProviderAccounts(
  ctx: Ctx,
  userId: string,
  projectId: string,
  scope: AccountScope,
): Promise<ProjectProviderAccountsView> {
  if (scope === 'claude-code')
    return fromClaude(scope, await getProjectClaudeAccounts(ctx, userId, projectId));
  const p = await loadVisibleProject(ctx.pool, userId, projectId);
  const cur = await one<{ account_key: string; fallback_to_main: boolean }>(
    ctx.pool,
    'SELECT account_key, fallback_to_main FROM project_provider_accounts WHERE project_id=$1 AND scope=$2',
    [projectId, scope],
  );
  const key = cur?.account_key ?? null;
  const agents = await rows(
    ctx.pool,
    `SELECT a.runtime, a.model, ws.id AS ws_id, ws.name, ws.connected, ws.runtimes,
            COALESCE($2 = ANY (wc.capabilities), false) AS supports
       FROM agents a
       JOIN workstations ws ON ws.id = a.workstation_id AND ws.status = 'active'
       LEFT JOIN workstation_capabilities wc ON wc.workstation_id = ws.id
      WHERE a.org_id = $1 AND a.status = 'active' AND ${wsServesOrgSql('ws', '$1::uuid')}
        AND (a.allowed_project_ids IS NULL OR $3::uuid = ANY (a.allowed_project_ids))
      ORDER BY ws.name, ws.id`,
    [p.org_id, PROVIDER_ACCOUNTS_CAPABILITY, p.id],
  );
  const known = new Set<string>();
  if (key) known.add(key);
  const seen = new Set<string>();
  const workstations: ProjectProviderAccountsView['workstations'] = [];
  for (const a of agents) {
    if (seen.has(a.ws_id)) continue;
    if (agentScope({ runtime: a.runtime, model: a.model, runtimes: a.runtimes }) !== scope) continue;
    seen.add(a.ws_id);
    const reports = reportsOf(a.runtimes);
    let main: ProviderAccountStatus | undefined;
    let account: ProviderAccountStatus | undefined;
    if (isLoginScope(scope)) {
      const rt = reports.find((r) => r.id === a.runtime);
      for (const x of rt?.accounts ?? []) if (!x.main) known.add(x.key);
      const list = rt?.accounts ?? [];
      const m = list.find((x) => x.main);
      if (m) main = fromInfo(m);
      else if (rt)
        main = {
          key: MAIN_ACCOUNT,
          main: true,
          kind: 'login',
          login: rt.auth === 'expired' ? 'expired' : 'ok',
          usage: rt.usage === 'limited' ? 'limited' : 'ok',
          ...(rt.limitedUntil ? { limitedUntil: rt.limitedUntil } : {}),
        };
      const chosen = key ? list.find((x) => x.key === key) : undefined;
      if (chosen) account = fromInfo(chosen);
    } else if (isKeyScope(scope)) {
      const k = reportsOf(a.runtimes)
        .find((r) => r.id === 'direct-model')
        ?.keys?.find((x) => x.provider === scope);
      for (const n of k?.accounts ?? []) known.add(n);
      main = keyStatus(reports, scope, MAIN_ACCOUNT, p.org_id);
      if (key) account = keyStatus(reports, scope, key, p.org_id);
    }
    workstations.push({
      workstationId: a.ws_id as string,
      name: a.name as string,
      connected: a.connected === true,
      supportsAccounts: a.supports === true,
      ...(main ? { main } : {}),
      ...(account ? { account } : {}),
    });
  }
  let orgKey = false;
  if (isKeyScope(scope)) {
    const o = await one<{ configured: boolean }>(
      ctx.pool,
      'SELECT configured FROM org_providers WHERE org_id=$1 AND provider=$2',
      [p.org_id, scope],
    );
    orgKey = o?.configured === true;
    if (orgKey) known.add(ORG_ACCOUNT);
  }
  return {
    scope,
    label: accountScopeDef(scope)?.label ?? scope,
    kind: isLoginScope(scope) ? 'login' : 'key',
    setting: { key, fallbackToMain: cur?.fallback_to_main ?? false },
    knownKeys: [...known].sort(),
    orgKey,
    workstations,
  };
}
