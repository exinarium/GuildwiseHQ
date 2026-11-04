import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
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

  it('keeps the document scroller: no app frame and no page lock', async () => {
    setViewport(false);
    mount();
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByTestId('app-frame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-scroll')).not.toBeInTheDocument();
    expect(document.documentElement.dataset.appFrame).toBeUndefined();
    expect(screen.getByRole('main').parentElement).toHaveClass('min-h-dvh');
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
});

describe('the phone app frame', () => {
  beforeEach(() => setViewport(true));
  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
  });

  it('is fixed to the visible viewport and locks the page', async () => {
    mount();
    const frame = await screen.findByTestId('app-frame');
    expect(frame).toHaveClass('fixed', 'flex-col', 'overflow-hidden');
    expect(frame.className).toContain('h-[var(--vvh,100dvh)]');
    expect(frame.className).toContain('top-[var(--vv-top,0px)]');
    expect(document.documentElement.dataset.appFrame).toBe('');
  });

  it('scrolls only the inner area, with the tab bar after it and not fixed', async () => {
    mount('/desk');
    const bar = await screen.findByTestId('mobile-tabbar');
    const scroll = screen.getByTestId('app-scroll');
    expect(scroll).toHaveClass('overflow-y-auto', 'overflow-x-hidden', 'overscroll-contain');
    expect(screen.getByRole('main')).not.toHaveClass('overflow-y-auto');
    expect(screen.getByTestId('app-frame')).toContainElement(bar);
    expect(scroll.contains(bar)).toBe(false);
    expect(bar).toHaveClass('shrink-0', 'relative');
    expect(bar).not.toHaveClass('fixed');
    // the tab bar comes after the scrolling area in the frame
    expect(scroll.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the header does not stick to the page: it is a frame row
    expect(screen.getByTestId('mobile-topbar')).toHaveClass('shrink-0');
    expect(screen.getByTestId('mobile-topbar')).not.toHaveClass('sticky');
  });

  it.each(['/desk', '/projects', '/cards/TOY-3', '/agents'])(
    'has the same structure on %s, with no padding for the tab bar',
    async (path) => {
      mount(path);
      const bar = await screen.findByTestId('mobile-tabbar');
      const scroll = screen.getByTestId('app-scroll');
      expect(scroll.contains(bar)).toBe(false);
      expect(screen.getByTestId('page').parentElement?.className).not.toContain('app-bottom-inset');
      expect(bar.className).toContain('pb-[env(safe-area-inset-bottom)]');
    },
  );

  it('removes the page lock when the shell goes away', async () => {
    const { unmount } = mount();
    await screen.findByTestId('app-frame');
    unmount();
    expect(document.documentElement.dataset.appFrame).toBeUndefined();
  });

  it('hides the tab bar while the keyboard is open and brings it back when it closes', async () => {
    class VV extends EventTarget {
      height = 800;
      offsetTop = 0;
      scale = 1;
    }
    const vv = new VV();
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const field = document.createElement('input');
    field.type = 'text';
    document.body.append(field);
    mount('/desk');
    await screen.findByTestId('mobile-tabbar');
    act(() => field.focus());
    vv.height = 480;
    act(() => {
      vv.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(screen.queryByTestId('mobile-tabbar')).not.toBeInTheDocument());
    expect(document.documentElement.dataset.kbd).toBe('1');
    expect(document.documentElement.style.getPropertyValue('--vvh')).toBe('480px');
    act(() => field.blur());
    vv.height = 800;
    act(() => {
      vv.dispatchEvent(new Event('resize'));
    });
    expect(await screen.findByTestId('mobile-tabbar')).toBeInTheDocument();
    expect(document.documentElement.dataset.kbd).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue('--kbd-gap')).toBe('0px');
    field.remove();
    vi.unstubAllGlobals();
  });
});

describe('the phone app frame: rotation and scroll restore', () => {
  type Listener = () => void;
  const listeners = new Set<Listener>();
  let phone = true;
  function liveViewport() {
    window.matchMedia = ((query: string) => ({
      get matches() {
        return phone ? /max-width:\s*767\.98px/.test(query) : /min-width:\s*(1024|768|640)px/.test(query);
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: Listener) => listeners.add(cb),
      removeEventListener: (_: string, cb: Listener) => listeners.delete(cb),
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  const flip = (toPhone: boolean) => {
    phone = toPhone;
    act(() => {
      for (const cb of [...listeners]) cb();
    });
  };
  beforeEach(() => {
    phone = true;
    listeners.clear();
    liveViewport();
  });
  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    vi.unstubAllGlobals();
  });

  function Form({ hide }: { hide?: boolean }) {
    return (
      <div>
        <input data-testid="field" aria-label="field" />
        {hide && <p className="kbd-hide">above</p>}
      </div>
    );
  }
  function mountPage(hide: boolean) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/x']}>
            <Routes>
              <Route element={<AppShell name="Olive" live="open" />}>
                <Route path="*" element={<Form hide={hide} />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
  }

  it('keeps the routed page (and what was typed) when the width crosses 768px', async () => {
    const user = userEvent.setup();
    mountPage(false);
    const field = await screen.findByTestId('field');
    await user.type(field, 'draft');
    flip(false);
    await waitFor(() => expect(screen.queryByTestId('app-frame')).not.toBeInTheDocument());
    expect(screen.getByTestId('field')).toBe(field);
    expect(field).toHaveValue('draft');
    flip(true);
    await waitFor(() => expect(screen.getByTestId('app-frame')).toBeInTheDocument());
    expect(screen.getByTestId('field')).toBe(field);
    expect(field).toHaveValue('draft');
  });

  async function openAndCloseKeyboard(hide: boolean, scrollAtFocus: number) {
    class VV extends EventTarget {
      height = 800;
      offsetTop = 0;
      scale = 1;
    }
    const vv = new VV();
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true, writable: true });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    mountPage(hide);
    const scroll = await screen.findByTestId('app-scroll');
    scroll.scrollTop = scrollAtFocus;
    const field = screen.getByTestId('field');
    act(() => field.focus());
    vv.height = 480;
    act(() => {
      vv.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(document.documentElement.dataset.kbd).toBe('1'));
    scroll.scrollTop = 0; // the page folded away and the browser reset the position
    act(() => field.blur());
    vv.height = 800;
    act(() => {
      vv.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(document.documentElement.dataset.kbd).toBeUndefined());
    return scroll;
  }

  it('puts the scroll position back after the keyboard on a page that folds content away', async () => {
    const scroll = await openAndCloseKeyboard(true, 300);
    expect(scroll.scrollTop).toBe(300);
  });

  it('leaves the scroll position alone on an ordinary page without kbd-hide content', async () => {
    const scroll = await openAndCloseKeyboard(false, 300);
    expect(scroll.scrollTop).toBe(0);
  });
});

describe('backTargetFor', () => {
  it('uses the parent crumb, else the list of a detail page', () => {
    expect(backTargetFor('/x', [{ label: 'P', to: '/p/K/board' }, { label: 'Card' }])).toBe('/p/K/board');
    expect(backTargetFor('/chat/abc', [{ label: 'Chat' }])).toBe('/desk');
    expect(backTargetFor('/desk', [{ label: 'Desk' }])).toBeNull();
  });
});
