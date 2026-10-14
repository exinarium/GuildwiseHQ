import { codeWorkflowV1, feedWorkflowV1, type ProjectDetailResponse, researchWorkflowV1 } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../pages/Board.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const ENTRY = '0192f3a0-0000-7000-8000-0000000000b1';

const dto = (workflowKey: string) => ({
  id: PROJECT,
  orgId: ORG,
  key: 'TOY',
  name: 'Toy',
  workflowKey,
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
  mergeLargeWithoutApproval: false,
  mergeLargeChanged: null,
  prBranchPrefix: 'pieter',
});

const BUDGET = {
  state: 'none',
  month: '2026-10',
  monthlyMicros: null,
  spentMicros: 4_250_000,
  percent: null,
  resetsAt: '2026-11-01T00:00:00.000Z',
  currency: 'USD',
  canEdit: true,
};
const defs = { code: codeWorkflowV1, research: researchWorkflowV1, feed: feedWorkflowV1 };

function stub(workflowKey: keyof typeof defs, repos: ProjectDetailResponse['repos'] = []) {
  const withBudget = (d: object) => ({ ...d, budget: BUDGET });
  const body = (url: string): unknown => {
    if (url.startsWith('/api/workflows'))
      return { workflows: [{ id: ENTRY, orgId: null, status: 'active', definition: defs[workflowKey] }] };
    if (url === '/api/projects') return { projects: [withBudget(dto(workflowKey))] };
    if (url.startsWith('/api/board')) return { projectId: PROJECT, workflowKey, columns: [] };
    if (url.startsWith('/api/projects/'))
      return { project: withBudget(dto(workflowKey)), repos, members: [], mergePolicyHistory: [] };
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

describe('board spend without a budget (#56)', () => {
  it('shows the real month spend and no budget meter', async () => {
    stub('code');
    renderAt('/p/TOY/board', '/p/:projectKey/board', <Board />);
    const spend = await screen.findByTestId('board-spend');
    expect(spend).toHaveTextContent('$4.25');
    expect(spend).toHaveTextContent('this month');
    expect(spend).not.toHaveTextContent(' of ');
    expect(screen.queryByTestId('budget-meter')).toBeNull();
  });
});
