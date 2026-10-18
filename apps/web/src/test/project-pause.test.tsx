import { codeWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatErrorText } from '../components/ChatPanel.tsx';
import { Board } from '../pages/Board.tsx';
import { Projects } from '../pages/Projects.tsx';
import { keysForEvent } from '../ws/invalidate.ts';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const ENTRY = '0192f3a0-0000-7000-8000-0000000000b1';
const ME = '0192f3a0-0000-7000-8000-0000000000c1';

const PAUSED = {
  at: new Date('2026-10-18T09:30:00Z').toISOString(),
  byUserId: ME,
  byName: 'Pia Owner',
  reason: 'Release freeze until Friday',
};

const dto = (paused: object | null) => ({
  id: PROJECT,
  orgId: ORG,
  key: 'TOY',
  name: 'Toy',
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
  paused,
});

/** A stubbed server: the project's pause state is mutable so pause and resume are visible after the refetch. */
function stub(role: 'owner' | 'admin' | 'member', initial: object | null = null) {
  const state = { paused: initial as object | null };
  const calls: Array<{ url: string; body: unknown }> = [];
  const body = (url: string, init?: RequestInit): unknown => {
    if (init?.method === 'POST') {
      const b = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body: b });
      if (url.endsWith('/pause')) state.paused = { ...PAUSED, reason: b.reason ?? null, byName: 'Pia Owner' };
      if (url.endsWith('/resume')) state.paused = null;
      return { project: dto(state.paused), repos: [], members: [], mergePolicyHistory: [] };
    }
    if (url.startsWith('/api/auth/me'))
      return {
        user: { id: ME, email: 'p@x.test', displayName: 'Pia', role: 'member' },
        orgs: [{ id: ORG, name: 'Org', status: 'active', role }],
        activeOrg: { id: ORG, name: 'Org', status: 'active', role },
      };
    if (url.startsWith('/api/workflows'))
      return { workflows: [{ id: ENTRY, orgId: null, status: 'active', definition: codeWorkflowV1 }] };
    if (url === '/api/projects') return { projects: [dto(state.paused)] };
    if (url.startsWith('/api/board')) return { projectId: PROJECT, workflowKey: 'code', columns: [] };
    if (url.startsWith('/api/projects/'))
      return { project: dto(state.paused), repos: [], members: [], mergePolicyHistory: [] };
    return {};
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string, init?: RequestInit) =>
        new Response(JSON.stringify(body(url, init)), { status: 200 }),
    ),
  );
  return { calls, state };
}

function renderAt(path: string, route: string, el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={el} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const board = () => renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);

describe('pause project button', () => {
  it.each(['owner', 'admin'] as const)('an organization %s sees it on a running project', async (role) => {
    stub(role);
    board();
    expect(await screen.findByTestId('pause-project-open')).toBeInTheDocument();
    expect(screen.queryByTestId('project-paused-banner')).toBeNull();
  });

  it('a Member does not see it', async () => {
    stub('member');
    board();
    await screen.findByText('Toy');
    expect(screen.queryByTestId('pause-project-open')).toBeNull();
  });

  it('opens an in-page dialog that explains the effect, takes an optional reason and pauses; the banner follows', async () => {
    const { calls } = stub('owner');
    const confirm = vi.spyOn(window, 'confirm');
    board();
    await userEvent.click(await screen.findByTestId('pause-project-open'));
    expect(confirm).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(
      'Nothing new starts on this project until an Owner or Admin resumes it.',
    );
    expect(dialog).toHaveTextContent('Shifts already running finish.');
    await userEvent.type(screen.getByTestId('pause-project-reason'), 'Release freeze until Friday');
    await userEvent.click(screen.getByTestId('pause-project-confirm'));
    await waitFor(() =>
      expect(calls).toEqual([
        { url: `/api/projects/${PROJECT}/pause`, body: { reason: 'Release freeze until Friday' } },
      ]),
    );
    const banner = await screen.findByTestId('project-paused-banner');
    expect(banner).toHaveTextContent('Paused by Pia Owner');
    expect(screen.getByTestId('project-paused-reason')).toHaveTextContent('Release freeze until Friday');
    // the button gives way to the banner's Resume
    expect(screen.queryByTestId('pause-project-open')).toBeNull();
  });

  it('pauses without a reason (an empty body)', async () => {
    const { calls } = stub('admin');
    board();
    await userEvent.click(await screen.findByTestId('pause-project-open'));
    await userEvent.click(await screen.findByTestId('pause-project-confirm'));
    await waitFor(() => expect(calls).toEqual([{ url: `/api/projects/${PROJECT}/pause`, body: {} }]));
  });

  it('Cancel closes the dialog and pauses nothing', async () => {
    const { calls } = stub('owner');
    board();
    await userEvent.click(await screen.findByTestId('pause-project-open'));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([]);
  });
});

describe('paused banner and resume', () => {
  it('shows who, when and why, with Resume for an Owner; resuming clears the banner', async () => {
    const { calls } = stub('owner', PAUSED);
    board();
    const banner = await screen.findByTestId('project-paused-banner');
    expect(banner).toHaveTextContent('Paused by Pia Owner');
    expect(banner).toHaveTextContent(
      'Nothing new starts on this project until an Owner or Admin resumes it.',
    );
    expect(screen.getByTestId('project-paused-reason')).toHaveTextContent('Release freeze until Friday');
    await userEvent.click(screen.getByTestId('resume-project'));
    await waitFor(() => expect(calls).toEqual([{ url: `/api/projects/${PROJECT}/resume`, body: {} }]));
    await waitFor(() => expect(screen.queryByTestId('project-paused-banner')).toBeNull());
    expect(await screen.findByTestId('pause-project-open')).toBeInTheDocument();
  });

  it('an Admin can resume too', async () => {
    stub('admin', PAUSED);
    board();
    expect(await screen.findByTestId('resume-project')).toBeInTheDocument();
  });

  it('a Member sees the banner but no Resume button, and no Pause button', async () => {
    stub('member', PAUSED);
    board();
    expect(await screen.findByTestId('project-paused-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('resume-project')).toBeNull();
    expect(screen.queryByTestId('pause-project-open')).toBeNull();
  });

  it('a pause without a reason shows no reason line', async () => {
    stub('member', { ...PAUSED, reason: null });
    board();
    await screen.findByTestId('project-paused-banner');
    expect(screen.queryByTestId('project-paused-reason')).toBeNull();
  });
});

describe('the project list and live refresh', () => {
  it('lists a paused project with a Paused badge, a running one without', async () => {
    stub('member', PAUSED);
    renderAt('/projects', '/projects', <Projects />);
    expect(await screen.findByTestId('project-paused-badge')).toHaveTextContent('Paused');
  });

  it('a project event refreshes the project lists and the board (the live update path)', () => {
    const keys = keysForEvent({ type: 'ProjectPaused', streamId: `project-${PROJECT}`, projectId: PROJECT });
    expect(keys).toEqual(expect.arrayContaining([['projects'], ['project'], ['board']]));
  });

  it('a chat on a paused project is told why', () => {
    expect(chatErrorText('project_paused')).toMatch(/paused by an Owner or Admin/);
  });
});
