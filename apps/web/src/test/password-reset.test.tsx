import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgotPassword } from '../pages/ForgotPassword.tsx';
import { ResetPassword } from '../pages/ResetPassword.tsx';

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function wrap(ui: React.ReactNode, path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/forgot-password" element={ui} />
          <Route path="/reset-password/:token" element={ui} />
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

describe('forgot and reset password', () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  let valid = true;
  beforeEach(() => {
    calls.length = 0;
    valid = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(url).includes('/password-reset/request')) return res(200, { ok: true });
        if (String(url).includes('/password-reset/confirm')) return res(200, { ok: true });
        if (String(url).includes('/password-reset/')) return res(200, { valid });
        return res(200, {});
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for an email and gives the same neutral answer', async () => {
    const user = userEvent.setup();
    wrap(<ForgotPassword />, '/forgot-password');
    await user.click(await screen.findByRole('button', { name: 'Send the link' }));
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.getByText(/If an account exists/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.includes('/request'))?.body).toEqual({ email: 'ada@example.com' });
  });

  it('sets the new password and returns to sign in; checks length and match first', async () => {
    const user = userEvent.setup();
    wrap(<ResetPassword />, `/reset-password/${TOKEN}`);
    await user.type(await screen.findByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat the password'), 'other');
    await user.click(screen.getByRole('button', { name: 'Save the password' }));
    expect(screen.getByText('Use at least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('The two passwords do not match')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Repeat the password'));
    await user.type(screen.getByLabelText('New password'), 'a-long-enough-password');
    await user.type(screen.getByLabelText('Repeat the password'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'Save the password' }));
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
    expect(calls.find((c) => c.url.includes('/confirm'))?.body).toEqual({
      token: TOKEN,
      password: 'a-long-enough-password',
    });
  });

  it('says so when the link is no longer valid', async () => {
    valid = false;
    wrap(<ResetPassword />, `/reset-password/${TOKEN}`);
    expect(await screen.findByText('This link is no longer valid')).toBeInTheDocument();
  });
});
