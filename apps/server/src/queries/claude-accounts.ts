import {
  CLAUDE_ACCOUNTS_CAPABILITY,
  ClaudeAccountEnsureResultSchema,
  type ClaudeAccountInfo,
  ClaudeAccountKeySchema,
  MAIN_ACCOUNT,
  type ProjectClaudeAccountsView,
} from '@aom/shared';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { wsServesOrgSql } from '../simulation/fit.ts';

interface ClaudeRuntime {
  id?: string;
  available?: boolean;
  auth?: string;
  usage?: string;
  limitedUntil?: string;
  limitedLabel?: string;
  accounts?: ClaudeAccountInfo[];
}

const claudeRuntime = (runtimes: unknown): ClaudeRuntime | undefined =>
  (Array.isArray(runtimes) ? (runtimes as ClaudeRuntime[]) : []).find((r) => r?.id === 'claude-code');

/** The workstation's main account as an info record; a legacy runtime (no accounts[]) is described by its top-level fields. */
export function mainAccountInfo(rt: ClaudeRuntime | undefined): ClaudeAccountInfo | undefined {
  if (!rt) return undefined;
  const listed = rt.accounts?.find((a) => a.key === MAIN_ACCOUNT);
  if (listed) return listed;
  return {
    key: MAIN_ACCOUNT,
    main: true,
    source: 'default',
    login: rt.auth === 'expired' ? 'expired' : 'ok',
    usage: rt.usage === 'limited' ? 'limited' : 'ok',
    ...(rt.limitedUntil ? { limitedUntil: rt.limitedUntil } : {}),
    ...(rt.limitedLabel ? { limitedLabel: rt.limitedLabel } : {}),
  };
}

/**
 * The project's account setting plus, per workstation that can serve it, the project's account and the main account as
 * the runner reported them (docs/design/claude-accounts.md section 2.4). Feeds the project settings panel.
 */
export async function getProjectClaudeAccounts(
  ctx: Ctx,
  userId: string,
  projectId: string,
): Promise<ProjectClaudeAccountsView> {
  const p = await loadVisibleProject(ctx.pool, userId, projectId);
  const key: string | null = p.claude_account_key ?? null;
  const stations = await rows(
    ctx.pool,
    `SELECT DISTINCT ws.id, ws.name, ws.connected, ws.runtimes, ws.claude_account_ensure,
            COALESCE($2 = ANY (wc.capabilities), false) AS supports
       FROM workstations ws
       JOIN agents a ON a.workstation_id = ws.id AND a.org_id = $1 AND a.status = 'active' AND a.runtime = 'claude-code'
       LEFT JOIN workstation_capabilities wc ON wc.workstation_id = ws.id
      WHERE ws.status = 'active' AND ${wsServesOrgSql('ws', '$1::uuid')}
        AND (a.allowed_project_ids IS NULL OR $3::uuid = ANY (a.allowed_project_ids))
      ORDER BY ws.name, ws.id`,
    [p.org_id, CLAUDE_ACCOUNTS_CAPABILITY, p.id],
  );
  const known = new Set<string>();
  if (key) known.add(key);
  const workstations = stations.map((w) => {
    const rt = claudeRuntime(w.runtimes);
    for (const a of rt?.accounts ?? [])
      if (!a.main && ClaudeAccountKeySchema.safeParse(a.key).success) known.add(a.key);
    const ensure = key ? (w.claude_account_ensure?.[key] as { state?: string } | undefined) : undefined;
    const provisioning = ClaudeAccountEnsureResultSchema.shape.state.safeParse(ensure?.state);
    const main = mainAccountInfo(rt);
    const account = key ? rt?.accounts?.find((a) => a.key === key) : undefined;
    return {
      workstationId: w.id as string,
      name: w.name as string,
      connected: w.connected === true,
      supportsAccounts: w.supports === true,
      ...(main ? { main } : {}),
      ...(account ? { account } : {}),
      ...(provisioning.success ? { provisioning: provisioning.data } : {}),
    };
  });
  return {
    setting: { key, fallbackToMain: p.claude_account_fallback ?? false },
    knownKeys: [...known].sort(),
    workstations,
  };
}
