import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agents } from '../pages/Agents.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const WS_BAD = ID(10);
const WS_OK = ID(11);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const agent = (n: number, name: string, workstationId: string, removed: boolean) => ({
  agent: {
    id: ID(100 + n),
    orgId: USER,
    hiredForProjectId: null,
    allowedProjectIds: null,
    focusProjectIds: [],
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
    sandbox: null,
    workstationRemoved: removed,
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
let projectsList: unknown[] = [];
beforeEach(() => {
  projectsList = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/api/workstations') return json({ workstations: [] });
    if (path === '/api/hr/board')
      return json({
        windowDays: 30,
        agents: [agent(1, 'Una', WS_BAD, true), agent(2, 'Ede', WS_OK, false)],
        recommendations: [],
        roleUpdates: [],
      });
    if (path === '/api/agents') return json({ agents: [] });
    if (path === '/api/roles') return json({ roles: [role] });
    if (path === '/api/auth/me' || path === '/api/me')
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
        orgs: [{ id: USER, name: 'Olga org', role: 'owner', status: 'active' }],
        activeOrg: {
          id: USER,
          name: 'Olga org',
          role: 'owner',
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
    if (path === '/api/agents/name-suggestions') return json({ names: [] });
    if (path === '/api/projects') return json({ projects: projectsList });
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

describe('agent whose workstation was removed', () => {
  it('shows the needs-a-new-workstation note only for that agent', async () => {
    wrap(<Agents />);
    const flagged = await screen.findAllByTestId('agent-workstation-removed');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain('needs a new workstation');
  });
});
