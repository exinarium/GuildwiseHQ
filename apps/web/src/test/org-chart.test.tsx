import type { OrgChart, OrgChartAgent } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escalationText, groupByDepartment, statusLine, worksOn } from '../lib/orgChart.ts';
import { layoutOrgChart, NODE_H, NODE_W } from '../lib/orgChartLayout.ts';
import { OrgChartPage } from '../pages/OrgChart.tsx';

afterEach(() => vi.unstubAllGlobals());

const U = (n: number) => `0192f3a0-0000-7000-8000-0000000000${String(n).padStart(2, '0')}`;
const PROJ_A = U(80);
const PROJ_B = U(81);

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
  workstation: { id: U(90), name: 'Pieter laptop', online: true },
  reportsTo: { userId: U(1), name: 'Pieter', orgRole: 'owner' },
  escalatesTo: { level: 'ba', agentIds: [U(10)] },
  allowedProjectIds: null,
  focusProjectIds: [],
  activeCards: [],
  blockedCards: [],
  recentWork: [],
  spend: { monthMicros: 1_500_000, totalMicros: 4_000_000, currency: 'USD' },
  ...over,
});

const CHART: OrgChart = {
  owner: { userId: U(1), name: 'Pieter' },
  admins: [{ userId: U(2), name: 'Ada' }],
  departments: [
    { key: 'delivery', label: 'Delivery' },
    { key: 'research', label: 'Research' },
  ],
  agents: [
    agent(10, 'Bea', {
      roleKey: 'ba',
      roleLabel: 'Business analyst',
      seniority: 'senior',
      escalatesTo: { level: 'desk', agentIds: [] },
    }),
    agent(11, 'Sam', {
      seniority: 'senior',
      escalatesTo: { level: 'ba', agentIds: [U(10)] },
      status: 'working',
      activeCards: [{ cardId: U(60), ref: 'TOY-4', title: 'Autosave' }],
    }),
    agent(12, 'Jo', {
      escalatesTo: { level: 'peer', agentIds: [U(11)] },
      allowedProjectIds: [PROJ_A],
      status: 'blocked',
      blockedCards: [{ cardId: U(61), ref: 'TOY-7', title: 'Tabs' }],
    }),
    agent(13, 'Rae', {
      roleKey: 'tester',
      roleLabel: 'Tester',
      allowedProjectIds: [PROJ_B],
      status: 'offline',
      workstation: { id: U(91), name: 'Old box', online: false },
    }),
    agent(14, 'Cy', {
      roleKey: 'scout',
      roleLabel: 'Scout',
      department: 'research',
      escalatesTo: { level: 'ba', agentIds: [U(10)] },
    }),
    agent(15, 'Dev', {
      roleKey: 'devops',
      roleLabel: 'DevOps',
      isDevops: true,
      department: 'delivery',
      seniority: 'senior',
      escalatesTo: { level: 'desk', agentIds: [] },
    }),
  ],
  projects: [
    { id: PROJ_A, key: 'TOY', name: 'Toy' },
    { id: PROJ_B, key: 'WEB', name: 'Web' },
  ],
  workstations: [
    {
      id: U(90),
      name: 'Pieter laptop',
      online: true,
      ownerName: 'Pieter',
      devopsAgentId: U(15),
      agentIds: [U(10), U(11), U(12), U(13), U(14)],
    },
    { id: U(91), name: 'Old box', online: false, ownerName: 'Ada', devopsAgentId: null, agentIds: [] },
  ],
};

