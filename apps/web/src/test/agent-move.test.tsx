import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../pages/Agents.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const OTHER = ID(2);
const WS_DEAD = ID(10);
const WS_MINE = ID(11);
const WS_HERS = ID(12);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const runtimes = [{ id: 'mock', version: '1', available: true, capabilities: ['shell'] }];
const entry = (n: number, name: string, over: Record<string, unknown> = {}) => ({
  agent: {
    id: ID(100 + n),
    orgId: USER,
    hiredForProjectId: null,
    allowedProjectIds: null,
    focusProjectIds: [],
    hiredByUserId: USER,
    managerUserId: USER,
    workstationId: WS_DEAD,
    workstationName: 'My workstation',
    workstationState: 'unpaired',
    name,
    roleKey: 'builder',
    roleVersion: 1,
    seniority: 'junior',
    runtime: 'mock',
    model: 'm',
    effort: null,
    skills: [],
    permissions: {},
    capacity: 1,
    isDevops: false,
    status: 'active',
    hiredAt: new Date(0).toISOString(),
    retiredAt: null,
    lastShiftEndedAt: null,
    activeCards: [],
    ...over,
  },
  hiredByName: 'Olga',
  blockedOn: [],
  stats: {
    agentId: ID(100 + n),
    windowDays: 30,
    from: new Date(0).toISOString(),
    to: new Date(0).toISOString(),
    cardsTouched: 0,
    cardsDone: { value: 0, team: 0 },
    blockedRate: { value: 0, team: 0 },
    reworkRate: { value: 0, team: 0 },
    bugsEscaped: { value: null, team: null },
    utilisation: { value: 0, team: 0 },
    tokensPerCard: { value: 0, team: 0 },
    doneByDay: [],
  },
  quality: {
    reviewScoreAvg: null,
    reviewCount: 0,
    reworkByReason: [],
    reworkRoundsPerCard: { avg: null, max: 0, cardsWithThreeOrMore: 0 },
    bugsEscaped: 0,
    criteriaMissed: 0,
    testCoverage: { cardsWithTests: 0, cardsMeasured: 0, rate: null },
  },
});

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
      ownerUserId: OTHER,
      ownerName: 'Pia',
      mine: false,
      connected: false,
      runtimes,
    },
  ],
};

const fetchMock = vi.fn();
let rehomed: any;
let rehomeAnswer: Response | undefined;
let role = 'owner';
beforeEach(() => {
  rehomed = undefined;
  rehomeAnswer = undefined;
  role = 'owner';
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0]!;
    if (path === '/api/workstations') return json({ workstations: [] });
    if (path === '/api/hr/board')
      return json({
        windowDays: 30,
        agents: [
          entry(1, 'Una'),
          entry(2, 'Homeless', {
            status: 'needs_rehome',
            workstationId: null,
            workstationName: null,
            workstationState: null,
          }),
          entry(3, 'Devon', { isDevops: true, roleKey: 'devops' }),
        ],
        recommendations: [],
        roleUpdates: [],
      });
    if (path === '/api/agents' && !init?.method) return json({ agents: [] });
    if (path === `/api/agents/${ID(101)}/move-targets` || path === `/api/agents/${ID(102)}/move-targets`)
      return json(targets);
    if (path.endsWith('/rehome') && init?.method === 'POST') {
      rehomed = { path, body: JSON.parse(String(init.body)) };
      return rehomeAnswer ?? json({});
    }
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

describe('move an agent to another workstation', () => {
  it.each(['owner', 'admin'])('%s: every agent has Move, a needs_rehome agent has Re-home', async (r) => {
    role = r;
    wrap(<Agents />);
    expect(
      await screen.findByRole('button', { name: 'Move Una to another workstation' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-home Homeless' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move Homeless to another workstation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move Devon to another workstation' })).toBeNull();
    expect(screen.getAllByText('workstation unpaired').length).toBeGreaterThan(0);
  });

  it('a member, even the hiring manager, sees neither Move nor Re-home', async () => {
    role = 'member';
    wrap(<Agents />);
    await screen.findByText('Una');
    expect(screen.queryByRole('button', { name: /Move Una/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-home/ })).toBeNull();
  });

  it('the dialog lists the targets with their state and owner, and submits the move', async () => {
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move Una to another workstation' }));
    const form = await screen.findByRole('form', { name: 'Move agent' });
    expect(await screen.findByTestId('move-now-on')).toHaveTextContent('Now on: My workstation (unpaired)');
    expect(form).toHaveTextContent('Desk · you (connected)');
    expect(form).toHaveTextContent('Laptop · Pia (offline)');
    await user.selectOptions(screen.getByLabelText('Workstation'), WS_HERS);
    expect(screen.getByTestId('move-others-hint')).toHaveTextContent("Pia's workstation");
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(rehomed).toBeDefined());
    expect(rehomed.path).toBe(`/api/agents/${ID(101)}/rehome`);
    expect(rehomed.body).toEqual({ workstationId: WS_HERS, runtime: 'mock', model: 'm' });
  });

  it('a refusal such as agent_busy shows inside the dialog, which stays open', async () => {
    rehomeAnswer = json(
      { error: { code: 'agent_busy', message: 'Una is in a running shift: stop it or wait until it ends' } },
      409,
    );
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Move Una to another workstation' }));
    await screen.findByRole('form', { name: 'Move agent' });
    await screen.findByText(/Desk · you/);
    await user.click(screen.getByRole('button', { name: 'Move' }));
    expect(await screen.findByText(/running shift/)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Move agent' })).toBeInTheDocument();
  });

  it('a needs_rehome agent keeps the Re-home form and submit label', async () => {
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Re-home Homeless' }));
    expect(await screen.findByRole('form', { name: 'Re-home agent' })).toBeInTheDocument();
    await screen.findByText(/Desk · you/);
    await user.click(screen.getByRole('button', { name: 'Re-home' }));
    await waitFor(() => expect(rehomed?.path).toBe(`/api/agents/${ID(102)}/rehome`));
  });
});
