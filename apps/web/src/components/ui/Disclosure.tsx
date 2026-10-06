import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/** Accessible show/hide built on <details>, styled to match the system. */
export function Disclosure({
  summary,
  children,
  defaultOpen,
  className,
  'data-testid': testId,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <details open={defaultOpen} data-testid={testId} className={cx('group', className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-sm font-medium text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
