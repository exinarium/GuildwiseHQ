import type { MeResponse } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../components/shell/AppShell.tsx';
import { ToastProvider } from '../components/ui.tsx';

const U = '0192f3a0-0000-7000-8000-000000000001';
const CARD_ID = '0b8f3c1e-5a7d-4e29-9c41-7d2a6e8f1b30';
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

const me = {
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

beforeEach(() => {
  setViewport(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return json(me);
      if (url.startsWith('/api/desk'))
        return json({ items: [], counts: { open: 0, blocking: 0, urgent: 0 } });
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

function mount(path: string) {
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

describe('the phone back arrow on a card opened by id', () => {
  it("goes back to the card's own board", async () => {
    const user = userEvent.setup();
    mount(`/cards/${CARD_ID}`);
    await waitFor(() => expect(screen.getByTestId('mobile-back')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('mobile-title')).toHaveTextContent('B2X9-7'));
    await user.click(screen.getByTestId('mobile-back'));
    expect(screen.getByTestId('where')).toHaveTextContent('/p/B2X9/board');
  });
});
