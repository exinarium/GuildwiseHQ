import {
  BLOG_IMAGE,
  BLOG_TAGS,
  type BlogPost,
  BlogSlugSchema,
  MANUAL_POST_LIMITS,
  type ManualPostRequest,
  slugifyTitle,
} from '@aom/shared';
import { ImagePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/queries/auth.ts';
import {
  useCreateManualPost,
  usePublishPost,
  useUnpublishPost,
  useUpdateManualPost,
  useUploadBlogImage,
} from '../../api/queries/blog.ts';
import { BlogArticleView } from '../../components/blog/BlogArticleView.tsx';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorBox,
  PageHeader,
  Panel,
  Tabs,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { formatDate, formatDateTime } from '../../lib/time.ts';

const IMAGE_TYPES = Object.values(BLOG_IMAGE.types) as string[];
const SUMMARY_MAX = 300;

type FieldErrors = Partial<Record<'title' | 'slug' | 'summary' | 'body' | 'author' | 'image', string>>;

/** Field errors the server sent as `details: [{ field, message }]` (a taken slug is shown under the slug field). */
function serverFieldErrors(e: unknown): FieldErrors {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return {};
  const out: FieldErrors = {};
  for (const d of e.details as Array<{ field?: string; message?: string }>) {
    if (d.field === 'slug' && d.message) out.slug = d.message;
    if (d.field === 'title' && d.message) out.title = d.message;
    if (d.field === 'summary' && d.message) out.summary = d.message;
  }
  return out;
}

/** The checks the server makes, so a person sees what is missing before anything is sent. */
export function validateArticle(v: {
  title: string;
  slug: string;
  summary: string;
  body: string;
  author: string;
}): FieldErrors {
  const e: FieldErrors = {};
  if (v.title.trim().length < MANUAL_POST_LIMITS.titleMin)
    e.title = `Give the article a title of at least ${MANUAL_POST_LIMITS.titleMin} characters.`;
  if (!BlogSlugSchema.safeParse(v.slug).success)
    e.slug = 'Use 3 to 80 lowercase letters, digits and single dashes.';
  if (v.summary.trim().length < MANUAL_POST_LIMITS.summaryMin)
    e.summary = `Write a summary of at least ${MANUAL_POST_LIMITS.summaryMin} characters.`;
  else if (v.summary.trim().length > SUMMARY_MAX)
    e.summary = `The summary can be at most ${SUMMARY_MAX} characters.`;
  if (!v.body.trim()) e.body = 'Write the article text.';
  if (!v.author.trim()) e.author = 'Enter the name to show as the author.';
  else if (v.author.trim().length > MANUAL_POST_LIMITS.authorMax)
    e.author = `The author name can be at most ${MANUAL_POST_LIMITS.authorMax} characters.`;
  return e;
}

/** The client-side check of an image before it is sent (type and size); `null` when it can go. */
export function imageProblem(file: { type: string; size: number }): string | null {
  if (!IMAGE_TYPES.includes(file.type)) return 'Only PNG, JPEG, WebP and GIF images can be uploaded.';
  if (file.size > BLOG_IMAGE.maxBytes) return 'Images can be at most 5 MB.';
  return null;
}

/** `/platform/blog/new`: write a new article by hand. */
export function PlatformBlogArticle() {
  return <ArticleEditor />;
}

/**
 * The authoring view of a hand-written article: title, address, summary, tags, author and a Markdown body with
 * uploaded images, a preview rendered by the same component as Help > Blog, save as draft, publish and unpublish.
 */
export function ArticleEditor({ post }: { post?: BlogPost | undefined }) {
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const create = useCreateManualPost();
  const update = useUpdateManualPost(post?.id ?? '');
  const publish = usePublishPost(post?.id ?? '');
  const unpublish = useUnpublishPost(post?.id ?? '');
  const uploadImage = useUploadBlogImage(post?.id ?? '');

  const myName = me.data?.user?.displayName ?? '';
  const [title, setTitle] = useState(post?.title ?? '');
  const [slug, setSlug] = useState(post?.slug ?? '');
  // the address follows the title until it is edited by hand (an existing article keeps its address)
  const [slugTouched, setSlugTouched] = useState(!!post);
  const [summary, setSummary] = useState(post?.summary ?? '');
  const [body, setBody] = useState(post?.bodyMarkdown ?? '');
  const [tags, setTags] = useState<string[]>(post?.tags ?? []);
  const [author, setAuthor] = useState(post?.authorName ?? '');
  // a new article is by the signed-in user until the name is edited
  useEffect(() => {
    if (!post && myName) setAuthor((cur) => cur || myName);
  }, [post, myName]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const caret = useRef<{ start: number; end: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const authorShown = author || myName;
  const slugLocked = !!post?.publishedAt;
  const published = post?.status === 'published';
  const onTitle = (v: string) => {
    setTitle(v);
    if (!slugTouched) setSlug(v.trim() ? slugifyTitle(v) : '');
  };
  const dirty =
    !post ||
    title !== post.title ||
    slug !== post.slug ||
    summary !== post.summary ||
    body !== post.bodyMarkdown ||
    tags.join() !== post.tags.join() ||
    (author !== '' && author !== (post.authorName ?? ''));

  const request = (): ManualPostRequest => ({
    title: title.trim(),
    slug,
    summary: summary.trim(),
    bodyMarkdown: body,
    tags,
    authorName: authorShown.trim(),
  });

  /** Validates and saves; resolves to the stored article, or `null` when something is wrong. */
  const save = async (): Promise<BlogPost | null> => {
    const found = validateArticle({ title, slug, summary, body, author: authorShown });
    setErrors(found);
    if (Object.keys(found).length) return null;
    try {
      const saved = post ? await update.mutateAsync(request()) : await create.mutateAsync(request());
      if (!post) navigate(`/platform/blog/${saved.id}`, { replace: true });
      return saved;
    } catch (e) {
      const fromServer = serverFieldErrors(e);
      setErrors(fromServer);
      if (!Object.keys(fromServer).length) toast.error(e instanceof Error ? e.message : 'Could not save');
      return null;
    }
  };
  const onSave = async () => {
    if (await save()) toast.success('Draft saved');
  };
  const onPublish = async () => {
    const saved = dirty ? await save() : post;
    if (!saved) return;
    publish.mutate(undefined, { onSuccess: () => toast.success('Published') });
  };

  const rememberCaret = (el: HTMLTextAreaElement) => {
    caret.current = { start: el.selectionStart, end: el.selectionEnd };
  };
  const pickImage = async (file: File | undefined) => {
    if (!file || !post) return;
    const problem = imageProblem(file);
    if (problem) {
      setErrors((e) => ({ ...e, image: problem }));
      return;
    }
    setErrors((e) => ({ ...e, image: undefined }));
    try {
      const img = await uploadImage.mutateAsync(file);
      // the caret is remembered on blur: the file picker and the soft keyboard take the focus away from the text
      const at = caret.current ?? { start: body.length, end: body.length };
      const before = body.slice(0, at.start);
      const lead = before && !before.endsWith('\n') ? '\n\n' : '';
      const insert = `${lead}${img.markdown}\n\n`;
      setBody(`${before}${insert}${body.slice(at.end)}`);
      caret.current = { start: at.start + insert.length, end: at.start + insert.length };
      toast.success('Image added');
    } catch (e) {
      setErrors((cur) => ({
        ...cur,
        image: e instanceof Error ? e.message : 'The image could not be uploaded.',
      }));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const busy = create.isPending || update.isPending;
  const anyError = publish.error ?? unpublish.error;
  const write = (
    <Panel title="Write">
      <div className="flex flex-col gap-3">
        <TextInput
          label="Title"
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          error={errors.title}
          autoComplete="off"
          data-testid="article-title"
        />
        <TextInput
          label="Address (slug)"
          value={slug}
          readOnly={slugLocked}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
          error={errors.slug}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          hint={
            slugLocked
              ? 'The address of a published article cannot change.'
              : `The article will be at /blog/${slug || '…'}`
          }
          data-testid="article-slug"
        />
        <TextArea
          label="Summary"
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          error={errors.summary}
          hint={`${summary.trim().length}/${SUMMARY_MAX} characters. The first 160 are the search snippet.`}
          data-testid="article-summary"
        />
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-fg">Tags (optional)</legend>
          <div className="flex flex-wrap gap-2">
            {BLOG_TAGS.map((t) => {
              const on = tags.includes(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTags((cur) => (on ? cur.filter((x) => x !== t.key) : [...cur, t.key]))}
                  className={`min-h-11 rounded-control border px-3 text-sm font-medium ${
                    on
                      ? 'border-brand bg-brand-soft text-brand-text'
                      : 'border-control bg-surface text-fg hover:bg-sunken'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        <TextInput
          label="Author"
          value={author}
          onChange={(e) => setAuthor(e.target.value)}
          error={errors.author}
          autoComplete="off"
          hint="The name shown on the article."
          data-testid="article-author"
        />
        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-fg">Text (Markdown)</span>
            <span className="flex items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                tabIndex={-1}
                aria-label="Choose an image"
                data-testid="article-image-input"
                onChange={(e) => void pickImage(e.target.files?.[0])}
              />
              <Button
                size="lg"
                disabled={!post}
                loading={uploadImage.isPending}
                onClick={() => fileInput.current?.click()}
                data-testid="article-add-image"
              >
                <ImagePlus aria-hidden="true" className="size-4" />
                Add image
              </Button>
            </span>
          </div>
          {!post && <p className="mb-1 text-xs text-subtle">Save the draft first to add images.</p>}
          {errors.image && (
            <p
              role="alert"
              className="mb-1 text-sm font-medium text-danger"
              data-testid="article-image-error"
            >
              {errors.image}
            </p>
          )}
          <TextArea
            label="Article text"
            rows={18}
            className="font-mono text-sm"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              rememberCaret(e.target);
            }}
            onBlur={(e) => rememberCaret(e.currentTarget)}
            onSelect={(e) => rememberCaret(e.currentTarget)}
            error={errors.body}
            hint="Headings, lists, quotes, code, tables, bold, italic, links and uploaded images. No HTML."
            data-testid="article-body"
          />
        </div>
      </div>
    </Panel>
  );
  const preview = (
    <Panel title="Preview">
      <div className="flex flex-col gap-4" data-testid="article-preview">
        <div className="rounded-card border border-line bg-surface p-4">
          <span className="block text-base font-semibold text-fg">{title || 'Title'}</span>
          <span className="mt-1 block text-sm text-muted">{summary || 'Summary'}</span>
          <span className="mt-2 block text-xs text-subtle">
            {authorShown || 'Author'} ·{' '}
            {post?.publishedAt ? formatDate(post.publishedAt) : 'Not published yet'}
          </span>
        </div>
        <article>
          <BlogArticleView
            title={title || 'Title'}
            author={authorShown || 'Author'}
            publishedAt={post?.publishedAt}
            readingMinutes={post?.readingMinutes}
            tags={tags}
            body={body}
            manual
          />
        </article>
      </div>
    </Panel>
  );

  return (
    <div data-testid="article-editor">
      <PageHeader
        title={post ? post.title : 'New article'}
        back={{ to: '/platform/blog', label: 'All posts' }}
        sub={
          post ? (
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={published ? 'success' : 'neutral'}>{published ? 'Published' : 'Draft'}</Badge>
              <span className="text-sm">
                Your article · {post.wordCount} words · {formatDateTime(post.updatedAt)}
              </span>
            </span>
          ) : (
            'Write an article by hand. It stays a draft until you publish it.'
          )
        }
        actions={
          <>
            <Button size="lg" loading={busy} onClick={() => void onSave()} data-testid="article-save">
              Save draft
            </Button>
            {post && !published && (
              <Button
                size="lg"
                variant="primary"
                loading={publish.isPending}
                onClick={() => void onPublish()}
                data-testid="article-publish"
              >
                {post.publishedAt ? 'Publish again' : 'Publish'}
              </Button>
            )}
            {published && (
              <>
                <Button size="lg" variant="primary" loading={busy} onClick={() => void onSave()}>
                  Save changes
                </Button>
                <a
                  href={`/blog/${post.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-11 items-center rounded-control border border-control px-3.5 text-sm font-medium text-fg hover:bg-sunken"
                >
                  Open public page
                </a>
                <Button
                  size="lg"
                  variant="danger"
                  onClick={() => setConfirmUnpublish(true)}
                  data-testid="article-unpublish"
                >
                  Unpublish
                </Button>
              </>
            )}
          </>
        }
      />
      <ErrorBox error={anyError} />
      <Tabs
        label="Article sections"
        prefix="article"
        className="lg:hidden"
        value={tab}
        onChange={(id) => setTab(id === 'preview' ? 'preview' : 'write')}
        tabs={[
          { id: 'write', label: 'Write', testId: 'article-tab-write' },
          { id: 'preview', label: 'Preview', testId: 'article-tab-preview' },
        ]}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <div className={tab === 'write' ? '' : 'hidden lg:block'}>{write}</div>
        <div className={tab === 'preview' ? '' : 'hidden lg:block'}>{preview}</div>
      </div>
      <ConfirmDialog
        open={confirmUnpublish}
        onOpenChange={setConfirmUnpublish}
        title="Unpublish this article?"
        description="It leaves the public blog, the feed and Help. It goes back to a draft that you can publish again."
        confirmLabel="Unpublish"
        pending={unpublish.isPending}
        onConfirm={() =>
          unpublish.mutate(undefined, {
            onSuccess: () => {
              setConfirmUnpublish(false);
              toast.success('Unpublished');
            },
          })
        }
      />
    </div>
  );
}
