import { Check } from 'lucide-react';
import { cx } from '../ui.tsx';
import type { Strip } from './model.ts';

/**
 * Saved, Tried, Approved (docs/design/environments-ux.md section 4 H): three steps with exactly one next action beside the
 * card. A finished step has a check and text, never colour alone.
 */
export function StatusStrip({ name, strip, next }: { name: string; strip: Strip; next: string | null }) {
  const steps = [
    { id: 'saved', label: 'Saved', done: strip.saved },
    { id: 'tried', label: 'Tried', done: strip.tried },
    { id: 'approved', label: 'Approved', done: strip.approved },
  ];
  const current = steps.findIndex((s) => !s.done);
  return (
    <div data-testid={`env-strip-${name}`} className="flex flex-col gap-1.5">
      <ol
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        aria-label="Steps before it is used"
      >
        {steps.map((s, i) => (
          <li
            key={s.id}
            className="flex items-center gap-2"
            aria-current={i === current ? 'step' : undefined}
          >
            <span
              data-testid={`strip-${s.id}`}
              data-done={s.done}
              className={cx(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                s.done
                  ? 'border-success-fill/40 bg-success-soft text-success-soft-fg'
                  : i === current
                    ? 'border-brand bg-brand-soft text-fg'
                    : 'border-line text-subtle',
              )}
            >
              {s.done ? (
                <Check aria-hidden="true" className="size-3" />
              ) : (
                <span aria-hidden="true" className="font-semibold">
                  {i + 1}
                </span>
              )}
              {s.label}
              <span className="sr-only">{s.done ? ' (done)' : i === current ? ' (next)' : ' (later)'}</span>
            </span>
            {i < steps.length - 1 && <span aria-hidden="true" className="h-px w-3 bg-line" />}
          </li>
        ))}
      </ol>
      {next && <p className="text-sm text-muted">{next}</p>}
    </div>
  );
}
