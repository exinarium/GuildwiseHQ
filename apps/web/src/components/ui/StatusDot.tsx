import { cx } from './cx.ts';

const dot = {
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
  info: 'bg-info-fill',
  neutral: 'bg-subtle/70',
  brand: 'bg-brand',
};

/** An 8 px dot plus a text label: colour never carries the meaning alone. */
export function StatusDot({
  tone = 'neutral',
  children,
  pulse = false,
  className,
}: {
  tone?: keyof typeof dot;
  children: React.ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-sm text-muted', className)}>
      <span
        aria-hidden="true"
        className={cx('size-2 shrink-0 rounded-full', dot[tone], pulse && 'animate-pulse-soft')}
      />
      {children}
    </span>
  );
}
