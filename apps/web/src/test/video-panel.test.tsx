import { defaultSchedule, type VideoPost, type VideoStatus } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialPanel } from '../components/blog/SocialPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ext } from '../extension/index.ts';
import { PlatformVideo } from '../pages/platform/PlatformVideo.tsx';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

const ID = '11111111-1111-4111-8111-111111111111';
const cue = (id: string, text: string) => ({ id, text, scene: { type: 'quote' as const, text } });
const video = (over: Partial<VideoPost> = {}): VideoPost => ({
  id: ID,
  kind: 'article',
  format: 'long',
  ref: 'my-article',
  parentId: null,
  status: 'in_review',
  title: 'How agents work',
  revision: 1,
  script: {
    version: 1,
    kind: 'article',
    format: 'long',
    title: 'How agents work',
    cues: [cue('a', 'First line of narration.'), cue('b', 'Second line.')],
    chapters: [],
    meta: {
      title: 'How agents work',
      description: 'A description.',
      tags: ['ai'],
      hashtags: ['#AI', '#Agents', '#HQ'],
    },
  } as VideoPost['script'],
  meta: {
    title: 'How agents work',
    description: 'A description.',
    tags: ['ai'],
    hashtags: ['#AI', '#Agents', '#HQ'],
  },
  rejectionReason: null,
  origin: 'Blog writer',
  reviewSince: '2026-10-28T10:00:00.000Z',
  approvedAt: null,
  approvedRenderId: null,
  slotAt: null,
  publishMode: null,
  destinations: [],
  captions: null,
  phase: 'in_review',
  shares: [],
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:00:00.000Z',
  render: {
    id: '22222222-2222-4222-8222-222222222222',
    revision: 1,
    status: 'rendered',
    attempts: 1,
    error: null,
    durationSeconds: 125,
    bytes: 12_000_000,
    createdAt: '2026-10-28T10:00:00.000Z',
    finishedAt: '2026-10-28T10:05:00.000Z',
    files: ['video', 'captionsVtt', 'thumb'],
    library: false,
    purged: false,
    notBefore: null,
    preview: true,
  },
  rendersUsed: 1,
  library: false,
  shortId: null,
  upload: null,
  crossPost: null,
  ...over,
});
const status = (over: Partial<VideoStatus> = {}): VideoStatus => ({
  settings: {
    enabled: true,
    articleVideos: true,
    releaseVideos: true,
    tutorials: true,
    shorts: true,
    perWeek: 3,
    shortsPerWeek: 3,
    schedule: defaultSchedule(3, 3),
    privacy: 'public',
    playlists: {},
    categoryId: '28',
  },
  channel: { connected: true, status: 'ok', accountName: 'Guildwise HQ' },
  active: true,
  worker: { running: true, lastSeen: '2026-10-28T10:00:00.000Z' },
  capacity: {
    long: { used: 1, limit: 3, backlog: 1, backlogLimit: 6 },
    short: { used: 0, limit: 3, backlog: 0, backlogLimit: 6 },
  },
  nextSlot: { long: '2026-10-29T08:00:00.000Z', short: '2026-10-29T14:00:00.000Z' },
  storage: { usedBytes: 0, maxBytes: 5 * 1024 ** 3 },
  offSchedule: 0,
  pending: 1,
  lockedPrivate: 0,
  auditFormUrl: 'https://support.google.com/youtube/contact/yt_api_form',
  ...over,
});

let calls: Array<{ url: string; method: string; body?: string }> = [];
let posts: VideoPost[] = [];
let st: VideoStatus = status();

beforeEach(() => {
  calls = [];
  posts = [video()];
  st = status();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
      if (url.startsWith('/api/platform/video/library'))
        return json({
          videos: [
            { slug: 'agents', title: 'Your agents', durationSeconds: 80, chapters: 4, imported: false },
          ],
        });
      if (url === '/api/platform/video/library/import') return json({ created: 1, skipped: [], posts: [] });
      if (url.startsWith('/api/platform/video/topics'))
        return json({
          topics: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              title: 'Run a night shift of agents',
              brief: '',
              origin: 'platform',
              status: 'queued',
              reason: null,
              attempts: 0,
              postId: null,
              queuedAt: '2026-10-28T10:00:00.000Z',
              updatedAt: '2026-10-28T10:00:00.000Z',
            },
          ],
          queued: 1,
        });
      if (url.startsWith('/api/platform/video/needing'))
        return json({
          articles: [
            { slug: 'my-article', title: 'How agents work', publishedAt: '2026-10-27T10:00:00.000Z' },
          ],
          releases: [],
        });
      if (url.endsWith('/approve')) return json(video({ status: 'approved' }));
      if (url.startsWith('/api/platform/video')) return json({ posts, status: st });
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete ext.VideoDrafter;
});

