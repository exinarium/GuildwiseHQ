import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PullRequests } from '../components/pull-requests/PullRequestsPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const PR_ID = '0192f3a0-0000-7000-8000-000000000301';
const F1 = '0192f3a0-0000-7000-8000-000000000501';
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
const pr = (hidden: boolean) => ({
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
  reviewer: hidden ? null : 'first',
  reviewersHidden: hidden,
  unmarkedCount: hidden ? 1 : 0,
  reviewerToken: 'present',
  lastRun: {
    state: 'posted',
    startedAt: '2026-11-12T10:00:00.000Z',
    finishedAt: '2026-11-12T10:03:12.000Z',
    durationMs: 192_000,
    timeoutMs: 600_000,
    error: null,
    code: null,
    postedCount: 1,
    reviewUrl: null,
  },
});
const finding = (over: Record<string, unknown> = {}) => ({
  id: F1,
  prReviewId: PR_ID,
  runId: '0192f3a0-0000-7000-8000-000000000601',
  rank: 1,
  severity: 'high',
  path: 'src/a.ts',
  line: 3,
  title: 'Null deref',
  body: 'x may be null',
  postedAt: '2026-11-12T10:03:12.000Z',
  reviewUrl: null,
  mark: null,
  markedAt: null,
  reviewers: null,
  canMark: true,
  ...over,
});

function renderPage(opts: { canMark?: boolean; precision?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    let body: unknown = {};
    if (url === '/api/auth/me')
      body = { user: { id: 'u1' }, activeOrg: { id: ORG, role: 'owner', features: {} }, orgs: [] };
    else if (url === '/api/projects') body = { projects: [project] };
    else if (url === `/api/projects/${PROJECT}/pull-requests`) body = { pullRequests: [pr(true)] };
    else if (url === `/api/projects/${PROJECT}/reviewer-precision`)
      body = opts.precision ?? {
        reviewers: [
          {
            reviewer: 'first',
            label: 'Sonnet reviewer',
            models: ['sonnet'],
            posted: 4,
            useful: 3,
            noise: 1,
            unmarked: 0,
            precision: 0.75,
          },
        ],
      };
    else if (url === `/api/pr-reviews/${PR_ID}/findings`)
      body = { findings: [finding({ canMark: opts.canMark ?? true })] };
    else if (url === `/api/pr-review-findings/${F1}/mark`)
      body = finding({
        mark: JSON.parse(String(init?.body)).mark,
        markedAt: '2026-11-14T11:00:00.000Z',
        reviewers: [{ key: 'first', label: 'Sonnet reviewer', model: 'sonnet' }],
      });
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
  return calls;
}

describe('AC2: blind marking in the owner view', () => {
  it('the row does not name the reviewer while the pull request has unmarked findings', async () => {
    renderPage();
    const detail = await screen.findByTestId('pr-review-detail-1');
    expect(detail.textContent).toMatch(/reviewer shown once every posted finding is marked/);
    expect(detail.textContent).not.toMatch(/Sonnet/);
  });

  it('an unmarked finding shows two 44px buttons and no reviewer; the reviewer appears after the mark', async () => {
    const calls = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 posted finding (1 to mark)' }));
    const useful = await screen.findByTestId(`mark-useful-${F1}`);
    expect(useful.className).toContain('min-h-11');
    expect(screen.getByTestId(`mark-noise-${F1}`).className).toContain('min-h-11');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/Sonnet/)).toBeNull();
    fireEvent.click(useful);
    expect(await screen.findByTestId(`finding-reviewer-${F1}`)).toHaveTextContent('Sonnet reviewer · sonnet');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe(`/api/pr-review-findings/${F1}/mark`);
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ mark: 'useful' });
  });
});

describe('AC1: a mark is saved, shown and changeable', () => {
  it('Change re-opens the buttons and saves the other mark', async () => {
    const calls = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Show 1 posted finding/ }));
    fireEvent.click(await screen.findByTestId(`mark-useful-${F1}`));
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(screen.getByTestId(`mark-useful-${F1}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`mark-noise-${F1}`)).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId(`mark-noise-${F1}`));
    await screen.findByText('Noise', { selector: 'span' });
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body ?? '{}').mark);
    expect(puts).toEqual(['useful', 'noise']);
  });

  it('a manager (canMark false) sees no buttons', async () => {
    renderPage({ canMark: false });
    fireEvent.click(await screen.findByRole('button', { name: /Show 1 posted finding/ }));
    expect(await screen.findByText('Not marked yet')).toBeTruthy();
    expect(screen.queryByTestId(`mark-useful-${F1}`)).toBeNull();
  });
});

describe('AC4: reviewer precision panel', () => {
  it('is collapsed, then shows 0.75 on open', async () => {
    const calls = renderPage();
    const toggle = await screen.findByTestId('reviewer-precision-toggle');
    expect(calls.some((c) => c.url.includes('reviewer-precision'))).toBe(false);
    fireEvent.click(toggle);
    expect(await screen.findByTestId('precision-first')).toHaveTextContent('Precision 0.75');
  });
  it('shows a dash when nothing was posted for the reviewer', async () => {
    renderPage({
      precision: {
        reviewers: [
          {
            reviewer: 'first',
            label: 'Sonnet reviewer',
            models: [],
            posted: 0,
            useful: 0,
            noise: 0,
            unmarked: 0,
            precision: null,
          },
        ],
      },
    });
    fireEvent.click(await screen.findByTestId('reviewer-precision-toggle'));
    expect(await screen.findByTestId('precision-first')).toHaveTextContent('Precision –');
  });
});
