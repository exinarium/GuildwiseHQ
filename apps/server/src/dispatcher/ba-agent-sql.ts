import { wsServesOrgSql } from '../simulation/fit.ts';

/**
 * The agents the BA task dispatcher can give a task to, before online-ness: the agent is active (not paused, not the
 * devops agent) on an active workstation of an active user that serves its organization, is allowed on the project, and
 * its user is an active member of the project. One definition for the dispatcher and for the scoping plan, which picks a
 * role by asking who the dispatcher could use: a weaker copy would choose a role nobody can run.
 *
 * The aliases are `a` (agents), `ws` (workstations) and `wu` (the workstation's user). The arguments are SQL
 * placeholders (`$1`) or literals for the organization, the project and "org level" (a task of no project).
 */
export const BA_TASK_AGENT_FROM = `agents a JOIN workstations ws ON ws.id = a.workstation_id AND ws.status = 'active'
                       JOIN users wu ON wu.id = ws.user_id AND wu.status = 'active'`;

export function baTaskAgentEligibleSql(args: { org: string; project: string; orgLevel: string }): string {
  return `a.org_id = ${args.org} AND a.status = 'active' AND a.paused_at IS NULL AND NOT a.is_devops
          AND ${wsServesOrgSql('ws', 'a.org_id')}
          AND (${args.orgLevel}::boolean OR ((a.allowed_project_ids IS NULL OR ${args.project}::uuid = ANY (a.allowed_project_ids))
               AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ${args.project}::uuid AND pm.user_id = ws.user_id
                            AND pm.status = 'active')))`;
}
