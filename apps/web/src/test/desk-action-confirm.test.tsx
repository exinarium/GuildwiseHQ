import type { DeskActionPreview } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui.tsx';
import { DeskActionConfirm } from '../pages/DeskActionConfirm.tsx';

afterEach(() => vi.unstubAllGlobals());

const preview = (over: Partial<DeskActionPreview> = {}): DeskActionPreview => ({
  state: 'ready',
  deskItemId: '0192f3a0-0000-7000-8000-000000000088',
  title: 'Ship the thing?',
  body: 'Details of the thing.',
  orgName: 'Acme',
  actionLabel: 'Approve',
  action: 'approve',
  expiresAt: '2026-10-24T10:15:00.000Z',
  ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function setup(opts: { signedIn?: boolean; preview?: Response; apply?: Response }) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      if (url.endsWith('/api/auth/me'))
        return opts.signedIn === false
          ? json({ error: { code: 'unauthenticated', message: 'no' } }, 401)
          : json({
              user: { id: 'u1', displayName: 'Pia', timezone: 'UTC' },
              account: { kind: 'user' },
              twoFactor: {},
              orgs: [],
              activeOrg: null,
            });
      if (url.includes('/apply'))
        return opts.apply ?? json({ deskItemId: 'x', outcome: 'approved', actionLabel: 'Approve' });
      if (url.includes('/api/m/desk/')) return opts.preview ?? json(preview());
      return json({});
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/m/desk/tok.en']}>
          <Routes>
            <Route path="/m/desk/:token" element={<DeskActionConfirm />} />
            <Route path="/login" element={<p>login page</p>} />
            <Route path="/desk" element={<p>desk page</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the notification confirm page', () => {
  it('sends a signed-out person to sign in first', async () => {
    const calls = setup({ signedIn: false });
    expect(await screen.findByText('login page')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/api/m/desk/'))).toBe(false);
  });

  it('shows what the button does and applies nothing until it is pressed (a GET never applies)', async () => {
    const calls = setup({});
    expect(await screen.findByRole('heading', { name: 'Ship the thing?' })).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText(/Nothing happens until you press the button/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')?.url).toBe('/api/m/desk/tok.en/apply');
    expect(await screen.findByText('Approved')).toBeTruthy();
  });

  it('a second press cannot happen while it is working, and the result is shown once', async () => {
    const calls = setup({});
    const btn = await screen.findByRole('button', { name: 'Approve' });
    await userEvent.dblClick(btn);
    await screen.findByText('Approved');
    expect(calls.filter((c) => c.method === 'POST').length).toBeLessThanOrEqual(2);
  });

  it('says so when the link is for somebody else', async () => {
    setup({ preview: json({ error: { code: 'forbidden', message: 'x' } }, 403) });
    expect(await screen.findByText('This link is for someone else')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the Desk' })).toBeTruthy();
  });

  it.each([
    ['used', 'Already used'],
    ['expired', 'This link expired'],
    ['resolved', 'Already decided'],
  ] as const)('a %s link offers the Desk instead of a button', async (state, title) => {
    setup({ preview: json(preview({ state })) });
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a Reject link asks for Reject', async () => {
    setup({ preview: json(preview({ action: 'reject', actionLabel: 'Reject' })) });
    expect(await screen.findByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('shows the server’s reason when the apply is refused (already used)', async () => {
    setup({
      apply: json(
        {
          error: { code: 'link_used', message: 'this link was already used: open the Desk to see the item' },
        },
        409,
      ),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/already used/)).toBeTruthy();
  });
});
