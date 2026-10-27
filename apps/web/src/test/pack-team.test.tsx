import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HireDialog } from '../components/agents/HireDialog.tsx';
import { PackProvenance } from '../components/agents/PackProvenance.tsx';
import { HirePackTeamDialog } from '../components/capabilities/HirePackTeamDialog.tsx';
import { groupSkills, PackTeamSection } from '../components/capabilities/PackTeamSection.tsx';
import { ToastProvider } from '../components/ui.tsx';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const USER = ID(1);
const PACK = ID(50);
const WS = ID(10);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SEATS = ['analyst', 'ba', 'builder', 'reviewer', 'writer'].map((key) => ({
  key,
  name: key.toUpperCase(),
}));
const agentDto = (key: string, name: string, over: Record<string, unknown> = {}) => ({
  key,
  kind: 'persona',
  name,
  description: `${name} does the work`,
  icon: null,
  suggestedSeat: 'own',
  skillRefs: [],
  agentSkill: null,
  hiredAgentIds: [],
  marked: false,
  ...over,
});
const teamBody = (over: Record<string, unknown> = {}) => ({
  packId: PACK,
  packName: 'acme',
  trusted: true,
  seats: SEATS,
  agents: [
    agentDto('mary', 'Mary', {
      suggestedSeat: 'analyst',
      skillRefs: ['brainstorm'],
      agentSkill: 'agent-mary',
      kind: 'skill',
    }),
    agentDto('dev', 'Dev', { suggestedSeat: 'builder' }),
    agentDto('muse', 'Muse'),
  ],
  skills: [
    { key: 'brainstorm', name: 'Brainstorm', description: 'Ideas', class: 'skill', marked: false },
    { key: 'review-pr', name: 'Review PR', description: 'Reviews', class: 'skill', marked: false },
    { key: 'agent-mary', name: 'Mary', description: 'Analyst', class: 'agent', marked: false },
    { key: 'ship', name: 'Ship it', description: 'Release', class: 'playbook', marked: true },
  ],
  classification: { agents: [], playbooks: ['ship'] },
  ...over,
});

const station = (runtimes: unknown[]) => ({
  id: WS,
  userId: USER,
  name: 'Desk',
  platform: 'linux',
  hostname: 'h',
  runnerVersion: '1',
  status: 'active',
  connected: true,
  lastSeenAt: null,
  runtimes,
  repos: [],
  pairedAt: new Date(0).toISOString(),
  shifts: { running: 0, limit: null },
});
const okRuntime = {
  id: 'claude-code',
  version: '1',
  available: true,
  capabilities: ['shell'],
  sandbox: 'enforced',
};
const badRuntime = {
  ...okRuntime,
  sandbox: 'unsandboxed',
  sandboxReason: 'Native Windows: allowUnsandboxed is set',
};
const role = (key: string, name: string) => ({
  definition: {
    key,
    name,
    seniorityLevels: ['senior', 'junior'],
    defaultModel: { runtime: 'claude-code', model: 'sonnet', effort: 'medium' },
  },
  orgId: null,
  status: 'active',
  extensions: null,
});

let team = teamBody();
let runtimes: unknown[] = [okRuntime];
let postResponse: Response | null = null;
let limits: { maxAgents: number | null } = { maxAgents: null };
const usage = { members: 1, projects: 1, agents: 2, workstations: 1 };
let me = 'owner';
const fetchMock = vi.fn();
const sent = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    method: (init as RequestInit)?.method ?? 'GET',
    url: url as string,
    body: (init as RequestInit)?.body ? JSON.parse(String((init as RequestInit).body)) : null,
  }));
const last = (method: string, urlPart: string) =>
  sent()
    .filter((c) => c.method === method && c.url.includes(urlPart))
    .at(-1);

