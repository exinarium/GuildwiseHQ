import { Fragment, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { helpBase } from './articles.ts';
import type { Block, Inline } from './markdown.ts';

function InlineNodes({ c }: { c: Inline[] }): ReactNode {
  const base = helpBase(useLocation().pathname);
  return c.map((n, i) => {
    const key = `${i}-${n.t}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={key}>{n.v}</Fragment>;
      case 'code':
        return (
          <code key={key} className="rounded-[6px] bg-sunken px-1.5 py-0.5 font-mono text-[0.9em] text-fg">
            {n.v}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-fg">
            <InlineNodes c={n.c} />
          </strong>
        );
      case 'em':
        return (
          <em key={key}>
            <InlineNodes c={n.c} />
          </em>
        );
      case 'link': {
        const cls = 'font-medium text-brand-text underline underline-offset-2 hover:no-underline';
        return /^https?:/.test(n.href) ? (
          <a key={key} href={n.href} target="_blank" rel="noreferrer noopener" className={cls}>
            <InlineNodes c={n.c} />
          </a>
        ) : (
          <Link
            key={key}
            to={n.href.startsWith('/help/') ? `${base}${n.href.slice(5)}` : n.href}
            className={cls}
          >
            <InlineNodes c={n.c} />
          </Link>
        );
      }
      default:
        return null;
    }
  });
}

/** Renders the blocks of an article. Headings carry their anchor ids (and a link to themselves). */
export function Markdown({ blocks }: { blocks: Block[] }) {
  return (
    <div className="flex flex-col gap-3 text-base leading-relaxed text-muted" data-testid="help-article-body">
      {blocks.map((b, i) => {
        const key = `${i}-${b.t}`;
        switch (b.t) {
          case 'h':
            return b.level === 2 ? (
              <h2 key={key} id={b.id} className="group mt-5 scroll-mt-20 text-xl font-semibold text-fg">
                <a href={`#${b.id}`} className="no-underline hover:underline">
                  {b.text}
                </a>
              </h2>
            ) : (
              <h3 key={key} id={b.id} className="mt-3 scroll-mt-20 text-base font-semibold text-fg">
                {b.text}
              </h3>
            );
          case 'p':
            return (
              <p key={key}>
                <InlineNodes c={b.c} />
              </p>
            );
          case 'ul':
            return (
              <ul key={key} className="ml-5 flex list-disc flex-col gap-1.5 marker:text-subtle">
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <li key={j}>
                    <InlineNodes c={it} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} className="ml-5 flex list-decimal flex-col gap-1.5 marker:text-subtle">
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static content
                  <li key={j}>
                    <InlineNodes c={it} />
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote
                key={key}
                className="rounded-control border border-info-fill/40 bg-info-soft px-3.5 py-2.5 text-sm text-info-soft-fg"
              >
                <InlineNodes c={b.c} />
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={key}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
                tabIndex={0}
                className="overflow-x-auto rounded-control border border-line bg-sunken p-3 font-mono text-sm text-fg"
              >
                <code>{b.v}</code>
              </pre>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
