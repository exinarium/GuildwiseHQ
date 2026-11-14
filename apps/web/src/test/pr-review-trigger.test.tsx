import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PullRequests } from '../components/pull-requests/PullRequestsPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const REPO = '0192f3a0-0000-7000-8000-0000000000b1';
const RUN = '0192f3a0-0000-7000-8000-0000000000c1';
const id = (n: number) => `0192f3a0-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`;
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
const run = (state: string, over: Record<string, unknown> = {}) => ({
  state,
  startedAt: '2026-11-13T10:00:00.000Z',
  finishedAt: '2026-11-13T10:10:00.000Z',
  durationMs: 600000,
  timeoutMs: 600000,
  error: null,
  code: null,
  postedCount: 0,
  reviewUrl: null,
  ...over,
});
const pr = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
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
  queueSlot: null,
  queuePosition: null,
  lastRun: null,
  manualAction: null,
  ...over,
});
const emptyQueue = {
  day: '2026-11-13',
  timeZone: 'UTC',
  resetsAt: '2026-11-14T00:00:00.000Z',
  used: 0,
  cap: 20,
  manualToday: 0,
  items: [],
};

function renderPage(pullRequests: unknown[], post?: () => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown = {};
    if (url === '/api/auth/me')
      body = { user: { id: 'u1' }, activeOrg: { id: ORG, role: 'owner', features: {} }, orgs: [] };
    else if (url === '/api/projects') body = { projects: [project] };
    else if (url === `/api/projects/${PROJECT}/pull-requests`) body = { pullRequests };
    else if (url === `/api/projects/${PROJECT}/pull-requests/queue`) body = emptyQueue;
    else if (init?.method === 'POST' && post) return post();
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
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
  return fetchMock;
}
const posts = (m: ReturnType<typeof vi.fn>) => m.mock.calls.filter((c) => c[1]?.method === 'POST');

describe('Review now / Re-run review on a pull request row', () => {
  it('a timed-out row offers Re-run review with the hint, and confirming posts previousRunId once', async () => {
    const m = renderPage([
      pr(1, { lastRun: run('timed_out'), manualAction: { kind: 'rerun', previousRunId: RUN } }),
    ]);
    const button = await screen.findByTestId('pr-review-trigger-1');
    expect(button.textContent).toBe('Re-run review');
    expect(button.className).toMatch(/min-h-11/);
    expect(button.className).toMatch(/w-full/);
    fireEvent.click(button);
    expect(await screen.findByText(/last run timed out after 10 minutes/)).toBeTruthy();
    expect(posts(m)).toHaveLength(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-run review' }).at(-1) as HTMLElement);
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    const call = posts(m)[0] as [string, RequestInit];
    expect(call[0]).toMatch(new RegExp(`/pull-requests/${id(1)}/review$`));
    expect(JSON.parse(String(call[1].body))).toEqual({ previousRunId: RUN });
  });

  it('a failed row offers Review now with no link', async () => {
    const m = renderPage([
      pr(2, {
        lastRun: run('failed', { code: 'error', error: 'boom' }),
        manualAction: { kind: 'review_now', previousRunId: null },
      }),
    ]);
    const button = await screen.findByTestId('pr-review-trigger-2');
    expect(button.textContent).toBe('Review now');
    fireEvent.click(button);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Review now' })).at(-1) as HTMLElement);
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(JSON.parse(String((posts(m)[0] as [string, RequestInit])[1].body))).toEqual({});
  });

  it('shows no button without an action or for a PR that is in the queue', async () => {
    renderPage([
      pr(3, { lastRun: run('failed'), manualAction: null }),
      pr(4, {
        queueSlot: 'later',
        queuePosition: 1,
        manualAction: { kind: 'review_now', previousRunId: null },
      }),
    ]);
    await screen.findByTestId('pr-review-3');
    expect(screen.queryByTestId('pr-review-trigger-3')).toBeNull();
    expect(screen.queryByTestId('pr-review-trigger-4')).toBeNull();
  });

  it('shows the server text when the start is refused', async () => {
    renderPage(
      [pr(5, { lastRun: run('timed_out'), manualAction: { kind: 'rerun', previousRunId: RUN } })],
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'stale_action', message: 'This pull request changed since the page loaded.' },
          }),
          { status: 409 },
        ),
    );
    fireEvent.click(await screen.findByTestId('pr-review-trigger-5'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Re-run review' }).at(-1) as HTMLElement);
    expect(await screen.findByText(/changed since the page loaded/)).toBeTruthy();
  });

  it('says a run was started by hand and which run it re-ran', async () => {
    renderPage([
      pr(6, {
        lastRun: run('running', {
          trigger: 'manual',
          rerunOf: { runId: RUN, startedAt: '2026-11-13T09:00:00.000Z' },
        }),
      }),
    ]);
    expect((await screen.findByTestId('pr-review-by-hand-6')).textContent).toMatch(/Started by hand/);
    expect(screen.getByTestId('pr-review-rerun-of-6').textContent).toMatch(
      /Re-run of the run that timed out at/,
    );
  });
});