beforeEach(() => {
  team = teamBody();
  runtimes = [okRuntime];
  postResponse = null;
  limits = { maxAgents: null };
  me = 'owner';
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.split('?')[0] as string;
    const method = init?.method ?? 'GET';
    if (path === `/api/packs/${PACK}/team` && method === 'GET') return json(team);
    if (path === `/api/packs/${PACK}/classification` && method === 'PUT') {
      const b = JSON.parse(String(init?.body));
      return json({ ...team, classification: b });
    }
    if (method === 'POST' && path.endsWith('/hire')) {
      if (postResponse) return postResponse;
      const b = JSON.parse(String(init?.body));
      return json(
        {
          hireId: ID(99),
          packId: PACK,
          agents: b.items.map((i: { key: string; seat: string }, n: number) => ({
            agentId: ID(200 + n),
            name: i.key === 'mary' ? 'Mary' : i.key,
            roleKey: i.seat,
            seat: i.seat,
            key: i.key,
            kind: 'persona',
            skills: [],
          })),
        },
        201,
      );
    }
    if (path === '/api/packs')
      return json({
        packs: [
          {
            id: PACK,
            name: 'acme',
            trusted: true,
            visibility: 'org',
            holders: [{ workstationId: WS, assignment: 'accepted' }],
          },
        ],
        workstationsOnline: 1,
        readableNow: true,
      });
    if (path === '/api/packs-hirable')
      return json({ packs: [{ id: PACK, name: 'acme', personaCount: 3, visibility: 'org' }] });
    if (path === '/api/workstations') return json({ workstations: [station(runtimes)] });
    if (path === '/api/roles')
      return json({
        roles: [role('analyst', 'Analyst'), role('builder', 'Builder'), role('reviewer', 'Reviewer')],
      });
    if (path === '/api/org')
      return json({
        id: USER,
        name: 'Olga org',
        role: me,
        status: 'active',
        limits,
        usage,
        planName: 'Founding',
      });
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
        orgs: [{ id: USER, name: 'Olga org', role: me, status: 'active' }],
        activeOrg: {
          id: USER,
          name: 'Olga org',
          role: me,
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
    if (path === '/api/projects')
      return json({ projects: [{ id: ID(70), key: 'APP', name: 'App', orgId: USER, orgName: null }] });
    if (path === '/api/agents/name-suggestions') return json({ names: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('skill classification', () => {
  const open = async () => {
    const user = userEvent.setup();
    wrap(<PackTeamSection packId={PACK} packName="acme" />);
    await screen.findByTestId('pack-team');
    return user;
  };

  it('groups skills by the first word of their key and the rest under Other', () => {
    const mk = (key: string) => ({ key, name: key, description: '', class: 'skill' as const, marked: false });
    const g = groupSkills([mk('web-a'), mk('web-b'), mk('web-c'), mk('solo'), mk('x-y')]);
    expect(g.map((x) => [x.name, x.items.length])).toEqual([
      ['web', 3],
      ['Other', 2],
    ]);
  });

  it('saves the full lists, and Agent and Playbook exclude each other', async () => {
    const user = await open();
    // everything is in "Other" or "review": open the groups by searching
    await user.type(screen.getByTestId('team-search'), 'r');
    await user.click(await screen.findByRole('checkbox', { name: 'Agent: Brainstorm' }));
    await user.click(screen.getByRole('checkbox', { name: 'Playbook: Brainstorm' }));
    expect(screen.getByRole('checkbox', { name: 'Agent: Brainstorm' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Agent: Review PR' }));
    await user.click(screen.getByTestId('save-classification'));
    await waitFor(() => expect(last('PUT', '/classification')).toBeTruthy());
    // the playbook the Owner marked before stays in the list: the lists are always sent in full
    expect(last('PUT', '/classification')?.body).toEqual({
      agents: ['review-pr'],
      playbooks: ['brainstorm', 'ship'],
    });
  });

  it('shows what the pack declares as agent without a toggle', async () => {
    const user = await open();
    await user.type(screen.getByTestId('team-search'), 'mary');
    const row = await screen.findByTestId('team-skill-agent-mary');
    expect(within(row).getByTestId('team-auto-agent-mary')).toHaveTextContent('Agent (found in the pack)');
    expect(within(row).queryByRole('checkbox')).toBeNull();
  });

  it('the search narrows the list', async () => {
    const user = await open();
    await user.type(screen.getByTestId('team-search'), 'ship');
    expect(await screen.findByTestId('team-skill-ship')).toBeInTheDocument();
    expect(screen.queryByTestId('team-skill-brainstorm')).toBeNull();
  });
});

describe('hire the whole pack', () => {
  const open = async () => {
    const user = userEvent.setup();
    wrap(<HirePackTeamDialog packId={PACK} packName="acme" onClose={() => {}} />);
    await screen.findByTestId('team-row-mary');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Hire Mary' })).toBeChecked());
    return user;
  };

  it('ticks the agents with a suggested seat, not the ones with an own role', async () => {
    await open();
    expect(screen.getByRole('checkbox', { name: 'Hire Dev' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Hire Muse' })).not.toBeChecked();
    expect(screen.getByTestId('adds-n')).toHaveTextContent('Adds 2 agents');
    expect(within(screen.getByTestId('team-row-muse')).getByLabelText('Seat')).toHaveValue('own');
  });

  it('a large pack starts with nothing ticked and asks to confirm a big hire', async () => {
    team = teamBody({
      agents: Array.from({ length: 40 }, (_, i) =>
        agentDto(`dev-${i}`, `Dev ${i}`, { suggestedSeat: 'builder' }),
      ),
    });
    const user = userEvent.setup();
    wrap(<HirePackTeamDialog packId={PACK} packName="acme" onClose={() => {}} />);
    await screen.findByTestId('team-row-dev-0');
    expect(screen.getByTestId('adds-n')).toHaveTextContent('Adds 0 agents');
    expect(screen.getByTestId('confirm-team-hire')).toBeDisabled();
    // only 50 rows are in the page at a time
    await user.click(screen.getByTestId('tick-suggested'));
    expect(screen.getByTestId('adds-n')).toHaveTextContent('Adds 40 agents');
    expect(screen.getByTestId('confirm-team-hire')).toBeDisabled();
    await user.click(within(screen.getByTestId('confirm-big')).getByRole('checkbox'));
    await waitFor(() => expect(screen.getByTestId('confirm-team-hire')).toBeEnabled());
  });

  it('sends the seat, count, name and skills the review shows', async () => {
    const user = await open();
    const mary = screen.getByTestId('team-row-mary');
    await user.selectOptions(within(mary).getByLabelText('Seat'), 'reviewer');
    await user.selectOptions(within(mary).getByLabelText('Count'), '3');
    await user.click(within(mary).getByRole('button', { name: 'Details' }));
    expect(within(mary).getByLabelText('Skill agent-mary (always)')).toBeDisabled();
    expect(within(mary).getByText('Hired as Mary, Mary 2, Mary 3')).toBeInTheDocument();
    expect(screen.getByTestId('adds-n')).toHaveTextContent('Adds 4 agents');
    await user.click(within(mary).getByLabelText('Skill brainstorm'));
    await user.click(screen.getByRole('checkbox', { name: 'Hire Dev' }));
    await user.click(screen.getByTestId('confirm-team-hire'));
    await screen.findByTestId('hired-list');
    expect(last('POST', '/team/hire')?.body).toMatchObject({
      workstationId: WS,
      items: [{ key: 'mary', seat: 'reviewer', count: 3, skills: [] }],
    });
    expect(last('POST', '/team/hire')?.body.items[0]).not.toHaveProperty('name');
    expect(screen.getByTestId('to-agents')).toHaveAttribute('href', '/agents');
  });

  it('keeps the submit disabled over the plan limit and says by how much', async () => {
    limits = { maxAgents: 3 };
    await open();
    expect(await screen.findByTestId('plan-room')).toHaveTextContent('2 of 3 on your plan');
    expect(await screen.findByTestId('over-limit')).toHaveTextContent('1 more than your plan allows');
    expect(screen.getByTestId('confirm-team-hire')).toBeDisabled();
  });

  it('says what a limit_reached answer means', async () => {
    const user = await open();
    postResponse = json({ error: { code: 'limit_reached', message: 'limit' } }, 409);
    await user.click(screen.getByTestId('confirm-team-hire'));
    expect(await screen.findByTestId('team-hire-error')).toHaveTextContent('no room for that many agents');
  });

  it('asks for the unsandboxed acknowledgement and sends it', async () => {
    runtimes = [badRuntime];
    const user = await open();
    const warn = await screen.findByTestId('team-sandbox-warning');
    expect(warn).toHaveTextContent('without an OS sandbox');
    expect(screen.getByTestId('confirm-team-hire')).toBeDisabled();
    await user.click(within(screen.getByTestId('team-unsandboxed')).getByRole('checkbox'));
    await user.click(screen.getByTestId('confirm-team-hire'));
    await screen.findByTestId('hired-list');
    expect(last('POST', '/team/hire')?.body.acknowledgeUnsandboxed).toBe(true);
  });

  it('shows the acknowledgement when only the server asks for it', async () => {
    const user = await open();
    postResponse = json({ error: { code: 'unsandboxed_ack_required', message: 'x' } }, 409);
    await user.click(screen.getByTestId('confirm-team-hire'));
    expect(await screen.findByTestId('team-hire-error')).toHaveTextContent('Confirm below');
    expect(await screen.findByTestId('team-unsandboxed')).toBeInTheDocument();
  });

  it('explains name_taken', async () => {
    const user = await open();
    postResponse = json({ error: { code: 'name_taken', message: 'x' } }, 409);
    await user.click(screen.getByTestId('confirm-team-hire'));
    expect(await screen.findByTestId('team-hire-error')).toHaveTextContent('already has one of these names');
  });
});

describe('hire dialog, from a pack', () => {
  it('hires one pack agent onto a seat', async () => {
    const user = userEvent.setup();
    wrap(<HireDialog open onOpenChange={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'From a pack' }));
    const form = await screen.findByTestId('hire-from-pack-form');
    await waitFor(() => expect(within(form).getByLabelText('Pack agent')).toHaveValue('mary'));
    // the suggested seat is preselected
    expect(within(form).getByLabelText('Seat')).toHaveValue('analyst');
    expect(within(form).getByLabelText('Name')).toHaveValue('Mary');
    await user.selectOptions(within(form).getByLabelText('Pack agent'), 'dev');
    expect(within(form).getByLabelText('Seat')).toHaveValue('builder');
    await user.selectOptions(within(form).getByLabelText('Seat'), 'reviewer');
    await user.click(within(form).getByRole('button', { name: 'Hire' }));
    await waitFor(() => expect(last('POST', '/agents/hire')).toBeTruthy());
    expect(last('POST', `/api/packs/${PACK}/agents/hire`)?.body).toMatchObject({
      workstationId: WS,
      allowedProjectIds: [ID(70)],
      items: [{ key: 'dev', seat: 'reviewer', count: 1 }],
    });
  });

  it('keeps the built-in path as it was', async () => {
    wrap(<HireDialog open onOpenChange={() => {}} />);
    expect(await screen.findByRole('form', { name: 'Hire agent' })).toBeInTheDocument();
    expect(screen.queryByTestId('hire-from-pack-form')).toBeNull();
  });
});

describe('agent tag', () => {
  const prov = {
    packId: PACK,
    packName: 'acme',
    capability: 'mary',
    ref: null,
    sha: 'abc1234',
    visibility: 'org' as const,
    label: 'ACME · mary · abc1234',
    warning: null,
  };
  const ref = {
    packId: PACK,
    packName: 'acme',
    key: 'mary',
    kind: 'persona' as const,
    name: 'Amelia',
    sha: 'abc1234',
    ref: null,
  };
  it('reads "<pack agent> · <pack> agent"', () => {
    wrap(<PackProvenance agent={{ packAgent: ref, provenance: prov as never }} />);
    expect(screen.getByTestId('pack-agent-tag')).toHaveTextContent('Amelia · acme agent');
  });
  it('shows the revoked and removed warnings', () => {
    const { unmount } = wrap(
      <PackProvenance agent={{ packAgent: ref, provenance: { ...prov, warning: 'revoked' } as never }} />,
    );
    expect(screen.getByTestId('pack-provenance-warning')).toHaveTextContent('no longer approved');
    unmount();
    wrap(<PackProvenance agent={{ packAgent: ref, provenance: { ...prov, warning: 'removed' } as never }} />);
    expect(screen.getByTestId('pack-provenance-warning')).toHaveTextContent('pack removed');
  });
  it('keeps the older tag for a persona turned into a role', () => {
    wrap(<PackProvenance agent={{ provenance: prov as never }} />);
    expect(screen.getByTestId('pack-provenance')).toHaveTextContent('ACME · mary · abc1234');
  });
});
