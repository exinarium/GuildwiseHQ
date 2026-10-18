import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { cx } from './cx.ts';

/**
 * A bottom sheet for phones (Radix Dialog underneath: focus trap, Escape, aria-modal, focus return).
 *
 * - `size="auto"` (default): as tall as its content, at most 90dvh, content scrolls inside.
 * - `size="full"`: a full-screen sheet (item detail screens); the header stays, the body scrolls.
 * - `footer`: a sticky action bar under the body; it sits above the bottom safe area.
 * - Swipe down on the handle/header closes it (`onOpenChange(false)`) when dragged more than 80px.
 * From `md` up it is a centered dialog, so a sheet that is opened on a wider screen still looks right.
 */
export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'auto',
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Screen-reader description . */
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'auto' | 'full';
  testId?: string;
}) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    start.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (start.current === null) return;
    setDrag(Math.max(0, e.clientY - start.current));
  };
  const onUp = () => {
    if (start.current === null) return;
    const far = drag > 80;
    start.current = null;
    setDrag(0);
    if (far) onOpenChange(false);
  };
  const titleText = typeof title === 'string' ? title : undefined;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-60 animate-fade bg-overlay" />
        <RadixDialog.Content
          data-testid={testId ?? 'bottom-sheet'}
          aria-describedby={undefined}
          aria-modal="true"
          style={drag ? { transform: `translateY(${drag}px)`, transition: 'none' } : undefined}
          className={cx(
            'fixed z-70 flex flex-col overflow-hidden border border-line bg-surface shadow-lg',
            'inset-x-0 bottom-0 animate-sheet rounded-t-dialog',
            size === 'full' ? 'top-[env(safe-area-inset-top)] max-h-none' : 'max-h-[90dvh]',
            'md:inset-x-auto md:top-1/2 md:bottom-auto md:left-1/2 md:max-h-[90dvh] md:w-[min(92vw,36rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:animate-rise md:rounded-dialog',
          )}
        >
          <div
            className="touch-none select-none"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 rounded-full bg-line md:hidden" />
            <div className="flex items-start gap-3 px-4 pt-2 pb-1">
              <RadixDialog.Title className="min-w-0 flex-1 text-lg font-semibold [overflow-wrap:anywhere] text-fg">
                {title}
              </RadixDialog.Title>
              <RadixDialog.Close
                aria-label="Close"
                className="-mt-1 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
              >
                <X aria-hidden="true" className="size-5" />
              </RadixDialog.Close>
            </div>
          </div>
          {description && (
            <RadixDialog.Description className="px-4 pb-1 text-base text-muted">
              {description}
            </RadixDialog.Description>
          )}
          {!description && (
            <RadixDialog.Description className="sr-only">{titleText ?? 'Sheet'}</RadixDialog.Description>
          )}
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-3">
            {children}
          </div>
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end [&>button]:max-sm:w-full">
              {footer}
            </div>
          )}
          {!footer && <div className="h-[env(safe-area-inset-bottom)] shrink-0" />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
