import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServersPanel } from '../components/McpServersPanel.tsx';
import { Workstations } from '../pages/Workstations.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const base = {
  userId: ID(1),
  platform: 'linux',
  runnerVersion: '1.0.0',
  status: 'active',
  connected: true,
  lastSeenAt: '2026-10-06T10:00:00.000Z',
  repos: [],
  pairedAt: '2026-10-01T10:00:00.000Z',
  shifts: { running: 0, limit: 4 },
};
const claude = (auth?: 'ok' | 'expired') => ({
  id: 'claude-code',
  version: '2.1.299',
  available: auth !== 'expired',
  capabilities: [],
  ...(auth ? { auth } : {}),
});
const atlassian = (authState?: string) => ({
  name: 'plugin_atlassian_atlassian',
  plugin: 'atlassian',
  server: 'atlassian',
  ...(authState ? { authState } : {}),
});

const list: unknown[] = [];
beforeEach(() => {
  list.length = 0;
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
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
      if (url === '/api/workstations') return json({ workstations: list });
      return json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const wrap = (el: React.ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{el}</MemoryRouter>
    </QueryClientProvider>,
  );

describe('Workstations page: sign-ins', () => {
  it('says what to do on the machine for an expired Claude login and an MCP server that needs sign-in', async () => {
    list.push(
      {
        ...base,
        id: ID(10),
        name: 'Desk',
        hostname: 'desk.lan',
        runtimes: [claude('expired')],
        mcpServers: [atlassian('needs_sign_in')],
      },
      {
        ...base,
        id: ID(11),
        name: 'Laptop',
        hostname: 'laptop.lan',
        runtimes: [claude('ok')],
        mcpServers: [atlassian('signed_in')],
      },
      // an older runner reports no auth state at all
      { ...base, id: ID(12), name: 'Old', hostname: 'old.lan', runtimes: [claude()] },
    );
    const user = userEvent.setup();
    wrap(<Workstations />);
    const desk = await screen.findByTestId('workstation-Desk');
    expect(within(desk).getByText('2 warnings')).toBeInTheDocument();
    await user.click(within(desk).getByRole('button', { name: 'Show details of Desk' }));
    expect(within(desk).getByTestId('claude-login-expired')).toHaveTextContent(
      /Claude login expired.*run claude, then \/login/s,
    );
    expect(within(desk).getByTestId('mcp-sign-in-plugin_atlassian_atlassian')).toHaveTextContent(
      'Needs sign-in: On Desk, run `claude`, then `/mcp`, choose atlassian, Authenticate.',
    );
    for (const name of ['Laptop', 'Old']) {
      const row = screen.getByTestId(`workstation-${name}`);
      await user.click(within(row).getByRole('button', { name: `Show details of ${name}` }));
      expect(within(row).queryByTestId('sign-in-problems')).toBeNull();
    }
  });
});

describe('MCP servers panel: sign-in', () => {
  const candidate = (needsSignIn?: string[]) => ({
    name: 'plugin_atlassian_atlassian',
    plugin: 'atlassian',
    server: 'atlassian',
    transport: 'http' as const,
    host: 'mcp.atlassian.com',
    tools: null,
    workstations: ['Desk', 'Laptop'],
    ...(needsSignIn ? { needsSignIn } : {}),
  });
  it('shows the exact steps per workstation where a granted server is not signed in', () => {
    wrap(
      <McpServersPanel
        projectId={ID(5)}
        granted={['plugin_atlassian_atlassian']}
        candidates={[candidate(['Desk'])]}
        canGrant={false}
      />,
    );
    expect(screen.getByTestId('mcp-needs-sign-in-plugin_atlassian_atlassian')).toHaveTextContent(
      'Needs sign-in: On Desk, run `claude`, then `/mcp`, choose atlassian, Authenticate.',
    );
  });
  it('shows nothing when every workstation is signed in (or an older server sends no state)', () => {
    wrap(
      <McpServersPanel
        projectId={ID(5)}
        granted={['plugin_atlassian_atlassian']}
        candidates={[candidate([])]}
        canGrant={false}
      />,
    );
    expect(screen.queryByTestId('mcp-needs-sign-in-plugin_atlassian_atlassian')).toBeNull();
  });
});
