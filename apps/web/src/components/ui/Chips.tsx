import { type ButtonHTMLAttributes, type ReactNode, useId } from 'react';
import { PRIORITY_LEVELS, priorityLevel } from '../../lib/priority.ts';
import { cx } from './cx.ts';

/** A toggle chip for filters (`aria-pressed`). */
export function FilterChip({
  pressed,
  children,
  count,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { pressed: boolean; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors [@media(pointer:coarse)]:h-10',
        pressed
          ? 'border-brand bg-brand-soft text-brand-soft-fg'
          : 'border-control bg-surface text-muted hover:bg-sunken hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
      {count !== undefined && <span className="tnum text-xs opacity-80">{count}</span>}
    </button>
  );
}

/** A small radio-like switcher (radiogroup of buttons). */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode }>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-control border border-control bg-sunken p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-[6px] px-3 text-sm font-medium [@media(pointer:coarse)]:h-9',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Low / Normal / High / Urgent segmented buttons. `value` is the stored number; the nearest level is shown selected. */
export function PriorityPicker({
  value,
  onChange,
  label = 'Priority',
  hint,
  allowAny,
  inline,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label?: string;
  hint?: string;
  /** Adds an "Any" segment (for filters) that selects `null`. */
  allowAny?: boolean;
  /** Label beside the buttons instead of above (filter bars). */
  inline?: boolean;
}) {
  const current = value === null ? null : priorityLevel(value);
  const id = useId();
  const segs: Array<{ key: string; label: string; value: number | null }> = [
    ...(allowAny ? [{ key: 'any', label: 'Any', value: null }] : []),
    ...[...PRIORITY_LEVELS]
      .reverse()
      .map((l) => ({ key: l.key, label: l.label, value: l.value as number | null })),
  ];
  return (
    <div className={cx(inline ? 'flex items-center gap-2' : 'flex flex-col gap-1.5')}>
      <span id={id} className={cx('text-sm font-medium', inline ? 'text-muted' : 'text-fg')}>
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="inline-flex self-start rounded-control border border-control bg-sunken p-0.5"
      >
        {segs.map((o) => {
          const on = current?.key === o.key || (o.value === null && current === null);
          return (
            <button
              key={o.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              className={cx(
                'h-8 rounded-[6px] px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none [@media(pointer:coarse)]:h-10',
                on ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {hint && <p className="text-xs text-subtle">{hint}</p>}
    </div>
  );
}
