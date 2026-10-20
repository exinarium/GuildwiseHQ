import { Check, Copy } from 'lucide-react';
import { type ComponentProps, isValidElement, memo, type ReactNode, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Link } from 'react-router';
import remarkGfm from 'remark-gfm';

/** Text of a React node tree (the source of a code block, for Copy). */
function nodeText(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join('');
  if (isValidElement(n)) return nodeText((n.props as { children?: ReactNode }).children);
  return '';
}

export function CopyButton({
  text,
  label = 'Copy',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {},
        );
      }}
      className={`inline-flex size-8 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg ${className}`}
    >
      {done ? (
        <Check aria-hidden="true" className="size-4 text-success" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
    </button>
  );
}

const components: Components = {
  a({ href, children }) {
    if (href?.startsWith('/') && !href.startsWith('//'))
      return (
        <Link to={href} className="text-brand-text underline underline-offset-2">
          {children}
        </Link>
      );
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand-text underline underline-offset-2 [overflow-wrap:anywhere]"
      >
        {children}
      </a>
    );
  },
  pre({ children }) {
    const text = nodeText(children).replace(/\n$/, '');
    const cls = isValidElement(children) ? ((children.props as { className?: string }).className ?? '') : '';
    const lang = /language-([\w+-]+)/.exec(cls)?.[1];
    return (
      <div className="group/code my-2 overflow-hidden rounded-card border border-line bg-sunken">
        <div className="flex items-center justify-between border-b border-line px-3 py-0.5 text-xs text-subtle">
          <span className="font-mono">{lang ?? 'code'}</span>
          <CopyButton text={text} label="Copy code" />
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-fg">{children}</pre>
      </div>
    );
  },
  code({ className, children, ...rest }: ComponentProps<'code'>) {
    // Fenced blocks arrive with a language class or inside <pre>; inline code has neither.
    if (className?.startsWith('language-')) return <code className={className}>{children}</code>;
    const multiline = nodeText(children).includes('\n');
    if (multiline) return <code {...rest}>{children}</code>;
    return (
      <code
        className="rounded bg-sunken px-1 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto rounded-card border border-line">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th: ({ children }) => (
    <th className="border-b border-line bg-sunken px-3 py-1.5 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-line px-3 py-1.5 align-top">{children}</td>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-lg font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2 mb-1 text-base font-semibold">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{children}</h4>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 [overflow-wrap:anywhere]">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-line pl-3 text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  img: ({ alt }) => <span className="text-subtle">[image{alt ? `: ${alt}` : ''}]</span>,
};

/** Markdown for agent messages: GFM (tables, lists, strikethrough), no raw HTML, code blocks with Copy. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 text-base leading-relaxed" data-testid="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
