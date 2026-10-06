import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentWarning, sandboxAdvice } from '../lib/sandbox.ts';
import { Agents } from '../pages/Agents.tsx';
import { Workstations } from '../pages/Workstations.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const WS_BAD = ID(10);
const WS_OK = ID(11);
const WS_WIN = ID(12);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const runtime = (sandbox?: string, sandboxReason?: string) => ({
  id: 'mock',
  version: '1',
  available: true,
  capabilities: ['shell'],
  ...(sandbox ? { sandbox, sandboxReason } : {}),
});
const station = (id: string, name: string, runtimes: unknown[]) => ({
  id,
  userId: USER,
  name,
  platform: 'win32',
  hostname: 'h',
  runnerVersion: '1',
  status: 'active',
  connected: true,
  lastSeenAt: null,
  runtimes,
  repos: [],
  pairedAt: new Date(0).toISOString(),
  shifts: name === 'Linux box' ? { running: 2, limit: 4 } : { running: 0, limit: null },
});
const stations = [
  station(WS_BAD, 'Win desk', [runtime('unsandboxed', 'Native Windows: allowUnsandboxed is set')]),
  station(WS_OK, 'Linux box', [runtime('enforced', 'bubblewrap + socat')]),
  station(WS_WIN, 'Win cold', [
    runtime('unavailable', 'Native Windows: install the runner in WSL2 (docs/RUNNER.md)'),
  ]),
];
const agent = (n: number, name: string, workstationId: string, sandbox: string | null) => ({
  agent: {
    id: ID(100 + n),
    orgId: USER,
    projectId: null,
    hiredByUserId: USER,
    managerUserId: USER,
    workstationId,
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
    sandbox,
    activeCards: [],
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
const role = {
  definition: {
    key: 'builder',
    name: 'Builder',
    seniorityLevels: ['junior'],
    defaultModel: { runtime: 'mock', model: 'm' },
  },
  orgId: null,
  status: 'active',
  extensions: null,
};

const fetchMock = vi.fn();
let hired: unknown;
beforeEach(() => {
  hired = undefined;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0];
    if (path === '/api/workstations') return json({ workstations: stations });
    if (path === '/api/hr/board')
      return json({
        windowDays: 30,
        agents: [
          agent(1, 'Una', WS_BAD, 'unsandboxed'),
          agent(2, 'Ede', WS_OK, 'enforced'),
          agent(3, 'Old', WS_OK, null),
        ],
        recommendations: [],
        roleUpdates: [],
      });
    if (path === '/api/agents' && init?.method === 'POST') {
      hired = JSON.parse(String(init.body));
      return json({}, 201);
    }
    if (path === '/api/agents') return json({ agents: [] });
    if (path === '/api/roles') return json({ roles: [role] });
    if (path === '/api/auth/me' || path === '/api/me')
      return json({ user: { id: USER, email: 'o@x.test', displayName: 'Olga' } });
    if (path === '/api/agents/name-suggestions') return json({ names: [] });
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

describe('sandbox advice follows the reported cause', () => {
  it.each([
    ['Native Windows: allowUnsandboxed is set', 'WSL2'],
    ['bwrap and socat not installed: install them', 'bubblewrap and socat'],
    ['sandbox is set to "off" in the runner config', '"required"'],
    ['test override: AOM_RUNNER_MOCK_SANDBOX=unsandboxed', 'test override'],
  ])('%s', (reason, expected) => {
    expect(sandboxAdvice(reason)).toContain(expected);
  });
  it('the agent card sentence follows the reason too', () => {
    expect(agentWarning('Box', 'bwrap and socat not installed')).toBe(
      'Runs without an OS sandbox on Box: an agent could read files your user can read, including the runner token. Install bubblewrap and socat to sandbox it.',
    );
  });
  it('a Linux reason never recommends WSL2 only', () => {
    expect(sandboxAdvice('bwrap not installed')).not.toContain('WSL2');
  });
});

describe('workstations page', () => {
  it('warns on an unsandboxed workstation, explains an unavailable one, and says nothing for an enforced one', async () => {
    wrap(<Workstations />);
    const bad = await screen.findByTestId('workstation-Win desk');
    // collapsed at first: only a warning chip shows; the details open per row
    expect(within(bad).queryByTestId('sandbox-warning')).toBeNull();
    expect(within(bad).getByText('1 warning')).toBeInTheDocument();
    const user = userEvent.setup();
    for (const name of ['Win desk', 'Win cold', 'Linux box'])
      await user.click(
        within(screen.getByTestId(`workstation-${name}`)).getByRole('button', {
          name: `Show details of ${name}`,
        }),
      );
    const warning = within(bad).getByTestId('sandbox-warning');
    expect(warning).toHaveTextContent('without an OS sandbox');
    expect(warning).toHaveTextContent('including the runner token');
    expect(warning).toHaveTextContent('Native Windows: allowUnsandboxed is set');
    expect(within(warning).getByRole('link')).toHaveAttribute(
      'href',
      expect.stringContaining('RUNNER.md#windows-run-the-runner-inside-wsl2'),
    );
    // not dismissable: no close control
    expect(within(warning).queryByRole('button')).toBeNull();

    const cold = screen.getByTestId('workstation-Win cold');
    expect(within(cold).getByTestId('sandbox-unavailable')).toHaveTextContent(
      'Native Windows: install the runner in WSL2',
    );
    expect(within(cold).queryByTestId('sandbox-warning')).toBeNull();

    // the shift cap of each workstation (runner config maxConcurrentShifts), and how many run now
    expect(
      within(screen.getByTestId('workstation-Linux box')).getByTestId('workstation-shifts'),
    ).toHaveTextContent('2 of 4');
    expect(within(bad).getByTestId('workstation-shifts')).toHaveTextContent(
      '0 (limit shown while connected)',
    );

    const ok = screen.getByTestId('workstation-Linux box');
    expect(within(ok).queryByTestId('sandbox-warning')).toBeNull();
    expect(within(ok).queryByTestId('sandbox-unavailable')).toBeNull();
  });
});

describe('HR board', () => {
  it('shows the warning on each affected agent card, with the docs link', async () => {
    wrap(<Agents />);
    const una = await screen.findByTestId('agent-Una');
    const w = await within(una).findByTestId('agent-sandbox-warning');
    expect(w).toHaveTextContent(
      'Runs without an OS sandbox on Win desk: an agent could read files your user can read, including the runner token. Run the runner in WSL2, or on Linux with bubblewrap and socat, to sandbox it.',
    );
    expect(within(w).getByRole('link')).toHaveAttribute('href', expect.stringContaining('RUNNER.md'));
    expect(within(screen.getByTestId('agent-Ede')).queryByTestId('agent-sandbox-warning')).toBeNull();
    expect(within(screen.getByTestId('agent-Old')).queryByTestId('agent-sandbox-warning')).toBeNull();
  });
});

describe('hire form', () => {
  async function openHire() {
    const user = userEvent.setup();
    wrap(<Agents />);
    await user.click(await screen.findByRole('button', { name: 'Hire agent' }));
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    await within(form).findByRole('option', { name: /Win desk/ });
    return { user, form };
  }

  it('requires the confirm checkbox to hire onto an unsandboxed workstation', async () => {
    const { user, form } = await openHire();
    await user.selectOptions(within(form).getByLabelText('Workstation'), WS_BAD);
    expect(await within(form).findByTestId('hire-sandbox-warning')).toHaveTextContent(
      'Runs without an OS sandbox on Win desk',
    );
    await user.type(within(form).getByLabelText('Name'), 'Newt');
    await user.click(within(form).getByRole('button', { name: 'Hire' }));
    expect(await within(form).findByText(/Confirm that you accept/)).toBeInTheDocument();
    expect(hired).toBeUndefined();

    await user.click(within(form).getByRole('checkbox', { name: /runs without an OS sandbox/ }));
    await user.click(within(form).getByRole('button', { name: 'Hire' }));
    await waitFor(() =>
      expect(hired).toMatchObject({ name: 'Newt', workstationId: WS_BAD, acknowledgeUnsandboxed: true }),
    );
  });

  it('shows no warning or checkbox for a sandboxed workstation, and asks again for another unsandboxed one', async () => {
    const { user, form } = await openHire();
    await user.selectOptions(within(form).getByLabelText('Workstation'), WS_OK);
    expect(within(form).queryByTestId('hire-sandbox-warning')).toBeNull();
    expect(within(form).queryByRole('checkbox')).toBeNull();
    await user.type(within(form).getByLabelText('Name'), 'Fern');
    await user.click(within(form).getByRole('button', { name: 'Hire' }));
    await waitFor(() => expect(hired).toMatchObject({ name: 'Fern', workstationId: WS_OK }));
  });
});

describe('live refresh', () => {
  it('a workstation event refetches workstations, agents and the HR board', () => {
    const keys = keysForEvent({
      type: 'WorkstationRuntimesChanged',
      streamId: `workstation-${WS_BAD}`,
      projectId: null,
    }).map((k) => k[0]);
    expect(keys).toEqual(expect.arrayContaining(['workstations', 'agents', 'hr']));
  });
});
