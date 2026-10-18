import { BLOG_COVER_KEYS, BLOG_TAGS, type BlogPost } from '@aom/shared';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  useEditPost,
  usePlatformPost,
  usePublishPost,
  useRejectPost,
  useSharePost,
  useUnpublishPost,
} from '../../api/queries/blog.ts';
import { BlogBody } from '../../components/blog/BlogBody.tsx';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';
import { statusLabel } from './PlatformBlog.tsx';

const sourcesToText = (p: BlogPost) => p.sources.map((s) => `${s.title} | ${s.url}`).join('\n');
const textToSources = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf('|');
      return i > 0 ? { title: l.slice(0, i).trim(), url: l.slice(i + 1).trim() } : { title: l, url: l };
    });

/** `/platform/blog/:id`: preview exactly as it will render, edit, publish or reject with a reason, unpublish, share status. */
export function PlatformBlogPost() {
  const { id } = useParams();
  const q = usePlatformPost(id);
  if (q.isPending) return <PageSkeleton label="Loading the post" />;
  if (q.isError || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return <Editor post={q.data} />;
}

function Editor({ post }: { post: BlogPost }) {
  const edit = useEditPost(post.id);
  const publish = usePublishPost(post.id);
  const reject = useRejectPost(post.id);
  const unpublish = useUnpublishPost(post.id);
  const share = useSharePost(post.id);
  const toast = useToast();
  const [title, setTitle] = useState(post.title);
  const [summary, setSummary] = useState(post.summary);
  const [body, setBody] = useState(post.bodyMarkdown);
  const [tags, setTags] = useState(post.tags);
  const [cover, setCover] = useState<string>(post.coverImage.defaultKey);
  const [alt, setAlt] = useState(post.coverImage.alt);
  const [sources, setSources] = useState(sourcesToText(post));
  const [metaTitle, setMetaTitle] = useState(post.seo.metaTitle ?? '');
  const [metaDesc, setMetaDesc] = useState(post.seo.metaDescription ?? '');
  const [noindex, setNoindex] = useState(!!post.seo.noindex);
  const [fb, setFb] = useState(post.social.facebookText ?? '');
  const [li, setLi] = useState(post.social.linkedinText ?? '');
  const [xt, setXt] = useState(post.social.xText ?? '');
  const [bs, setBs] = useState(post.social.blueskyText ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  // the server's copy changed (after a save or an action): show it
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the form when the stored revision changes
  useEffect(() => {
    setTitle(post.title);
    setSummary(post.summary);
    setBody(post.bodyMarkdown);
    setTags(post.tags);
    setCover(post.coverImage.defaultKey);
    setAlt(post.coverImage.alt);
    setSources(sourcesToText(post));
    setMetaTitle(post.seo.metaTitle ?? '');
    setMetaDesc(post.seo.metaDescription ?? '');
    setNoindex(!!post.seo.noindex);
    setFb(post.social.facebookText ?? '');
    setLi(post.social.linkedinText ?? '');
    setXt(post.social.xText ?? '');
    setBs(post.social.blueskyText ?? '');
  }, [post.updatedAt]);

  const save = () =>
    edit.mutate(
      {
        title,
        summary,
        bodyMarkdown: body,
        tags,
        coverImage: { defaultKey: cover as (typeof BLOG_COVER_KEYS)[number], alt },
        sources: textToSources(sources),
        seo: {
          ...(metaTitle ? { metaTitle } : {}),
          ...(metaDesc ? { metaDescription: metaDesc } : {}),
          ...(noindex ? { noindex: true } : {}),
        },
        social: {
          ...(fb ? { facebookText: fb } : {}),
          ...(li ? { linkedinText: li } : {}),
          ...(xt ? { xText: xt } : {}),
          ...(bs ? { blueskyText: bs } : {}),
        },
      },
      { onSuccess: () => toast.success('Saved') },
    );
  const canPublish = ['in_review', 'draft', 'unpublished'].includes(post.status);
  const anyError = edit.error ?? publish.error ?? reject.error ?? unpublish.error ?? share.error;

  return (
    <div data-testid="blog-post-editor">
      <PageHeader
        title={post.title}
        back={{ to: '/platform/blog', label: 'All posts' }}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                post.status === 'published' ? 'success' : post.status === 'rejected' ? 'danger' : 'warning'
              }
            >
              {statusLabel(post.status)}
            </Badge>
            <span className="text-sm">
              {post.origin ?? 'Platform'} · {post.wordCount} words · {formatDateTime(post.updatedAt)}
            </span>
          </span>
        }
        actions={
          <>
            {canPublish && (
              <Button
                variant="primary"
                loading={publish.isPending}
                onClick={() => publish.mutate(undefined, { onSuccess: () => toast.success('Published') })}
                data-testid="blog-publish"
              >
                {post.status === 'unpublished' ? 'Publish again' : 'Approve and publish'}
              </Button>
            )}
            {['in_review', 'draft', 'unpublished'].includes(post.status) && (
              <Button variant="danger" onClick={() => setRejecting(true)} data-testid="blog-reject">
                Reject
              </Button>
            )}
            {post.status === 'published' && (
              <>
                <a
                  href={`/blog/${post.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center rounded-control border border-control px-3.5 text-sm font-medium text-fg hover:bg-sunken"
                >
                  View public page
                </a>
                <Button
                  variant="danger"
                  loading={unpublish.isPending}
                  onClick={() =>
                    unpublish.mutate(undefined, { onSuccess: () => toast.success('Unpublished') })
                  }
                  data-testid="blog-unpublish"
                >
                  Unpublish
                </Button>
              </>
            )}
          </>
        }
      />
      <ErrorBox error={anyError} />
      {post.rejectionReason && (
        <Callout tone="danger" title="Rejected" className="mb-4">
          {post.rejectionReason}
        </Callout>
      )}
      {post.warnings.length > 0 && (
        <Callout
          tone="warning"
          title="Content warnings (this post will not auto-publish)"
          className="mb-4"
          data-testid="blog-warnings"
        >
          <ul className="list-disc pl-5">
            {post.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
      {post.autoPublishAt && (
        <Callout tone="info" className="mb-4">
          Publishes by itself on {formatDateTime(post.autoPublishAt)} unless you reject it first.
        </Callout>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Edit">
          <div className="flex flex-col gap-3">
            <TextInput
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="blog-title"
            />
            <TextArea label="Summary" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
            <TextArea
              label="Body (Markdown)"
              rows={18}
              className="font-mono text-sm"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-testid="blog-body-input"
              hint="Headings, lists, quotes, code, tables, bold, italic and links. No HTML."
            />
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-fg">Tags</legend>
              <div className="flex flex-wrap gap-3">
                {BLOG_TAGS.map((t) => (
                  <label key={t.key} className="flex items-center gap-1.5 text-sm text-fg">
                    <input
                      type="checkbox"
                      checked={tags.includes(t.key)}
                      onChange={(e) =>
                        setTags((cur) =>
                          e.target.checked ? [...cur, t.key] : cur.filter((x) => x !== t.key),
                        )
                      }
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select label="Cover" value={cover} onChange={(e) => setCover(e.target.value)}>
                {BLOG_COVER_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
              <TextInput label="Cover description" value={alt} onChange={(e) => setAlt(e.target.value)} />
            </div>
            <TextArea
              label="Sources (one per line: title | url)"
              rows={4}
              value={sources}
              onChange={(e) => setSources(e.target.value)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput
                label="Search title (max 60)"
                value={metaTitle}
                onChange={(e) => setMetaTitle(e.target.value)}
              />
              <TextInput
                label="Search description (max 160)"
                value={metaDesc}
                onChange={(e) => setMetaDesc(e.target.value)}
              />
              <TextArea
                label="Facebook caption"
                rows={2}
                value={fb}
                onChange={(e) => setFb(e.target.value)}
              />
              <TextArea
                label="LinkedIn caption"
                rows={2}
                value={li}
                onChange={(e) => setLi(e.target.value)}
              />
              <TextArea
                label="X caption (max 250)"
                rows={2}
                maxLength={250}
                value={xt}
                onChange={(e) => setXt(e.target.value)}
              />
              <TextArea
                label="Bluesky caption (max 270)"
                rows={2}
                maxLength={270}
                value={bs}
                onChange={(e) => setBs(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" checked={noindex} onChange={(e) => setNoindex(e.target.checked)} />
              Ask search engines not to index this post
            </label>
            <div>
              <Button variant="primary" loading={edit.isPending} onClick={save} data-testid="blog-save">
                Save changes
              </Button>
            </div>
          </div>
        </Panel>
        <Panel title="Preview">
          <article data-testid="blog-preview">
            <h2 className="text-2xl font-semibold text-fg">{title}</h2>
            <p className="mt-1 mb-4 text-sm text-subtle">The Guildwise HQ team</p>
            <BlogBody source={body} />
            <p className="mt-6 rounded-control bg-sunken p-3 text-sm text-muted">
              This article was written by an AI agent for Guildwise HQ and is reviewed against its sources.
            </p>
          </article>
        </Panel>
      </div>

      {post.status === 'published' && (
        <Panel title="Social shares" className="mt-5">
          {post.shares.length === 0 ? (
            <p className="text-sm text-muted">
              Nothing shared yet. Connect a network under Blog to share automatically.
            </p>
          ) : (
            <table className="w-full text-sm" data-testid="blog-shares">
              <tbody className="divide-y divide-line">
                {post.shares.map((s) => (
                  <tr key={s.network}>
                    <td className="py-1.5 font-medium capitalize">{s.network}</td>
                    <td className="py-1.5">
                      <Badge
                        tone={s.status === 'sent' ? 'success' : s.status === 'failed' ? 'danger' : 'neutral'}
                      >
                        {s.status}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-muted">
                      {s.url ? (
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand hover:underline"
                        >
                          Open the post
                        </a>
                      ) : (
                        (s.error ?? '')
                      )}
                      {s.nextAttemptAt && <> · next try {formatDateTime(s.nextAttemptAt)}</>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mt-3">
            <Button
              loading={share.isPending}
              onClick={() =>
                share.mutate(undefined, { onSuccess: () => toast.success('Queued for sharing') })
              }
            >
              Share again (failed networks only)
            </Button>
          </div>
        </Panel>
      )}

      <Dialog
        open={rejecting}
        onOpenChange={setRejecting}
        title="Reject this post?"
        description="The reason is kept with the post. An outside tool that sent it can read the reason, revise and resubmit."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={reject.isPending}
              onClick={() =>
                reject.mutate(reason.trim(), {
                  onSuccess: () => {
                    setRejecting(false);
                    setReason('');
                    toast.success('Rejected');
                  },
                })
              }
              data-testid="blog-reject-confirm"
            >
              Reject
            </Button>
          </>
        }
      >
        <TextArea
          label="Reason"
          rows={4}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          data-testid="blog-reject-reason"
        />
      </Dialog>
    </div>
  );
}
