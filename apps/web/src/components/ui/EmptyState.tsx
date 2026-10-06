import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

const toneCls = {
  brand: 'bg-brand-soft text-brand-soft-fg',
  success: 'bg-success-soft text-success-soft-fg',
  warning: 'bg-warning-soft text-warning-soft-fg',
  danger: 'bg-danger-soft text-danger-soft-fg',
  neutral: 'bg-neutral-soft text-neutral-soft-fg',
};

/** Centred empty/error state: icon, title, a sentence of explanation and (at most) one primary action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  tone = 'brand',
  bare = false,
  className,
  'data-testid': testId,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  tone?: keyof typeof toneCls;
  /** No border and background: for use inside a panel. */
  bare?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cx(
        'flex flex-col items-center px-6 py-10 text-center',
        !bare && 'rounded-card border border-dashed border-control/60 bg-surface',
        className,
      )}
    >
      {Icon && (
        <span className={cx('mb-4 flex size-16 items-center justify-center rounded-full', toneCls[tone])}>
          <Icon aria-hidden="true" className="size-8" strokeWidth={1.6} />
        </span>
      )}
      <h2 className="text-lg font-semibold text-fg">{title}</h2>
      {description && <p className="mt-1.5 max-w-[44ch] text-base text-muted">{description}</p>}
      {(action || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
