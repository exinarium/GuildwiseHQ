import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrReplayDetailPage } from '../components/pull-requests/PrReplayDetailPage.tsx';

afterEach(() => vi.unstubAllGlobals());

const PROJECT = '0192f3a0-0000-7000-8000-000000000001';
const ORG = '0192f3a0-0000-7000-8000-0000000000a1';
const REPLAY = '0192f3a0-0000-7000-8000-000000000701';
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
const progress = { runsTotal: 40, runsDone: 40, runsFailed: 0, findingsToMark: 2, findingsMarked: 0 };
const replay = (state: string, result: unknown = null) => ({
  id: REPLAY,
  projectId: PROJECT,
  repoId: '0192f3a0-0000-7000-8000-0000000000b1',
  repoName: 'toy',
  state,
  startedAt: '2026-11-14T08:00:00.000Z',
  finishedAt: null,
  failure: null,
  prs: [],
  progress,
  result,
  canManage: true,
});
const finding = {
  id: F1,
  prReviewId: '0192f3a0-0000-7000-8000-000000000302',
  runId: '0192f3a0-0000-7000-8000-000000000601',
  rank: 1,
  severity: 'high',
  path: 'src/a.ts',
  line: 3,
  title: 'Null deref',
  body: 'x may be null',
  postedAt: null,
  reviewUrl: null,
  mark: null,
  markedAt: null,
  reviewers: null,
  canMark: true,
};
const RESULT = {
  prCount: 20,
  reviewers: [
    {
      reviewer: 'first',
      label: 'Sonnet reviewer',
      model: 'sonnet',
      prsReviewed: 20,
      prsNotReviewed: 0,
      wouldPost: 10,
      heldBack: 2,
      useful: 7,
      noise: 3,
      precision: 0.7,
      effortMs: 600000,
    },
    {
      reviewer: 'second',
      label: 'Opus reviewer',
      model: 'opus',
      prsReviewed: 20,
      prsNotReviewed: 0,
      wouldPost: 8,
      heldBack: 0,
      useful: 6,
      noise: 2,
      precision: 0.75,
      effortMs: 480000,
    },
  ],
  effort: {
    activeMs: 1080000,
    perPrMs: 54000,
    perFindingMs: 60000,
    findingsMarked: 18,
    wallClockMs: 3600000,
    idleCapMs: 600000,
    prsPerWeek: 5,
    hoursPerWeekEstimate: 1.25,
  },
};

function renderPage(state: string, result: unknown = null) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    let body: unknown = {};
    let status = 200;
    if (url === '/api/auth/me')
      body = { user: { id: 'u1' }, activeOrg: { id: ORG, role: 'owner', features: {} }, orgs: [] };
    else if (url === '/api/projects') body = { projects: [project] };
    else if (url === `/api/pr-replays/${REPLAY}`) body = replay(state, result);
    else if (url === `/api/pr-replays/${REPLAY}/next-finding`)
      body = {
        next: {
          finding,
          pr: { changeId: '4', url: 'https://github.com/acme/toy/pull/4', title: 'Change 4' },
          position: 1,
          total: 2,
        },
      };
    else if (url === `/api/pr-replays/${REPLAY}/findings`) body = { findings: [] };
    else if (url === `/api/pr-replay-findings/${F1}/shown`) status = 204;
    else if (url === `/api/pr-replay-findings/${F1}/mark`)
      body = { finding: { ...finding, mark: 'useful' }, replay: replay(state) };
    else if (url === `/api/projects/${PROJECT}/review-targets`) body = {};
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/p/TOY/pull-requests/replay/${REPLAY}`]}>
        <Routes>
          <Route path="/p/:projectKey/pull-requests/replay/:replayId" element={<PrReplayDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe('AC2: blind marking in the replay', () => {
  it('shows one finding with the replay hint and no reviewer; Useful sends the mark', async () => {
    const calls = renderPage('marking');
    const useful = await screen.findByTestId(`mark-useful-${F1}`);
    const page = screen.getByTestId('replay-marking');
    expect(page.textContent).toContain('Finding 1 of 2');
    expect(page.textContent).toContain('Reviewers are shown when every finding is marked');
    expect(page.textContent?.toLowerCase()).not.toMatch(/sonnet|opus/);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/shown'))).toHaveLength(1));
    fireEvent.click(useful);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'PUT' &&
            c.url === `/api/pr-replay-findings/${F1}/mark` &&
            c.body === JSON.stringify({ mark: 'useful' }),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/next-finding')).length).toBeGreaterThan(1),
    );
  });
  it('progress while reviewing is totals only', async () => {
    renderPage('reviewing');
    const p = await screen.findByTestId('replay-progress');
    expect(p.textContent).toContain('40 of 40 reviews done');
  });
});

describe('AC3 and AC4: result and targets', () => {
  it('shows precision per reviewer and the effort; the targets form starts empty and sends fractions', async () => {
    const calls = renderPage('finished', RESULT);
    expect((await screen.findByTestId('replay-precision-first')).textContent).toBe('0.70');
    expect(screen.getByTestId('replay-precision-second').textContent).toBe('0.75');
    expect(screen.getByTestId('replay-effort').textContent).toContain('1.25 h per week');
    const precision = screen.getByLabelText(/Reviewer precision target/) as HTMLInputElement;
    const effort = screen.getByLabelText(/Baseline review effort target/) as HTMLInputElement;
    expect(precision.value).toBe('');
    expect(effort.value).toBe('');
    expect(precision.getAttribute('inputmode')).toBe('decimal');
    expect(effort.getAttribute('inputmode')).toBe('decimal');
    fireEvent.change(precision, { target: { value: '70' } });
    fireEvent.change(effort, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Targets saved/);
    const put = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/review-targets'));
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ precisionTarget: 0.7, effortTargetHoursPerWeek: 3 });
  });
});
