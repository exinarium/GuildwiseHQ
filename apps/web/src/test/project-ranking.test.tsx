import { BUILTIN_WORKFLOWS, type ProjectDto } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moveTo, ProjectRankList } from '../components/ProjectRankList.tsx';
import { ToastProvider } from '../components/ui.tsx';
import { Projects } from '../pages/Projects.tsx';

const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const OTHER_ORG = '0192f3a0-0000-7000-8000-0000000000a2';
const id = (n: number) => `0192f3a0-0000-7000-8000-00000000010${n}`;
const mk = (n: number, key: string, over: Partial<ProjectDto> = {}): ProjectDto => ({
  id: id(n),
  orgId: ORG,
  key,
  name: `Project ${key}`,
  workflowKey: 'code',
  rank: n,
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
const PROJECTS = [mk(1, 'AAA'), mk(2, 'BBB'), mk(3, 'CCC'), mk(4, 'DDD')];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (role: string) => ({
  user: { id: id(9), email: 'a@b.test', displayName: 'A', role: 'member' },
  isAdmin: false,
  orgs: [{ id: ORG, name: 'Acme', status: 'active', role }],
  activeOrg: { id: ORG, name: 'Acme', status: 'active', role },
  visibleProjectIds: [],
});

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const rankCalls = () =>
  fetchMock.mock.calls
    .filter(([u, i]) => String(u) === '/api/projects/ranking' && (i as RequestInit)?.method === 'PUT')
    .map(([, i]) => JSON.parse(String((i as RequestInit).body)).projectIds as string[]);

function page(role: string, projects: ProjectDto[] = PROJECTS, rankStatus = 200, workflows: unknown[] = []) {
  let current = projects;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return json(me(role));
    if (url === '/api/projects/ranking' && init?.method === 'PUT') {
      if (rankStatus !== 200)
        return json({ error: { code: 'ranking_stale', message: 'The projects changed' } }, rankStatus);
      const ids = JSON.parse(String(init.body)).projectIds as string[];
      current = ids.map((i, n) => ({ ...(current.find((p) => p.id === i) as ProjectDto), rank: n + 1 }));
      return json({ projects: current });
    }
    if (url.startsWith('/api/projects?status=archived')) return json({ projects: [] });
    if (url.startsWith('/api/projects')) return json({ projects: current });
    if (url.includes('invitations')) return json({ invitations: [] });
    if (url.startsWith('/api/workflows')) return json({ workflows });
    return json({});
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Projects />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const order = () =>
  within(screen.getByTestId('project-rank-list'))
    .getAllByRole('listitem')
    .map((li) => li.getAttribute('data-testid')?.replace('rank-row-', ''));

describe('moveTo', () => {
  it('moves one id to a position and leaves the rest in order', () => {
    expect(moveTo(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTo(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
  });
  it('returns the same list for no move or an impossible one', () => {
    const l = ['a', 'b'];
    expect(moveTo(l, 'a', 0)).toBe(l);
    expect(moveTo(l, 'b', 5)).toBe(l);
    expect(moveTo(l, 'zz', 0)).toBe(l);
    expect(moveTo(l, 'a', -1)).toBe(l);
  });
});

describe('the Projects page: priority order', () => {
  it('lists the organization projects in rank order with their position', async () => {
    page('owner');
    await screen.findByTestId('project-rank-list');
    expect(order()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(screen.getByTestId('rank-number-CCC')).toHaveTextContent('3');
    expect(screen.getByRole('heading', { name: 'Priority order' })).toBeInTheDocument();
  });

  it('the move buttons reorder, announce the move, keep the focus and save the order', async () => {
    const user = userEvent.setup();
    page('owner');
    await screen.findByTestId('project-rank-list');
    expect(screen.getByRole('button', { name: 'Move Project AAA up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Project DDD down' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move Project CCC up' }));
    await waitFor(() => expect(rankCalls()).toEqual([[id(1), id(3), id(2), id(4)]]));
    expect(order()).toEqual(['AAA', 'CCC', 'BBB', 'DDD']);
    expect(screen.getByTestId('rank-announce')).toHaveTextContent('Project CCC moved to position 2 of 4');
    // the control that was used keeps the focus in the new place
    expect(screen.getByRole('button', { name: 'Move Project CCC up' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Move Project CCC up' }));
    await waitFor(() => expect(rankCalls()).toHaveLength(2));
    expect(order()).toEqual(['CCC', 'AAA', 'BBB', 'DDD']);
    expect(screen.getByRole('button', { name: 'Move Project CCC up' })).toBeDisabled();
    expect(screen.getByTestId('rank-number-CCC')).toHaveTextContent('1');
  });

  it('the grip answers the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    page('owner');
    await screen.findByTestId('project-rank-list');
    const grip = screen.getByTestId('rank-grip-BBB');
    grip.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(rankCalls().at(-1)).toEqual([id(1), id(3), id(2), id(4)]));
    expect(screen.getByTestId('rank-grip-BBB')).toHaveFocus();
    await user.keyboard('{Home}');
    await waitFor(() => expect(rankCalls().at(-1)).toEqual([id(2), id(1), id(3), id(4)]));
    await user.keyboard('{End}');
    await waitFor(() => expect(rankCalls().at(-1)).toEqual([id(1), id(3), id(4), id(2)]));
    expect(order()).toEqual(['AAA', 'CCC', 'DDD', 'BBB']);
  });

  it('presses in a quick burst each act on the order the previous one made, and the saves run in order', async () => {
    const user = userEvent.setup();
    page('owner');
    await screen.findByTestId('project-rank-list');
    screen.getByTestId('rank-grip-DDD').focus();
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}');
    await waitFor(() => expect(rankCalls()).toHaveLength(3));
    expect(rankCalls()).toEqual([
      [id(1), id(2), id(4), id(3)],
      [id(1), id(4), id(2), id(3)],
      [id(4), id(1), id(2), id(3)],
    ]);
    expect(order()).toEqual(['DDD', 'AAA', 'BBB', 'CCC']);
  });

  it('dragging a row onto another moves it there', async () => {
    page('owner');
    await screen.findByTestId('project-rank-list');
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: (k: string, v: string) => void data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
    };
    const from = screen.getByTestId('rank-row-DDD');
    const to = screen.getByTestId('rank-row-BBB');
    expect(from).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(from, { dataTransfer });
    fireEvent.dragOver(to, { dataTransfer });
    fireEvent.drop(to, { dataTransfer });
    fireEvent.dragEnd(from, { dataTransfer });
    await waitFor(() => expect(rankCalls()).toEqual([[id(1), id(4), id(2), id(3)]]));
    expect(order()).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
  });

  it('an Admin can rank; a Member sees the order and no controls', async () => {
    page('admin');
    await screen.findByTestId('project-rank-list');
    expect(screen.getByTestId('rank-up-BBB')).toBeInTheDocument();
  });

  it('a Member sees the order read-only: no grip, no buttons, rows are not draggable', async () => {
    page('member');
    await screen.findByTestId('project-rank-list');
    expect(order()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(screen.queryByTestId('rank-grip-AAA')).toBeNull();
    expect(screen.queryByTestId('rank-up-BBB')).toBeNull();
    expect(screen.getByTestId('rank-row-AAA')).toHaveAttribute('draggable', 'false');
    expect(screen.getByTestId('rank-number-BBB')).toHaveTextContent('2');
  });

  it('a failed save puts the old order back and says so', async () => {
    const user = userEvent.setup();
    page('owner', PROJECTS, 409);
    await screen.findByTestId('project-rank-list');
    await user.click(screen.getByRole('button', { name: 'Move Project BBB down' }));
    await waitFor(() => expect(rankCalls()).toHaveLength(1));
    await screen.findByText(/The order was not saved/);
    await waitFor(() => expect(order()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']));
  });

  it("projects of other organizations (a guest's) are listed apart and cannot be ranked", async () => {
    page('owner', [...PROJECTS, mk(5, 'GST', { orgId: OTHER_ORG, orgName: 'Elsewhere', myRole: 'manager' })]);
    await screen.findByTestId('project-rank-list');
    expect(order()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(await screen.findByRole('heading', { name: 'Shared with you' })).toBeInTheDocument();
    expect(screen.queryByTestId('rank-row-GST')).toBeNull();
    expect(screen.getByText('Project GST')).toBeInTheDocument();
  });
});

describe('ProjectRankList on its own', () => {
  it('does not offer to reorder while a filter hides projects', () => {
    const onReorder = vi.fn();
    render(
      <MemoryRouter>
        <ProjectRankList
          projects={PROJECTS.slice(0, 2)}
          canRank
          disabledReason="Clear the filter to change the order."
          onReorder={onReorder}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Clear the filter to change the order.')).toBeInTheDocument();
    expect(screen.queryByTestId('rank-up-BBB')).toBeNull();
    expect(screen.getByTestId('rank-row-AAA')).toHaveAttribute('draggable', 'false');
  });
});

describe('New project', () => {
  it('offers the project workflows by name, never the internal bugfix workflow', async () => {
    const latest = new Map(BUILTIN_WORKFLOWS.map((d) => [d.key, d]));
    const custom = {
      ...(latest.get('code') as (typeof BUILTIN_WORKFLOWS)[number]),
      key: 'support',
      name: 'Support desk',
      builtIn: false,
    };
    const workflows = [...latest.values(), custom].map((definition, n) => ({
      id: `0192f3a0-0000-7000-8000-00000000020${n}`,
      orgId: null,
      status: 'active',
      definition,
    }));
    page('owner', PROJECTS, 200, workflows);
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const form = await screen.findByRole('form', { name: 'New project' });
    const options = within(form)
      .getAllByRole('radio')
      .map((r) => (r as HTMLInputElement).value);
    expect(options).toEqual(expect.arrayContaining(['code', 'research', 'feed', 'support']));
    expect(options).not.toContain('code-bugfix');
    expect(within(form).queryByText(/code-bugfix/)).toBeNull();
    // a custom workflow shows its own name, not its key
    expect(within(form).getByText('Support desk')).toBeInTheDocument();
    expect(within(form).getByText('A custom workflow of your organization.')).toBeInTheDocument();
  });
});
