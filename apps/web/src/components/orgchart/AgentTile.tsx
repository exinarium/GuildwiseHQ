import type { OrgChartAgent } from '@aom/shared';
import { AlertTriangle, CircleDot, Moon, OctagonAlert, PauseCircle, WifiOff } from 'lucide-react';
import { STATUS_META, statusLine } from '../../lib/orgChart.ts';
import { AgentAvatar } from '../Face.tsx';
import { cx } from '../ui/cx.ts';

const ICON = {
  working: CircleDot,
  blocked: OctagonAlert,
  idle: Moon,
  offline: WifiOff,
  needs_rehome: AlertTriangle,
};

/** One agent in the chart or the DevOps panel: face (ringed by status), name, role and seniority, status in words. */
export function AgentTile({
  agent,
  onOpen,
  style,
  className,
  escalation,
  paused = false,
}: {
  agent: OrgChartAgent;
  onOpen: (a: OrgChartAgent) => void;
  style?: React.CSSProperties;
  className?: string;
  /** Spoken after the name: "escalates to the BA". */
  escalation?: string;
  /** The agent takes no new work (the CEO page pauses and resumes the CEO). */
  paused?: boolean;
}) {
  const meta = STATUS_META[agent.status];
  const Icon = ICON[agent.status];
  const line = statusLine(agent);
  return (
    <button
      type="button"
      data-testid="org-agent"
      data-agent={agent.name}
      data-status={agent.status}
      data-paused={paused || undefined}
      onClick={() => onOpen(agent)}
      aria-haspopup="dialog"
      aria-label={`${agent.name}, ${agent.seniority} ${agent.roleLabel}. ${line}${paused ? ', paused' : ''}.${escalation ? ` Escalates to ${escalation}.` : ''} Open details`}
      style={style}
      className={cx(
        'group flex items-center gap-2.5 rounded-card border border-line bg-surface p-2.5 text-left shadow-sm transition-[border-color,box-shadow] duration-100',
        'hover:border-brand hover:shadow-md focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
        agent.status === 'offline' && 'opacity-80',
        paused && 'border-dashed',
        className,
      )}
    >
      <span className={cx('shrink-0 rounded-full p-0.5 ring-2 ring-offset-2 ring-offset-surface', meta.ring)}>
        <AgentAvatar
          agentId={agent.id}
          name={agent.name}
          size={40}
          seed={agent.avatarSeed}
          style={agent.avatarStyle}
          className={agent.status === 'offline' ? 'grayscale' : undefined}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base leading-tight font-semibold text-fg">{agent.name}</span>
        <span
          className="line-clamp-2 text-xs leading-snug text-muted"
          title={`${agent.roleLabel}, ${agent.seniority}`}
        >
          {agent.roleLabel}
          {agent.seniority === 'senior' ? ' · senior' : ''}
        </span>
        <span
          className={cx(
            'mt-0.5 flex items-center gap-1 truncate text-xs',
            meta.tone === 'danger' && 'text-danger',
            meta.tone === 'warning' && 'text-warning-soft-fg',
            meta.tone === 'success' && 'text-success-soft-fg',
            meta.tone === 'neutral' && 'text-subtle',
          )}
        >
          <Icon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{line}</span>
        </span>
        {paused && (
          <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-warning-soft-fg">
            <PauseCircle aria-hidden="true" className="size-3 shrink-0" />
            Paused
          </span>
        )}
        {agent.workstation && (
          <span className="block truncate text-[11px] text-subtle">{agent.workstation.name}</span>
        )}
      </span>
    </button>
  );
}
