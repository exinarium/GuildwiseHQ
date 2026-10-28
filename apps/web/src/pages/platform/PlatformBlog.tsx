import { type BlogStatus, blogTagLabel } from '@aom/shared';
import { Newspaper } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useBlogSummary, usePlatformBlog } from '../../api/queries/blog.ts';
import { BlogSettingsPanel } from '../../components/blog/BlogSettingsPanel.tsx';
import { BlogTopicsPanel } from '../../components/blog/BlogTopicsPanel.tsx';
import { ReleasesPanel } from '../../components/blog/ReleasesPanel.tsx';
import { SocialPanel } from '../../components/blog/SocialPanel.tsx';
import {
  Badge,
  EmptyState,
  ErrorBox,
  FilterChip,
  ListSkeleton,
  PageHeader,
  Panel,
  Tabs,
} from '../../components/ui.tsx';
import { ext } from '../../extension/index.ts';
import { formatDateTime } from '../../lib/time.ts';
import { PlatformVideo } from './PlatformVideo.tsx';

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
  const summary = useBlogSummary();
  const tabParam = params.get('tab');
  const tab = tabParam === 'topics' || tabParam === 'releases' || tabParam === 'videos' ? tabParam : 'posts';
  const setTab = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === 'topics' || id === 'releases' || id === 'videos') next.set('tab', id);
    else next.delete('tab');
    setParams(next, { replace: true });
  };
  const postsView = () => (
    <>
      {list.isError && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {d && <BlogSettingsPanel settings={d.settings} />}
      {ext.PlatformBlogWriter && <ext.PlatformBlogWriter />}
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
          description={`${ext.PlatformBlogWriter ? 'Switch the blog writer on under Writer above, or press Write one now. ' : ''}Outside tools can post through the blog API (see API keys).`}
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
    </>
  );
  return (
    <div>
      <PageHeader
        title="Blog"
        sub="The Guildwise HQ blog: articles from the blog writer (or an outside tool) wait here for your review."
      />
      <Tabs
        label="Blog sections"
        prefix="blog"
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'posts', label: 'Posts', testId: 'blog-tab-posts' },
          {
            id: 'releases',
            label:
              (summary.data?.pendingReleases ?? 0) > 0
                ? `Releases (${summary.data?.pendingReleases})`
                : 'Releases',
            testId: 'blog-tab-releases',
          },
          {
            id: 'videos',
            label:
              (summary.data?.pendingVideos ?? 0) > 0 ? `Videos (${summary.data?.pendingVideos})` : 'Videos',
            testId: 'blog-tab-videos',
          },
          { id: 'topics', label: 'Topics', testId: 'blog-tab-topics' },
        ]}
      />
      {tab === 'releases' && (
        <div role="tabpanel" id="blog-panel-releases" aria-labelledby="blog-tab-releases">
          <ReleasesPanel />
        </div>
      )}
      {tab === 'videos' && (
        <div role="tabpanel" id="blog-panel-videos" aria-labelledby="blog-tab-videos">
          <PlatformVideo />
        </div>
      )}
      {tab === 'topics' && (
        <div role="tabpanel" id="blog-panel-topics" aria-labelledby="blog-tab-topics">
          <BlogTopicsPanel />
        </div>
      )}
      {tab === 'posts' && (
        <div role="tabpanel" id="blog-panel-posts" aria-labelledby="blog-tab-posts">
          {postsView()}
        </div>
      )}
    </div>
  );
}
