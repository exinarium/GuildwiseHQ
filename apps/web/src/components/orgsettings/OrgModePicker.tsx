import { ORG_MODE_LABEL, type OrgMode } from '@aom/shared';
import { useId } from 'react';
import { cx } from '../ui/cx.ts';

const DESCRIPTION: Record<OrgMode, string> = {
  dev: 'Software delivery: repositories, branches, builders, reviewers, testers and DevOps.',
  business: 'Everyday business work: no repositories, branches or code roles.',
};

/** Two large choice cards (Developer or Business): full width and touch-sized on phones. */
export function OrgModePicker({
  value,
  onChange,
  disabled = false,
  label = 'How this organization works',
}: {
  value: OrgMode;
  onChange: (mode: OrgMode) => void;
  disabled?: boolean;
  label?: string;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0" disabled={disabled} data-testid="org-mode-picker">
      <legend className="mb-1.5 text-sm font-medium text-fg">{label}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(['dev', 'business'] as const).map((m) => (
          <label
            key={m}
            className={cx(
              'flex min-h-14 w-full cursor-pointer items-start gap-3 rounded-card border p-3',
              value === m ? 'border-brand bg-brand-soft' : 'border-line bg-surface hover:bg-sunken',
              disabled && 'cursor-not-allowed opacity-70',
            )}
          >
            <input
              type="radio"
              name={name}
              value={m}
              checked={value === m}
              onChange={() => onChange(m)}
              data-testid={`org-mode-${m}`}
              className="mt-1 size-5 shrink-0"
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-fg">{ORG_MODE_LABEL[m]}</span>
              <span className="block text-xs text-muted">{DESCRIPTION[m]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
