import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlogBody } from '../components/blog/BlogBody.tsx';
import { HelpBlog } from '../components/blog/HelpBlog.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { PlatformApiKeys } from '../pages/platform/PlatformApiKeys.tsx';
import { PlatformBlog } from '../pages/platform/PlatformBlog.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const wrap = (ui: React.ReactNode, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const post = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'first-post',
  title: 'A first article about agents',
  summary: 'x'.repeat(90),
  bodyMarkdown: 'b'.repeat(4000),
  coverImage: { defaultKey: 'ai-agents', alt: 'An abstract picture' },
  tags: ['ai-agents'],
  sources: [],
  seo: {},
  social: {},
  aiDisclosure: {},
  status: 'in_review',
  rejectionReason: null,
  publishedAt: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  updatedAt: '2026-10-10T08:00:00.000Z',
  readingMinutes: 4,
  wordCount: 800,
  warnings: [],
  origin: 'Blog writer',
  autoPublishAt: null,
  shares: [],
  ...over,
});

const writerRun = (over: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'scheduled',
  status: 'ok',
  slot: 's:2026-10-10T06',
  topic: 'How to give an AI agent a narrow job',
  model: 'claude-haiku-4-5',
  startedAt: '2026-10-10T06:00:00.000Z',
  finishedAt: '2026-10-10T06:01:30.000Z',
  inputTokens: 20000,
  outputTokens: 5000,
  searches: 3,
  costUsd: 0.075,
  postId: '11111111-1111-4111-8111-111111111111',
  slug: 'first-post',
  error: null,
  ...over,
});
let writer: Record<string, any> = {};
const freshWriter = () => ({
  enabled: false,
  postsPerDay: 1,
  queuedPerDay: 1,
  topics: ['Topic one about agents', 'Topic two about automation'],
  model: 'claude-haiku-4-5',
  models: ['claude-haiku-4-5', 'claude-haiku-5-5'],
  prices: {
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
    'claude-haiku-5-5': null,
  },
  priceOverrides: {},
  searchUsd: 0.01,
  capUsd: 10,
  spentMonthUsd: 0.075,
  runsMonth: 1,
  postsMonth: 1,
  month: '2026-10',
  estimateRunUsd: 0.11,
  keyConfigured: true,
  blogEnabled: true,
  blockedReason: null,
  nextSlot: null,
  lastRun: writerRun(),
  runs: [writerRun()],
});

