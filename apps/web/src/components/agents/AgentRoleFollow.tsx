import { type AgentDto, hasDeviations, permissionDeviations, type RoleDefinition } from '@aom/shared';

/** What the agent has of its own on top of (or taken away from) the role it follows, in plain words. */
export function deviationLines(role: RoleDefinition, agent: AgentDto): string[] {
  const d = permissionDeviations({ role: role.permissions }, agent.permissions);
  if (!hasDeviations(d)) return [];
  const out: string[] = [];
  if (d.addedTools.length) out.push(`extra tools: ${d.addedTools.join(', ')}`);
  if (d.removedTools.length) out.push(`tools removed: ${d.removedTools.join(', ')}`);
  if (d.extraDeniedShell.length) out.push(`extra blocked commands: ${d.extraDeniedShell.join(', ')}`);
  if (d.removedRiskTiers.length) out.push(`risk tiers removed: ${d.removedRiskTiers.join(', ')}`);
  if (d.addedRiskTiers.length) out.push(`risk tiers added: ${d.addedRiskTiers.join(', ')}`);
  if (d.writableGlobs !== undefined)
    out.push(`writes only to: ${d.writableGlobs === null ? 'anywhere' : d.writableGlobs.join(', ')}`);
  if (d.repoIds !== undefined) out.push('limited set of repositories');
  if (d.mayCommit === false) out.push('may not commit');
  if (d.browser !== undefined) out.push(d.browser ? 'browser access added' : 'browser access removed');
  if (d.readOrgRepos !== undefined)
    out.push(d.readOrgRepos ? 'reads every organization repository' : 'organization repository read removed');
  return out;
}

/**
 * "Follows role Builder v3": the agent takes the role's current permissions and instructions; only the agent's own
 * deviations are listed. Shows nothing until the role definition has loaded.
 */
export function AgentRoleFollow({ agent, role }: { agent: AgentDto; role: RoleDefinition | undefined }) {
  if (!role?.permissions || !agent.permissions) return null;
  const lines = agent.isDevops ? [] : deviationLines(role, agent);
  return (
    <div className="text-xs text-subtle" data-testid="agent-role-follow">
      <p>
        Follows role {role.name} v{agent.roleVersion}
        {lines.length ? '; own changes:' : '; no changes of its own'}
      </p>
      {lines.length > 0 && (
        <ul className="list-disc pl-4">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
