import type { OrgChart, OrgChartAgent, OrgChartStatus } from '@aom/shared';

export interface StatusMeta {
  label: string;
  /** Tailwind ring classes of the face (colour is never the only cue: the label and icon say it too). */
  ring: string;
  tone: 'success' | 'danger' | 'neutral' | 'warning';
}

export const STATUS_META: Record<OrgChartStatus, StatusMeta> = {
  working: { label: 'Working', ring: 'ring-accent', tone: 'success' },
  blocked: { label: 'Blocked', ring: 'ring-danger-fill', tone: 'danger' },
  idle: { label: 'Idle', ring: 'ring-line', tone: 'neutral' },
  offline: { label: 'Offline', ring: 'ring-line', tone: 'neutral' },
  needs_rehome: { label: 'Needs a new workstation', ring: 'ring-warning-fill', tone: 'warning' },
};

/** "Working on TOY-4", "Blocked on TOY-7", "Idle": the one line under a name. */
export function statusLine(a: OrgChartAgent): string {
  if (a.status === 'working' && a.activeCards[0])
    return `Working on ${a.activeCards[0].ref}${a.activeCards.length > 1 ? ` +${a.activeCards.length - 1}` : ''}`;
  if (a.status === 'blocked' && a.blockedCards[0]) return `Blocked on ${a.blockedCards[0].ref}`;
  return STATUS_META[a.status].label;
}

/** Does the agent work on this project (an empty filter or an agent allowed on any project always matches)? */
export const worksOn = (a: OrgChartAgent, projectId: string): boolean =>
  !projectId || a.allowedProjectIds === null || a.allowedProjectIds.includes(projectId);

/** Plain words for where the agent's questions go first. */
export function escalationText(a: OrgChartAgent, chart: OrgChart): string {
  const names = (ids: string[]) =>
    ids
      .map((id) => chart.agents.find((x) => x.id === id)?.name)
      .filter(Boolean)
      .join(', ');
  if (a.escalatesTo.level === 'peer')
    return `${names(a.escalatesTo.agentIds)} (senior ${a.roleLabel.toLowerCase()})`;
  if (a.escalatesTo.level === 'ba') return `the BA (${names(a.escalatesTo.agentIds)})`;
  return `${chart.owner.name}, on the desk`;
}

/** "Delivery" -> its agents, in the order the chart shows them (seniors first). */
export function groupByDepartment(
  agents: OrgChartAgent[],
  departments: OrgChart['departments'],
): Array<{
  key: string;
  label: string;
  roles: Array<{ key: string; label: string; agents: OrgChartAgent[] }>;
}> {
  return departments
    .map((d) => {
      const inDept = agents.filter((a) => !a.isDevops && (a.department ?? 'other') === d.key);
      const roles = [...new Set(inDept.map((a) => a.roleKey))].sort().map((key) => {
        const mine = inDept
          .filter((a) => a.roleKey === key)
          .sort(
            (a, b) =>
              Number(b.seniority === 'senior') - Number(a.seniority === 'senior') ||
              a.name.localeCompare(b.name),
          );
        return { key, label: mine[0]?.roleLabel ?? key, agents: mine };
      });
      return { key: d.key, label: d.label, roles };
    })
    .filter((d) => d.roles.length > 0);
}
