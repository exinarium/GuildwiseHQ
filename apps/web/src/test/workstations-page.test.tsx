import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ws = (n: number, name: string) => ({
  id: ID(n),
  userId: ID(1),
  name,
  platform: 'linux',
  hostname: `${name}.lan`,
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-06T10:00:00.000Z',
  runtimes: [],
  repos: [{ projectRepoId: ID(50), localPath: '/home/me/toy', reportedAt: '2026-10-06T10:00:00.000Z' }],
  pairedAt: '2026-10-01T10:00:00.000Z',
  shifts: { running: 1, limit: 4 },
});

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'admin',
            status: 'active',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastLoginAt: null,
          },
          isAdmin: true,
          visibleProjectIds: [],
          features: { mockUi: false },
        });
      if (url === '/api/workstations') return json({ workstations: [ws(10, 'Desk'), ws(11, 'Laptop')] });
      if (method === 'POST' && url.endsWith('/unlink')) return json({ ok: true });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Workstations />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Workstations page', () => {
  it('is collapsed by default, expands per row and remembers it per user', async () => {
    const user = userEvent.setup();
    const first = wrap();
    const desk = await screen.findByTestId('workstation-Desk');
    expect(within(desk).queryByTestId('workstation-repos')).toBeNull();
    expect(within(screen.getByTestId('workstation-Laptop')).queryByTestId('workstation-repos')).toBeNull();
    await user.click(within(desk).getByRole('button', { name: 'Show details of Desk' }));
    expect(within(desk).getByTestId('workstation-repos')).toHaveTextContent('/home/me/toy');
    expect(within(screen.getByTestId('workstation-Laptop')).queryByTestId('workstation-repos')).toBeNull();
    first.unmount();

    // a new visit: Desk is still open, Laptop closed
    wrap();
    const again = await screen.findByTestId('workstation-Desk');
    await waitFor(() => expect(within(again).getByTestId('workstation-repos')).toBeInTheDocument());
    expect(within(screen.getByTestId('workstation-Laptop')).queryByTestId('workstation-repos')).toBeNull();
  });

  it('still works when storage is blocked', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    wrap();
    const desk = await screen.findByTestId('workstation-Desk');
    await user.click(within(desk).getByRole('button', { name: 'Show details of Desk' }));
    expect(within(desk).getByTestId('workstation-repos')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('Unpair asks first, says what happens, then unpairs', async () => {
    const user = userEvent.setup();
    wrap();
    const desk = await screen.findByTestId('workstation-Desk');
    await user.click(within(desk).getByRole('button', { name: 'Unpair Desk' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Unpair Desk?');
    expect(dialog).toHaveTextContent('runner token stops working');
    expect(dialog).toHaveTextContent('DevOps requests waiting for it fail');
    expect(calls.some((c) => c.endsWith('/unlink'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Unpair' }));
    await waitFor(() => expect(calls).toContain(`POST /api/workstations/${ID(10)}/unlink`));
  });
});
