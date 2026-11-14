import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PullRequests } from '../components/pull-requests/PullRequestsPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const REPO = '0192f3a0-0000-7000-8000-0000000000b1';
const project = {
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
};
const pr = (n: number, over: Record<string, unknown> = {}) => ({
  id: `0192f3a0-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`,
  repoId: REPO,
  repoName: 'toy',
  changeId: String(n),
  url: `https://github.com/acme/toy/pull/${n}`,
  title: `Change ${n}`,
  author: 'dev',
  openedAt: '2026-11-10T10:00:00.000Z',
  state: 'not_reviewed',
  reviewedAt: null,
  reviewer: null,
  reviewerToken: 'present',
  lastRun: null,
  ...over,
});

function renderPage(pullRequests: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      let body: unknown = {};
      if (url === '/api/auth/me')
        body = { user: { id: 'u1' }, activeOrg: { id: ORG, role: 'owner', features: {} }, orgs: [] };
      else if (url === '/api/projects') body = { projects: [project] };
      else if (url === `/api/projects/${PROJECT}/pull-requests`) body = { pullRequests };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/p/TOY/pull-requests']}>
        <Routes>
          <Route path="/p/:projectKey/pull-requests" element={<PullRequests />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const members = [
  { changeId: '12', size: 300 },
  { changeId: '13', size: 400 },
];

describe('the size check on the Pull requests tab', () => {
  it('a pull request that needs splitting says so in words, names the stack and says the author was told', async () => {
    renderPage([
      pr(12, {
        state: 'needs_split',
        size: { state: 'over', total: 700, budget: 600, unit: 'changed_lines', members },
        split: {
          reason: 'over_budget',
          total: 700,
          budget: 600,
          unit: 'changed_lines',
          members,
          at: '2026-11-14T10:00:00.000Z',
          notice: {
            state: 'posted',
            postedAt: '2026-11-14T10:05:00.000Z',
            url: 'https://github.com/acme/toy/pull/12#r1',
            error: null,
          },
        },
      }),
    ]);
    expect((await screen.findByTestId('pr-review-state-12')).textContent).toBe('Needs split');
    expect(screen.getByTestId('pr-split-detail-12').textContent).toMatch(
      /Over the size budget: 700 of 600 changed lines \(stacked with #13\)\. Sent back to the author to split\./,
    );
    expect(screen.getByTestId('pr-split-notice-12').textContent).toMatch(/Author notified/);
    expect(screen.getByRole('link', { name: 'View' })).toBeTruthy();
    // no review button on a pull request that needs splitting, and no "waiting for a review" line
    expect(screen.queryByTestId('pr-review-detail-12')).toBeNull();
  });

  it('shows when the author could not be told, and when the notice is on its way', async () => {
    const split = (notice: unknown) => ({
      reason: 'over_budget',
      total: 650,
      budget: 600,
      unit: 'changed_lines',
      members: [{ changeId: '14', size: 650 }],
      at: null,
      notice,
    });
    renderPage([
      pr(14, {
        state: 'needs_split',
        split: split({ state: 'failed', postedAt: null, url: null, error: 'no reviewer token' }),
      }),
      pr(15, {
        state: 'needs_split',
        split: split({ state: 'pending', postedAt: null, url: null, error: null }),
      }),
    ]);
    expect((await screen.findByTestId('pr-split-notice-14')).textContent).toBe(
      'Author not notified: no reviewer token',
    );
    expect(screen.getByTestId('pr-split-notice-15').textContent).toBe('Notifying the author…');
  });

  it('a pull request that timed out twice within the budget waits for the owner, with the reminder', async () => {
    renderPage([
      pr(16, {
        attention: 'timed_out_twice',
        size: {
          state: 'within',
          total: 420,
          budget: 600,
          unit: 'changed_lines',
          members: [{ changeId: '16', size: 420 }],
          complete: true,
        },
        reminder: { dueAt: '2026-11-18T10:00:00.000Z', remindedAt: null },
      }),
    ]);
    const text = (await screen.findByTestId('pr-timed-out-twice-16')).textContent ?? '';
    expect(text).toMatch(/Timed out twice/);
    expect(text).toMatch(/waits for your decision/);
    expect(text).toMatch(/Reminder /);
    expect(screen.getByTestId('pr-size-line-16').textContent).toBe('Size 420 of 600 changed lines');
    expect(screen.getByTestId('pr-review-state-16').textContent).toBe('Not reviewed');
  });

  it('says when the check is inactive or the size is unknown', async () => {
    renderPage([
      pr(17, { size: { state: 'inactive', reason: 'inactive: no size budget set' } }),
      pr(18, { size: { state: 'unknown', reason: 'no_size' } }),
    ]);
    expect((await screen.findByTestId('pr-size-line-17')).textContent).toBe(
      'Size check inactive: no size budget set',
    );
    expect(screen.getByTestId('pr-size-line-18').textContent).toMatch(/Size unknown/);
  });
});