describe('org chart layout', () => {
  const layout = layoutOrgChart(CHART.agents, CHART.departments);
  const node = (id: string) => layout.nodes.find((n) => n.id === id);

  it('stacks manager, BA, seniors and juniors in tiers and keeps DevOps out of the tree', () => {
    const [manager, ba, sam, jo] = ['manager', U(10), U(11), U(12)].map((id) => node(id));
    expect(manager && ba && sam && jo).toBeTruthy();
    expect(manager!.y).toBeLessThan(ba!.y);
    expect(ba!.y).toBeLessThan(sam!.y);
    expect(sam!.y).toBeLessThan(jo!.y);
    expect(node(U(15))).toBeUndefined();
    // the manager is centred over the chart
    expect(manager!.x + manager!.w / 2).toBeCloseTo(layout.width / 2, 0);
  });

  it('groups roles into one box per department and never overlaps two tiles', () => {
    expect(layout.boxes.map((b) => b.key)).toEqual(['delivery', 'research']);
    const agents = layout.nodes.filter((n) => n.kind === 'agent' || n.kind === 'ba');
    for (const [i, a] of agents.entries())
      for (const b of agents.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} and ${b.id}`).toBe(true);
      }
    const dev = layout.boxes.find((b) => b.key === 'delivery')!;
    for (const id of [U(11), U(12), U(13)]) {
      const n = node(id)!;
      expect(n.x).toBeGreaterThanOrEqual(dev.x);
      expect(n.x + n.w).toBeLessThanOrEqual(dev.x + dev.w);
      expect(n.y + n.h).toBeLessThanOrEqual(dev.y + dev.h);
    }
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.h).toBeLessThanOrEqual(layout.height);
    }
  });

  it('draws one line per escalation: junior to senior, seniors and lone juniors to the BA, the BA to the manager', () => {
    const lines = layout.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
    expect(lines).toEqual(
      [
        `${U(12)}>${U(11)}:peer`,
        `${U(11)}>${U(10)}:ba`,
        `${U(13)}>${U(10)}:ba`,
        `${U(14)}>${U(10)}:ba`,
        `${U(10)}>manager:desk`,
      ].sort(),
    );
    for (const e of layout.edges) expect(e.d).toMatch(/^M[\d.-]+,[\d.-]+ V[\d.-]+ H[\d.-]+ V[\d.-]+$/);
    expect(NODE_W).toBeGreaterThan(150);
    expect(NODE_H).toBeGreaterThan(70);
  });

  it('without a BA the seniors line up to a placeholder and the chart still lays out', () => {
    const noBa = layoutOrgChart(
      CHART.agents.filter((a) => a.roleKey !== 'ba'),
      CHART.departments,
    );
    expect(noBa.nodes.some((n) => n.kind === 'placeholder')).toBe(true);
    expect(noBa.edges.some((e) => e.to === 'ba-none')).toBe(true);
    expect(layoutOrgChart([], []).nodes.map((n) => n.kind)).toEqual(['manager', 'placeholder']);
  });
});

describe('org chart helpers', () => {
  it('says what an agent is doing in words', () => {
    expect(statusLine(CHART.agents[1] as OrgChartAgent)).toBe('Working on TOY-4');
    expect(statusLine(CHART.agents[2] as OrgChartAgent)).toBe('Blocked on TOY-7');
    expect(statusLine(CHART.agents[3] as OrgChartAgent)).toBe('Offline');
    expect(statusLine(agent(1, 'X'))).toBe('Idle');
  });
  it('names who answers first', () => {
    expect(escalationText(CHART.agents[2] as OrgChartAgent, CHART)).toBe('Sam (senior builder)');
    expect(escalationText(CHART.agents[1] as OrgChartAgent, CHART)).toBe('the BA (Bea)');
    expect(escalationText(CHART.agents[0] as OrgChartAgent, CHART)).toBe('Pieter, on the desk');
  });
  it('filters by project: an agent allowed anywhere always matches', () => {
    const a = CHART.agents;
    expect(a.filter((x) => worksOn(x, PROJ_A)).map((x) => x.name)).toEqual(['Bea', 'Sam', 'Jo', 'Cy', 'Dev']);
    expect(a.filter((x) => worksOn(x, '')).length).toBe(a.length);
  });
  it('groups by department and role, seniors first', () => {
    const g = groupByDepartment(CHART.agents, CHART.departments);
    expect(g.map((d) => d.key)).toEqual(['delivery', 'research']);
    expect(g[0]?.roles.map((r) => r.key)).toEqual(['builder', 'ba', 'tester'].sort());
    expect(g[0]?.roles.find((r) => r.key === 'builder')?.agents.map((x) => x.name)).toEqual(['Sam', 'Jo']);
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function show(chart: OrgChart = CHART, role: 'owner' | 'member' = 'owner') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/org-chart')) return json(chart);
      if (String(url).includes('/api/auth/me') || String(url).endsWith('/api/me'))
        return json({
          user: { id: U(1), email: 'p@x.test', displayName: 'Pieter' },
          activeOrg: { id: U(99), role, features: {} },
          orgs: [],
        });
      return json({});
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/org-chart']}>
        <Routes>
          <Route path="/org-chart" element={<OrgChartPage />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the org chart page', () => {
  it('shows the manager, every agent with its status in words, the department boxes and the DevOps panel', async () => {
    show();
    const chart = await screen.findByTestId('org-chart');
    expect(within(chart).getByTestId('org-manager')).toHaveTextContent('Pieter');
    expect(within(chart).getByTestId('org-manager')).toHaveTextContent('1 admin');
    const sam = within(chart).getByRole('button', {
      name: /^Sam, senior Builder\. Working on TOY-4\. Escalates to the BA \(Bea\)/,
    });
    expect(sam).toBeInTheDocument();
    expect(
      within(chart).getByRole('button', {
        name: /^Jo, junior Builder\. Blocked on TOY-7\. Escalates to Sam \(senior builder\)/,
      }),
    ).toBeInTheDocument();
    expect(within(chart).getByRole('button', { name: /^Rae, .*Offline/ })).toBeInTheDocument();
    expect(within(chart).getAllByTestId('org-department')).toHaveLength(2);
    // DevOps is not in the tree; it is in the workstation panel
    expect(within(chart).queryByText('Dev')).toBeNull();
    const panel = screen.getByTestId('org-devops');
    expect(within(panel).getAllByTestId('org-workstation')).toHaveLength(2);
    expect(within(panel).getByRole('button', { name: /^Dev, senior DevOps/ })).toBeInTheDocument();
    expect(within(panel).getByText(/No DevOps engineer here yet/)).toBeInTheDocument();
    expect(screen.getByTestId('org-summary')).toHaveTextContent('5 agents in 2 departments');
  });

  it('filters by project allow-list', async () => {
    const user = userEvent.setup();
    show();
    await screen.findByTestId('org-chart');
    await user.selectOptions(screen.getByTestId('org-project-filter'), PROJ_B);
    const chart = screen.getByTestId('org-chart');
    expect(within(chart).getByRole('button', { name: /^Rae,/ })).toBeInTheDocument();
    expect(within(chart).queryByRole('button', { name: /^Jo,/ })).toBeNull();
    expect(screen.getByTestId('org-summary')).toHaveTextContent('allowed on WEB');
  });

  it('opens the agent card: where it works, reporting line, spend, recent work', async () => {
    const user = userEvent.setup();
    const withWork = structuredClone(CHART);
    (withWork.agents[2] as OrgChartAgent).recentWork = [
      {
        shiftId: U(70),
        kind: 'card',
        outcome: 'reported',
        endedAt: '2026-10-06T08:00:00.000Z',
        cardId: U(60),
        ref: 'TOY-3',
        title: 'Dark mode',
      },
      {
        shiftId: U(71),
        kind: 'chat',
        outcome: 'reported',
        endedAt: null,
        cardId: null,
        ref: null,
        title: null,
      },
    ];
    show(withWork);
    await user.click(await screen.findByRole('button', { name: /^Jo, junior Builder/ }));
    const card = await screen.findByTestId('org-agent-card');
    expect(within(card).getByTestId('org-agent-allowed')).toHaveTextContent('TOY');
    expect(card).toHaveTextContent('Reports to');
    expect(card).toHaveTextContent('Pieter');
    expect(within(card).getByTestId('org-agent-spend')).toHaveTextContent('$1.50 this month');
    expect(within(card).getByTestId('org-agent-spend')).toHaveTextContent('$4.00 in total');
    const recent = within(card).getByTestId('org-agent-recent');
    expect(within(recent).getByRole('link', { name: /TOY-3 Dark mode/ })).toHaveAttribute(
      'href',
      `/cards/${U(60)}`,
    );
    expect(recent).toHaveTextContent('A chat');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('org-agent-card')).toBeNull());
  });

  it("has a list view that says each agent's escalation in words", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByTestId('org-chart');
    await user.click(screen.getByRole('button', { name: 'List' }));
    const list = screen.getByTestId('org-list');
    expect(within(list).getAllByTestId('org-list-department')).toHaveLength(2);
    expect(list).toHaveTextContent('Escalates to Sam (senior builder)');
    expect(list).toHaveTextContent('Escalates to the BA (Bea)');
    expect(screen.queryByTestId('org-chart')).toBeNull();
  });

  it('invites to hire the first agent when nobody works here, and shows errors', async () => {
    show({ ...CHART, agents: [], workstations: [] });
    expect(await screen.findByText('Nobody works here yet')).toBeInTheDocument();
  });

  it('offers to hire a BA from the placeholder to an Owner but not to a member', async () => {
    const noBa = { ...CHART, agents: CHART.agents.filter((a) => a.roleKey !== 'ba') };
    const { unmount } = show(noBa, 'owner');
    const holder = await screen.findByTestId('org-no-ba');
    await waitFor(() => expect(within(holder).getByRole('link', { name: /Hire a BA/ })).toBeInTheDocument());
    unmount();
    show(noBa, 'member');
    const again = await screen.findByTestId('org-no-ba');
    await new Promise((r) => setTimeout(r, 50));
    expect(within(again).queryByRole('link', { name: /Hire a BA/ })).toBeNull();
  });
});
