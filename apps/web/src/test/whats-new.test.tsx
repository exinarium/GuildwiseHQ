import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_TOUR, type TourApi, TourContext } from '../components/tour/TourContext.tsx';
import { WhatsNewHost } from '../components/whatsnew/WhatsNew.tsx';
import { ARTICLES } from '../help/articles.ts';
import { Help } from '../pages/Help.tsx';
import { ENTRIES, entriesFor, parseEntry, unseenFor, type WhatsNewEntry } from '../whats-new/entries.ts';

const entry = (id: string, date: string, audience: string, extra = ''): WhatsNewEntry =>
  parseEntry(
    id,
    `---\ntitle: T ${id}\ndate: ${date}\naudience: ${audience}\n${extra}---\nBody of **${id}**.\n`,
  );

const me = (over: {
  role?: 'owner' | 'admin' | 'member' | null;
  platform?: boolean;
  seen?: string[];
  createdAt?: string;
}): MeResponse =>
  ({
    user: {
      id: '0192f3a0-0000-7000-8000-000000000001',
      email: 'me@example.test',
      displayName: 'Me',
      status: 'active',
      kind: over.platform ? 'super_admin' : 'user',
      createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      twoFactorEnabled: false,
      tour: { status: 'completed', step: 0 },
      whatsNewSeen: over.seen ?? [],
    },
    account: { kind: over.platform ? 'super_admin' : 'user' },
    activeOrg: over.role ? { id: 'o1', name: 'Org', role: over.role } : null,
    features: { mockUi: false, whatsNew: true },
  }) as unknown as MeResponse;

describe('the entry files', () => {
  it('parses frontmatter, a trailing comment and the body, and falls back safely', () => {
    const e = parseEntry(
      'x',
      '---\ntitle: Hello\ndate: 2026-10-10\naudience: admin   # who\nhelp: /help/agents#hiring\n---\nSome **text**.',
    );
    expect(e).toMatchObject({
      id: 'x',
      title: 'Hello',
      date: '2026-10-10',
      audience: 'admin',
      help: '/help/agents#hiring',
    });
    expect(e.blocks[0]?.t).toBe('p');
    const bad = parseEntry(
      'y',
      '---\ntitle: T\ndate: soon\naudience: nobody\nhelp: https://evil.test\n---\nB',
    );
    expect(bad).toMatchObject({ audience: 'all', date: '1970-01-01' });
    expect(bad.help).toBeUndefined();
  });

  it('every bundled entry is well formed, has a unique id and links to a real help article', () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ENTRIES.map((e) => e.id)).size).toBe(ENTRIES.length);
    const slugs = new Set(ARTICLES.map((a) => a.slug));
    for (const e of ENTRIES) {
      expect(e.id).toMatch(/^\d{4}-\d{2}-\d{2}-/);
      expect(e.date).toBe(e.id.slice(0, 10));
      expect(e.title.length).toBeLessThanOrEqual(60);
      expect(e.body.length).toBeGreaterThan(10);
      if (e.help) expect(slugs.has(e.help.slice(6).split('#')[0] ?? '')).toBe(true);
    }
    const dates = ENTRIES.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });
});

describe('who sees which entry', () => {
  const all = [
    entry('2026-10-01-a', '2026-10-01', 'all'),
    entry('2026-10-02-o', '2026-10-02', 'owner'),
    entry('2026-10-03-d', '2026-10-03', 'admin'),
    entry('2026-10-04-s', '2026-10-04', 'superadmin'),
  ];
  const ids = (m: MeResponse) => entriesFor(m, all).map((e) => e.id.slice(11));

  it('matches the audience by role in the current organization; superadmin entries only for platform users', () => {
    expect(ids(me({ role: 'owner' }))).toEqual(['a', 'o', 'd']);
    expect(ids(me({ role: 'admin' }))).toEqual(['a', 'd']);
    expect(ids(me({ role: 'member' }))).toEqual(['a']);
    expect(ids(me({ role: null }))).toEqual(['a']);
    expect(ids(me({ platform: true }))).toEqual(['a', 's']);
  });

  it('leaves out what was seen and what is older than the account', () => {
    const m = me({ role: 'owner', seen: ['2026-10-02-o'], createdAt: '2026-10-02T08:00:00.000Z' });
    // a: before the account; o: seen; d: new
    expect(unseenFor(m, all).map((e) => e.id)).toEqual(['2026-10-03-d']);
  });
});

// ---------------------------------------------------------------- the popup

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
let current: MeResponse;
const puts: unknown[] = [];

beforeEach(() => {
  puts.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me') return json(current);
      if (url === '/api/auth/whats-new-seen') {
        const body = JSON.parse(String(init?.body)) as { entryIds: string[] };
        puts.push(body);
        current = me({ role: 'owner', seen: body.entryIds });
        return json(current);
      }
      return json({ tickets: [] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const host = (tour: TourApi = NO_TOUR, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <TourContext.Provider value={tour}>
          <WhatsNewHost />
        </TourContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('the What’s new popup', () => {
  it('opens for a user with unseen entries, newest first, and Got it marks them seen on the server', async () => {
    current = me({ role: 'owner' });
    const user = userEvent.setup();
    host();
    const list = await screen.findByTestId('whats-new-list');
    const titles = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(titles[0]).toBe(ENTRIES.filter((e) => e.audience !== 'superadmin')[0]?.title);
    expect(within(list).getAllByRole('link', { name: 'Learn more' })[0]).toHaveAttribute('href');
    await user.click(screen.getByTestId('whats-new-got-it'));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect((puts[0] as { entryIds: string[] }).entryIds).toEqual(
      entriesFor(me({ role: 'owner' })).map((e) => e.id),
    );
    await waitFor(() => expect(screen.queryByTestId('whats-new-list')).toBeNull());
  });

  it('stays closed when everything is seen, and for a brand-new account', async () => {
    current = me({ role: 'owner', seen: ENTRIES.map((e) => e.id) });
    const a = host();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('whats-new-list')).toBeNull();
    a.unmount();
    current = me({ role: 'owner', createdAt: '2999-01-01T00:00:00.000Z' });
    host();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('whats-new-list')).toBeNull();
  });

  it('does not open on top of the tour, and opens when the tour is closed', async () => {
    current = me({ role: 'owner' });
    const busy: TourApi = { ...NO_TOUR, available: true, active: true, status: 'in_progress', total: 5 };
    const a = host(busy);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('whats-new-list')).toBeNull();
    a.unmount();
    host({ ...busy, active: false, status: 'dismissed' });
    expect(await screen.findByTestId('whats-new-list')).toBeInTheDocument();
  });

  it('is off when the server switches it off (no tour auto-start)', async () => {
    current = me({ role: 'owner' });
    current.features = { mockUi: false };
    host();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('whats-new-list')).toBeNull();
  });

  it('can be reopened from the Help page, with every entry for the user', async () => {
    current = me({ role: 'member', seen: ENTRIES.map((e) => e.id) });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/help']}>
          <Help />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByTestId('help-open-whats-new'));
    const list = await screen.findByTestId('whats-new-list');
    expect(within(list).getAllByRole('listitem').length).toBe(entriesFor(me({ role: 'member' })).length);
    expect(puts).toHaveLength(0);
  });
});
