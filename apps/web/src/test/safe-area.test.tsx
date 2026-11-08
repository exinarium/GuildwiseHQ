import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatDrawer } from '../components/ChatDrawer.tsx';
import { UpdateToast } from '../components/pwa/UpdateToast.tsx';
import { AppShell } from '../components/shell/AppShell.tsx';
import { BottomSheet } from '../components/ui/BottomSheet.tsx';
import { Dialog, ToastProvider } from '../components/ui.tsx';

vi.mock('../api/queries/agents.ts', () => ({ useAgents: () => ({ data: [] }) }));
vi.mock('../lib/pwa.ts', async (importActual) => ({
  ...(await importActual<typeof import('../lib/pwa.ts')>()),
  useUpdateAvailable: () => true,
}));

const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const SRC = join(__dirname, '..');

const html = new DOMParser().parseFromString(read('../../index.html'), 'text/html');
const meta = (name: string) =>
  Array.from(html.querySelectorAll(`meta[name="${name}"]`)).map((m) => ({
    content: m.getAttribute('content'),
    media: m.getAttribute('media'),
  }));
const manifest = JSON.parse(read('../../public/manifest.webmanifest'));
const css = read('../index.css');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' ? [] : sourceFiles(p);
    return /\.(ts|tsx|css)$/.test(name) ? [p] : [];
  });
}

describe('document head', () => {
  it('draws edge to edge so the insets reach CSS', () => {
    expect(meta('viewport')[0]?.content).toContain('viewport-fit=cover');
  });

  it('runs as an iOS home-screen app with the opaque default status bar', () => {
    expect(meta('apple-mobile-web-app-capable')[0]?.content).toBe('yes');
    expect(meta('apple-mobile-web-app-status-bar-style')).toEqual([{ content: 'default', media: null }]);
  });

  it('tints the browser chrome with the canvas colour of each scheme', () => {
    expect(meta('theme-color')).toEqual([
      { content: '#f5f6f8', media: '(prefers-color-scheme: light)' },
      { content: '#0b0e14', media: '(prefers-color-scheme: dark)' },
    ]);
  });
});

describe('web manifest', () => {
  it('is a standalone portrait app whose colours match the light canvas', () => {
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait-primary');
    expect(manifest.theme_color).toBe('#f5f6f8');
    expect(manifest.background_color).toBe('#f5f6f8');
    const light = meta('theme-color').find((m) => m.media?.includes('light'));
    expect(manifest.theme_color).toBe(light?.content);
  });
});

