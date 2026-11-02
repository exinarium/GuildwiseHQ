import { Link } from 'react-router';
import type { InstanceView } from '../../api/queries/journeys.ts';
import { Badge } from '../ui.tsx';

const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');

const TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  open: 'info',
  waiting: 'warning',
  done: 'success',
  skipped: 'success',
  cancelled: 'neutral',
  refused: 'danger',
};

/** Every visit of every step with its times, as a list (works on a phone: no wide table). */
export function InstanceHistory({ history }: { history: InstanceView['history'] }) {
  return (
    <ol className="flex flex-col gap-2" data-testid="journey-history">
      {history.map((h) => (
        <li key={h.visit} className="rounded-control border border-line bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-subtle">#{h.visit}</span>
            <span className="font-medium text-fg">{h.stepLabel}</span>
            <Badge tone={TONE[h.status] ?? 'neutral'}>{h.status}</Badge>
            {h.cardRef && (
              <Link className="text-sm text-brand underline" to={`/cards/${h.cardRef}`}>
                {h.cardRef}
              </Link>
            )}
            {h.playbookThreadId && (
              <Link className="text-sm text-brand underline" to={`/discovery/${h.playbookThreadId}`}>
                Playbook session
              </Link>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            Entered {fmt(h.enteredAt)} · Started {fmt(h.startedAt)} · Ended {fmt(h.endedAt)}
          </p>
        </li>
      ))}
    </ol>
  );
}
