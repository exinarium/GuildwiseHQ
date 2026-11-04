import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../pages/Agents.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const WS_DEAD = ID(10);
const WS_MINE = ID(11);
const WS_HERS = ID(12);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const runtimes = [{ id: 'mock', version: '1', available: true, capabilities: ['shell'] }];
const homes = {
  workstations: [
    {
      id: WS_DEAD,
      name: 'My workstation',
      status: 'unlinked',
      connected: false,
      ownerName: 'Olga',
      mine: true,
      agentCount: 3,
      runningCount: 1,
    },
  ],
};
const targets = {
  current: { id: WS_DEAD, name: 'My workstation', state: 'unpaired' },
  workstations: [
    {
      id: WS_MINE,
      name: 'Desk',
      ownerUserId: USER,
      ownerName: 'Olga',
      mine: true,
      connected: true,
      runtimes,
    },
    {
      id: WS_HERS,
      name: 'Laptop',
      ownerUserId: ID(2),
      ownerName: 'Pia',
      mine: false,
      connected: false,
      runtimes,
    },
  ],
};
const ref = (n: number, name: string) => ({ agentId: ID(100 + n), name });
const preview = (target: string, targetName: string, over: Record<string, unknown> = {}) => ({
  dryRun: true,
  scope: 'all',
  source: { id: WS_DEAD, name: 'My workstation', status: 'unlinked', connected: false },
  target: { id: target, name: targetName },
  moved: [
    { ...ref(1, 'Una'), releasedClaims: ['GWP-12'] },
    { ...ref(2, 'Dora'), releasedClaims: [] },
  ],
  blocked: [
    {
      ...ref(3, 'Busy'),
      reason: 'running_shift',
      code: 'agent_busy',
      message: 'Busy is in a running shift: wait.',
    },
  ],
  needsUnsandboxedAck: false,
  ...over,
});

