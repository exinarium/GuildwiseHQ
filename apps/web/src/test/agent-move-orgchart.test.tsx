import type { OrgChart, OrgChartAgent } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canMoveAgent } from '../lib/agentMove.ts';
import { OrgChartPage } from '../pages/OrgChart.tsx';

afterEach(() => vi.unstubAllGlobals());

const U = (n: number) => `0192f3a0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
const OWNER = U(1);
const OTHER_MEMBER = U(3);
const WS_OLD = U(90);
const WS_DEAD = U(91);
const WS_NEW = U(92);
const WS_NEW2 = U(93);

const agent = (n: number, name: string, over: Partial<OrgChartAgent> = {}): OrgChartAgent => ({
  id: U(n),
  name,
  roleKey: 'builder',
  roleLabel: 'Builder',
  department: 'delivery',
  seniority: 'junior',
  isDevops: false,
  status: 'idle',
  avatarSeed: `seed-${n}`,
  avatarStyle: 'notionists',
  runtime: 'claude-code',
  model: 'sonnet',
  capacity: 1,
  hiredAt: '2026-10-01T00:00:00.000Z',
  workstation: { id: WS_OLD, name: 'Old laptop', online: true, unpaired: false },
  reportsTo: { userId: OWNER, name: 'Pieter', orgRole: 'owner' },
  escalatesTo: { level: 'desk', agentIds: [] },
  allowedProjectIds: null,
  focusProjectIds: [],
  activeCards: [],
  blockedCards: [],
  recentWork: [],
  spend: { monthMicros: 0, totalMicros: 0, currency: 'USD' },
  ...over,
});

const CHART: OrgChart = {
  owner: { userId: OWNER, name: 'Pieter' },
  admins: [],
  departments: [{ key: 'delivery', label: 'Delivery' }],
  agents: [
    agent(11, 'Sam', { status: 'working' }),
    agent(12, 'Tess', { reportsTo: { userId: OTHER_MEMBER, name: 'Tom', orgRole: 'member' } }),
    agent(15, 'Dev', {
      roleKey: 'devops',
      roleLabel: 'DevOps',
      isDevops: true,
      seniority: 'senior',
      workstation: { id: WS_DEAD, name: 'Dead box', online: false, unpaired: true },
    }),
  ],
  projects: [],
  workstations: [
    {
      id: WS_OLD,
      name: 'Old laptop',
      online: true,
      ownerName: 'Pieter',
      devopsAgentId: null,
      agentIds: [U(11), U(12)],
    },
    { id: WS_DEAD, name: 'Dead box', online: false, ownerName: 'Pieter', devopsAgentId: U(15), agentIds: [] },
  ],
};

const rt = (id: string, available = true) => ({ id, version: '1', available, capabilities: ['shell'] });
const targets = {
  current: { id: WS_OLD, name: 'Old laptop', state: 'connected' },
  workstations: [
    {
      id: WS_NEW,
      name: 'Desk',
      ownerUserId: OWNER,
      ownerName: 'Pieter',
      mine: true,
      connected: true,
      runtimes: [rt('claude-code'), rt('mock')],
      devops: { agentId: U(40), name: 'Dora' },
    },
    {
      id: WS_NEW2,
      name: 'Bare box',
      ownerUserId: OWNER,
      ownerName: 'Pieter',
      mine: true,
      connected: true,
      runtimes: [rt('mock')],
      devops: null,
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function show(role: 'owner' | 'admin' | 'member', myId = OWNER, rehomeAnswer?: Response) {
  const calls: { path: string; body: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split('?')[0]!;
      if (path === '/api/org-chart') return json(CHART);
      if (path.endsWith('/move-targets')) return json(targets);
      if (path.endsWith('/rehome') && init?.method === 'POST') {
        calls.push({ path, body: JSON.parse(String(init.body)) });
        return rehomeAnswer ?? json({});
      }
      if (path === '/api/auth/me')
        return json({
          user: { id: myId, email: 'p@x.test', displayName: 'Me' },
          activeOrg: { id: U(99), role, features: {} },
          orgs: [{ id: U(99), name: 'Org', role, status: 'active' }],
        });
      return json({});
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/org-chart']}>
        <OrgChartPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const openAgent = async (name: RegExp) => {
  const user = userEvent.setup();
  await screen.findByTestId('org-chart');
  await user.click(screen.getByRole('button', { name }));
  return { user, dialog: await screen.findByTestId('org-agent-card') };
};
const moveButton = (name: string) =>
  screen.queryByRole('button', { name: `Move ${name} to another workstation` });

describe('canMoveAgent', () => {
  const base = {
    myId: 'me',
    orgRole: 'member' as const,
    managerUserId: 'me',
    roleKey: 'builder',
    isDevops: false,
    status: 'active',
    unpaired: false,
  };
  it('lets the Owner, Admins and the hiring manager move a builder, nobody else', () => {
    expect(canMoveAgent({ ...base, orgRole: 'owner', managerUserId: 'x' })).toBe(true);
    expect(canMoveAgent({ ...base, orgRole: 'admin', managerUserId: 'x' })).toBe(true);
    expect(canMoveAgent(base)).toBe(true);
    expect(canMoveAgent({ ...base, managerUserId: 'x' })).toBe(false);
    expect(canMoveAgent({ ...base, myId: undefined })).toBe(false);
  });
  it('never moves the CEO or a fired agent', () => {
    expect(canMoveAgent({ ...base, orgRole: 'owner', roleKey: 'ceo' })).toBe(false);
    expect(canMoveAgent({ ...base, orgRole: 'owner', status: 'retired' })).toBe(false);
  });
  it('moves a DevOps engineer only for Owner/Admin and only off an unpaired workstation', () => {
    const d = { ...base, isDevops: true, orgRole: 'owner' as const };
    expect(canMoveAgent(d)).toBe(false);
    expect(canMoveAgent({ ...d, unpaired: true })).toBe(true);
    expect(canMoveAgent({ ...d, orgRole: 'member', unpaired: true })).toBe(false);
  });
});

describe('Move to workstation on the org chart', () => {
  it.each(['owner', 'admin'] as const)('%s sees it for an agent in a running shift', async (role) => {
    show(role, role === 'owner' ? OWNER : U(2));
    await openAgent(/^Sam /);
    expect(screen.getByRole('button', { name: 'Move Sam to another workstation' })).toHaveTextContent(
      'Move to workstation',
    );
    expect(screen.getByTestId('org-agent-move-hint')).toBeInTheDocument();
  });

  it('the hiring manager (a Member) sees it for their agent, a plain Member does not', async () => {
    show('member', OWNER);
    await openAgent(/^Sam /);
    expect(moveButton('Sam')).toBeInTheDocument();
  });

  it('a Member who did not hire the agent does not see it', async () => {
    show('member', OTHER_MEMBER);
    await openAgent(/^Sam /);
    expect(moveButton('Sam')).toBeNull();
  });

  it('the hiring manager of Tess sees it for Tess only', async () => {
    show('member', OTHER_MEMBER);
    await openAgent(/^Tess /);
    expect(moveButton('Tess')).toBeInTheDocument();
  });

  it('a DevOps engineer on an unpaired workstation shows it to the Owner, not to a Member', async () => {
    show('owner');
    await openAgent(/^Dev DevOps/);
    expect(moveButton('Dev')).toBeInTheDocument();
  });

  it('a DevOps engineer is not offered to a Member', async () => {
    show('member', OWNER);
    await openAgent(/^Dev DevOps/);
    expect(moveButton('Dev')).toBeNull();
  });

  it('opens the move dialog, offers only the targets, keeps runtime and model when nothing changes', async () => {
    const calls = show('owner');
    const { user } = await openAgent(/^Sam /);
    await user.click(moveButton('Sam')!);
    const form = await screen.findByRole('form', { name: 'Move agent' });
    expect(await screen.findByTestId('move-now-on')).toHaveTextContent('Now on: Old laptop');
    expect(form).toHaveTextContent('Desk');
    expect(form).toHaveTextContent('Bare box');
    expect(within(form).queryByRole('option', { name: /Old laptop/ })).toBeNull();
    expect(screen.getByLabelText('Runtime')).toHaveValue('claude-code');
    expect(screen.getByLabelText('Model')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.path).toBe(`/api/agents/${U(11)}/rehome`);
    expect(calls[0]!.body).toEqual({ workstationId: WS_NEW, runtime: 'claude-code', model: 'sonnet' });
  });

  it('says so when the target lacks the agent runtime', async () => {
    show('owner');
    const { user } = await openAgent(/^Sam /);
    await user.click(moveButton('Sam')!);
    await screen.findByRole('form', { name: 'Move agent' });
    expect(screen.queryByTestId('move-runtime-changes')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Workstation'), WS_NEW2);
    expect(screen.getByTestId('move-runtime-changes')).toHaveTextContent(
      'claude-code is not available on Bare box: the agent will use mock.',
    );
  });

  it('warns before the user confirms when a DevOps engineer moves to a workstation that has one', async () => {
    const calls = show('owner');
    const { user } = await openAgent(/^Dev DevOps/);
    await user.click(moveButton('Dev')!);
    await screen.findByRole('form', { name: 'Move agent' });
    expect(await screen.findByTestId('move-devops-warning')).toHaveTextContent(
      'One DevOps engineer per workstation: Desk already has Dora',
    );
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Workstation'), WS_NEW2);
    expect(screen.queryByTestId('move-devops-warning')).toBeNull();
    expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();
    expect(calls).toHaveLength(0);
  });

  it('shows the sandbox warning when the runtime has no OS sandbox on the target', async () => {
    show('owner');
    targets.workstations[1]!.runtimes = [
      { ...rt('claude-code'), sandbox: 'unsandboxed', sandboxReason: 'no bwrap' } as never,
    ];
    try {
      const { user } = await openAgent(/^Sam /);
      await user.click(moveButton('Sam')!);
      await screen.findByRole('form', { name: 'Move agent' });
      await user.selectOptions(screen.getByLabelText('Workstation'), WS_NEW2);
      expect(await screen.findByTestId('rehome-sandbox-warning')).toBeInTheDocument();
    } finally {
      targets.workstations[1]!.runtimes = [rt('mock')];
    }
  });

  it('shows a server refusal inside the dialog, which stays open', async () => {
    show(
      'owner',
      OWNER,
      json({ error: { code: 'agent_busy', message: 'Sam is in a running shift: wait until it ends' } }, 409),
    );
    const { user } = await openAgent(/^Sam /);
    await user.click(moveButton('Sam')!);
    await screen.findByRole('form', { name: 'Move agent' });
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/Sam is in a running shift/)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Move agent' })).toBeInTheDocument();
  });
});
