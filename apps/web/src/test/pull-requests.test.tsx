import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtRunTime, PullRequests } from '../pages/PullRequests.tsx';

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
const run = (over: Record<string, unknown> = {}) => ({
  state: 'failed',
  startedAt: '2026-11-12T10:00:00.000Z',
  finishedAt: '2026-11-12T10:10:00.000Z',
  durationMs: 600_000,
  timeoutMs: 600_000,
  error: null,
  code: null,
  postedCount: 0,
  reviewUrl: null,
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

describe('the Pull requests tab', () => {
  it('formats the run time', () => {
    expect(fmtRunTime(192_000)).toBe('3 min 12 s');
    expect(fmtRunTime(45_000)).toBe('45 s');
  });

  it('AC1: a reviewed pull request shows Reviewed, the reviewer, the run time and a link to the review', async () => {
    renderPage([
      pr(1, {
        state: 'reviewed',
        reviewer: 'first',
        reviewedAt: '2026-11-12T10:03:12.000Z',
        lastRun: run({
          state: 'posted',
          durationMs: 192_000,
          postedCount: 4,
          reviewUrl: 'https://github.com/acme/toy/pull/1#review-1',
        }),
      }),
    ]);
    expect((await screen.findByTestId('pr-review-state-1')).textContent).toBe('Reviewed');
    const detail = screen.getByTestId('pr-review-detail-1');
    expect(detail.textContent).toMatch(/by Sonnet reviewer/);
    expect(detail.textContent).toMatch(/run took 3 min 12 s/);
    expect(detail.textContent).toMatch(/4 comments/);
    expect(within(detail).getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/acme/toy/pull/1#review-1',
    );
    expect(screen.getByRole('tab', { name: 'Pull requests' })).toHaveAttribute('aria-selected', 'true');
  });

  it('AC2: a timeout says not reviewed, that it timed out and that nothing was posted', async () => {
    renderPage([pr(2, { lastRun: run({ state: 'timed_out' }) })]);
    expect((await screen.findByTestId('pr-review-state-2')).textContent).toBe('Not reviewed');
    const t = screen.getByTestId('pr-review-timeout-2');
    expect(t.textContent).toMatch(/timed out after 10 minutes/);
    expect(t.textContent).toMatch(/No comments were posted/);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('AC4: another failure shows the error to the owner', async () => {
    renderPage([
      pr(3, {
        lastRun: run({
          state: 'failed',
          code: 'model_error',
          error: 'the claude process exited with code 1',
        }),
      }),
    ]);
    const e = await screen.findByTestId('pr-review-error-3');
    expect(e.textContent).toMatch(/Not reviewed/);
    expect(e.textContent).toMatch(/the claude process exited with code 1/);
    expect(e.textContent).toMatch(/No comments were posted/);
    expect(e).toHaveAttribute('role', 'alert');
  });

  it('shows running, waiting and token missing in words', async () => {
    renderPage([
      pr(4, { lastRun: run({ state: 'running', finishedAt: null, durationMs: null }) }),
      pr(5),
      pr(6, { reviewerToken: 'missing' }),
    ]);
    expect((await screen.findByTestId('pr-review-detail-4')).textContent).toMatch(
      /Review running.*stops after 10 min/,
    );
    expect(screen.getByTestId('pr-review-detail-5').textContent).toBe('Waiting for a review');
    expect(screen.getByTestId('pr-review-detail-6').textContent).toMatch(/Reviewer token missing/);
  });

  it('is usable by touch: links are at least 44px tall, nothing needs hover, there is no input', async () => {
    renderPage([pr(7)]);
    const link = await screen.findByRole('link', { name: 'Change 7' });
    expect(link.className).toMatch(/min-h-11/);
    expect(document.querySelector('input, textarea')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/group-hover|hover:visible/);
  });

  it('says so when no pull request is recorded', async () => {
    renderPage([]);
    expect(await screen.findByText('No pull requests recorded yet')).toBeInTheDocument();
  });
});
