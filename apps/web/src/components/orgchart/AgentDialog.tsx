import type { OrgChart, OrgChartAgent } from '@aom/shared';
import { Link } from 'react-router';
import { money } from '../../lib/money.ts';
import { escalationText, STATUS_META, statusLine } from '../../lib/orgChart.ts';
import { ageLabel } from '../../lib/time.ts';
import { AgentAvatar } from '../Face.tsx';
import { Badge, Dialog } from '../ui.tsx';

const TONE = { success: 'green', danger: 'red', neutral: 'neutral', warning: 'amber' } as const;

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
    <dt className="text-sm font-medium text-muted">{label}</dt>
    <dd className="min-w-0 text-sm text-fg">{children}</dd>
  </div>
);

/** An agent's card: where it may work, what it focuses on, what it costs, what it did lately. */
export function AgentDialog({
  agent,
  chart,
  onClose,
}: {
  agent: OrgChartAgent | null;
  chart: OrgChart;
  onClose: () => void;
}) {
  if (!agent) return null;
  const projects = new Map(chart.projects.map((p) => [p.id, p]));
  const names = (ids: string[]) => ids.map((id) => projects.get(id)?.key ?? 'a project that is gone');
  const meta = STATUS_META[agent.status];
  const station = agent.workstation;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={agent.name}
      description={`${agent.seniority} ${agent.roleLabel}`}
      size="lg"
      footer={
        <Link
          to="/agents"
          className="inline-flex h-9 items-center justify-center rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken"
        >
          Open in HR board
        </Link>
      }
    >
      <div data-testid="org-agent-card" className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <AgentAvatar
            agentId={agent.id}
            name={agent.name}
            size={64}
            seed={agent.avatarSeed}
            style={agent.avatarStyle}
          />
          <div className="flex flex-col gap-1">
            <Badge tone={TONE[meta.tone]} data-testid="org-agent-status">
              {statusLine(agent)}
            </Badge>
            <p className="font-mono text-xs text-subtle">
              {agent.runtime} · {agent.model} · capacity {agent.capacity}
            </p>
          </div>
        </div>
        <dl className="flex flex-col gap-2.5">
          <Row label="Works on">
            <span data-testid="org-agent-allowed">
              {agent.allowedProjectIds === null
                ? 'Any project of the organization'
                : agent.allowedProjectIds.length === 0
                  ? 'No project (benched)'
                  : names(agent.allowedProjectIds).join(', ')}
            </span>
          </Row>
          <Row label="Focus">
            {agent.focusProjectIds.length ? names(agent.focusProjectIds).join(', ') : 'No preference'}
          </Row>
          <Row label="Reports to">
            {agent.reportsTo.name}
            {agent.reportsTo.userId !== chart.owner.userId && (
              <>, and through them {chart.owner.name} (Owner)</>
            )}
          </Row>
          <Row label="Escalates to">
            {agent.isDevops ? `${chart.owner.name}, on the desk` : escalationText(agent, chart)}
          </Row>
          <Row label="Department">
            {agent.department === 'management' ? 'Management' : (agent.department ?? 'none')}
          </Row>
          {agent.roleKey === 'ceo' && (
            <Row label="Manage">
              <Link to="/org/ceo" className="text-brand-text underline">
                Manage on the CEO page
              </Link>
            </Row>
          )}
          <Row label="Workstation">
            {station ? (
              <>
                {station.name} {station.online ? '(online)' : '(offline)'}
              </>
            ) : (
              'None'
            )}
          </Row>
          <Row label="Spend">
            <span className="tnum" data-testid="org-agent-spend">
              {money(agent.spend.monthMicros, agent.spend.currency)} this month,{' '}
              {money(agent.spend.totalMicros, agent.spend.currency)} in total
            </span>
          </Row>
        </dl>
        <section aria-labelledby="org-recent">
          <h3 id="org-recent" className="mb-1.5 text-sm font-semibold text-fg">
            Recent work
          </h3>
          {agent.recentWork.length === 0 ? (
            <p className="text-sm text-muted">No finished shifts yet.</p>
          ) : (
            <ul
              className="flex flex-col divide-y divide-line rounded-control border border-line"
              data-testid="org-agent-recent"
            >
              {agent.recentWork.map((w) => (
                <li key={w.shiftId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {w.cardId && w.ref ? (
                      <Link to={`/cards/${w.cardId}`} className="font-medium text-brand-text hover:underline">
                        {w.ref} {w.title}
                      </Link>
                    ) : (
                      <span className="text-muted">
                        {w.kind === 'chat' ? 'A chat' : `A ${w.kind.replace('_', ' ')} shift`}
                      </span>
                    )}
                  </span>
                  <Badge tone={w.outcome === 'reported' ? 'green' : 'neutral'}>
                    {(w.outcome ?? 'ended').replace('_', ' ')}
                  </Badge>
                  <span className="tnum w-10 text-right text-xs text-subtle">{ageLabel(w.endedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}
