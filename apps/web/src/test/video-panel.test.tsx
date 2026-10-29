import { defaultSchedule, localDate, type VideoPost, type VideoStatus } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SocialPanel } from '../components/blog/SocialPanel.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ext } from '../extension/index.ts';
import { weeklyCapText } from '../lib/video-schedule.ts';
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
  destinationOptions: null,
  slippedAt: null,
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
    tiktokAudited: false,
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
let channels: Array<{ network: string; connected: boolean; status: string }> = [];
let tiktokReply: () => Response = () => json({ error: { code: 'not_found', message: 'no' } }, 404);
const SLOTS = [
  '2026-10-29T08:00:00.000Z',
  '2026-10-30T08:00:00.000Z',
  '2026-11-02T08:00:00.000Z',
  '2026-11-04T08:00:00.000Z',
];
let held = new Set<string>();

beforeEach(() => {
  calls = [];
  posts = [video()];
  st = status();
  channels = [
    { network: 'youtube', connected: true, status: 'ok' },
    { network: 'facebook', connected: true, status: 'ok' },
  ];
  tiktokReply = () => json({ error: { code: 'not_found', message: 'no' } }, 404);
  held = new Set();
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
      if (url === '/api/platform/social/channels') return json({ channels });
      if (url === '/api/platform/social/tiktok/creator-info') return tiktokReply();
      if (url.startsWith('/api/platform/video/slots'))
        return json({
          timezone: 'Africa/Johannesburg',
          slots: SLOTS.map((at) => ({ at, postId: held.has(at) ? ID : null, free: !held.has(at) })),
        });
      if (url.endsWith('/schedule'))
        return json(video({ status: 'approved', slotAt: SLOTS[0] as string, phase: 'scheduled' }));
      if (url === '/api/platform/video/reflow') return json({ moved: 2 });
      if (url === '/api/platform/video/settings')
        return json(
          init?.method === 'PATCH' ? { ...st.settings, ...JSON.parse(String(init.body)) } : st.settings,
        );
      if (/\/(move|unschedule|retry-upload|retry-render|shares\/[a-z]+\/retry)$/.test(url))
        return json(video({ status: 'approved', slotAt: SLOTS[1] as string, phase: 'scheduled' }));
      if (url.endsWith('/swap')) return json({ a: video(), b: video() });
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
    expect(approve.textContent).toContain('Schedule: ');
    await user.click(approve);
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/platform/video/posts/${ID}/schedule`)).toBe(true),
    );
    const sent = JSON.parse(
      calls.find((c) => c.url === `/api/platform/video/posts/${ID}/schedule`)?.body ?? '{}',
    );
    expect(sent.mode).toBe('slot');
    expect(sent.slotAt).toBeUndefined(); // the next free slot
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

// ---- script-first review and the schedule

const shortVideo = (over: Partial<VideoPost> = {}) =>
  video({
    id: '44444444-4444-4444-8444-444444444444',
    format: 'short',
    ref: 'my-short',
    title: 'Short one',
    ...over,
  });
const withShort = (destinations: Array<'youtube' | 'x' | 'bluesky' | 'tiktok' | 'facebook'>) => {
  const sch = defaultSchedule(3, 3);
  sch.short.destinations = destinations;
  st = status({ settings: { ...st.settings, schedule: sch } });
  posts = [shortVideo()];
};
const openShort = async (user: ReturnType<typeof userEvent.setup>) => {
  wrap(<PlatformVideo />);
  await user.click(await screen.findByTestId('video-open-my-short-short'));
};
const scheduleBody = () =>
  JSON.parse(calls.find((c) => c.url.endsWith('/schedule') && c.method === 'POST')?.body ?? '{}');
const CREATOR = {
  nickname: 'Guildwise',
  username: 'guildwisehq',
  avatarUrl: null,
  privacyOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
  commentDisabled: false,
  duetDisabled: true,
  stitchDisabled: false,
  maxDurationSeconds: 600,
  audited: true,
};

describe('script-first review', () => {
  it('shows the script cue by cue with scene type and clip names, the chapters and the rendered description, and no player without a render', async () => {
    const base = video().script as NonNullable<VideoPost['script']>;
    const script = {
      ...base,
      cues: [
        { id: 'a', text: 'Intro line.', scene: { type: 'title' as const, heading: 'Hello' } },
        { id: 'b', text: 'Watch this.', scene: { type: 'clip' as const, slug: 'agents', chapter: 2 } },
      ],
      chapters: [{ title: 'Start', fromCue: 0 }],
    } as VideoPost['script'];
    posts = [video({ render: null, script })];
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    const sc = screen.getByTestId('video-script');
    expect(within(sc).getByLabelText('1. scene: title')).toBeTruthy();
    expect(within(sc).getByLabelText('2. scene: clip agents, chapter 2')).toBeTruthy();
    expect(within(sc).getByTestId('video-chapter').textContent).toContain('Start');
    expect(screen.queryByTestId('video-player')).toBeNull();
    expect(screen.getByTestId('video-description').textContent).toContain('Narrated with a synthetic voice.');
    const preview = screen.getByTestId('video-preview');
    expect(preview.textContent).toBe('Preview render (uses 2 of 3)');
  });
});

describe('Schedule: the slot menu', () => {
  it('lists the free slots from the next one, leaves out held slots, and schedules the picked one', async () => {
    held = new Set([SLOTS[2] as string]);
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    const menu = (await screen.findByLabelText('Another slot')) as HTMLSelectElement;
    await waitFor(() => expect(menu.options.length).toBe(3)); // next + two free ones; the held slot is gone
    expect(menu.options[0]?.textContent).toContain('Next free slot');
    await user.selectOptions(menu, SLOTS[3] as string);
    await user.click(screen.getByTestId('video-approve'));
    await waitFor(() => expect(scheduleBody().slotAt).toBe(SLOTS[3]));
  });

  it('offers Publish now for Shorts and public long videos, not for a private long one', async () => {
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-open-my-article-long'));
    expect(screen.getByTestId('video-publish-now')).toBeTruthy(); // the setting is public
    await user.selectOptions(screen.getByLabelText('Privacy'), 'private');
    expect(screen.queryByTestId('video-publish-now')).toBeNull();
    // a Short can always go now
    await user.click(screen.getByTestId('video-open-my-article-long')); // close
    posts = [shortVideo()];
  });

  it('a Short goes now with mode "now" and no slot', async () => {
    posts = [shortVideo()];
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-open-my-short-short'));
    await user.click(await screen.findByTestId('video-publish-now'));
    await waitFor(() => expect(scheduleBody()).toMatchObject({ mode: 'now' }));
    expect(scheduleBody().slotAt).toBeUndefined();
  });
});

describe('Schedule settings', () => {
  it('ticking a day saves the days in week order and the derived line follows the ticked days', async () => {
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-tab-settings'));
    const long = await screen.findByTestId('schedule-long');
    expect(screen.getByTestId('schedule-cap').textContent).toBe(
      'The writer drafts 3 long and 3 Short scripts a week.',
    );
    await user.click(within(long).getByTestId('day-long-tue'));
    const body = JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}');
    expect(body.schedule.long.days).toEqual(['mon', 'tue', 'wed', 'fri']);
    expect((screen.getByTestId('schedule-timezone') as HTMLSelectElement).value).toBe('Africa/Johannesburg');
  });

  it('derives the cap text from the days', () => {
    const sch = defaultSchedule(4, 1);
    expect(weeklyCapText(sch)).toBe('The writer drafts 4 long and 1 Short scripts a week.');
    expect(weeklyCapText(defaultSchedule(0, 0))).toContain('no scripts');
  });

  it('shows connection status per destination; an unconnected one is disabled with a hint, TikTok has its note', async () => {
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-tab-settings'));
    const short = await screen.findByTestId('schedule-short');
    await waitFor(() =>
      expect((within(short).getByTestId('dest-short-facebook') as HTMLInputElement).disabled).toBe(false),
    );
    expect((within(short).getByTestId('dest-short-x') as HTMLInputElement).disabled).toBe(true);
    expect(short.textContent).toContain('Connect it under Social sharing');
    expect(short.textContent).toContain('TikTok posts privately until the app is audited.');
  });

  it('the off-schedule banner re-flows', async () => {
    st = status({ offSchedule: 2 });
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    expect((await screen.findByTestId('video-offschedule')).textContent).toContain(
      '2 videos sit on slots no longer in your schedule',
    );
    await user.click(screen.getByTestId('video-reflow'));
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/api/platform/video/reflow' && c.method === 'POST')).toBe(true),
    );
  });
});

describe('captions per destination', () => {
  it('counts live against the limit, flags an overflow and notes that X carries no link', async () => {
    withShort(['youtube', 'x', 'bluesky']);
    channels.push(
      { network: 'x', connected: true, status: 'ok' },
      { network: 'bluesky', connected: true, status: 'ok' },
    );
    const user = userEvent.setup();
    await openShort(user);
    const count = await screen.findByTestId('caption-count-x');
    expect(count.textContent).toMatch(/^\d+ \/ 256/);
    expect(count.textContent).toContain('X: no link ($0.015 post)');
    const box = screen.getByLabelText('X caption');
    await user.clear(box);
    fireEvent.change(box, { target: { value: 'a'.repeat(300) } });
    await waitFor(() => expect(screen.getByTestId('caption-count-x').textContent).toContain('over'));
    await user.click(screen.getByTestId('caption-tab-bluesky'));
    expect(screen.getByTestId('caption-count-bluesky').textContent).toMatch(/\/ 300/);
    // the edited captions travel with the schedule request
    await user.click(screen.getByTestId('video-approve'));
    await waitFor(() => expect(scheduleBody().captions?.x?.text).toBe('a'.repeat(300)));
    expect(scheduleBody().captions.bluesky).toBeTruthy();
    expect(scheduleBody().destinations).toEqual(['youtube', 'x', 'bluesky']);
  });
});

describe('TikTok panel', () => {
  const setup = async () => {
    withShort(['youtube', 'tiktok']);
    tiktokReply = () => json(CREATOR);
    const user = userEvent.setup();
    await openShort(user);
    await screen.findByTestId('tiktok-panel');
    return user;
  };

  it('shows "TikTok not connected" when the route answers 404 and schedules without TikTok', async () => {
    withShort(['youtube', 'tiktok']);
    const user = userEvent.setup();
    await openShort(user);
    expect((await screen.findByTestId('tiktok-not-connected')).textContent).toContain('TikTok not connected');
    await waitFor(() => expect((screen.getByTestId('dest-tiktok') as HTMLInputElement).disabled).toBe(true));
    const go = screen.getByTestId('video-approve') as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    await user.click(go);
    await waitFor(() => expect(scheduleBody().destinations).toEqual(['youtube']));
    expect(scheduleBody().destinationOptions).toBeUndefined();
  });

  it('has no default privacy, unchecked toggles (greyed when the creator disabled them) and the disclosure off', async () => {
    await setup();
    expect((screen.getByTestId('tiktok-privacy') as HTMLSelectElement).value).toBe('');
    for (const k of ['comment', 'duet', 'stitch'])
      expect((screen.getByTestId(`tiktok-${k}`) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('tiktok-duet') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('tiktok-comment') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('tiktok-commercial') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('tiktok-your-brand')).toBeNull();
  });

  it('keeps Schedule disabled until privacy is chosen and the consent is ticked, then sends the choices', async () => {
    const user = await setup();
    const go = screen.getByTestId('video-approve') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByTestId('schedule-blocker').textContent).toContain('Choose who can see');
    await user.selectOptions(screen.getByTestId('tiktok-privacy'), 'PUBLIC_TO_EVERYONE');
    expect(go.disabled).toBe(true);
    expect(screen.getByTestId('schedule-blocker').textContent).toContain('consent');
    await user.click(screen.getByTestId('tiktok-comment'));
    await user.click(screen.getByTestId('tiktok-consent'));
    expect(go.disabled).toBe(false);
    await user.click(go);
    await waitFor(() => expect(scheduleBody().destinationOptions?.tiktok).toBeTruthy());
    expect(scheduleBody().destinationOptions.tiktok).toEqual({
      privacy: 'PUBLIC_TO_EVERYONE',
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      commercial: { on: false, yourBrand: false, brandedContent: false },
      consent: true,
    });
  });

  it('the commercial disclosure needs a brand choice, names the label, and branded content cannot be private', async () => {
    const user = await setup();
    await user.selectOptions(screen.getByTestId('tiktok-privacy'), 'SELF_ONLY');
    await user.click(screen.getByTestId('tiktok-consent'));
    const go = screen.getByTestId('video-approve') as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    await user.click(screen.getByTestId('tiktok-commercial'));
    expect(go.disabled).toBe(true); // a brand choice is missing
    await user.click(screen.getByTestId('tiktok-your-brand'));
    expect(screen.getByTestId('tiktok-label-note').textContent).toContain('Promotional content');
    expect(go.disabled).toBe(false);
    await user.click(screen.getByTestId('tiktok-branded'));
    expect(screen.getByTestId('tiktok-label-note').textContent).toContain('Paid partnership');
    expect(go.disabled).toBe(true); // private + branded
    expect(screen.getByTestId('tiktok-panel').textContent).toContain('Branded Content Policy and');
    await user.selectOptions(screen.getByTestId('tiktok-privacy'), 'PUBLIC_TO_EVERYONE');
    expect(go.disabled).toBe(false);
  });

  it('before the app is audited only "Only me" is offered', async () => {
    withShort(['youtube', 'tiktok']);
    tiktokReply = () => json({ ...CREATOR, audited: false });
    const user = userEvent.setup();
    await openShort(user);
    const sel = (await screen.findByTestId('tiktok-privacy')) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'SELF_ONLY']);
    expect(screen.getByTestId('tiktok-unaudited').textContent).toContain(
      'posts privately until the app is audited',
    );
  });
});

describe('Queue', () => {
  const tz = 'Africa/Johannesburg';
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
  const dayOf = (d: Date) => localDate(d.getTime(), tz);
  const slot = (n: number) => {
    const day = inDays(n);
    return new Date(`${dayOf(day)}T08:00:00.000Z`).toISOString();
  };
  const allDays = () => {
    const sch = defaultSchedule(7, 0);
    st = status({ settings: { ...st.settings, schedule: sch } });
  };

  it('draws two weeks with a row per format: the video with phase badge and destination icons, or "empty, N scripts waiting"', async () => {
    allDays();
    const at = slot(2);
    posts = [
      video({
        id: '55555555-5555-4555-8555-555555555555',
        title: 'Scheduled one',
        ref: 'sched',
        status: 'approved',
        slotAt: at,
        publishMode: 'slot',
        destinations: ['youtube'],
        phase: 'scheduled',
      }),
      video({ id: '66666666-6666-4666-8666-666666666666', ref: 'waiting', title: 'Waiting one' }),
    ];
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-tab-queue'));
    const cell = await screen.findByTestId(`cell-long-${dayOf(new Date(at))}`);
    expect(cell.textContent).toContain('Scheduled one');
    expect(cell.textContent).toContain('Scheduled');
    expect(within(cell).getByTestId('dest-icon-youtube-pending')).toBeTruthy();
    const empty = screen.getByTestId(`empty-long-${dayOf(inDays(3))}`);
    expect(empty.textContent).toBe('Empty, 1 script waiting');
    // a day that is not a Short day has no slot
    expect(screen.queryByTestId(`empty-short-${dayOf(inDays(1))}`)).toBeNull();
    expect(screen.getByTestId('video-queue').querySelectorAll('[data-testid^="day-"]').length).toBe(14);
  });

  it('moves a scheduled video to a free slot, and offers Retry YouTube for a failed upload', async () => {
    allDays();
    const id = '55555555-5555-4555-8555-555555555555';
    posts = [
      video({
        id,
        title: 'Scheduled one',
        ref: 'sched',
        status: 'approved',
        slotAt: slot(2),
        publishMode: 'slot',
        destinations: ['youtube'],
        phase: 'failed',
        upload: {
          status: 'failed',
          attempts: 2,
          videoId: null,
          url: null,
          error: 'quota',
          nextAttemptAt: null,
          publishAt: null,
          privacy: 'public',
          warnings: [],
        },
      }),
    ];
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-tab-queue'));
    const card = await screen.findByTestId(`queue-post-${id}`);
    await user.click(within(card).getByRole('button', { name: 'Move' }));
    await user.selectOptions(await within(card).findByTestId('move-select'), SLOTS[3] as string);
    await user.click(within(card).getByTestId('move-confirm'));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url === `/api/platform/video/posts/${id}/move` && c.body?.includes(SLOTS[3] as string),
        ),
      ).toBe(true),
    );
    await user.click(within(card).getByRole('button', { name: 'Retry YouTube' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/${id}/shares/youtube/retry`))).toBe(true));
  });

  it('lists past posts with their links', async () => {
    allDays();
    posts = [
      video({
        title: 'Gone out',
        status: 'approved',
        slotAt: '2026-10-20T08:00:00.000Z',
        publishMode: 'slot',
        destinations: ['youtube'],
        phase: 'published',
        upload: {
          status: 'sent',
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
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-tab-queue'));
    const past = await screen.findByTestId('video-past');
    expect(within(past).getByRole('link', { name: 'YouTube' }).getAttribute('href')).toBe(
      'https://www.youtube.com/watch?v=abc',
    );
  });
});

describe('status strip', () => {
  it('shows the workers online or offline (one heartbeat, or the render/publish split), the next slot per format', async () => {
    st = status({
      worker: {
        render: { running: true, lastSeen: null },
        publish: { running: false, lastSeen: null },
      } as never,
    });
    wrap(<PlatformVideo />);
    const strip = await screen.findByTestId('video-strip');
    expect(strip.textContent).toContain('Render worker');
    expect(strip.textContent).toContain('online');
    expect(strip.textContent).toContain('Publish worker');
    expect(strip.textContent).toContain('offline');
    expect(screen.getByTestId('strip-next').textContent).toContain('video');
  });

  it('alerts for a slipped video and one waiting on its file', async () => {
    posts = [
      video({
        status: 'approved',
        slotAt: '2026-11-02T08:00:00.000Z',
        slippedAt: '2026-10-29T08:00:00.000Z',
        phase: 'scheduled',
      }),
    ];
    wrap(<PlatformVideo />);
    expect((await screen.findByTestId('video-alert')).textContent).toContain('slipped');
  });
});

describe('Core 5: destinations', () => {
  const channel = (network: 'instagram' | 'tiktok', connected = false) => ({
    network,
    connected,
    accountName: connected ? 'acct' : null,
    status: (connected ? 'ok' : 'disconnected') as 'ok' | 'disconnected',
    expiresAt: null,
    connectedAt: null,
  });

  it('Social sharing has an Instagram row (account id and Page token) and a TikTok row with Connect and the audit tick', async () => {
    wrap(
      <SocialPanel
        failedShares={0}
        needReconnect={[]}
        channels={[channel('instagram'), channel('tiktok', true)]}
      />,
    );
    const ig = screen.getByTestId('social-instagram');
    expect(ig.textContent).toContain('instagram_content_publish');
    expect(within(ig).getByLabelText('Instagram account id')).toBeTruthy();
    expect(within(ig).getByLabelText('Access token')).toBeTruthy();
    const tt = screen.getByTestId('social-tiktok');
    expect(within(tt).getByTestId('tiktok-connect').getAttribute('href')).toBe(
      '/api/platform/social/tiktok/connect',
    );
    expect(tt.textContent).toContain('posts privately until the app is audited');
    const audited = within(tt).getByTestId('tiktok-audited') as HTMLInputElement;
    await waitFor(() => expect(audited.disabled).toBe(false));
    expect(audited.checked).toBe(false);
    await userEvent.setup().click(audited);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url === '/api/platform/video/settings' &&
            c.body === '{"tiktokAudited":true}',
        ),
      ).toBe(true),
    );
  });

  it('the Queue offers a retry for each failed destination, not only YouTube', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    const sch = defaultSchedule(0, 7);
    st = status({ settings: { ...st.settings, schedule: sch } });
    posts = [
      video({
        id,
        format: 'short',
        title: 'A Short',
        status: 'approved',
        slotAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        publishMode: 'slot',
        destinations: ['youtube', 'facebook', 'x'],
        phase: 'partial',
        shares: [
          { network: 'facebook', status: 'failed', url: null, error: 'HTTP 400' },
          { network: 'x', status: 'sent', url: 'https://x.com/i/web/status/1', error: null },
        ],
      }),
    ];
    wrap(<PlatformVideo />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('video-tab-queue'));
    const card = await screen.findByTestId(`queue-post-${id}`);
    expect(within(card).queryByTestId('retry-x')).toBeNull();
    await user.click(within(card).getByTestId('retry-facebook'));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url === `/api/platform/video/posts/${id}/shares/facebook/retry`,
        ),
      ).toBe(true),
    );
  });

  it('share links are shown only for https addresses', async () => {
    const { safeHref } = await import('../lib/video-schedule.ts');
    expect(safeHref('https://x.com/i/web/status/1')).toBe('https://x.com/i/web/status/1');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('http://plain.example.com')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });

  it('the strip says what a missing worker means, per role, and the waiting wording matches the server', async () => {
    st = status({
      worker: { running: false, lastSeen: null },
      render: { running: true, lastSeen: null },
      publish: { running: false, lastSeen: '2026-10-29T08:00:00.000Z' },
    });
    posts = [
      video({
        status: 'approved',
        slotAt: '2026-11-02T08:00:00.000Z',
        phase: 'rendered',
        shares: [{ network: 'facebook', status: 'pending', url: null, error: 'waiting for the video file' }],
      }),
    ];
    wrap(<PlatformVideo />);
    const down = await screen.findByTestId('video-worker-down');
    expect(down.textContent).toContain('Publish worker is offline');
    expect(down.textContent).toContain('Nothing is uploaded or posted');
    expect(down.textContent).not.toContain('Render worker is offline');
    expect((await screen.findByTestId('video-alert')).textContent).toContain('waiting for the rendered file');
  });

  it('the Schedule step starts from the captions stored with the post', async () => {
    const { normalizeCreator } = await import('../api/queries/video.ts');
    // the shape of GET /api/platform/social/tiktok/creator-info
    expect(
      normalizeCreator({
        nickname: 'GW',
        username: 'gw',
        avatarUrl: null,
        privacyLevelOptions: ['SELF_ONLY'],
        commentDisabled: false,
        duetDisabled: true,
        stitchDisabled: false,
        maxVideoPostDurationSec: 600,
        canPost: true,
        audited: false,
      }),
    ).toMatchObject({
      privacyOptions: ['SELF_ONLY'],
      maxDurationSeconds: 600,
      duetDisabled: true,
      canPost: true,
      audited: false,
    });
    withShort(['youtube', 'facebook']);
    posts = [
      shortVideo({ captions: { facebook: { text: 'Drafter wrote this for Facebook', tags: ['ai'] } } }),
    ];
    wrap(<PlatformVideo />);
    await userEvent.setup().click(await screen.findByTestId('video-open-my-short-short'));
    const step = await screen.findByTestId('schedule-step');
    await waitFor(() => expect(step.textContent).toContain('Facebook'));
    const box = within(step)
      .getAllByRole('textbox')
      .find((el) => (el as HTMLTextAreaElement).value.includes('Drafter wrote this'));
    expect(box).toBeTruthy();
  });
});