let settings = { enabled: true, autoPublishFrom: null, holdHours: 3, digestEnabled: true, reviewAll: true };
let calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  calls = [];
  writer = freshWriter();
  settings = { enabled: true, autoPublishFrom: null, holdHours: 3, digestEnabled: true, reviewAll: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.startsWith('/api/platform/blog/writer/run'))
        return json({ run: writerRun({ kind: 'manual' }), post: post() });
      if (url.startsWith('/api/platform/blog/writer')) {
        if (init?.method === 'PATCH') {
          const b = JSON.parse(String(init.body ?? '{}'));
          if (b.price) writer.prices = { ...writer.prices, [b.price.model]: b.price.value };
          else writer = { ...writer, ...b };
        }
        return json(writer);
      }
      if (url.startsWith('/api/platform/blog/summary'))
        return json({ pending: 1, enabled: settings.enabled });
      if (url.startsWith('/api/platform/blog/settings')) {
        settings = { ...settings, ...JSON.parse(String(init?.body ?? '{}')) };
        return json(settings);
      }
      if (url.startsWith('/api/platform/blog/digests')) return json({ digests: [] });
      if (url.startsWith('/api/platform/blog'))
        return json({
          posts: [
            post(),
            post({
              id: '22222222-2222-4222-8222-222222222222',
              slug: 'warned',
              title: 'A warned article about links',
              warnings: ['link shortener: bit.ly'],
            }),
          ],
          pending: 2,
          settings,
          social: {
            channels: [
              {
                network: 'facebook',
                connected: false,
                accountName: null,
                status: 'disconnected',
                expiresAt: null,
                connectedAt: null,
              },
              {
                network: 'linkedin',
                connected: true,
                accountName: 'Guildwise',
                status: 'needs_reconnect',
                expiresAt: null,
                connectedAt: '2026-10-01T00:00:00.000Z',
              },
              ...(['x', 'bluesky'] as const).map((network) => ({
                network,
                connected: false,
                accountName: null,
                status: 'disconnected',
                expiresAt: null,
                connectedAt: null,
              })),
            ],
            failedShares: 0,
            channelsNeedingReconnect: ['linkedin'],
          },
        });
      if (url.startsWith('/api/blog/posts/first-post'))
        return json({
          slug: 'first-post',
          title: 'A first article about agents',
          summary: 'x',
          coverImage: { defaultKey: 'ai-agents', alt: 'alt text' },
          tags: ['ai-agents'],
          publishedAt: '2026-10-10T08:00:00.000Z',
          updatedAt: '2026-10-10T08:00:00.000Z',
          readingMinutes: 4,
          url: 'http://x/blog/first-post',
          bodyMarkdown: '## Heading\n\nBody <script>alert(1)</script>',
          sources: [{ title: 'Docs', url: 'https://example.com' }],
          author: 'The Guildwise HQ team',
        });
      if (url.startsWith('/api/blog/posts'))
        return json({
          posts: [
            {
              slug: 'first-post',
              title: 'A first article about agents',
              summary: 'Summary of it',
              coverImage: { defaultKey: 'ai-agents', alt: 'alt text' },
              tags: ['ai-agents'],
              publishedAt: '2026-10-10T08:00:00.000Z',
              updatedAt: '2026-10-10T08:00:00.000Z',
              readingMinutes: 4,
              url: 'http://x/blog/first-post',
            },
          ],
          total: 1,
        });
      if (url.startsWith('/api/platform/api-keys/audit')) return json({ requests: [] });
      if (url.startsWith('/api/platform/api-keys') && init?.method === 'POST')
        return json(
          {
            id: '33333333-3333-4333-8333-333333333333',
            name: 'Writer',
            prefix: 'gwk_abcd',
            scopes: ['blog:write'],
            createdAt: '2026-10-10T08:00:00.000Z',
            expiresAt: null,
            revokedAt: null,
            lastUsedAt: null,
            lastIp: null,
            ipAllowList: [],
            requests24h: 0,
            posts24h: 0,
            secret: 'gwk_SECRETSECRETSECRETSECRETSECRETSECRET',
          },
          201,
        );
      if (url.startsWith('/api/platform/api-keys')) return json({ keys: [] });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('blog body', () => {
  it('shows raw HTML as text and never makes a script link', () => {
    render(
      <BlogBody
        source={
          '## Title\n\nHello <script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://example.com)'
        }
      />,
    );
    const body = screen.getByTestId('blog-body');
    expect(body.querySelector('script')).toBeNull();
    expect(body.textContent).toContain('<script>alert(1)</script>');
    const hrefs = Array.from(body.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com']);
    expect(body.querySelector('a')?.getAttribute('rel')).toContain('nofollow');
  });
});

describe('Help > Blog', () => {
  it('lists published articles and opens one with its sources and a public link', async () => {
    const user = userEvent.setup();
    wrap(<HelpBlog />, '/help/blog');
    expect(await screen.findByTestId('blog-post-first-post')).toHaveTextContent(
      'A first article about agents',
    );
    wrap(<HelpBlog slug="first-post" />, '/help/blog/first-post');
    const article = await screen.findByTestId('help-blog-post');
    expect(within(article).getByText('Docs')).toBeInTheDocument();
    expect(within(article).getByTestId('blog-public-link')).toHaveAttribute('href', '/blog/first-post');
    expect(article.querySelector('script')).toBeNull();
    void user;
  });
});

describe('platform blog', () => {
  it('shows the queue with warnings and the reconnect alert, and the kill switch asks first', async () => {
    const user = userEvent.setup();
    wrap(<PlatformBlog />, '/platform/blog');
    const table = await screen.findByTestId('blog-posts');
    expect(within(table).getByTestId('blog-row-warned')).toHaveTextContent('1 warning');
    expect(screen.getByTestId('social-alert')).toHaveTextContent('LinkedIn');
    expect(screen.getByTestId('review-mode')).toHaveTextContent('you review every post');
    await user.click(screen.getByTestId('blog-kill'));
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Switch off' }));
    await vi.waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.body?.includes('"enabled":false'))).toBe(true),
    );
  });

  it('shows a new API key once, in a dialog that cannot be dismissed by accident', async () => {
    const user = userEvent.setup();
    wrap(<PlatformApiKeys />, '/platform/api-keys');
    await user.type(await screen.findByTestId('key-name'), 'Writer');
    await user.click(screen.getByTestId('key-create'));
    expect(await screen.findByTestId('key-secret')).toHaveTextContent('gwk_SECRETSECRET');
    await user.click(screen.getByTestId('key-done'));
    expect(screen.queryByTestId('key-secret')).toBeNull();
  });
});

describe('social panel networks', () => {
  it('has cards for X and Bluesky with their own credential fields', async () => {
    wrap(<PlatformBlog />, '/platform/blog');
    const x = await screen.findByTestId('social-x');
    expect(within(x).getByLabelText('API key')).toBeInTheDocument();
    expect(within(x).getByLabelText('Access token secret')).toBeInTheDocument();
    const b = screen.getByTestId('social-bluesky');
    expect(within(b).getByLabelText('Handle')).toBeInTheDocument();
    expect(within(b).getByLabelText('App password')).toBeInTheDocument();
    expect(within(b).queryByLabelText('Access token')).toBeNull();
  });
});
