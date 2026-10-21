import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../ui.tsx';

/**
 * A row the person picks one of (a radio that looks like a card). The group is a `fieldset` with a `legend` at the caller;
 * each row is a real radio so the keyboard and screen readers work.
 */
export function Choice({
  name,
  checked,
  onSelect,
  icon,
  title,
  children,
  disabled,
  testId,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label
      data-testid={testId}
      className={cx(
        'flex w-full cursor-pointer gap-3 rounded-control border p-3 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand',
        children ? 'min-h-14 items-start' : 'min-h-11 items-center',
        disabled && 'cursor-not-allowed opacity-60',
        checked
          ? 'border-brand bg-brand-soft ring-1 ring-brand'
          : 'border-control bg-surface hover:bg-sunken',
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      {icon && (
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-fg">{title}</span>
        {children && <span className="mt-0.5 block text-sm text-muted">{children}</span>}
      </span>
      {checked && <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />}
    </label>
  );
}
