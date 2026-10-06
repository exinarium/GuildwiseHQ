import { Check } from 'lucide-react';
import { cx } from './cx.ts';

export interface Step {
  id: string;
  label: string;
  color: string;
}

/** The workflow's stages as a horizontal stepper: done filled, current ringed and labelled, upcoming outlined. */
export function Stepper({
  steps,
  currentId,
  label = 'Stages',
}: {
  steps: Step[];
  currentId: string;
  label?: string;
}) {
  const at = Math.max(
    0,
    steps.findIndex((s) => s.id === currentId),
  );
  return (
    <ol
      aria-label={label}
      className="scroll-fade-x -mx-4 flex items-center overflow-x-auto px-4 py-1 sm:mx-0 sm:px-0"
    >
      {steps.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo';
        return (
          <li
            key={s.id}
            aria-current={state === 'current' ? 'step' : undefined}
            className="flex shrink-0 items-center"
          >
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cx('mx-2 h-0.5 w-5 rounded sm:w-8', i <= at ? 'bg-fg/30' : 'bg-line')}
              />
            )}
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cx(
                  'flex size-5 items-center justify-center rounded-full border-2 text-white',
                  state === 'todo' && 'bg-transparent',
                  state === 'current' && 'ring-2 ring-offset-2 ring-offset-canvas',
                )}
                style={{
                  borderColor: s.color,
                  backgroundColor: state === 'todo' ? 'transparent' : s.color,
                  ...(state === 'current' ? { ['--tw-ring-color' as string]: s.color } : {}),
                }}
              >
                {state === 'done' && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span
                className={cx(
                  'text-sm whitespace-nowrap',
                  state === 'current'
                    ? 'font-semibold text-fg'
                    : state === 'done'
                      ? 'text-muted'
                      : 'text-subtle',
                  state !== 'current' && 'max-sm:sr-only',
                )}
              >
                {s.label}
                {state === 'done' && <span className="sr-only"> (done)</span>}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
