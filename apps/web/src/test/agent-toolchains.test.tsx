import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ORG = ID(900);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let owner = ID(1);
let items: Array<Record<string, unknown>>;
const posts: Array<{ url: string; body: unknown }> = [];

const ws = () => ({
  id: ID(10),
  userId: owner,
  name: 'Desk',
  platform: 'linux',
  hostname: 'desk.lan',
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-06T10:00:00.000Z',
  runtimes: [],
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
  toolchains: { items, checkedAt: '2026-10-06T10:00:00.000Z' },
});

beforeEach(() => {
  owner = ID(1);
  posts.length = 0;
  localStorage.clear();
  localStorage.setItem('aom-workstations-open-anon', '[]');
  items = [
    {
      name: 'dotnet',
      source: 'detected',
      version: '8.0.425, 10.0.401 (~/.dotnet)',
      binDirs: ['/home/me/.dotnet'],
      readDirs: ['/home/me/.dotnet'],
      envKeys: ['DOTNET_ROOT'],
    },
    {
      name: 'zig',
      source: 'devops',
      binDirs: ['/home/me/.local/zig'],
      readDirs: [],
      envKeys: [],
      addedAt: '2026-10-13T10:00:00.000Z',
      addedBy: 'devops',
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/auth/me')
        return json({
          user: {
            id: ID(1),
            email: 'me@example.test',
            displayName: 'Me',
            role: 'member',
            status: 'active',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastLoginAt: null,
          },
          isAdmin: false,
          visibleProjectIds: [],
          features: { mockUi: false },
          activeOrg: {
            id: ORG,
            name: 'Acme',
            status: 'active',
            role: 'owner',
            banners: [],
            plan: 'x',
            planName: 'X',
            features: {},
          },
        });
      if (url === '/api/workstations') return json({ workstations: [ws()] });
      if (init.method === 'POST' && url.endsWith('/toolchains/remove')) {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ ok: true }, 202);
      }
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const open = async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Workstations />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const card = await screen.findByTestId('workstation-Desk');
  await user.click(within(card).getByRole('button', { name: 'Show details of Desk' }));
  return { user, card };
};

describe('Agent toolchains row', () => {
  it('lists the .NET SDKs and the registered tool; only registered ones can be removed', async () => {
    const { user, card } = await open();
    const row = await within(card).findByTestId('agent-toolchains');
    expect(within(row).getByTestId('toolchain-dotnet')).toHaveTextContent('8.0.425, 10.0.401 (~/.dotnet)');
    expect(within(row).getByTestId('toolchain-dotnet')).toHaveTextContent('detected');
    expect(within(row).getByTestId('toolchain-zig')).toHaveTextContent('added by DevOps on');
    expect(within(row).queryByRole('button', { name: /Remove the toolchain dotnet/ })).toBeNull();
    await user.click(within(row).getByRole('button', { name: /Remove the toolchain zig/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      url: `/api/workstations/${ID(10)}/toolchains/remove`,
      body: { name: 'zig' },
    });
  });

  it('is not shown on a workstation of someone else', async () => {
    owner = ID(2);
    const { card } = await open();
    expect(within(card).queryByTestId('agent-toolchains')).toBeNull();
  });
});