describe('Videos tab', () => {
  it('shows the player with a caption track, the script and the metadata, and schedules a video (Schedule needs no render)', async () => {
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    const player = (await screen.findByTestId('video-player')) as HTMLVideoElement;
    expect(player.getAttribute('src')).toBe(`/api/platform/video/posts/${ID}/files/video.mp4?revision=1`);
    expect(player.querySelector('track')?.getAttribute('src')).toBe(
      `/api/platform/video/posts/${ID}/files/captions.vtt?revision=1`,
    );
    expect(screen.getByTestId('video-download').getAttribute('href')).toContain('video.mp4');
    const meta = screen.getByTestId('video-meta');
    expect((within(meta).getByLabelText('YouTube title') as HTMLInputElement).value).toBe('How agents work');
    expect(screen.getByTestId('video-script').textContent).toContain('Script (2 cues)');
    const approve = screen.getByTestId('video-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    await user.click(approve);
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/platform/video/posts/${ID}/approve`)).toBe(true),
    );
  });

  it('Schedule needs no render: with only a queued render it is enabled, and says when the worker is down', async () => {
    posts = [
      video({
        render: { ...(video().render as NonNullable<VideoPost['render']>), status: 'queued', files: [] },
      }),
    ];
    st = status({ worker: { running: false, lastSeen: null } });
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    expect((await screen.findByTestId('video-worker-down')).textContent).toContain(
      'Video worker not running',
    );
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    expect((screen.getByTestId('video-approve') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('video-player')).toBeNull();
    expect(screen.getByTestId('video-render').textContent).toContain('Waiting to be rendered');
  });

  it('an edit of the script asks for a render again, tags only save in place', async () => {
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    const save = screen.getByTestId('video-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const meta = screen.getByTestId('video-meta');
    const tags = within(meta).getByLabelText('Tags (comma separated)');
    await user.clear(tags);
    await user.type(tags, 'ai, agents');
    expect(save.textContent).toBe('Save changes');
    await user.type(within(meta).getByLabelText('YouTube title'), '!');
    expect(save.textContent).toBe('Save and render again');
    // scheduling waits for the save
    expect((screen.getByTestId('video-approve') as HTMLButtonElement).disabled).toBe(true);
    await user.click(save);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PATCH' && c.url.includes(`/posts/${ID}`))).toBe(true),
    );
    const body = JSON.parse(
      calls.find((c) => c.method === 'PATCH' && c.url.includes(`/posts/${ID}`))?.body ?? '{}',
    );
    expect(body.meta).toMatchObject({ title: 'How agents work!', tags: ['ai', 'agents'] });
  });

  it('warns when YouTube kept an upload private, with the audit form', async () => {
    posts = [
      video({
        status: 'approved',
        upload: {
          status: 'locked_private',
          attempts: 1,
          videoId: 'abc',
          url: 'https://www.youtube.com/watch?v=abc',
          error: null,
          nextAttemptAt: null,
          publishAt: null,
          privacy: 'public',
          warnings: [],
        },
      }),
    ];
    st = status({ lockedPrivate: 1 });
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    expect((await screen.findByTestId('video-locked')).textContent).toContain(
      'kept 1 uploaded video private',
    );
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    const up = screen.getByTestId('video-upload');
    expect(up.textContent).toContain('Kept private by YouTube');
    expect(up.querySelector('a[href="https://support.google.com/youtube/contact/yt_api_form"]')).toBeTruthy();
  });

  it('imports the help videos with the Library button, and lists the topics', async () => {
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    const btn = await screen.findByTestId('video-library-import');
    await waitFor(() => expect(btn.textContent).toContain('(1)'));
    await user.click(btn);
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/platform/video/library/import' && c.method === 'POST')).toBe(
        true,
      ),
    );
    expect((await screen.findByTestId('video-topics')).textContent).toContain('Run a night shift of agents');
  });

  it('shows the extension VideoDrafter slot for an article without a video and for a queued topic', async () => {
    ext.VideoDrafter = ({ kind, ref }) => (
      <button type="button" data-testid={`drafter-${kind}`}>{`draft ${ref}`}</button>
    );
    wrap(<PlatformVideo />);
    expect((await screen.findByTestId('drafter-article')).textContent).toBe('draft my-article');
    expect((await screen.findByTestId('drafter-tutorial')).textContent).toContain('draft 3333');
  });

  it('is quiet about videos when there is no channel', async () => {
    posts = [];
    st = status({ active: false, channel: { connected: false, status: 'disconnected', accountName: null } });
    wrap(<PlatformVideo />);
    expect((await screen.findByTestId('video-no-channel')).textContent).toContain(
      'nothing is drafted by the writer',
    );
    expect(screen.getByText('Not active')).toBeTruthy();
  });
});

describe('Social sharing: YouTube row', () => {
  it('connects the channel with a pasted refresh token only', async () => {
    wrap(
      <SocialPanel
        failedShares={0}
        needReconnect={[]}
        channels={[
          {
            network: 'youtube',
            connected: false,
            accountName: null,
            status: 'disconnected',
            expiresAt: null,
            connectedAt: null,
          },
        ]}
      />,
    );
    const user = userEvent.setup();
    const row = screen.getByTestId('social-youtube');
    expect(row.textContent).toContain('YouTube channel');
    await user.type(within(row).getByLabelText('Refresh token'), '1//0g-refresh-token');
    await user.click(within(row).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/platform/social/channels/youtube')).toBe(
        true,
      ),
    );
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')?.body ?? '{}')).toEqual({
      refreshToken: '1//0g-refresh-token',
    });
  });
});
