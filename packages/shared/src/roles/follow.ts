import type { AgentPermissions } from './schema.ts';

/**
 * Agents follow their role. An agent's stored permissions are the role's permissions of the version it follows plus
 * the agent's own deviations (extra denied shell patterns, narrowed tools or write scope, removed risk tiers, plugin
 * MCP servers an Owner added). When the role moves to a new version, `rebasePermissions` re-derives the agent's
 * permissions as `newRole + (agent - oldRole)`, so the role's changes arrive and the deliberate edits stay.
 */

const uniq = (xs: string[]) => [...new Set(xs)];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
const subset = (a: string[], of: string[]) => a.every((x) => of.includes(x));

/** The role version an agent's permissions were derived from, plus values earlier versions of the role carried. */
export interface RoleBaseline {
  /** The permissions of the version the agent follows (its `roleVersion`). */
  role: AgentPermissions;
  /**
   * Every value of the set fields across the role's versions up to that one. A value any past version carried is
   * never a deviation, which keeps hires whose version was not recorded exactly (or were hired before a bump) clean.
   */
  knownTools?: string[];
  knownDeniedShell?: string[];
  knownRiskTiers?: string[];
}

/** What one agent has on top of, or has taken away from, its role: the deliberate per-agent edits. */
export interface PermissionDeviations {
  addedTools: string[];
  removedTools: string[];
  extraDeniedShell: string[];
  addedRiskTiers: string[];
  removedRiskTiers: string[];
  /** Set only when the agent's write scope / repositories differ from the role's. */
  writableGlobs?: string[] | null;
  repoIds?: string[] | null;
  /** Set only when the agent lost the commit right the role has. */
  mayCommit?: false;
  browser?: boolean;
  readOrgRepos?: boolean;
}

export function permissionDeviations(base: RoleBaseline, agent: AgentPermissions): PermissionDeviations {
  const r = base.role;
  const d: PermissionDeviations = {
    addedTools: minus(agent.allowedTools, uniq([...r.allowedTools, ...(base.knownTools ?? [])])),
    removedTools: minus(r.allowedTools, agent.allowedTools),
    extraDeniedShell: minus(
      agent.deniedShellPatterns,
      uniq([...r.deniedShellPatterns, ...(base.knownDeniedShell ?? [])]),
    ),
    addedRiskTiers: minus(agent.riskTiers, uniq([...r.riskTiers, ...(base.knownRiskTiers ?? [])])),
    removedRiskTiers: minus(r.riskTiers, agent.riskTiers),
  };
  if (!same(agent.writableGlobs, r.writableGlobs)) d.writableGlobs = agent.writableGlobs;
  if (!same(agent.repoIds, r.repoIds)) d.repoIds = agent.repoIds;
  if (r.mayCommit && !agent.mayCommit) d.mayCommit = false;
  if (agent.browser !== r.browser) d.browser = agent.browser;
  if (agent.readOrgRepos !== r.readOrgRepos) d.readOrgRepos = agent.readOrgRepos;
  return d;
}

export const hasDeviations = (d: PermissionDeviations): boolean =>
  d.addedTools.length > 0 ||
  d.removedTools.length > 0 ||
  d.extraDeniedShell.length > 0 ||
  d.addedRiskTiers.length > 0 ||
  d.removedRiskTiers.length > 0 ||
  d.writableGlobs !== undefined ||
  d.repoIds !== undefined ||
  d.mayCommit !== undefined ||
  d.browser !== undefined ||
  d.readOrgRepos !== undefined;

/** The effective permissions: the role's permissions with the agent's own deviations applied on top. */
export function applyDeviations(role: AgentPermissions, d: PermissionDeviations): AgentPermissions {
  let writableGlobs = role.writableGlobs;
  if (d.writableGlobs !== undefined) {
    // A narrowed scope stays while it still fits the role; otherwise the role's scope wins.
    const fits =
      role.writableGlobs === null ||
      (d.writableGlobs !== null && subset(d.writableGlobs, role.writableGlobs));
    writableGlobs = fits ? d.writableGlobs : role.writableGlobs;
  }
  return {
    allowedTools: uniq([...minus(role.allowedTools, d.removedTools), ...d.addedTools]),
    deniedShellPatterns: uniq([...role.deniedShellPatterns, ...d.extraDeniedShell]),
    writableGlobs,
    mayCommit: d.mayCommit === false ? false : role.mayCommit,
    browser: d.browser ?? role.browser,
    readOrgRepos: d.readOrgRepos ?? role.readOrgRepos,
    riskTiers: uniq([
      ...minus(role.riskTiers, d.removedRiskTiers),
      ...d.addedRiskTiers,
    ]) as AgentPermissions['riskTiers'],
    repoIds: d.repoIds !== undefined ? d.repoIds : role.repoIds,
  };
}

/**
 * The same rule for skills: the new version's skills, without the ones the agent had dropped from the version it followed,
 * plus the agent's own additions (a skill no version of the role ever listed). `known` is every skill of the role's versions
 * up to the one the agent follows, so a skill an older version listed is never taken for the agent's own.
 */
export function rebaseSkills(
  base: { role: string[]; known?: string[] },
  agent: string[],
  newRole: string[],
): string[] {
  const known = uniq([...base.role, ...(base.known ?? [])]);
  const removed = minus(base.role, agent);
  return uniq([...minus(newRole, removed), ...minus(agent, known)]);
}

/** `newRole + (agent - oldRole)`: the agent's permissions after its role moved to a new version. */
export function rebasePermissions(
  base: RoleBaseline,
  agent: AgentPermissions,
  newRole: AgentPermissions,
): AgentPermissions {
  return applyDeviations(newRole, permissionDeviations(base, agent));
}
