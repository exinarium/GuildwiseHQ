import type { ReactNode } from 'react';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { cx } from './ui/cx.ts';

/**
 * A full-height screen with a scrolling middle and a composer at the bottom (the chat pages).
 *
 * On a phone it fills the shell's main area, between the top bar and the bottom tab bar (or the on-screen keyboard, which
 * the app frame follows), so the page itself never scrolls and the composer cannot jump: the log inside it is a `min-h-0 flex-1 overflow-y-auto` child. From `md` up it is a
 * normal block of the given `desktopClassName`.
 */
export function PinnedScreen({
  children,
  desktopClassName,
  testId,
}: {
  children: ReactNode;
  desktopClassName: string;
  testId?: string;
}) {
  const mobile = useIsMobile();
  if (!mobile) {
    return (
      <div className={cx('flex flex-col', desktopClassName)} data-testid={testId}>
        {children}
      </div>
    );
  }
  return (
    <div
      data-testid={testId}
      className="absolute inset-0 z-10 flex flex-col overflow-hidden bg-canvas pt-3 pr-[max(1rem,var(--safe-right))] pl-[max(1rem,var(--safe-left))]"
    >
      {children}
    </div>
  );
}
