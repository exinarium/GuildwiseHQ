import { blogTagLabel } from '@aom/shared';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { usePublishedPost, usePublishedPosts } from '../../api/queries/blog.ts';
import { formatDate } from '../../lib/time.ts';
import { Badge, EmptyState, ErrorBox, ListSkeleton, Panel } from '../ui.tsx';
import { BlogBody } from './BlogBody.tsx';

const baseOf = (pathname: string) =>
  pathname.startsWith('/platform') ? '/platform/help/blog' : '/help/blog';

/** Help > Blog (`/help/blog`, `/help/blog/:slug`): the published articles, read inside the app. */
export function HelpBlog({ slug }: { slug?: string | undefined }) {
  return slug ? <HelpBlogPost slug={slug} /> : <HelpBlogList />;
}

function HelpBlogList() {
  const base = baseOf(useLocation().pathname);
  const list = usePublishedPosts();
  return (
    <div data-testid="help-blog">
      <p className="mb-3 text-sm text-muted">
        Articles from the Guildwise HQ team about AI agents and automation. They are also on the public blog
        at{' '}
        <a href="/blog" className="font-medium text-brand-text underline-offset-2 hover:underline">
          /blog
        </a>
        .
      </p>
      {list.isPending && <ListSkeleton label="Loading articles" rows={4} />}
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {list.data?.posts?.length === 0 && (
        <EmptyState
          title="No articles yet"
          description="New articles show up here as soon as they are published."
        />
      )}
      <ul className="flex flex-col gap-3">
        {list.data?.posts?.map((p) => (
          <li key={p.slug}>
            <Link
              to={`${base}/${p.slug}`}
              data-testid={`blog-post-${p.slug}`}
              className="block rounded-card border border-line bg-surface p-4 hover:bg-sunken"
            >
              <span className="block text-base font-semibold text-fg">{p.title}</span>
              <span className="mt-1 block text-sm text-muted">{p.summary}</span>
              <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
                {formatDate(p.publishedAt)} · {p.readingMinutes} min read
                {p.tags.map((t) => (
                  <Badge key={t} tone="neutral">
                    {blogTagLabel(t)}
                  </Badge>
                ))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HelpBlogPost({ slug }: { slug: string }) {
  const base = baseOf(useLocation().pathname);
  const q = usePublishedPost(slug);
  if (q.isPending) return <ListSkeleton label="Loading the article" rows={3} />;
  if (q.isError)
    return (
      <EmptyState
        title="That article is not available"
        description="It may have been taken down. Go back to the list of articles."
        action={
          <Link
            to={base}
            className="inline-flex h-9 items-center rounded-control bg-brand px-3.5 text-sm font-medium text-brand-fg hover:bg-brand-hover"
          >
            All articles
          </Link>
        }
      />
    );
  const p = q.data;
  return (
    <Panel>
      <article className="mx-auto max-w-3xl" data-testid="help-blog-post">
        <Link
          to={base}
          className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-brand-text hover:underline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All articles
        </Link>
        <h2 className="text-2xl font-semibold text-fg">{p.title}</h2>
        <p className="mt-1 mb-4 text-sm text-subtle">
          {p.author} · {formatDate(p.publishedAt)} · {p.readingMinutes} min read
        </p>
        <BlogBody source={p.bodyMarkdown} />
        {p.sources.length > 0 && (
          <section className="mt-6" aria-label="Sources">
            <h3 className="mb-1 text-base font-semibold text-fg">Sources</h3>
            <ol className="list-decimal space-y-1 pl-6 text-sm text-muted">
              {p.sources.map((s) => (
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
        <p className="mt-6 rounded-control bg-sunken p-3 text-sm text-muted">
          This article was written by an AI agent for Guildwise HQ and is reviewed against its sources.
        </p>
        <p className="mt-4 text-sm">
          <a
            href={`/blog/${p.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-medium text-brand-text hover:underline"
            data-testid="blog-public-link"
          >
            <ExternalLink aria-hidden="true" className="size-4" />
            Open the public page to share it
          </a>
        </p>
      </article>
    </Panel>
  );
}

/** The "From the blog" group of the help search. */
export function BlogSearchHits({ q }: { q: string }) {
  const base = baseOf(useLocation().pathname);
  const list = usePublishedPosts(q.trim());
  if (!list.data?.posts?.length) return null;
  return (
    <section aria-label="From the blog" className="mt-5" data-testid="help-blog-results">
      <h3 className="mb-2 text-sm font-semibold tracking-wide text-subtle uppercase">From the blog</h3>
      <ul className="flex flex-col gap-2">
        {(list.data.posts ?? []).slice(0, 5).map((p) => (
          <li key={p.slug}>
            <Link
              to={`${base}/${p.slug}`}
              className="block rounded-card border border-line bg-surface p-3.5 hover:bg-sunken"
            >
              <span className="text-base font-semibold text-fg">{p.title}</span>
              <span className="mt-1 block text-sm text-muted">{p.summary}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
