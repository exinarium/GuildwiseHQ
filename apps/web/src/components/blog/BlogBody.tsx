import { type MdInline, parseMarkdown } from '@aom/shared';
import { Fragment, type ReactNode, useMemo } from 'react';

/**
 * Renders a blog post's restricted Markdown with the same parser the public pages use (packages/shared). No raw HTML
 * ever exists in the tree: everything is a React text node or one of these elements.
 */
function Inline({ c }: { c: MdInline[] }): ReactNode {
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
            <Inline c={n.c} />
          </strong>
        );
      case 'em':
        return (
          <em key={key}>
            <Inline c={n.c} />
          </em>
        );
      case 'link':
        return (
          <a
            key={key}
            href={n.href}
            {...(/^https?:/.test(n.href) ? { target: '_blank', rel: 'nofollow noopener noreferrer' } : {})}
            className="font-medium text-brand-text underline underline-offset-2 hover:no-underline"
          >
            <Inline c={n.c} />
          </a>
        );
      default:
        return null;
    }
  });
}

export function BlogBody({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className="flex flex-col gap-3 text-base leading-relaxed text-muted" data-testid="blog-body">
      {blocks.map((b, i) => {
        const key = `${i}-${b.t}`;
        switch (b.t) {
          case 'h':
            return b.level === 2 ? (
              <h2 key={key} id={b.id} className="mt-5 scroll-mt-20 text-xl font-semibold text-fg">
                {b.text}
              </h2>
            ) : b.level === 3 ? (
              <h3 key={key} id={b.id} className="mt-4 scroll-mt-20 text-lg font-semibold text-fg">
                {b.text}
              </h3>
            ) : (
              <h4 key={key} id={b.id} className="mt-3 scroll-mt-20 text-base font-semibold text-fg">
                {b.text}
              </h4>
            );
          case 'p':
            return (
              <p key={key}>
                <Inline c={b.c} />
              </p>
            );
          case 'ul':
            return (
              <ul key={key} className="list-disc space-y-1 pl-6">
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list built from the text
                  <li key={j}>
                    <Inline c={it} />
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key} className="list-decimal space-y-1 pl-6">
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list built from the text
                  <li key={j}>
                    <Inline c={it} />
                  </li>
                ))}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={key} className="border-l-4 border-brand pl-4 italic">
                <Inline c={b.c} />
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-control bg-sunken p-3 font-mono text-sm text-fg"
              >
                {b.v}
              </pre>
            );
          case 'table':
            return (
              <div key={key} className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static table built from the text
                        <th key={j} className="border border-line px-2 py-1 text-left font-semibold text-fg">
                          <Inline c={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: static table built from the text
                      <tr key={j}>
                        {r.map((c, k) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: static table built from the text
                          <td key={k} className="border border-line px-2 py-1">
                            <Inline c={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
