import type { OrgChart, OrgChartAgent } from '@aom/shared';
import { escalationText, groupByDepartment, isPausedCeo } from '../../lib/orgChart.ts';
import { AgentTile } from './AgentTile.tsx';

/** The same organization as plain grouped lists: phones, and anyone who prefers reading to looking. */
export function ListView({
  chart,
  agents,
  onOpen,
}: {
  chart: OrgChart;
  agents: OrgChartAgent[];
  onOpen: (a: OrgChartAgent) => void;
}) {
  const bas = agents.filter((a) => a.roleKey === 'ba' && !a.isDevops);
  const groups = groupByDepartment(
    agents.filter((a) => a.roleKey !== 'ba'),
    chart.departments,
  );
  return (
    <div className="flex flex-col gap-4" data-testid="org-list">
      <section aria-labelledby="org-l-mgr">
        <h2 id="org-l-mgr" className="mb-2 text-sm font-semibold text-muted uppercase">
          Manager
        </h2>
        <p className="rounded-card border border-line bg-surface p-3 text-sm">
          <span className="font-semibold text-fg">{chart.owner.name}</span> is the Owner and the manager.
          Everything nobody below can answer reaches {chart.owner.name}'s desk.
          {chart.admins.length > 0 && <> Admins: {chart.admins.map((a) => a.name).join(', ')}.</>}
        </p>
      </section>
      <section aria-labelledby="org-l-ba">
        <h2 id="org-l-ba" className="mb-2 text-sm font-semibold text-muted uppercase">
          Business analysts
        </h2>
        {bas.length === 0 ? (
          <p className="text-sm text-muted">No BA yet: questions go straight to the manager.</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {bas.map((a) => (
              <li key={a.id}>
                <AgentTile
                  agent={a}
                  onOpen={onOpen}
                  escalation={escalationText(a, chart)}
                  className="w-full"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      {groups.map((d) => (
        <section key={d.key} aria-labelledby={`org-l-${d.key}`} data-testid="org-list-department">
          <h2 id={`org-l-${d.key}`} className="mb-2 text-sm font-semibold text-muted uppercase">
            {d.label}
          </h2>
          <div className="flex flex-col gap-3">
            {d.roles.map((r) => (
              <div key={r.key}>
                <h3 className="mb-1 text-sm font-medium text-fg">{r.label}</h3>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {r.agents.map((a) => (
                    <li key={a.id}>
                      <AgentTile
                        agent={a}
                        onOpen={onOpen}
                        escalation={escalationText(a, chart)}
                        paused={isPausedCeo(chart, a)}
                        className="w-full"
                      />
                      <p className="mt-0.5 pl-1 text-xs text-subtle">
                        Escalates to {escalationText(a, chart)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
