import type { ReactNode } from 'react';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { useViewportBottomGap } from '../hooks/useViewportBottomGap.ts';
import { cx } from './ui/cx.ts';

/**
 * A full-height screen with a scrolling middle and a composer at the bottom (the chat pages).
 *
 * On a phone it is fixed between the top bar and the bottom tab bar (or the on-screen keyboard), so the page itself never
 * scrolls and the composer cannot jump: the log inside it is a `min-h-0 flex-1 overflow-y-auto` child. From `md` up it is a
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
  const gap = useViewportBottomGap(mobile);
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
      className="fixed inset-x-0 top-[calc(3.5rem+env(safe-area-inset-top))] z-10 flex flex-col overflow-hidden bg-canvas pt-3 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]"
      style={{ bottom: gap > 0 ? gap : 'var(--app-bottom-inset, 0px)' }}
    >
      {children}
    </div>
  );
}
