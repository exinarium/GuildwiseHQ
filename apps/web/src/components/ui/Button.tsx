import { Loader2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cx } from './cx.ts';

export type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'danger-ghost' | 'link';
export type Size = 'sm' | 'md' | 'lg';
export const variants: Record<Variant, string> = {
  primary: 'bg-brand text-brand-fg hover:bg-brand-hover disabled:bg-sunken disabled:text-disabled-fg',
  secondary:
    'border border-control bg-surface text-fg hover:bg-sunken disabled:text-disabled-fg disabled:hover:bg-surface',
  danger:
    'bg-danger-fill text-white hover:brightness-95 disabled:opacity-50 dark:border dark:border-danger-fill/60 dark:bg-danger-soft dark:text-danger-soft-fg dark:hover:brightness-110',
  ghost: 'text-muted hover:bg-sunken hover:text-fg disabled:text-disabled-fg disabled:hover:bg-transparent',
  'danger-ghost': 'text-danger hover:bg-danger-soft disabled:text-disabled-fg disabled:hover:bg-transparent',
  link: 'text-brand-text underline-offset-2 hover:underline disabled:text-disabled-fg',
};
export const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm [@media(pointer:coarse)]:min-h-11',
  md: 'h-9 px-3.5 text-sm [@media(pointer:coarse)]:min-h-11',
  lg: 'h-11 px-5 text-base',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ComponentProps<'button'> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors duration-100 active:translate-y-px disabled:cursor-not-allowed',
        variant !== 'link' && sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
      {children}
    </button>
  );
}
