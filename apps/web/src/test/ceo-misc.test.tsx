import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskCeoButton } from '../components/ceo/AskCeoButton.tsx';
import { buildNav } from '../components/shell/nav-config.ts';
import { Agents } from '../pages/Agents.tsx';
import { ceoStatus, jsonRes, meFor, stubApi, U } from './ceo-fixtures.tsx';

afterEach(() => vi.unstubAllGlobals());

describe('navigation', () => {
  const ids = (canManage: boolean) =>
    buildNav({ projectKey: null, canManage }).sections.flatMap((s) => s.items.map((i) => i.id));
  it('lists the CEO page under Organization for Owners and Admins only', () => {
    expect(ids(true)).toContain('ceo');
    expect(ids(false)).not.toContain('ceo');
    const org = buildNav({ projectKey: null, canManage: true }).sections.find(
      (s) => s.label === 'Organization',
    );
    expect(org?.items.find((i) => i.id === 'ceo')?.to).toBe('/org/ceo');
  });
  it('keeps Roles & workflows from lighting up on the CEO page', () => {
    const org = buildNav({ projectKey: null, canManage: true }).sections.find(
      (s) => s.label === 'Organization',
    );
    const roles = org?.items.find((i) => i.id === 'org');
    expect(roles?.match?.('/org')).toBe(true);
    expect(roles?.match?.('/org/ceo')).toBe(false);
  });
  it('highlights only the current entry on a project page: Board stays dark on Backlog, Environments and Research', () => {
    const work =
      buildNav({ projectKey: 'SHOP', hasResearch: true, hasEnvironments: true }).sections[0]?.items ?? [];
    const lit = (path: string) => work.filter((e) => e.match?.(path)).map((e) => e.id);
    expect(lit('/p/SHOP/board')).toEqual(['board']);
    expect(lit('/cards/SHOP-3')).toEqual(['board']);
    expect(lit('/p/SHOP/backlog')).toEqual(['backlog']);
    expect(lit('/p/SHOP/environments')).toEqual(['environments']);
    expect(lit('/p/SHOP/research')).toEqual(['research']);
  });
});

function Shell() {
  return (
    <Routes>
      <Route path="/" element={<AskCeoButton />} />
      <Route path="/ceo-chat/:id" element={<p data-testid="chat-page">chat</p>} />
    </Routes>
  );
}
const mountAsk = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <Shell />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('Ask <CEO> in the top bar', () => {
  it('opens the standing chat for the Owner', async () => {
    const calls = stubApi('owner', [
      ['GET /api/ceo/status', () => ceoStatus()],
      ['POST /api/ceo/chat', () => ({ threadId: U(88) })],
    ]);
    mountAsk();
    await userEvent.click(await screen.findByRole('button', { name: 'Ask Cora' }));
    expect(await screen.findByTestId('chat-page')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/ceo/chat')).toBe(true);
  });

  it('is absent for an Admin, which never even fetches the status', async () => {
    const calls = stubApi('admin', [['GET /api/ceo/status', () => ceoStatus()]]);
    mountAsk();
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId('ask-ceo-button')).toBeNull();
    expect(calls.some((c) => c.url === '/api/ceo/status')).toBe(false);
  });

  it('is absent without a CEO or when it is disabled', async () => {
    stubApi('owner', [['GET /api/ceo/status', () => ceoStatus({ state: 'disabled' })]]);
    mountAsk();
    await new Promise((r) => setTimeout(r, 40));
    expect(screen.queryByTestId('ask-ceo-button')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- Agents page

const agentRow = (n: number, name: string, roleKey: string, over: Record<string, unknown> = {}) => ({
  agent: {
    id: U(100 + n),
    orgId: U(1),
    hiredForProjectId: null,
    allowedProjectIds: null,
    focusProjectIds: [],
    hiredByUserId: U(1),
    managerUserId: U(1),
    workstationId: null,
    name,
    roleKey,
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
    agentId: U(100 + n),
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
const roleDef = (key: string, name: string) => ({
  definition: {
    key,
    name,
    seniorityLevels: ['junior'],
    defaultModel: { runtime: 'mock', model: 'm' },
  },
  orgId: null,
  status: 'active',
  extensions: null,
});

function mountAgents() {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      if (path === '/api/auth/me') return jsonRes(meFor('owner'));
      if (path === '/api/hr/board')
        return jsonRes({
          windowDays: 30,
          agents: [
            agentRow(1, 'Una', 'builder', {
              pausedAt: '2026-10-13T10:00:00.000Z',
              pauseReason: 'looping on TOY-4',
              pausedByCeo: true,
            }),
            agentRow(2, 'Ede', 'builder'),
            agentRow(3, 'Cora', 'ceo', { department: 'management' }),
          ],
          recommendations: [],
          roleUpdates: [],
        });
      if (path === '/api/roles')
        return jsonRes({ roles: [roleDef('builder', 'Builder'), roleDef('ceo', 'Chief executive')] });
      if (path === '/api/workstations') return jsonRes({ workstations: [] });
      if (path === '/api/agents') return jsonRes({ agents: [] });
      if (path === '/api/projects') return jsonRes({ projects: [] });
      return jsonRes({});
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Agents />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('the agents page and the CEO', () => {
  it('shows a Paused badge with who paused it and why, and resumes it', async () => {
    const calls = mountAgents();
    const una = await screen.findByTestId('agent-Una');
    const badge = await within(una).findByTestId('agent-paused');
    expect(badge).toHaveTextContent('Paused by the CEO');
    expect(badge).toHaveAttribute('title', 'looping on TOY-4');
    await userEvent.click(within(una).getByRole('button', { name: 'Resume Una' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/agents/${U(101)}/resume`)).toBe(true),
    );
    expect(within(screen.getByTestId('agent-Ede')).queryByTestId('agent-paused')).toBeNull();
    await userEvent.click(within(screen.getByTestId('agent-Ede')).getByRole('button', { name: 'Pause Ede' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/agents/${U(102)}/pause`)).toBe(true),
    );
  });

  it('never offers to fire the CEO: it points to the CEO page instead', async () => {
    mountAgents();
    const cora = await screen.findByTestId('agent-Cora');
    expect(within(cora).queryByRole('button', { name: 'Fire Cora' })).toBeNull();
    expect(within(cora).getByRole('link', { name: 'Manage on the CEO page' })).toHaveAttribute(
      'href',
      '/org/ceo',
    );
    expect(
      within(screen.getByTestId('agent-Ede')).getByRole('button', { name: 'Fire Ede' }),
    ).toBeInTheDocument();
  });

  it('does not list the CEO role on the hire form', async () => {
    mountAgents();
    await userEvent.click(await screen.findByRole('button', { name: 'Hire agent' }));
    const form = await screen.findByRole('form', { name: 'Hire agent' });
    const select = await within(form).findByLabelText('Role');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Builder']);
  });
});
