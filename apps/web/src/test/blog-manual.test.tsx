import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlogBody } from '../components/blog/BlogBody.tsx';
import { HelpBlog } from '../components/blog/HelpBlog.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { PlatformBlog } from '../pages/platform/PlatformBlog.tsx';
import {
  ArticleEditor,
  imageProblem,
  PlatformBlogArticle,
  validateArticle,
} from '../pages/platform/PlatformBlogArticle.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ID = '0b6f0d7e-1c2a-4d3b-8e4f-5a6b7c8d9e0f';
const IMG = `/blog/media/${ID}.png`;

const stored = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'my-own-article',
  title: 'My own article',
  summary: 'A summary that is long enough to pass.',
  bodyMarkdown: 'Hello',
  coverImage: { defaultKey: 'ai-agents', alt: 'My own article' },
  tags: [],
  sources: [],
  seo: {},
  social: {},
  aiDisclosure: {},
  status: 'draft',
  rejectionReason: null,
  publishedAt: null,
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
  readingMinutes: 1,
  wordCount: 1,
  warnings: [],
  origin: 'Ann',
  originKind: 'manual',
  authorName: 'Ann',
  autoPublishAt: null,
  shares: [],
  ...over,
});

let calls: Array<{ url: string; method: string; body?: string }> = [];
let respond: (url: string, init?: RequestInit) => Response | undefined = () => undefined;

beforeEach(() => {
  calls = [];
  respond = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        ...(init?.body && typeof init.body === 'string' ? { body: init.body } : {}),
      });
      const custom = respond(url, init);
      if (custom) return custom;
      if (url.startsWith('/api/auth/me'))
        return json({ user: { id: 'u1', displayName: 'Ann Author' }, account: { kind: 'super_admin' } });
      if (url.endsWith('/publish'))
        return json(stored({ status: 'published', publishedAt: '2026-11-02T08:00:00.000Z' }));
      if (url.endsWith('/unpublish'))
        return json(stored({ status: 'draft', publishedAt: '2026-11-02T08:00:00.000Z' }));
      if (url.startsWith('/api/platform/blog/manual'))
        return json(stored(), init?.method === 'POST' ? 201 : 200);
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode, path = '/platform/blog/new') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/platform/blog/new" element={ui} />
            <Route path="/platform/blog/:id" element={<div data-testid="opened-post" />} />
            <Route path="*" element={ui} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const fill = async (u: ReturnType<typeof userEvent.setup>) => {
  await u.type(screen.getByTestId('article-title'), 'My Own Article!');
  await u.type(screen.getByTestId('article-summary'), 'A summary that is long enough to pass.');
  await u.type(screen.getByTestId('article-body'), 'Hello **world**');
};