describe('one safe-area definition', () => {
  it('defines the four insets from env() with a 0px fallback', () => {
    for (const side of ['top', 'right', 'bottom', 'left'])
      expect(css).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px);`);
    expect(css).toContain('--safe-x: max(var(--safe-left), var(--safe-right));');
    expect(css).toContain('--safe-y: max(var(--safe-top), var(--safe-bottom));');
    expect(css).toContain('--safe-bottom-kbd: var(--safe-bottom);');
    expect(css.match(/env\(safe-area-inset/g)).toHaveLength(4);
  });

  it('drops the keyboard-aware bottom inset to 0 while the keyboard is open', () => {
    expect(css).toMatch(/:root\[data-kbd\]\s*\{\s*--safe-bottom-kbd:\s*0px;\s*\}/);
  });

  it('builds the tab bar height and the fixed-element inset on the shared value', () => {
    expect(css).toContain('--app-tabbar-h: calc(3.5rem + var(--safe-bottom));');
    expect(css).toContain('--app-bottom-inset: var(--safe-bottom);');
  });

  it('leaves no env(safe-area-inset-*) anywhere else in the app source', () => {
    const stray = sourceFiles(SRC)
      .filter((f) => !f.endsWith('index.css'))
      .filter((f) => readFileSync(f, 'utf8').includes('env(safe-area-inset'));
    expect(stray).toEqual([]);
  });

  it('does not pad the sticky action bar a second time', () => {
    const block = /\.sticky-actions \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(block).toContain('padding: 0.75rem 1rem;');
  });
});

const U = '0192f3a0-0000-7000-8000-000000000001';
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } });
const ME = {
  user: {
    id: U,
    email: 'o@example.test',
    displayName: 'Olive',
    kind: 'user',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: null,
    timezone: 'UTC',
    tour: { status: 'dismissed', step: 0 },
  },
  account: { kind: 'user' },
  isAdmin: true,
  orgs: [{ id: U, name: 'Acme', role: 'owner', status: 'active' }],
  activeOrg: {
    id: U,
    name: 'Acme',
    role: 'owner',
    status: 'active',
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
} as unknown as MeResponse;

const realMatchMedia = window.matchMedia;
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

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return json(ME);
      if (url.startsWith('/api/desk'))
        return json({ items: [], counts: { open: 0, blocking: 0, urgent: 0 } });
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
  window.matchMedia = realMatchMedia;
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/projects']}>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const shell = () =>
  wrap(
    <Routes>
      <Route element={<AppShell name="Olive" live="open" />}>
        <Route path="*" element={<p data-testid="page">page</p>} />
      </Route>
    </Routes>,
  );

describe('shell', () => {
  it('pads the phone top bar by the top and side insets', async () => {
    setViewport(true);
    shell();
    const bar = await screen.findByTestId('mobile-topbar');
    expect(bar).toHaveClass(
      'pt-(--safe-top)',
      'pr-[max(0.5rem,var(--safe-right))]',
      'pl-[max(0.5rem,var(--safe-left))]',
    );
  });

  it('pads the phone tab bar by the bottom and side insets', async () => {
    setViewport(true);
    shell();
    const bar = await screen.findByTestId('mobile-tabbar');
    expect(bar).toHaveClass('pb-(--safe-bottom)', 'pl-(--safe-left)', 'pr-(--safe-right)');
  });

  it('keeps the tablet (landscape) header, sidebar and content clear of the insets', async () => {
    setViewport(false);
    shell();
    const header = await screen.findByTestId('tablet-header');
    expect(header).toHaveClass(
      'pt-(--safe-top)',
      'pr-[calc(1.5rem+var(--safe-right))]',
      'lg:pr-[calc(2rem+var(--safe-right))]',
    );
    expect(screen.getByTestId('tablet-sidebar')).toHaveClass('pt-(--safe-top)', 'pl-(--safe-left)');
    const content = screen.getByTestId('page').parentElement as HTMLElement;
    expect(content).toHaveClass(
      'sm:pr-[calc(1.5rem+var(--safe-right))]',
      'lg:pr-[calc(2rem+var(--safe-right))]',
    );
    const grid = header.parentElement?.parentElement as HTMLElement;
    expect(grid.style.getPropertyValue('--sidebar-w')).toMatch(/var\(--safe-left\)/);
  });
});

describe('overlays', () => {
  it('a bottom sheet footer sits above the home indicator, but not above the keyboard', () => {
    wrap(
      <BottomSheet open onOpenChange={() => {}} title="Move" footer={<button type="button">Go</button>}>
        body
      </BottomSheet>,
    );
    const footer = screen.getByRole('button', { name: 'Go' }).parentElement as HTMLElement;
    expect(footer).toHaveClass('pb-[max(0.75rem,var(--safe-bottom-kbd))]');
    const sheet = screen.getByTestId('bottom-sheet');
    expect(sheet).toHaveClass('max-md:pl-(--safe-left)', 'max-md:pr-(--safe-right)');
    expect(sheet).toHaveClass('md:max-w-[calc(100vw-2*var(--safe-x)-1rem)]');
  });

  it('a bottom sheet without a footer ends with a keyboard-aware inset spacer', () => {
    wrap(
      <BottomSheet open onOpenChange={() => {}} title="Move">
        body
      </BottomSheet>,
    );
    expect(screen.getByTestId('bottom-sheet-spacer')).toHaveClass('h-(--safe-bottom-kbd)');
  });

  it('the dialog sheet pads the bottom and sides and fits a centred dialog inside the insets', () => {
    wrap(
      <Dialog open onOpenChange={() => {}} title="Edit">
        body
      </Dialog>,
    );
    const dlg = screen.getByRole('dialog', { name: 'Edit' });
    expect(dlg).toHaveClass(
      'max-sm:pb-(--safe-bottom-kbd)',
      'max-sm:pl-(--safe-left)',
      'max-sm:pr-(--safe-right)',
      'sm:max-h-[calc(90dvh-2*var(--safe-y))]',
      'sm:max-w-[calc(100vw-2*var(--safe-x)-1rem)]',
    );
  });

  it('the chat drawer pads all four edges, with the keyboard-aware bottom inset', async () => {
    wrap(<ChatDrawer open onOpenChange={() => {}} />);
    const list = await screen.findByTestId('chat-list');
    const drawer = list.closest('[role="dialog"]') as HTMLElement;
    expect(drawer).toHaveClass(
      'pt-(--safe-top)',
      'pr-(--safe-right)',
      'pb-(--safe-bottom-kbd)',
      'pl-(--safe-left)',
    );
    expect(drawer).not.toHaveClass('pb-(--safe-bottom)');
  });

  it('toasts sit below the status bar on a phone and inside the insets from sm up', () => {
    wrap(<p>x</p>);
    expect(screen.getByTestId('toasts')).toHaveClass(
      'top-[calc(var(--safe-top)+4rem)]',
      'sm:right-[calc(1rem+var(--safe-right))]',
      'sm:bottom-[calc(var(--app-bottom-inset,0px)+1rem)]',
    );
  });

  it('the update toast keeps clear of the side insets', () => {
    wrap(<UpdateToast />);
    expect(screen.getByTestId('update-toast')).toHaveClass(
      'pr-[calc(1rem+var(--safe-right))]',
      'pl-[calc(1rem+var(--safe-left))]',
    );
  });

  it('the push prompt keeps clear of the side insets and the home indicator', () => {
    const src = read('../components/push/PushPrompt.tsx');
    for (const cls of [
      'left-[calc(0.75rem+var(--safe-left))]',
      'right-[calc(0.75rem+var(--safe-right))]',
      'md:right-[calc(1rem+var(--safe-right))]',
      'md:bottom-[calc(var(--app-bottom-inset,0px)+1rem)]',
    ])
      expect(src).toContain(cls);
  });
});

describe('chat composer', () => {
  // The tab bar (keyboard closed) or the keyboard (open) is directly below a page composer: an inset of its own would
  // leave a gap above the keyboard.
  it.each([
    'components/chat/Composer.tsx',
    'components/ChatPanel.tsx',
    'components/boardroom/BoardComposer.tsx',
    'pages/PersonaChat.tsx',
    'pages/DiscoverySession.tsx',
  ])('%s adds no bottom inset of its own', (file) => {
    expect(read(`../${file}`)).not.toMatch(/--safe-bottom/);
  });
});
