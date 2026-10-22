import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { helpBase, helpPath } from '../../help/articles.ts';
import { pageHelpFor } from '../../help/pageHelp.ts';
import { useTour } from '../tour/TourContext.tsx';
import { Button } from '../ui.tsx';
import { PageVideo } from './SectionVideo.tsx';

/** "What's on this page": a side panel (a sheet on a phone) explaining each control of the page behind it. */
export function PageHelpPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { pathname } = useLocation();
  const found = pageHelpFor(pathname);
  const tour = useTour();
  const base = helpBase(pathname);
  const help = found?.help;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-60 animate-fade bg-overlay" />
        <RadixDialog.Content
          data-testid="page-help"
          aria-describedby="page-help-intro"
          // no Trigger element (the button lives in the top bar): hand focus back to it ourselves
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document.querySelector<HTMLElement>('[data-testid="page-help-button"]')?.focus();
          }}
          className="fixed z-70 flex max-h-[88dvh] flex-col overflow-hidden border border-line bg-surface shadow-lg outline-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:animate-sheet max-sm:rounded-t-dialog max-sm:pb-[env(safe-area-inset-bottom)] sm:inset-y-0 sm:right-0 sm:max-h-none sm:w-[min(94vw,26rem)] sm:animate-drawer-right sm:rounded-none sm:border-y-0 sm:border-r-0"
        >
          <div className="flex items-start gap-3 border-b border-line px-5 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold tracking-wide text-brand-text uppercase">
                What is on this page
              </p>
              <RadixDialog.Title className="mt-0.5 text-lg font-semibold text-fg">
                {help?.title ?? 'This page'}
              </RadixDialog.Title>
            </div>
            <RadixDialog.Close
              aria-label="Close help"
              className="-mt-1 -mr-2 inline-flex size-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
            >
              <X aria-hidden="true" className="size-4" />
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <PageVideo pathname={pathname} />
            {help ? (
              <>
                <p id="page-help-intro" className="text-base text-muted">
                  {help.intro}
                </p>
                <h3 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">
                  Controls on this page
                </h3>
                <dl className="flex flex-col divide-y divide-line" data-testid="page-help-controls">
                  {help.controls.map((c) => (
                    <div key={c.name} className="py-2.5 first:pt-0">
                      <dt className="text-sm font-semibold text-fg">{c.name}</dt>
                      <dd className="mt-0.5 text-sm text-muted">{c.text}</dd>
                    </div>
                  ))}
                </dl>
                {help.tips && help.tips.length > 0 && (
                  <>
                    <h3 className="mt-5 mb-2 text-xs font-semibold tracking-wide text-subtle uppercase">
                      Tips
                    </h3>
                    <ul className="ml-4 flex list-disc flex-col gap-1.5 text-sm text-muted marker:text-subtle">
                      {help.tips.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p id="page-help-intro" className="text-base text-muted">
                There is no guide for this page yet. The Help centre has articles on everything else.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-line px-5 py-3 sm:flex-row sm:flex-wrap sm:items-center">
            {help?.article && (
              <Link
                to={helpPath(help.article, base)}
                onClick={() => onOpenChange(false)}
                data-testid="page-help-article"
                className="text-sm font-medium text-brand-text underline-offset-2 hover:underline"
              >
                Read the full article
              </Link>
            )}
            <Link
              to={base}
              onClick={() => onOpenChange(false)}
              className="text-sm font-medium text-brand-text underline-offset-2 hover:underline"
            >
              Open the Help centre
            </Link>
            {tour.available && (
              <Button
                variant="ghost"
                size="sm"
                className="sm:ml-auto"
                data-testid="page-help-tour"
                onClick={() => {
                  onOpenChange(false);
                  // after the panel has released focus
                  setTimeout(tour.start, 0);
                }}
              >
                Take the tour again
              </Button>
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
