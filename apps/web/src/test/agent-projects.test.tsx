import type { AgentDto, ProjectDetailResponse, ProjectDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowedProjectsDialog, WorksOn } from '../components/agents/ProjectAccess.tsx';
import { ConcurrencyCapPanel } from '../components/ConcurrencyCapPanel.tsx';

const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const OTHER_ORG = '0192f3a0-0000-7000-8000-0000000000a2';
const P1 = '0192f3a0-0000-7000-8000-000000000001';
const P2 = '0192f3a0-0000-7000-8000-000000000002';
const P3 = '0192f3a0-0000-7000-8000-000000000003';
const G1 = '0192f3a0-0000-7000-8000-000000000009';

const project = (id: string, key: string, over: Partial<ProjectDto> = {}): ProjectDto => ({
  id,
  orgId: ORG,
  orgName: 'Acme',
  key,
  name: `${key} project`,
  workflowKey: 'code',
  rank: 1,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
  ...over,
});
const PROJECTS = [project(P1, 'TOY'), project(P2, 'WEB'), project(P3, 'API')];

const agent = (over: Partial<AgentDto> = {}): AgentDto => ({
  id: '0192f3a0-0000-7000-8000-0000000000c1',
  orgId: ORG,
  hiredForProjectId: null,
  allowedProjectIds: null,
  focusProjectIds: [],
  hiredByUserId: ORG,
  managerUserId: ORG,
  workstationId: null,
  name: 'Ada',
  roleKey: 'builder',
  roleVersion: 1,
  seniority: 'junior',
  runtime: 'mock',
  model: 'mock',
  effort: null,
  skills: [],
  permissions: {
    allowedTools: [],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: true,
    browser: false,
    riskTiers: ['small', 'large'],
    repoIds: null,
  },
  capacity: 1,
  isDevops: false,
  status: 'active',
  hiredAt: '2026-10-01T10:00:00.000Z',
  retiredAt: null,
  lastShiftEndedAt: null,
  activeCards: [],
  ...over,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => json({ agent: agent() }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => [
    (init as RequestInit).method,
    url as string,
    JSON.parse(String((init as RequestInit).body ?? 'null')),
  ]);

describe('"Works on" on the agent card', () => {
  it('says any project, a list with the preferred ones starred, or benched', () => {
    const { rerender } = wrap(<WorksOn agent={agent()} projects={PROJECTS} />);
    expect(screen.getByTestId('agent-works-on')).toHaveTextContent('any project');
    const qc = new QueryClient();
    const again = (a: AgentDto) =>
      rerender(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <WorksOn agent={a} projects={PROJECTS} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    again(agent({ allowedProjectIds: [P1, P2], focusProjectIds: [P2] }));
    const text = screen.getByTestId('agent-works-on').textContent ?? '';
    expect(text).toContain('TOY');
    expect(text).toContain('WEB');
    expect(text).not.toContain('API');
    again(agent({ allowedProjectIds: [] }));
    expect(screen.getByTestId('agent-works-on')).toHaveTextContent('no project (benched)');
    again(agent({ isDevops: true }));
    expect(screen.getByText(/DevOps requests and repository checks only/)).toBeInTheDocument();
  });
});

describe('allowed projects dialog', () => {
  it('saves a picked list and the preferred project', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    wrap(<AllowedProjectsDialog agent={agent()} projects={PROJECTS} canAny onClose={onClose} />);
    const form = await screen.findByRole('form', { name: 'Allowed projects' });
    await user.click(within(form).getByRole('button', { name: 'Selected projects' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Allow TOY' }));
    await user.click(within(form).getByRole('checkbox', { name: 'Allow WEB' }));
    await user.click(within(form).getByRole('button', { name: 'Prefer WEB' }));
    await user.click(within(form).getByTestId('allowed-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls()).toEqual([
      ['PUT', '/api/agents/0192f3a0-0000-7000-8000-0000000000c1/allowed-projects', { projectIds: [P1, P2] }],
      ['PUT', '/api/agents/0192f3a0-0000-7000-8000-0000000000c1/focus-projects', { projectIds: [P2] }],
    ]);
  });

  it('un-picking a project drops its star; "any project" sends null', async () => {
    const user = userEvent.setup();
    wrap(
      <AllowedProjectsDialog
        agent={agent({ allowedProjectIds: [P1, P2], focusProjectIds: [P2] })}
        projects={PROJECTS}
        canAny
        onClose={() => undefined}
      />,
    );
    const form = await screen.findByRole('form', { name: 'Allowed projects' });
    await user.click(within(form).getByRole('checkbox', { name: 'Allow WEB' }));
    expect(within(form).queryByRole('button', { name: 'Stop preferring WEB' })).not.toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Prefer API' })).toBeDisabled(); // not allowed: cannot be preferred
    await user.click(within(form).getByRole('button', { name: 'Any project' }));
    await user.click(within(form).getByTestId('allowed-save'));
    await waitFor(() => expect(calls().length).toBe(2));
    expect(calls()[0]?.[2]).toEqual({ projectIds: null });
  });

  it('offers "any project" only to the organization Owner and Admins', async () => {
    wrap(
      <AllowedProjectsDialog
        agent={agent({ allowedProjectIds: [P1] })}
        projects={PROJECTS}
        canAny={false}
        onClose={() => undefined}
      />,
    );
    await screen.findByRole('form', { name: 'Allowed projects' });
    expect(screen.queryByRole('button', { name: 'Any project' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Selected projects' })).toBeInTheDocument();
  });

  it("only the agent's organization projects are listed; a guest project of another org is not", async () => {
    wrap(
      <AllowedProjectsDialog
        agent={agent({ allowedProjectIds: [P1] })}
        projects={[...PROJECTS, project(G1, 'SHR', { orgId: OTHER_ORG, orgName: 'Elsewhere' })]}
        canAny
        onClose={() => undefined}
      />,
    );
    const form = await screen.findByRole('form', { name: 'Allowed projects' });
    expect(within(form).getByRole('checkbox', { name: 'Allow TOY' })).toBeInTheDocument();
    expect(within(form).queryByRole('checkbox', { name: 'Allow SHR' })).not.toBeInTheDocument();
  });
});

describe('simultaneous shifts panel (project settings)', () => {
  const detail = (cap: number | null) =>
    ({ ...project(P1, 'TOY'), maxConcurrentShifts: cap }) as ProjectDetailResponse['project'];

  it('is off by default and saves a limit, then removes it', async () => {
    const user = userEvent.setup();
    const { rerender } = wrap(<ConcurrencyCapPanel projectId={P1} project={detail(null)} />);
    expect(screen.getByTestId('concurrency-state')).toHaveTextContent('No limit');
    expect(screen.getByTestId('concurrency-save')).toBeDisabled();
    expect(screen.queryByTestId('concurrency-clear')).not.toBeInTheDocument();
    await user.type(screen.getByTestId('concurrency-input'), '2');
    await user.click(screen.getByTestId('concurrency-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(calls()[0]).toEqual(['PUT', `/api/projects/${P1}/concurrency-cap`, { cap: 2 }]);

    const qc = new QueryClient();
    rerender(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ConcurrencyCapPanel projectId={P1} project={detail(2)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('concurrency-state')).toHaveTextContent('At most 2 at once');
    await user.click(screen.getByTestId('concurrency-clear'));
    await waitFor(() => expect(calls().length).toBe(2));
    expect(calls()[1]).toEqual(['PUT', `/api/projects/${P1}/concurrency-cap`, { cap: null }]);
  });

  it('refuses nonsense before calling the server', async () => {
    const user = userEvent.setup();
    wrap(<ConcurrencyCapPanel projectId={P1} project={detail(null)} />);
    await user.type(screen.getByTestId('concurrency-input'), '0');
    expect(screen.getByText('Enter a whole number from 1 to 50')).toBeInTheDocument();
    expect(screen.getByTestId('concurrency-save')).toBeDisabled();
  });
});
