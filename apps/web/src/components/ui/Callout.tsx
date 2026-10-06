import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

const tones = {
  info: { box: 'border-info-fill/40 bg-info-soft text-info-soft-fg', Icon: Info },
  warning: { box: 'border-warning-fill/50 bg-warning-soft text-warning-soft-fg', Icon: AlertTriangle },
  danger: { box: 'border-danger-fill/40 bg-danger-soft text-danger-soft-fg', Icon: OctagonAlert },
  success: { box: 'border-success-fill/40 bg-success-soft text-success-soft-fg', Icon: CheckCircle2 },
};

/** An inline banner. `role` stays with the caller (status/alert) because existing screens rely on their own. */
export function Callout({
  tone = 'info',
  title,
  children,
  actions,
  className,
  ...rest
}: {
  tone?: keyof typeof tones;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  const { box, Icon } = tones[tone];
  return (
    <div
      className={cx('flex items-start gap-2.5 rounded-control border p-3 text-sm', box, className)}
      {...rest}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className="[&_a]:underline">{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
