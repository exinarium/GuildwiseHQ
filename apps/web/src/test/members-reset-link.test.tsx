import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembersTab } from '../components/orgsettings/MembersTab.tsx';
import { ToastProvider } from '../components/ui.tsx';

/** R6: "Email a reset link" is the main reset action; a reset refused for a member with access elsewhere explains why. */

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{ui}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const MEMBER = {
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: 'Mia Member',
  email: 'mia@example.test',
  role: 'member',
  allProjects: false,
  projects: [],
  twoFactorEnabled: true,
  avatar: null,
};
const OWNER = { userId: '11111111-1111-4111-8111-111111111111', role: 'owner' as const };
const otherAccess = () =>
  res(409, {
    error: {
      code: 'member_has_other_access',
      message: 'this person also has access to another organization',
    },
  });

describe('member resets with the reset link first', () => {
  const calls: Array<{ method: string; url: string }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push({ method: init?.method ?? 'GET', url: u });
        if (u.endsWith('/send-password-reset'))
          return res(200, { sentTo: MEMBER.email, expiresAt: '2026-11-21T01:00:00.000Z' });
        if (u.endsWith('/reset-password') || u.endsWith('/reset-two-factor')) return otherAccess();
        if (u.endsWith('/org/members')) return res(200, { members: [MEMBER] });
        if (u.endsWith('/org') || u.includes('/org?')) return res(200, { id: 'o1', name: 'Acme' });
        return res(200, { projects: [] });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers "Email a reset link" first and sends it', async () => {
    const user = userEvent.setup();
    wrap(<MembersTab me={OWNER} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Mia Member' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items[1]?.textContent).toMatch(/Email a reset link/); // after "Change projects"
    await user.click(screen.getByRole('menuitem', { name: /Email a reset link/ }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url.endsWith(`/${MEMBER.userId}/send-password-reset`)),
      ).toBe(true),
    );
    expect(await screen.findByText(`Reset link sent to ${MEMBER.email}`)).toBeInTheDocument();
  });

  it('a temporary password refused with member_has_other_access explains why and offers the link', async () => {
    const user = userEvent.setup();
    wrap(<MembersTab me={OWNER} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Mia Member' }));
    await user.click(await screen.findByRole('menuitem', { name: /Reset password/ }));
    await user.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText('Mia Member also has access to another organization')).toBeInTheDocument();
    expect(screen.queryByTestId('temporary-password')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('member-other-access-send-link'));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/send-password-reset'))).toBe(true));
    await waitFor(() =>
      expect(
        screen.queryByText('Mia Member also has access to another organization'),
      ).not.toBeInTheDocument(),
    );
  });

  it('a refused two-factor reset points to the member recovering it themselves, not to a password link', async () => {
    const user = userEvent.setup();
    wrap(<MembersTab me={OWNER} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Mia Member' }));
    await user.click(await screen.findByRole('menuitem', { name: /Reset two-factor login/ }));
    expect(await screen.findByText('Mia Member also has access to another organization')).toBeInTheDocument();
    expect(screen.getByText(/Lost your authenticator\?/)).toBeInTheDocument();
    expect(screen.queryByTestId('member-other-access-send-link')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        screen.queryByText('Mia Member also has access to another organization'),
      ).not.toBeInTheDocument(),
    );
    expect(calls.some((c) => c.url.endsWith('/send-password-reset'))).toBe(false);
  });
});
