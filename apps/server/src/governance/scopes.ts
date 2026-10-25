import {
  type AgentPermissions,
  type AgentScopeFacts,
  checkScopes,
  normalizeScopes,
  type ScopeWarning,
} from '@aom/shared';
import { effectiveRegistry } from '../capabilities/registry.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { conflict } from '../errors.ts';

/** What an agent has, in the words packs use for the scopes they need (`shell`, `web`, `commit`, ...). */
export async function agentScopeFacts(db: Queryable, agent: Row): Promise<AgentScopeFacts> {
  const p = (agent.permissions ?? {}) as Partial<AgentPermissions>;
  const g = await one(
    db,
    `SELECT 1 FROM delegate_grants g
      WHERE (g.owner_kind='agent' AND g.owner_id=$1)
         OR (g.owner_kind='role' AND g.org_id=$2 AND g.owner_key=$3) LIMIT 1`,
    [agent.id, agent.org_id, agent.role_key],
  );
  return {
    allowedTools: p.allowedTools ?? [],
    mayCommit: p.mayCommit === true,
    browser: p.browser === true,
    readOrgRepos: p.readOrgRepos === true,
    hasDelegation: !!g,
    // scripts are switched on per pack by an Owner; granting a capability does not turn them on
    scriptsEnabled: false,
  };
}

export function scopeWarning(scopes: readonly string[], facts: AgentScopeFacts): ScopeWarning {
  const required = checkScopes(scopes, facts);
  return { required, missing: required.filter((c) => c.known && !c.has).map((c) => c.scope) };
}

/** The scopes a registry capability declares (empty for a capability of an older runner, which reports none). */
export async function capabilityScopes(
  db: Queryable,
  orgId: string,
  userId: string,
  kind: 'playbook' | 'persona' | 'skill',
  key: string,
): Promise<string[]> {
  const reg = await effectiveRegistry(db, orgId, { kind, usableOnly: true, userId });
  const item = reg.items.find((i) => i.key === key) as (Row & { scopes?: string[] }) | undefined;
  return normalizeScopes(item?.scopes);
}

/** The union of the scopes of everything a pack holds (a private pack is granted as a whole). */
export async function packScopes(db: Queryable, packId: string): Promise<string[]> {
  const p = await one(db, 'SELECT snapshot FROM packs WHERE id=$1', [packId]);
  const items = ((p?.snapshot as { items?: Array<{ scopes?: string[] }> } | null)?.items ?? []) as Array<{
    scopes?: string[];
  }>;
  return normalizeScopes(items.flatMap((i) => i.scopes ?? []));
}

/** A grant of something that needs a scope the agent lacks is refused until the granter confirms it knowing that. */
export function assertScopesConfirmed(warning: ScopeWarning, confirmed: boolean | undefined): void {
  if (warning.missing.length === 0 || confirmed) return;
  throw conflict(
    'scopes_missing',
    `This needs ${warning.missing.join(', ')}, which the agent does not have. Grant it anyway to accept that it may not work.`,
    warning,
  );
}

export async function agentsPacksGranted(db: Queryable, agentId: string): Promise<Row[]> {
  return rows(
    db,
    `SELECT p.id, p.name FROM pack_agent_grants g JOIN packs p ON p.id = g.pack_id WHERE g.agent_id=$1 AND p.removed_at IS NULL ORDER BY p.name`,
    [agentId],
  );
}
