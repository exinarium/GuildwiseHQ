import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { BuilderIssue } from '../../lib/builder.ts';
import { Badge } from '../ui.tsx';

/**
 * The "things to fix" summary at the top of the builder. Errors block sending the workflow for approval, warnings do
 * not. Every line is a button that jumps to the step it is about.
 */
export function IssueBar({
  issues,
  labelOf,
  onJump,
}: {
  issues: readonly BuilderIssue[];
  /** Name of the step an issue belongs to, for the jump button. */
  labelOf: (stageId: string) => string | undefined;
  onJump: (stageId: string | null) => void;
}) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.length - errors.length;
  return (
    <section
      aria-label="Things to fix"
      data-testid="issue-bar"
      data-errors={errors.length}
      className="rounded-control border border-line bg-surface p-3"
    >
      <p role="status" className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {errors.length === 0 ? (
          <>
            <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
            <span data-testid="issues-ok">Nothing to fix. You can save and send this for approval.</span>
          </>
        ) : (
          <>
            <AlertCircle aria-hidden="true" className="size-4 text-danger" />
            <span>
              {errors.length === 1 ? '1 thing to fix' : `${errors.length} things to fix`} before you can send
              this for approval
            </span>
          </>
        )}
        {warnings > 0 && <Badge tone="amber">{warnings === 1 ? '1 tip' : `${warnings} tips`}</Badge>}
      </p>
      {issues.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {issues.map((i, n) => {
            const where = i.stageId ? labelOf(i.stageId) : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same sentence can appear twice
              <li key={`${i.code}-${i.stageId ?? ''}-${i.outcomeId ?? ''}-${n}`} data-testid="issue-bar-item">
                <button
                  type="button"
                  onClick={() => onJump(i.stageId ?? null)}
                  className="flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-sunken focus-visible:outline-2 [@media(pointer:coarse)]:min-h-11"
                >
                  {i.severity === 'error' ? (
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                  ) : (
                    <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                  )}
                  <span>
                    <span className="sr-only">{i.severity === 'error' ? 'Problem: ' : 'Tip: '}</span>
                    {i.text}
                    {where && <span className="text-subtle"> (go to {where})</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