describe('authoring view', () => {
  it('makes the slug from the title until the slug is edited by hand', async () => {
    const u = userEvent.setup();
    wrap(<PlatformBlogArticle />);
    const slug = screen.getByTestId('article-slug') as HTMLInputElement;
    await u.type(screen.getByTestId('article-title'), 'Hello There World');
    expect(slug.value).toBe('hello-there-world');
    await u.clear(slug);
    await u.type(slug, 'my-address');
    await u.type(screen.getByTestId('article-title'), ' again');
    expect(slug.value).toBe('my-address');
  });

  it('defaults the author to the signed-in name', async () => {
    wrap(<PlatformBlogArticle />);
    await waitFor(() =>
      expect((screen.getByTestId('article-author') as HTMLInputElement).value).toBe('Ann Author'),
    );
  });

  it('shows what is missing under each field and sends nothing', async () => {
    const u = userEvent.setup();
    wrap(<PlatformBlogArticle />);
    await u.click(screen.getByTestId('article-save'));
    expect(await screen.findByText(/Give the article a title/)).toBeTruthy();
    expect(screen.getByText(/Write a summary of at least/)).toBeTruthy();
    expect(screen.getByText('Write the article text.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/manual'))).toBe(false);
    expect(
      validateArticle({
        title: 'ok title',
        slug: 'ok-title',
        summary: 'x'.repeat(30),
        body: 'b',
        author: 'A',
      }),
    ).toEqual({});
    expect(
      validateArticle({
        title: 'ok title',
        slug: 'Bad Slug',
        summary: 'x'.repeat(30),
        body: 'b',
        author: 'A',
      }).slug,
    ).toBeTruthy();
  });

  it('saves a draft: creates it and opens the stored article', async () => {
    const u = userEvent.setup();
    wrap(<PlatformBlogArticle />);
    await fill(u);
    await u.click(screen.getByTestId('article-save'));
    await screen.findByTestId('opened-post');
    const c = calls.find((x) => x.method === 'POST' && x.url === '/api/platform/blog/manual');
    expect(JSON.parse(c?.body ?? '{}')).toMatchObject({
      title: 'My Own Article!',
      slug: 'my-own-article',
      bodyMarkdown: 'Hello **world**',
      tags: [],
    });
  });

  it('shows a taken slug under the slug field', async () => {
    const u = userEvent.setup();
    respond = (url, init) =>
      url === '/api/platform/blog/manual' && init?.method === 'POST'
        ? json(
            {
              error: {
                code: 'slug_taken',
                message: 'taken',
                details: [
                  {
                    field: 'slug',
                    message: 'That slug is already used by another post. Choose a different one.',
                  },
                ],
              },
            },
            409,
          )
        : undefined;
    wrap(<PlatformBlogArticle />);
    await fill(u);
    await u.click(screen.getByTestId('article-save'));
    expect(await screen.findByText(/already used by another post/)).toBeTruthy();
    expect(screen.queryByTestId('opened-post')).toBeNull();
  });

  it('previews the Markdown, the author and an uploaded image', async () => {
    const u = userEvent.setup();
    wrap(
      <ArticleEditor post={stored({ bodyMarkdown: `Intro **bold**\n\n![](${IMG})` }) as never} />,
      '/editor',
    );
    const pv = screen.getByTestId('article-preview');
    expect(pv.textContent).toContain('My own article');
    expect(pv.textContent).toContain('Ann');
    expect(pv.querySelector('strong')?.textContent).toBe('bold');
    expect(pv.querySelector(`img[src="${IMG}"]`)).toBeTruthy();
    expect(pv.textContent).not.toContain('written by an AI agent');
    await u.click(screen.getByTestId('article-tab-write'));
  });

  it('adds an uploaded image at the remembered caret', async () => {
    respond = (url) =>
      url.includes('/images')
        ? json({ id: ID, url: IMG, markdown: `![](${IMG})`, contentType: 'image/png', size: 5 }, 201)
        : undefined;
    wrap(<ArticleEditor post={stored({ bodyMarkdown: 'AB' }) as never} />, '/editor');
    const body = screen.getByTestId('article-body') as HTMLTextAreaElement;
    body.setSelectionRange(1, 1);
    fireEvent.blur(body);
    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('article-image-input'), { target: { files: [file] } });
    await waitFor(() => expect(body.value).toBe(`A\n\n![](${IMG})\n\nB`));
    expect(
      calls.some((c) =>
        c.url.startsWith('/api/platform/blog/posts/11111111-1111-4111-8111-111111111111/images'),
      ),
    ).toBe(true);
  });

  it('refuses a wrong type and a big file before sending, and needs a saved draft first', async () => {
    expect(imageProblem({ type: 'application/pdf', size: 10 })).toMatch(/PNG, JPEG, WebP and GIF/);
    expect(imageProblem({ type: 'image/png', size: 6 * 1024 * 1024 })).toMatch(/5 MB/);
    expect(imageProblem({ type: 'image/gif', size: 100 })).toBeNull();
    wrap(<ArticleEditor post={stored() as never} />, '/editor');
    fireEvent.change(screen.getByTestId('article-image-input'), {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    });
    expect((await screen.findByTestId('article-image-error')).textContent).toMatch(/Only PNG/);
    expect(calls.some((c) => c.url.includes('/images'))).toBe(false);
  });

  it('disables Add image until the draft exists', () => {
    wrap(<PlatformBlogArticle />);
    expect((screen.getByTestId('article-add-image') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Save the draft first to add images.')).toBeTruthy();
  });

  it('publishes a draft and unpublishes a published article after a confirmation', async () => {
    const u = userEvent.setup();
    wrap(<ArticleEditor post={stored() as never} />, '/editor');
    await u.click(screen.getByTestId('article-publish'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/publish'))).toBe(true),
    );
  });

  it('unpublish asks first', async () => {
    const u = userEvent.setup();
    wrap(
      <ArticleEditor
        post={stored({ status: 'published', publishedAt: '2026-11-02T08:00:00.000Z' }) as never}
      />,
      '/editor',
    );
    expect((screen.getByTestId('article-slug') as HTMLInputElement).readOnly).toBe(true);
    await u.click(screen.getByTestId('article-unpublish'));
    expect(calls.some((c) => c.url.endsWith('/unpublish'))).toBe(false);
    await u.click(await screen.findByRole('button', { name: 'Unpublish' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/unpublish'))).toBe(true),
    );
  });
});

describe('admin list and reading', () => {
  it('shows the origin of each post and filters by it', async () => {
    const u = userEvent.setup();
    respond = (url) =>
      url.startsWith('/api/platform/blog/digests')
        ? json({ digests: [] })
        : url.startsWith('/api/platform/blog/summary')
          ? json({ pending: 0, enabled: true })
          : url.startsWith('/api/platform/blog?') || url === '/api/platform/blog'
            ? json({
                posts: [
                  stored(),
                  stored({
                    id: '22222222-2222-4222-8222-222222222222',
                    slug: 'writer-post',
                    title: 'Writer one',
                    originKind: 'writer',
                    authorName: null,
                    origin: 'Blog writer',
                  }),
                ],
                pending: 0,
                settings: {
                  enabled: true,
                  autoPublishFrom: null,
                  holdHours: 3,
                  digestEnabled: true,
                  reviewAll: true,
                },
                social: { channels: [], failedShares: 0, channelsNeedingReconnect: [] },
              })
            : undefined;
    wrap(<PlatformBlog />, '/platform/blog');
    expect((await screen.findByTestId('blog-origin-my-own-article')).textContent).toBe('Manual');
    expect(screen.getByTestId('blog-origin-writer-post').textContent).toBe('Writer');
    expect(screen.getByTestId('blog-new-article').getAttribute('href')).toBe('/platform/blog/new');
    await u.click(screen.getByTestId('blog-origin-manual'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('origin=manual'))).toBe(true));
  });

  it('BlogBody renders an uploaded image node', () => {
    const { container } = render(<BlogBody source={`Text\n\n![A cat](${IMG})`} />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(IMG);
    expect(img?.getAttribute('alt')).toBe('A cat');
  });

  it('Help > Blog shows the author and no AI notice for a hand-written article', async () => {
    const full = (over: Record<string, unknown>) => ({
      slug: 's',
      title: 'T',
      summary: 'x'.repeat(30),
      coverImage: { defaultKey: 'ai-agents', alt: 'alt text' },
      tags: [],
      publishedAt: '2026-11-02T08:00:00.000Z',
      updatedAt: '2026-11-02T08:00:00.000Z',
      readingMinutes: 1,
      url: 'http://x/blog/s',
      bodyMarkdown: 'Body',
      sources: [],
      author: 'The Guildwise HQ team',
      ...over,
    });
    respond = (url) =>
      url.startsWith('/api/blog/posts/s')
        ? json(full({ origin: 'manual', author: 'Ann Author' }))
        : undefined;
    const a = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <HelpBlog slug="s" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const post = await screen.findByTestId('help-blog-post');
    expect(post.textContent).toContain('Ann Author');
    expect(post.textContent).not.toContain('written by an AI agent');
    a.unmount();
    respond = (url) => (url.startsWith('/api/blog/posts/s') ? json(full({})) : undefined);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <HelpBlog slug="s" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId('help-blog-post')).textContent).toContain('written by an AI agent');
  });
});
