import { type PlaybookRunState, stepLabel } from '@aom/shared';
import { BookOpen, Check } from 'lucide-react';
import { cx } from '../ui/cx.ts';

/**
 * The steps of the playbook a guided session runs, and the one the facilitator is on. A built-in playbook lists all its steps;
 * for a pack's the list grows as the facilitator reports each step. An agent that started the session is named.
 */
export function PlaybookSteps({ run }: { run: PlaybookRunState }) {
  const total = run.total ?? run.steps.length;
  const titles = Array.from(
    { length: Math.max(total, run.steps.length) },
    (_, i) => run.steps[i] ?? `Step ${i + 1}`,
  );
  return (
    <section
      aria-label="Playbook"
      data-testid="playbook-steps"
      className="rounded-control border border-line bg-surface px-3 py-2"
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-fg">
        <BookOpen aria-hidden="true" className="size-4 text-subtle" />
        <span className="font-medium">{run.name}</span>
        <span className="text-muted" data-testid="playbook-step-label">
          {run.step ? stepLabel(run) : 'not started'}
        </span>
        {run.startedBy.kind === 'agent' && (
          <span className="text-xs text-subtle" data-testid="playbook-started-by">
            started by {run.startedBy.agentName ?? 'an agent'}
          </span>
        )}
      </p>
      {titles.length > 0 && (
        <ol className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Steps">
          {titles.map((t, i) => {
            const n = i + 1;
            const done = run.step !== null && n < run.step;
            const active = run.step === n;
            return (
              <li
                key={`${n}:${t}`}
                aria-current={active ? 'step' : undefined}
                className={cx(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
                  active
                    ? 'border-brand bg-brand-soft text-brand-soft-fg'
                    : done
                      ? 'border-line bg-sunken text-muted'
                      : 'border-line text-subtle',
                )}
              >
                {done ? <Check aria-hidden="true" className="size-3" /> : <span className="tnum">{n}</span>}
                {t}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
