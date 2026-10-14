import type { OrgChart, OrgChartAgent } from '@aom/shared';
import { Crown, UserPlus } from 'lucide-react';
import { Link } from 'react-router';
import { escalationText, isPausedCeo } from '../../lib/orgChart.ts';
import { type LaidEdge, layoutOrgChart, NODE_H, NODE_W } from '../../lib/orgChartLayout.ts';
import { cx } from '../ui/cx.ts';
import { AgentTile } from './AgentTile.tsx';

const EDGE_LABEL: Record<LaidEdge['kind'], string> = {
  peer: 'a senior of the same role',
  ba: 'the BA',
  ceo: 'the CEO',
  desk: 'you, on the desk',
};

/**
 * The chart itself: SVG lines (hidden from assistive tech, the list view and each tile's label say the same in words)
 * under absolutely placed tiles. Scrolls sideways when the tree is wider than the page.
 */
export function ChartCanvas({
  chart,
  agents,
  onOpen,
  canHire,
}: {
  chart: OrgChart;
  agents: OrgChartAgent[];
  onOpen: (a: OrgChartAgent) => void;
  canHire: boolean;
}) {
  const layout = layoutOrgChart(agents, chart.departments);
  const byId = new Map(agents.map((a) => [a.id, a]));
  return (
    <div
      className="scroll-fade-x overflow-x-auto rounded-card border border-line bg-sunken/60 p-3"
      data-testid="org-chart-scroll"
    >
      <div
        role="group"
        aria-label="Organization chart"
        data-testid="org-chart"
        className="relative mx-auto"
        style={{ width: layout.width, height: layout.height }}
      >
        {layout.boxes.map((b) => (
          <div
            key={b.key}
            data-testid="org-department"
            data-department={b.key}
            className="absolute rounded-card border border-line bg-surface/70"
            style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
          />
        ))}
        <svg
          aria-hidden="true"
          focusable="false"
          className="pointer-events-none absolute inset-0"
          width={layout.width}
          height={layout.height}
        >
          <defs>
            <marker
              id="org-arrow"
              viewBox="0 0 8 8"
              refX="4"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M1,6 L4,1.5 L7,6" fill="none" stroke="var(--control)" strokeWidth="1.4" />
            </marker>
          </defs>
          {layout.edges.map((e) => (
            <path
              key={e.id}
              d={e.d}
              data-edge={e.kind}
              fill="none"
              stroke="var(--control)"
              strokeWidth="1.5"
              strokeDasharray={e.kind === 'desk' ? '5 4' : undefined}
              markerEnd="url(#org-arrow)"
              strokeLinejoin="round"
            />
          ))}
        </svg>
        {layout.boxes.map((b) => (
          <div
            key={`${b.key}-label`}
            className="absolute flex items-center gap-2 px-3 text-xs font-semibold tracking-wide text-muted uppercase"
            style={{ left: b.x, top: b.y, width: b.w, height: 34 }}
          >
            <span className="rounded-full bg-surface px-2 py-0.5">{b.label}</span>
            {b.roles.length > 1 && (
              <span className="sr-only">roles: {b.roles.map((r) => r.label).join(', ')}</span>
            )}
          </div>
        ))}
        {layout.nodes.map((n) => {
          const place = { left: n.x, top: n.y, width: n.w, height: n.h };
          if (n.kind === 'manager')
            return (
              <div
                key={n.id}
                data-testid="org-manager"
                className="absolute flex items-center gap-3 rounded-card border border-brand/40 bg-brand-soft p-3 text-brand-soft-fg"
                style={place}
              >
                <Crown aria-hidden="true" className="size-6 shrink-0" />
                <div className="min-w-0">
                  <p className="truncate text-base leading-tight font-semibold">{chart.owner.name}</p>
                  <p className="text-xs">Owner, the manager</p>
                  {chart.admins.length > 0 && (
                    <p className="truncate text-xs">
                      with {chart.admins.length} admin{chart.admins.length === 1 ? '' : 's'}
                    </p>
                  )}
                </div>
              </div>
            );
          if (n.kind === 'placeholder')
            return (
              <div
                key={n.id}
                data-testid="org-no-ba"
                className="absolute flex flex-col items-start justify-center gap-1 rounded-card border border-dashed border-control p-3 text-sm text-muted"
                style={place}
              >
                <span className="font-medium text-fg">No BA yet</span>
                <span className="text-xs">Questions go straight to you.</span>
                {canHire && (
                  <Link
                    to="/agents?hire=ba"
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline"
                  >
                    <UserPlus aria-hidden="true" className="size-3" /> Hire a BA
                  </Link>
                )}
              </div>
            );
          const a = n.agent as OrgChartAgent;
          return (
            <AgentTile
              key={n.id}
              agent={byId.get(a.id) ?? a}
              onOpen={onOpen}
              escalation={escalationText(a, chart)}
              paused={isPausedCeo(chart, a)}
              className={cx('absolute')}
              style={{ ...place, width: NODE_W, height: NODE_H }}
            />
          );
        })}
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted" aria-label="Legend">
        {(
          [
            'peer',
            'ba',
            ...(layout.nodes.some((n) => n.kind === 'ceo') ? (['ceo'] as const) : []),
            'desk',
          ] as const
        ).map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <svg aria-hidden="true" width="26" height="8" focusable="false">
              <line
                x1="0"
                y1="4"
                x2="26"
                y2="4"
                stroke="var(--control)"
                strokeWidth="1.5"
                strokeDasharray={k === 'desk' ? '5 4' : undefined}
              />
            </svg>
            Questions go up to {EDGE_LABEL[k]}
          </li>
        ))}
      </ul>
    </div>
  );
}