const fetchMock = vi.fn();
let role = 'owner';
let posted: { path: string; body: any } | undefined;
let previewOver: Record<string, unknown> = {};
let homesOver: unknown = homes;
beforeEach(() => {
  role = 'owner';
  posted = undefined;
  previewOver = {};
  homesOver = homes;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0]!;
    if (path === '/api/agents/workstations') return json(homesOver);
    if (path === `/api/workstations/${WS_DEAD}/move-targets`) return json(targets);
    if (path === `/api/workstations/${WS_DEAD}/move-agents/preview`) {
      const t = new URL(url, 'http://x').searchParams.get('targetWorkstationId')!;
      return json(preview(t, t === WS_MINE ? 'Desk' : 'Laptop', previewOver));
    }
    if (path === `/api/workstations/${WS_DEAD}/move-agents` && init?.method === 'POST') {
      posted = { path, body: JSON.parse(String(init.body)) };
      return json({
        ...preview(posted.body.targetWorkstationId, 'Desk'),
        dryRun: false,
        blocked: [
          {
            ...ref(4, 'Odd'),
            reason: 'runtime_missing',
            code: 'runtime_missing',
            message: 'Desk has no ghost runtime',
          },
        ],
      });
    }
    if (path === '/api/hr/board')
      return json({ windowDays: 30, agents: [], recommendations: [], roleUpdates: [] });
    if (path === '/api/agents' || path === '/api/workstations') return json({ agents: [], workstations: [] });
    if (path === '/api/roles') return json({ roles: [] });
    if (path === '/api/auth/me')
      return json({
        user: {
          id: USER,
          email: 'o@x.test',
          displayName: 'Olga',
          kind: 'user',
          twoFactorEnabled: false,
          status: 'active',
          createdAt: '2026-10-01T10:00:00.000Z',
          lastLoginAt: null,
        },
        account: { kind: 'user' },
        isAdmin: true,
        orgs: [{ id: USER, name: 'Olga org', role, status: 'active' }],
        activeOrg: {
          id: USER,
          name: 'Olga org',
          role,
          status: 'active',
          plan: 'founding',
          planName: 'Founding',
          features: {},
          banners: [],
        },
        guestIn: [],
        guestProjectIds: [],
        visibleProjectIds: [],
        pendingInvitations: 0,
        twoFactor: { enabled: false, required: false, setupRequired: false },
        mustChangePassword: false,
        features: { mockUi: false },
      });
    if (path === '/api/projects') return json({ projects: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('move all agents from a workstation', () => {
  it.each(['owner', 'admin'])('%s sees the workstation with its agent count and the action', async (r) => {
    role = r;
    wrap(<Agents />);
    expect(await screen.findByRole('button', { name: 'Move all agents from My workstation' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Move all agents from My workstation' })).toHaveTextContent(
      'Move all agents from this workstation',
    );
    expect(screen.getByTestId('agent-homes')).toHaveTextContent('Unpaired');
    expect(screen.getByTestId('agent-homes')).toHaveTextContent('3 agents');
  });

  it('a member with no agents on an offline or removed workstation sees no action', async () => {
    role = 'member';
    homesOver = { workstations: [] };
    wrap(<Agents />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/hr/board', expect.anything()));
    expect(screen.queryByRole('button', { name: /Move all agents/ })).toBeNull();
  });

  it('a hiring manager sees the action for their own agents and the note that only those are listed', async () => {
    role = 'member';
    previewOver = { scope: 'own', moved: [{ ...ref(1, 'Una'), releasedClaims: [] }], blocked: [] };
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move all agents from My workstation' }));
    expect(await screen.findByTestId('move-all-own-note')).toHaveTextContent('Only the agents you hired');
  });

  it('does not post anything before the confirm click', async () => {
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move all agents from My workstation' }));
    await screen.findByTestId('move-all-count');
    expect(posted).toBeUndefined();
  });

  it('shows how many agents will move, then the moved and skipped lists with reasons', async () => {
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move all agents from My workstation' }));
    expect(await screen.findByTestId('move-all-count')).toHaveTextContent('2 agents will move to Desk');
    expect(screen.getByTestId('move-all-preview-moved')).toHaveTextContent('Una (releases GWP-12)');
    expect(screen.getByTestId('move-all-preview-blocked')).toHaveTextContent('Busy');
    expect(screen.getByTestId('move-all-preview-blocked')).toHaveTextContent('In a running shift');
    expect(screen.getByTestId('move-all-preview-blocked')).toHaveTextContent('Busy is in a running shift');
    await user.selectOptions(screen.getByLabelText('Move to'), WS_HERS);
    await waitFor(() => expect(screen.getByTestId('move-all-count')).toHaveTextContent('to Laptop'));
    await user.selectOptions(screen.getByLabelText('Move to'), WS_MINE);
    await waitFor(() => expect(screen.getByTestId('move-all-count')).toHaveTextContent('to Desk'));
    await user.click(screen.getByRole('button', { name: 'Move 2 agents' }));
    await waitFor(() => expect(posted).toBeDefined());
    expect(posted!.body).toEqual({ targetWorkstationId: WS_MINE });
    const result = await screen.findByTestId('move-all-result');
    expect(within(result).getByTestId('move-all-moved')).toHaveTextContent('Una');
    expect(within(result).getByTestId('move-all-moved')).toHaveTextContent('Dora');
    expect(within(result).getByTestId('move-all-not-moved')).toHaveTextContent('Odd');
    expect(within(result).getByTestId('move-all-not-moved')).toHaveTextContent('Desk has no ghost runtime');
    expect(
      within(result).getByRole('button', { name: 'Move the rest to another workstation' }),
    ).toBeVisible();
  });

  it('disables the button when nothing would move', async () => {
    previewOver = { moved: [] };
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move all agents from My workstation' }));
    await screen.findByTestId('move-all-count');
    expect(screen.getByRole('button', { name: 'Move 0 agents' })).toBeDisabled();
  });

  it('asks for the sandbox acknowledgement before it allows the move', async () => {
    previewOver = {
      needsUnsandboxedAck: true,
      moved: [],
      blocked: [
        { ...ref(1, 'Una'), reason: 'sandbox_gate', code: 'unsandboxed_ack_required', message: 'no sandbox' },
      ],
    };
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move all agents from My workstation' }));
    expect(await screen.findByLabelText(/without an OS sandbox on Desk/)).toBeInTheDocument();
    expect(screen.getByTestId('move-all-preview-blocked')).toHaveTextContent('Una');
  });
});
