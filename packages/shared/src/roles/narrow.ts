import type { AgentPermissions } from './schema.ts';

export interface PermissionCheck {
  /** Never allowed, whoever asks: it would defeat what the role is for (a reviewer that commits, a scout that edits). */
  forbidden: string[];
  /** Wider than the role definition but not forbidden: only the organization owner may grant these. */
  widened: string[];
}

const subset = (a: string[], of: string[]) => a.every((x) => of.includes(x));

/**
 * Compares the permissions asked for an agent with the role definition's. Narrowing is always fine. Widening the
 * hard limits of the role (`edit`/`shell` tools, committing, dropping its denied shell patterns, a write scope that
 * is not inside the role's) is forbidden outright; other widening (web, MCP tools, risk tiers, repositories) is
 * reported so the caller can require the organization owner.
 */
export function checkPermissions(role: AgentPermissions, proposed: AgentPermissions): PermissionCheck {
  const forbidden: string[] = [];
  const widened: string[] = [];
  for (const t of proposed.allowedTools) {
    if (role.allowedTools.includes(t)) continue;
    if (t === 'edit' || t === 'shell') forbidden.push(`the ${t} tool is not part of this role`);
    else widened.push(`tool ${t}`);
  }
  if (proposed.mayCommit && !role.mayCommit) forbidden.push('this role may not commit');
  const dropped = role.deniedShellPatterns.filter((p) => !proposed.deniedShellPatterns.includes(p));
  if (dropped.length)
    forbidden.push(`the role's shell restrictions cannot be removed (${dropped.join(', ')})`);
  if (role.writableGlobs !== null) {
    if (proposed.writableGlobs === null || !subset(proposed.writableGlobs, role.writableGlobs))
      forbidden.push('the writable paths must stay inside the role definition');
  }
  if (proposed.browser && !role.browser) widened.push('browser access (Unix sockets)');
  if (!subset(proposed.riskTiers, role.riskTiers)) widened.push('risk tiers');
  if (role.repoIds !== null && (proposed.repoIds === null || !subset(proposed.repoIds, role.repoIds)))
    widened.push('repositories');
  return { forbidden, widened };
}
