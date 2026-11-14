import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PullRequests } from '../components/pull-requests/PullRequestsPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const REPO = '0192f3a0-0000-7000-8000-0000000000b1';
const project = (myRole: string) => ({
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
  myRole,
});
const id = (n: number) => `0192f3a0-0000-7000-8000-0000000003${String(n).padStart(2, '0')}`;
const waiting = (n: number, slot: string, over: Record<string, unknown> = {}) => ({
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
  lastRun: null,
  queueSlot: slot,
  queuePosition: n,
  ...over,
});
const item = (n: number, slot: string, over: Record<string, unknown> = {}) => ({
  prReviewId: id(n),
  position: n,
  repoId: REPO,
  repoName: 'toy',
  changeId: String(n),
  title: `Change ${n}`,
  url: `https://github.com/acme/toy/pull/${n}`,
  author: 'dev',
  openedAt: '2026-11-10T10:00:00.000Z',
  openedDay: '2026-11-10',
  changedLines: 312,
  slot,
  blockedReason: null,
  blockedProblem: null,
  ...over,
});
const queueOf = (used: number, items: unknown[]) => ({
  day: '2026-11-13',
  timeZone: 'Africa/Johannesburg',
  resetsAt: '2026-11-13T22:00:00.000Z',
  used,
  cap: 20,
  manualToday: 0,
  items,
});

function renderPage(myRole: string, q: unknown, pullRequests: unknown[]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    let body: unknown = {};
    if (url === '/api/auth/me')
      body = { user: { id: 'u1' }, activeOrg: { id: ORG, role: myRole, features: {} }, orgs: [] };
    else if (url === '/api/projects') body = { projects: [project(myRole)] };
    else if (url === `/api/projects/${PROJECT}/pull-requests`) body = { pullRequests };
    else if (url === `/api/projects/${PROJECT}/pull-requests/queue`) body = q;
    else if (init?.method === 'POST') body = {};
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

describe('the daily cap and the queue on the Pull requests tab (AC4)', () => {
  it("shows today's used count and the queue in run order with each slot as text", async () => {
    renderPage(
      'owner',
      queueOf(7, [
        item(1, 'today'),
        item(2, 'later', { changedLines: null }),
        item(3, 'blocked', { blockedReason: 'runner_outdated' }),
      ]),
      [waiting(2, 'later')],
    );
    expect((await screen.findByTestId('pr-review-used')).textContent).toBe('7/20');
    expect(screen.getByTestId('pr-review-cap').textContent).toMatch(/Automatic reviews today: 7\/20/);
    expect(screen.getByTestId('pr-review-cap').textContent).toMatch(
      /Resets at midnight \(Africa\/Johannesburg\)/,
    );
    const rows = within(screen.getByTestId('pr-review-queue')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'pr-review-queue-item-1',
      'pr-review-queue-item-2',
      'pr-review-queue-item-3',
    ]);
    expect(rows[0]?.textContent).toMatch(/312 lines changed/);
    expect(rows[0]?.textContent).toMatch(/Today/);
    expect(rows[1]?.textContent).toMatch(/size unknown/);
    expect(rows[1]?.textContent).toMatch(/Waits for a following day/);
    expect(rows[2]?.textContent).toMatch(/Blocked: the runner needs an update/);
    // AC1: a queued pull request stays "Not reviewed" and says it is queued
    expect(screen.getByTestId('pr-review-state-2').textContent).toBe('Not reviewed');
    expect(screen.getByTestId('pr-review-detail-2').textContent).toMatch(
      /queued #2 \(waits for a following day\)/,
    );
  });

  it('says so when the cap is used up', async () => {
    renderPage('owner', queueOf(20, [item(1, 'later')]), []);
    expect((await screen.findByText(/automatic reviews are used up/)).textContent).toMatch(/20/);
  });

  it('has an empty state', async () => {
    renderPage('owner', queueOf(0, []), []);
    expect(await screen.findByText('No pull requests waiting.')).toBeTruthy();
  });

  it('the owner can review now after a confirmation; a member has no button (AC3)', async () => {
    const fetchMock = renderPage('owner', queueOf(20, [item(1, 'later')]), []);
    fireEvent.click(await screen.findByTestId('pr-review-now-1'));
    expect(await screen.findByText(/not counted toward the daily cap/)).toBeTruthy();
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Review now' }).at(-1) as HTMLElement);
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) => c[1]?.method === 'POST' && String(c[0]).endsWith(`/pull-requests/${id(1)}/review`),
        ),
      ).toBe(true),
    );
  });

  it('a member sees the queue but no Review now button', async () => {
    renderPage('manager', queueOf(3, [item(1, 'today')]), []);
    await screen.findByTestId('pr-review-queue-item-1');
    expect(screen.queryByTestId('pr-review-now-1')).toBeNull();
  });
});
