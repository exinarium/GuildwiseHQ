import { blogTagLabel } from '@aom/shared';
import { formatDate } from '../../lib/time.ts';
import { Badge } from '../ui.tsx';
import { BlogBody } from './BlogBody.tsx';

export interface ArticleViewProps {
  title: string;
  /** The byline. */
  author: string;
  /** Shown as the date; a draft has none yet. */
  publishedAt?: string | null | undefined;
  readingMinutes?: number | undefined;
  tags?: string[] | undefined;
  body: string;
  sources?: Array<{ title: string; url: string }> | undefined;
  /** A hand-written article carries no "written by an AI agent" notice. */
  manual?: boolean | undefined;
}

/**
 * One article as it is read: Help > Blog and the authoring preview both render through this component, so the
 * preview is the same markup and the same Markdown parser as the published article.
 */
export function BlogArticleView({
  title,
  author,
  publishedAt,
  readingMinutes,
  tags = [],
  body,
  sources = [],
  manual = false,
}: ArticleViewProps) {
  const meta = [
    author,
    publishedAt ? formatDate(publishedAt) : null,
    readingMinutes ? `${readingMinutes} min read` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <h2 className="text-2xl font-semibold text-fg">{title}</h2>
      <p className="mt-1 mb-4 text-sm text-subtle">{meta}</p>
      {tags.length > 0 && (
        <p className="mb-4 flex flex-wrap gap-2">
          {tags.map((t) => (
            <Badge key={t} tone="neutral">
              {blogTagLabel(t)}
            </Badge>
          ))}
        </p>
      )}
      <BlogBody source={body} />
      {sources.length > 0 && (
        <section className="mt-6" aria-label="Sources">
          <h3 className="mb-1 text-base font-semibold text-fg">Sources</h3>
          <ol className="list-decimal space-y-1 pl-6 text-sm text-muted">
            {sources.map((s) => (
              <li key={s.url}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  className="text-brand-text underline underline-offset-2"
                >
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}
      {!manual && (
        <p className="mt-6 rounded-control bg-sunken p-3 text-sm text-muted">
          This article was written by an AI agent for Guildwise HQ and is reviewed against its sources.
        </p>
      )}
    </>
  );
}
