import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND } from '../brand.ts';
import { strengthOf } from '../pages/AcceptInvite.tsx';
import { Login } from '../pages/Login.tsx';

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('login screen', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      if (String(url).includes('/auth/me'))
        return res(401, { error: { code: 'unauthorized', message: 'no' } });
      return res(401, { error: { code: 'unauthorized', message: 'bad credentials' } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the brand, the slogan and the form', async () => {
    renderLogin();
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText(BRAND.slogan)).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(document.title).toBe(`Sign in · ${BRAND.name}`);
  });

  it('validates on submit and reveals the characters without a second "password" label', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show characters' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide characters' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('answers a failed attempt with one alert and clears the password', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password-xx');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''));
  });
});

describe('password strength (advisory)', () => {
  it('is too short under 12 characters and grows with length and variety', () => {
    expect(strengthOf('short').label).toBe('Too short');
    expect(strengthOf('abcdefghijkl').label).toBe('OK');
    expect(strengthOf('Abcdefgh1jkl!').label).toBe('Strong');
  });
});
