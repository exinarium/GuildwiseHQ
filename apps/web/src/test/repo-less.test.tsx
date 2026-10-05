import { codeWorkflowV1, feedWorkflowV1, type ProjectDetailResponse, researchWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../pages/Board.tsx';
import { ProjectSettings } from '../pages/ProjectSettings.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const ENTRY = '0192f3a0-0000-7000-8000-0000000000b1';

const dto = (workflowKey: string) => ({
  id: PROJECT,
  orgId: ORG,
  key: 'TOY',
  name: 'Toy',
  domain: 'work',
  workflowKey,
  priorityTier: 2,
  branchPrefix: 'aom/',
  workingBranch: 'main',
  subCategories: [],
  vaultFolder: null,
  architecturalGlobs: [],
  e2eGlobs: [],
  status: 'active',
  createdAt: '2026-10-01T10:00:00.000Z',
  myRole: 'owner',
  mergeLargeWithoutApproval: false,
  mergeLargeChanged: null,
});

const defs = { code: codeWorkflowV1, research: researchWorkflowV1, feed: feedWorkflowV1 };

function stub(workflowKey: keyof typeof defs, repos: ProjectDetailResponse['repos'] = []) {
  const body = (url: string): unknown => {
    if (url.startsWith('/api/workflows'))
      return { workflows: [{ id: ENTRY, orgId: null, status: 'active', definition: defs[workflowKey] }] };
    if (url === '/api/projects') return { projects: [dto(workflowKey)] };
    if (url.startsWith('/api/board')) return { projectId: PROJECT, workflowKey, columns: [] };
    if (url.startsWith('/api/projects/'))
      return { project: dto(workflowKey), repos, members: [], mergePolicyHistory: [] };
    return {};
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(JSON.stringify(body(url)), { status: 200 })),
  );
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

describe('board regression control', () => {
  it('is shown for a code project', async () => {
    stub('code');
    renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);
    expect(await screen.findByRole('button', { name: /regression/i })).toBeInTheDocument();
  });

  it.each(['research', 'feed'] as const)(
    'is absent for a %s project once its workflow is known',
    async (k) => {
      stub(k);
      renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);
      await screen.findByRole('link', { name: 'New card' });
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: /regression/i })).toBeNull());
    },
  );
});

describe('project settings for repo-less workflows', () => {
  const open = () => renderAt(`/projects/${PROJECT}/settings`, '/projects/:id/settings', <ProjectSettings />);

  it('shows repositories and globs for code', async () => {
    stub('code');
    open();
    expect(await screen.findByText('Repositories')).toBeInTheDocument();
    expect(screen.getByLabelText('E2E globs')).toBeInTheDocument();
    expect(screen.getByLabelText('Architectural globs')).toBeInTheDocument();
    expect(screen.getByText('Merge large changes without my approval')).toBeInTheDocument();
  });

  it('hides repositories, globs and the merge policy for research', async () => {
    stub('research');
    open();
    await screen.findByLabelText('Working branch');
    await vi.waitFor(() => expect(screen.queryByText('Repositories')).toBeNull());
    expect(screen.queryByLabelText('E2E globs')).toBeNull();
    expect(screen.queryByLabelText('Architectural globs')).toBeNull();
    expect(screen.queryByText('Merge large changes without my approval')).toBeNull();
  });

  it('still lists existing repositories (removable, no add form) for research', async () => {
    stub('research', [
      {
        id: '0192f3a0-0000-7000-8000-0000000000c1',
        name: 'old',
        remoteUrl: 'https://example.test/old.git',
        workingBranch: null,
        removedAt: null,
      } as ProjectDetailResponse['repos'][number],
    ]);
    open();
    expect(await screen.findByRole('button', { name: 'Remove repository old' })).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole('form', { name: 'Add repository' })).toBeNull());
  });
});
