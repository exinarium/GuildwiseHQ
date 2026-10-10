import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembersTab } from '../components/orgsettings/MembersTab.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { ChangePasswordRequired } from '../pages/ChangePasswordRequired.tsx';

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
  twoFactorEnabled: false,
  avatar: null,
};

describe('Owner resets a member password', () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        calls.push({
          method: init?.method ?? 'GET',
          url: u,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (u.endsWith('/reset-password')) return res(200, { temporaryPassword: 'Abcd2345Efgh6789Jkmn' });
        if (u.endsWith('/org/members')) return res(200, { members: [MEMBER] });
        if (u.endsWith('/org') || u.includes('/org?')) return res(200, { id: 'o1', name: 'Acme' });
        return res(200, { projects: [] });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('explains the account is global, shows the temporary password once and offers a copy button', async () => {
    const user = userEvent.setup();
    wrap(<MembersTab me={{ userId: '11111111-1111-4111-8111-111111111111', role: 'owner' }} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Mia Member' }));
    await user.click(await screen.findByRole('menuitem', { name: /Reset password/ }));
    expect(await screen.findByTestId('reset-password-global-note')).toHaveTextContent(
      /one account for every organization/,
    );
    await user.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByTestId('temporary-password')).toHaveTextContent('Abcd2345Efgh6789Jkmn');
    expect(screen.getByRole('button', { name: /Copy/ })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`/${MEMBER.userId}/reset-password`))).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('temporary-password')).not.toBeInTheDocument());
  });

  it('an Admin does not get the reset-password action', async () => {
    const user = userEvent.setup();
    wrap(<MembersTab me={{ userId: '11111111-1111-4111-8111-111111111111', role: 'admin' }} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Mia Member' }));
    await screen.findByRole('menuitem', { name: /Change projects/ });
    expect(screen.queryByRole('menuitem', { name: /Reset password/ })).not.toBeInTheDocument();
  });
});

describe('the forced password change', () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return res(200, { ok: true });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('checks the new password, then sends the temporary one as the current password', async () => {
    const user = userEvent.setup();
    wrap(<ChangePasswordRequired />);
    await user.type(await screen.findByLabelText('Temporary password'), 'Abcd2345Efgh6789Jkmn');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat the new password'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save the password' }));
    expect(screen.getByText('Use at least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('The two passwords do not match')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/auth/password'))).toBe(false);
    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Repeat the new password'));
    await user.type(screen.getByLabelText('New password'), 'my-own-new-password-1');
    await user.type(screen.getByLabelText('Repeat the new password'), 'my-own-new-password-1');
    await user.click(screen.getByRole('button', { name: 'Save the password' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/auth/password'))?.body).toEqual({
        current: 'Abcd2345Efgh6789Jkmn',
        new: 'my-own-new-password-1',
      }),
    );
  });
});
