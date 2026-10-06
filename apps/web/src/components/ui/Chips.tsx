import type { ButtonHTMLAttributes, ReactNode } from 'react';
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
