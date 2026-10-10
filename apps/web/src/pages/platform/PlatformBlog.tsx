import { type BlogStatus, blogTagLabel } from '@aom/shared';
import { Newspaper } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { usePlatformBlog } from '../../api/queries/blog.ts';
import { BlogSettingsPanel } from '../../components/blog/BlogSettingsPanel.tsx';
import { SocialPanel } from '../../components/blog/SocialPanel.tsx';
import {
  Badge,
  EmptyState,
  ErrorBox,
  FilterChip,
  ListSkeleton,
  PageHeader,
  Panel,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

const STATUS: Array<{ id: BlogStatus; label: string }> = [
  { id: 'in_review', label: 'In review' },
  { id: 'draft', label: 'Drafts' },
  { id: 'published', label: 'Published' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'unpublished', label: 'Unpublished' },
];
const TONE: Record<BlogStatus, 'neutral' | 'brand' | 'success' | 'danger' | 'warning'> = {
  draft: 'neutral',
  in_review: 'warning',
  published: 'success',
  rejected: 'danger',
  unpublished: 'neutral',
};
export const statusLabel = (s: BlogStatus) => STATUS.find((x) => x.id === s)?.label ?? s;

/** `/platform/blog`: the review queue and every post, the kill switch and moderation settings, the digest and the social networks. */
export function PlatformBlog() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as BlogStatus | null) ?? undefined;
  const list = usePlatformBlog(status);
  const set = (v: BlogStatus | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set('status', v);
    else next.delete('status');
    setParams(next, { replace: true });
  };
  const d = list.data;
  return (
    <div>
      <PageHeader
        title="Blog"
        sub="The Guildwise HQ blog: posts from the writer agents wait here for your review."
      />
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {d && <BlogSettingsPanel settings={d.settings} />}
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Status">
        <FilterChip pressed={!status} onClick={() => set(undefined)}>
          All
        </FilterChip>
        {STATUS.map((s) => (
          <FilterChip
            key={s.id}
            pressed={status === s.id}
            {...(s.id === 'in_review' && d ? { count: d.pending } : {})}
            onClick={() => set(s.id)}
            data-testid={`blog-filter-${s.id}`}
          >
            {s.label}
          </FilterChip>
        ))}
      </div>
      {list.isPending && <ListSkeleton label="Loading posts" rows={4} />}
      {d?.posts.length === 0 && (
        <EmptyState
          icon={Newspaper}
          title="No posts here"
          description="Posts arrive through the agent API. Create an API key under API keys and set up the writer agent (see BLOG-API.md)."
        />
      )}
      {d && d.posts.length > 0 && (
        <Panel padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="blog-posts">
              <thead className="text-left text-xs text-subtle">
                <tr>
                  <th className="px-4 py-2 font-medium">Post</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">From</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.posts.map((p) => (
                  <tr key={p.id} data-testid={`blog-row-${p.slug}`}>
                    <td className="px-4 py-2.5">
                      <Link to={`/platform/blog/${p.id}`} className="font-medium text-brand hover:underline">
                        {p.title}
                      </Link>
                      <span className="block text-xs text-subtle">
                        {p.tags.map(blogTagLabel).join(', ')} · {p.readingMinutes} min
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={TONE[p.status]}>{statusLabel(p.status)}</Badge>
                      {p.warnings.length > 0 && (
                        <Badge tone="danger" className="ml-1" title={p.warnings.join('\n')}>
                          {p.warnings.length} warning{p.warnings.length === 1 ? '' : 's'}
                        </Badge>
                      )}
                      {p.autoPublishAt && (
                        <span className="mt-0.5 block text-xs text-muted">
                          Auto-publishes {formatDateTime(p.autoPublishAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{p.origin ?? 'Platform'}</td>
                    <td className="px-4 py-2.5 text-muted">{formatDateTime(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {d && (
        <div className="mt-5">
          <SocialPanel
            channels={d.social.channels}
            failedShares={d.social.failedShares}
            needReconnect={d.social.channelsNeedingReconnect}
          />
        </div>
      )}
    </div>
  );
}
