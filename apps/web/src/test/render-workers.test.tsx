import { defaultSchedule, type RenderWorker, type VideoStatus } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { PlatformVideo } from '../pages/platform/PlatformVideo.tsx';

/** R16, R23: the Render workers card (add with the token shown once, revoke, encoder badge) and the CPU warning. */

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

const W1 = '22222222-2222-4222-8222-222222222222';
const W2 = '33333333-3333-4333-8333-333333333333';
const REASON = 'libnvidia-encode.so.1 is missing: install libnvidia-encode-595 on the host';
const TOKEN = 'aomv_shown-once-token-value-0123456789abcdef';

const worker = (over: Partial<RenderWorker> = {}): RenderWorker => ({
  id: W1,
  name: 'devbox',
  createdAt: '2026-11-21T08:00:00.000Z',
  revokedAt: null,
  lastSeenAt: '2026-11-21T09:00:00.000Z',
  lastIp: '192.0.2.10',
  version: '1.10.0',
  encoder: 'nvenc',
  encoderReason: null,
  warning: false,
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
  worker: { running: true, lastSeen: '2026-11-21T09:00:00.000Z' },
  capacity: {
    long: { used: 0, limit: 3, backlog: 0, backlogLimit: 6 },
    short: { used: 0, limit: 3, backlog: 0, backlogLimit: 6 },
  },
  nextSlot: { long: null, short: null },
  storage: { usedBytes: 0, maxBytes: 5 * 1024 ** 3 },
  offSchedule: 0,
  pending: 0,
  lockedPrivate: 0,
  auditFormUrl: 'https://support.google.com/youtube/contact/yt_api_form',
  ...over,
});

let workers: RenderWorker[] = [];
let st: VideoStatus = status();
let calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  workers = [worker()];
  st = status();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, ...(init?.body ? { body: String(init.body) } : {}) });
      if (url === '/api/platform/render-workers' && method === 'POST') {
        const added = worker({
          id: W2,
          name: JSON.parse(String(init?.body)).name,
          lastSeenAt: null,
          encoder: null,
        });
        workers = [...workers, added];
        return json({ worker: added, token: TOKEN }, 201);
      }
      if (url === '/api/platform/render-workers') return json({ workers });
      const m = /^\/api\/platform\/render-workers\/([^/]+)\/revoke$/.exec(url);
      if (m) {
        workers = workers.map((w) =>
          w.id === m[1] ? { ...w, revokedAt: '2026-11-21T10:00:00.000Z', warning: false } : w,
        );
        return json({ worker: workers.find((w) => w.id === m[1]) });
      }
      if (url === '/api/platform/social/channels') return json({ channels: [] });
      if (url.startsWith('/api/platform/video/slots'))
        return json({ timezone: 'Africa/Johannesburg', slots: [] });
      if (url === '/api/platform/video/settings') return json(st.settings);
      if (url.startsWith('/api/platform/video/topics')) return json({ topics: [], queued: 0 });
      if (url.startsWith('/api/platform/video/needing')) return json({ articles: [], releases: [] });
      if (url.startsWith('/api/platform/video/library')) return json({ videos: [] });
      if (url.startsWith('/api/platform/video')) return json({ posts: [], status: st });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function openSettings() {
  wrap(<PlatformVideo />);
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('video-tab-settings'));
  return { user, card: await screen.findByTestId('render-workers') };
}

describe('Render workers card', () => {
  it('lists a worker with its encoder, last seen, address and version', async () => {
    const { card } = await openSettings();
    const row = await within(card).findByTestId(`render-worker-${W1}`);
    expect(row.textContent).toContain('devbox');
    expect(row.textContent).toContain('nvenc');
    expect(row.textContent).toContain('192.0.2.10');
    expect(row.textContent).toContain('1.10.0');
    expect(within(card).queryByTestId('render-worker-cpu-badge')).toBeNull();
  });

  it('adds a worker and shows the token once', async () => {
    const { user, card } = await openSettings();
    await user.type(within(card).getByTestId('render-worker-name'), 'gpu-2');
    await user.click(within(card).getByTestId('render-worker-add'));
    const shown = await within(card).findByTestId('render-worker-token');
    expect(shown.textContent).toContain(TOKEN);
    expect(shown.textContent).toMatch(/shown only once/);
    expect(JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}')).toEqual({ name: 'gpu-2' });
    await user.click(within(shown).getByRole('button', { name: 'I have copied it' }));
    await waitFor(() => expect(within(card).queryByTestId('render-worker-token')).toBeNull());
    expect(card.textContent).not.toContain(TOKEN);
  });

  it('revokes a worker', async () => {
    const { user, card } = await openSettings();
    await user.click(await within(card).findByTestId('render-worker-revoke'));
    await waitFor(() =>
      expect(calls.some((c) => c.url === `/api/platform/render-workers/${W1}/revoke`)).toBe(true),
    );
    await waitFor(() =>
      expect(within(card).getByTestId(`render-worker-${W1}`).textContent).toContain('Revoked'),
    );
  });

  it('a worker on the CPU carries the warning badge with the reason', async () => {
    workers = [worker({ encoder: 'cpu', encoderReason: REASON, warning: true })];
    const { card } = await openSettings();
    const badge = await within(card).findByTestId('render-worker-cpu-badge');
    expect(badge.textContent).toBe('cpu');
    expect(within(card).getByTestId('render-worker-reason').textContent).toBe(REASON);
  });
});

describe('the Video page status', () => {
  it('a render worker on the CPU shows a warning with the reason above the tabs', async () => {
    st = status({
      renderWorkers: [{ name: 'devbox', encoder: 'cpu', reason: REASON, lastSeen: null, warning: true }],
    });
    wrap(<PlatformVideo />);
    const alert = await screen.findByTestId('render-worker-cpu');
    expect(alert.textContent).toContain('Render worker devbox renders on the CPU');
    expect(alert.textContent).toContain(REASON);
  });

  it('no warning while every worker is on NVENC', async () => {
    st = status({
      renderWorkers: [{ name: 'devbox', encoder: 'nvenc', reason: null, lastSeen: null, warning: false }],
    });
    wrap(<PlatformVideo />);
    await screen.findByTestId('video-panel');
    await screen.findByTestId('video-tab-settings');
    expect(screen.queryByTestId('render-worker-cpu')).toBeNull();
  });
});
