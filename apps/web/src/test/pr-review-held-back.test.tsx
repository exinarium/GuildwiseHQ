import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PullRequests } from '../components/pull-requests/PullRequestsPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const PR_ID = '0192f3a0-0000-7000-8000-000000000301';
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
const pr = (heldBackCount: number) => ({
  id: PR_ID,
  repoId: '0192f3a0-0000-7000-8000-0000000000b1',
  repoName: 'toy',
  changeId: '1',
  url: 'https://github.com/acme/toy/pull/1',
  title: 'Change 1',
  author: 'dev',
  openedAt: '2026-11-10T10:00:00.000Z',
  state: 'reviewed',
  reviewedAt: '2026-11-12T10:03:12.000Z',
  reviewer: 'first',
  reviewerToken: 'present',
  lastRun: {
    state: 'posted',
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:03:12.000Z',
    durationMs: 192_000,
    timeoutMs: 600_000,
    error: null,
    code: null,
    postedCount: 7 - heldBackCount,
    reviewUrl: null,
    findingsCount: 7,
    heldBackCount,
    findingsCap: 3,
    changedLines: 250,
  },
});
const held = Array.from({ length: 4 }, (_, i) => ({
  id: `0192f3a0-0000-7000-8000-00000000040${i}`,
  rank: i + 4,
  severity: 'low',
  path: `src/f${i}.ts`,
  line: 10 + i,
  title: `Held ${i}`,
  body: 'text',
}));

function renderPage(heldBackCount: number, heldStatus = 200) {
  const fetchMock = vi.fn(async (url: string) => {
    let body: unknown = {};
    if (url === '/api/auth/me')
      body = { user: { id: 'u1' }, activeOrg: { id: ORG, role: 'owner', features: {} }, orgs: [] };
    else if (url === '/api/projects') body = { projects: [project] };
    else if (url === `/api/projects/${PROJECT}/pull-requests`) body = { pullRequests: [pr(heldBackCount)] };
    else if (url === `/api/pr-reviews/${PR_ID}/held-back`)
      return heldStatus === 200
        ? new Response(JSON.stringify({ runId: 'r', findings: held }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'boom' } }), { status: heldStatus });
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

describe('held-back findings on the Pull requests tab (AC2)', () => {
  it('no button when nothing is held back; the comment count stays', async () => {
    renderPage(0);
    expect((await screen.findByTestId('pr-review-detail-1')).textContent).toMatch(/7 comments/);
    expect(screen.queryByRole('button', { name: /held-back/ })).toBeNull();
  });
  it('shows Posted 3 of 7 and loads the 4 held-back findings on the first open only', async () => {
    const fetchMock = renderPage(4);
    expect((await screen.findByTestId('pr-review-detail-1')).textContent).toMatch(/Posted 3 of 7 findings/);
    const btn = await screen.findByRole('button', { name: 'Show 4 held-back findings' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('held-back'))).toBe(false);
    fireEvent.click(btn);
    expect(await screen.findByText('Held 0')).toBeTruthy();
    expect(screen.getAllByText('Held back: not posted to the PR')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Hide held-back findings' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide held-back findings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show 4 held-back findings' }));
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('held-back'))).toHaveLength(1);
  });
  it('shows an error when the findings cannot be loaded', async () => {
    renderPage(4, 500);
    fireEvent.click(await screen.findByRole('button', { name: 'Show 4 held-back findings' }));
    expect(await screen.findByRole('button', { name: /retry|try again/i })).toBeTruthy();
  });
});
