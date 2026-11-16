import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCancelRelease } from '../api/queries/delivery.ts';
import { useResolveDeskItem } from '../api/queries/desk.ts';
import { BRAND } from '../brand.ts';
import { AppShell } from '../components/shell/AppShell.tsx';
import { ToastProvider } from '../components/ui.tsx';

const U = '0192f3a0-0000-7000-8000-000000000001';
const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function setDesktop() {
  window.matchMedia = ((query: string) => ({
    matches: /min-width:\s*(1024|768|640)px/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const makeMe = (role: 'owner' | 'admin' | 'member', mode: 'dev' | 'business' = 'dev'): MeResponse =>
  ({
    user: {
      id: U,
      email: 'o@example.test',
      displayName: 'Olive Owner',
      kind: 'user',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: null,
      timezone: 'UTC',
      tour: { status: 'dismissed', step: 0 },
    },
    account: { kind: 'user' },
    isAdmin: role === 'owner',
    orgs: [{ id: U, name: 'Acme', role, status: 'active' }],
    activeOrg: {
      id: U,
      name: 'Acme',
      role,
      status: 'active',
      mode,
      plan: 'starter',
      planName: 'Starter',
      features: {},
      requireTwoFactor: false,
      simulation: false,
      banners: [],
      gate: null,
    },
    guestIn: [],
    guestProjectIds: [],
    visibleProjectIds: [],
    pendingInvitations: 0,
    mustChangePassword: false,
    twoFactor: { enabled: false, required: false, setupRequired: false },
    features: { mockUi: false, whatsNew: false },
  }) as unknown as MeResponse;

const ship = (n: number) => ({ id: ID(100 + n), kind: 'approval', subkind: 'ship_release', status: 'open' });
const other = (n: number) => ({ id: ID(200 + n), kind: 'question', subkind: null, status: 'open' });
const queueRow = (n: number) => ({ projectId: ID(1), projectKey: 'P5', env: 'production', commit: `c${n}` });

let me: MeResponse;
let queue: unknown[];
let deskItems: Array<{ id: string; kind: string; subkind: string | null; status: string }>;
let deskCounts: { open: number; blocking: number };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setDesktop();
  localStorage.clear();
  me = makeMe('owner');
  queue = [];
  deskItems = [];
  deskCounts = { open: 0, blocking: 0 };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return json(me);
    if (url === '/api/delivery/queue') return json({ items: queue });
    if (url.startsWith('/api/desk') && (init?.method ?? 'GET') === 'GET')
      return json({ items: deskItems, counts: { ...deskCounts, urgent: 0 } });
    if (url.startsWith('/api/projects')) return json({ projects: [] });
    if (url.startsWith('/api/agents')) return json({ agents: [] });
    if (url.startsWith('/api/chats')) return json({ chats: [] });
    if (url === '/api/setup-checklist') return json({ steps: [], doneCount: 0, dismissed: true });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const queueCalls = () => fetchMock.mock.calls.filter(([u]) => String(u) === '/api/delivery/queue');

/** A page with buttons that release/cancel from the queue and resolve a desk item, like the real pages do. */
function Actions() {
  const cancel = useCancelRelease();
  const resolve = useResolveDeskItem();
  return (
    <div data-testid="page">
      <button type="button" onClick={() => cancel.mutate(ID(9))}>
        cancel release
      </button>
      <button
        type="button"
        onClick={() => resolve.mutate({ id: ID(101), body: { resolution: 'approved' } as never })}
      >
        resolve ship
      </button>
    </div>
  );
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/projects']}>
          <Routes>
            <Route element={<AppShell name="Olive" live="open" />}>
              <Route path="*" element={<Actions />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const releasesLink = () => screen.findByTestId('nav-releases');

describe('the Releases badge in the sidebar', () => {
  it('adds waiting deploys and open Ship release items, next to an unchanged Desk badge', async () => {
    queue = [queueRow(1), queueRow(2)];
    deskItems = [ship(1), other(1)];
    deskCounts = { open: 2, blocking: 0 };
    mount();
    const link = await releasesLink();
    const badge = await within(link).findByTestId('releases-badge');
    await waitFor(() => expect(badge).toHaveTextContent('3'));
    expect(badge).toHaveAttribute('title', '2 waiting to release, 1 Ship release');
    expect(link).toHaveAccessibleName('Releases, 3 waiting');
    // the same look as the Desk badge (accent tone when nothing is blocking)
    expect(badge).toHaveClass('rounded-full', 'bg-accent', 'text-accent-fg', 'tnum');
    const desk = await screen.findByTestId('desk-badge');
    expect(desk).toHaveTextContent(/^2$/);
    expect(desk).toHaveAttribute('title', '0 blocking, 2 open');
    expect(desk).not.toHaveAttribute('aria-label');
    expect(desk.closest('a')).not.toHaveAttribute('aria-label');
  });

  it('shows no badge (no 0) when nothing is waiting, and the Desk badge as before', async () => {
    deskItems = [other(1)];
    deskCounts = { open: 1, blocking: 1 };
    mount();
    const desk = await screen.findByTestId('desk-badge');
    expect(desk).toHaveTextContent(/^1$/);
    expect(desk).toHaveClass('bg-danger-solid');
    await waitFor(() => expect(queueCalls().length).toBeGreaterThan(0));
    expect(within(await releasesLink()).queryByTestId('releases-badge')).toBeNull();
  });

  it('shows the badge in the collapsed sidebar too, placed like the Desk badge', async () => {
    localStorage.setItem(`${BRAND.storagePrefix}-sidebar`, 'collapsed');
    queue = [queueRow(1)];
    deskItems = [ship(1)];
    deskCounts = { open: 1, blocking: 0 };
    mount();
    const link = await releasesLink();
    const badge = await within(link).findByTestId('releases-badge');
    await waitFor(() => expect(badge).toHaveTextContent('2'));
    expect(badge).toHaveClass('absolute', '-top-1.5', '-right-1.5');
    expect(await screen.findByTestId('desk-badge')).toHaveClass('absolute', '-top-1.5', '-right-1.5');
  });

  it('counts only Ship release items for a member, without asking for the release queue', async () => {
    me = makeMe('member');
    queue = [queueRow(1), queueRow(2)];
    deskItems = [ship(1)];
    deskCounts = { open: 1, blocking: 0 };
    mount();
    const badge = await within(await releasesLink()).findByTestId('releases-badge');
    expect(badge).toHaveTextContent(/^1/);
    expect(queueCalls()).toHaveLength(0);
  });

  it('shows a member nothing when there is no Ship release item', async () => {
    me = makeMe('member');
    deskItems = [other(1)];
    deskCounts = { open: 1, blocking: 0 };
    mount();
    await screen.findByTestId('desk-badge');
    expect(within(await releasesLink()).queryByTestId('releases-badge')).toBeNull();
    expect(queueCalls()).toHaveLength(0);
  });

  it('counts an Admin like the Owner', async () => {
    me = makeMe('admin');
    queue = [queueRow(1)];
    mount();
    const badge = await within(await releasesLink()).findByTestId('releases-badge');
    expect(badge).toHaveTextContent(/^1/);
  });

  it('makes no release queue request in the Business view, which has no Releases link', async () => {
    me = makeMe('owner', 'business');
    queue = [queueRow(1)];
    deskItems = [ship(1)];
    deskCounts = { open: 1, blocking: 0 };
    mount();
    await screen.findByTestId('desk-badge');
    expect(screen.queryByTestId('nav-releases')).toBeNull();
    expect(screen.queryByTestId('releases-badge')).toBeNull();
    expect(queueCalls()).toHaveLength(0);
  });

  it('drops after a cancel from the queue and after resolving a Ship release item, without a remount', async () => {
    const user = userEvent.setup();
    queue = [queueRow(1), queueRow(2)];
    deskItems = [ship(1), other(1)];
    deskCounts = { open: 2, blocking: 0 };
    mount();
    const link = await releasesLink();
    const badge = await within(link).findByTestId('releases-badge');
    await waitFor(() => expect(badge).toHaveTextContent('3'));

    queue = [queueRow(2)];
    await user.click(screen.getByRole('button', { name: 'cancel release' }));
    await waitFor(() => expect(within(link).getByTestId('releases-badge')).toHaveTextContent('2'));

    deskItems = [other(1)];
    deskCounts = { open: 1, blocking: 0 };
    await user.click(screen.getByRole('button', { name: 'resolve ship' }));
    await waitFor(() => expect(within(link).getByTestId('releases-badge')).toHaveTextContent('1'));
    expect(await screen.findByTestId('desk-badge')).toHaveTextContent(/^1$/);
    // the same sidebar link throughout: the counts came through the cache, not a remount
    expect(screen.getByTestId('nav-releases')).toBe(link);
  });
});
