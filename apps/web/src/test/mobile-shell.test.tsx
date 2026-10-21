import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, backTargetFor } from '../components/shell/AppShell.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';

const U = '0192f3a0-0000-7000-8000-000000000001';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile ? /max-width:\s*767\.98px/.test(query) : /min-width:\s*(1024|768|640)px/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const makeMe = (role: 'owner' | 'member', features: Record<string, boolean> = {}): MeResponse =>
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
      plan: 'starter',
      planName: 'Starter',
      features,
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

let me: MeResponse;
let desk = { open: 3, blocking: 1 };
beforeEach(() => {
  me = makeMe('owner');
  desk = { open: 3, blocking: 1 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return json(me);
      if (url.startsWith('/api/desk'))
        return json({ items: [], counts: { open: desk.open, blocking: desk.blocking, urgent: 0 } });
      if (url.startsWith('/api/projects')) return json({ projects: [] });
      if (url.startsWith('/api/agents')) return json({ agents: [] });
      if (url.startsWith('/api/chats')) return json({ chats: [] });
      if (url === '/api/setup-checklist') return json({ steps: [], doneCount: 0, dismissed: true });
      return json({});
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setViewport(false);
});

function Where() {
  const l = useLocation();
  return <p data-testid="where">{l.pathname}</p>;
}

function mount(path = '/projects') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route element={<AppShell name="Olive" live="open" />}>
              <Route path="*" element={<p data-testid="page">page</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('useIsMobile', () => {
  it('follows the (max-width: 767.98px) media query', () => {
    setViewport(true);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
    setViewport(false);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });
});

describe('the app shell on a desktop', () => {
  it('keeps the sidebar and has no bottom tab bar', async () => {
    setViewport(false);
    mount();
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-tabbar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mobile-topbar')).not.toBeInTheDocument();
  });
});

describe('the app shell on a phone', () => {
  beforeEach(() => setViewport(true));

  it('replaces the sidebar with five tabs and a desk badge', async () => {
    mount();
    const bar = await screen.findByTestId('mobile-tabbar');
    await waitFor(() => expect(screen.getByTestId('tab-intake')).toHaveTextContent('Intake'));
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    const labels = within(bar)
      .getAllByRole('listitem')
      .map((li) => li.textContent?.replace(/\d+/g, '').trim());
    expect(labels).toEqual(['Desk', 'Chats', 'Intake', 'Projects', 'More']);
    expect(await screen.findByTestId('tab-desk-badge')).toHaveTextContent('3');
    // the active tab follows the route
    expect(screen.getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('tab-desk')).not.toHaveAttribute('aria-current');
  });

  it('goes to the desk, projects and intake from the tabs', async () => {
    const user = userEvent.setup();
    mount('/projects');
    await user.click(await screen.findByTestId('tab-desk'));
    expect(screen.getByTestId('where')).toHaveTextContent('/desk');
    expect(screen.getByTestId('tab-desk')).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByTestId('tab-intake'));
    expect(screen.getByTestId('where')).toHaveTextContent('/intake');
    await user.click(screen.getByTestId('tab-projects'));
    expect(screen.getByTestId('where')).toHaveTextContent('/projects');
  });

  it('sends a member without intake rights to a new card from the centre button', async () => {
    me = makeMe('member');
    mount();
    const centre = await screen.findByTestId('tab-intake');
    expect(centre).toHaveAttribute('href', '/cards/new');
    expect(centre).toHaveTextContent('New');
  });

  it('opens every other destination from More, with the org switcher and sign out', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByTestId('tab-more'));
    const menu = await screen.findByRole('dialog', { name: 'Main menu' });
    for (const name of [
      'Board',
      'Automations',
      'Interests',
      'Ledger',
      'Vaults',
      'Agents',
      'Org chart',
      'CEO',
      'Roles & workflows',
      'Workstations',
      'Integrations',
      'Metrics',
      'Costs',
      'Settings',
      'Organization',
      'Help',
    ])
      expect(within(menu).getByRole('link', { name })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    await user.click(within(menu).getByRole('link', { name: 'Agents' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/agents');
    expect(screen.queryByRole('dialog', { name: 'Main menu' })).not.toBeInTheDocument();
  });

  it('hides manager-only destinations from a member', async () => {
    me = makeMe('member');
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByTestId('tab-more'));
    const menu = await screen.findByRole('dialog', { name: 'Main menu' });
    for (const name of ['CEO', 'Costs', 'Vaults'])
      expect(within(menu).queryByRole('link', { name })).not.toBeInTheDocument();
    expect(within(menu).getByRole('link', { name: 'Agents' })).toBeInTheDocument();
  });

  it('shows the page title and a back button on a detail page, none on a top-level page', async () => {
    mount('/projects');
    expect(await screen.findByTestId('mobile-title')).toHaveTextContent('Projects');
    expect(screen.queryByTestId('mobile-back')).not.toBeInTheDocument();
  });

  it('goes back to the board from a card', async () => {
    const user = userEvent.setup();
    mount('/cards/TOY-3');
    await user.click(await screen.findByTestId('mobile-back'));
    expect(screen.getByTestId('where')).toHaveTextContent('/p/TOY/board');
  });

  it("goes back to the card's own board when the card is opened by id", async () => {
    const CARD_ID = '0b8f3c1e-5a7d-4e29-9c41-7d2a6e8f1b30';
    const base = vi.mocked(fetch).getMockImplementation() as (u: string) => Promise<Response>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/projects'))
          return json({
            projects: [
              { id: '11111111-1111-4111-8111-111111111111', key: 'TOY', name: 'Toy' },
              { id: '22222222-2222-4222-8222-222222222222', key: 'B2X9', name: 'Other' },
            ],
          });
        if (url === `/api/cards/${CARD_ID}`)
          return json({
            card: { id: CARD_ID, ref: 'B2X9-7', projectId: '22222222-2222-4222-8222-222222222222' },
          });
        return base(url);
      }),
    );
    const user = userEvent.setup();
    mount(`/cards/${CARD_ID}`);
    await waitFor(() => expect(screen.getByTestId('mobile-back')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('mobile-title')).toHaveTextContent('B2X9-7'));
    await user.click(screen.getByTestId('mobile-back'));
    expect(screen.getByTestId('where')).toHaveTextContent('/p/B2X9/board');
  });
});

describe('backTargetFor', () => {
  it('uses the parent crumb, else the list of a detail page', () => {
    expect(backTargetFor('/x', [{ label: 'P', to: '/p/K/board' }, { label: 'Card' }])).toBe('/p/K/board');
    expect(backTargetFor('/chat/abc', [{ label: 'Chat' }])).toBe('/desk');
    expect(backTargetFor('/desk', [{ label: 'Desk' }])).toBeNull();
  });
});
