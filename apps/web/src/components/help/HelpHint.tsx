import * as Popover from '@radix-ui/react-popover';
import { CircleHelp } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { helpBase, helpPath } from '../../help/articles.ts';

/**
 * A small "?" next to a complex control: a sentence of explanation and a link to the matching help article. The link
 * opens the article in a new tab, so a half-filled form is never lost.
 */
export function HelpHint({
  article,
  label,
  children,
}: {
  /** `slug#anchor` of the article. */
  article: string;
  /** What it is about, for the button's name: "About follow-ups". */
  label: string;
  /** One or two plain sentences. */
  children: string;
}) {
  const base = helpBase(useLocation().pathname);
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={label}
        data-testid="help-hint"
        data-article={article}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-subtle hover:bg-sunken hover:text-brand-text data-[state=open]:bg-brand-soft data-[state=open]:text-brand-soft-fg [@media(pointer:coarse)]:size-8"
      >
        <CircleHelp aria-hidden="true" className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-90 w-[min(20rem,calc(100vw-1.5rem))] animate-fade rounded-card border border-line bg-surface p-3.5 text-sm text-fg shadow-lg"
        >
          <p className="text-muted">{children}</p>
          <Link
            to={helpPath(article, base)}
            target="_blank"
            rel="noopener"
            data-testid="help-hint-link"
            className="mt-2 inline-block font-medium text-brand-text underline-offset-2 hover:underline"
          >
            Read more in Help<span className="sr-only"> (opens in a new tab)</span>
          </Link>
          <Popover.Arrow className="fill-surface stroke-line" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
