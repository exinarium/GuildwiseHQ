import type { AgentStats as AgentStatsDto, Recommendation, RoleUpdate, WorkQuality } from '@aom/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStats, WorkQualityPanel } from '../components/hr/AgentStats.tsx';
import { BarChart, CompareBar, Sparkline } from '../components/hr/Charts.tsx';
import { RecommendationList, RoleUpdates } from '../components/hr/Recommendations.tsx';
import { describeStat, duration, num, pct, tokens, versusTeam } from '../lib/hr.ts';

afterEach(() => vi.unstubAllGlobals());

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const stat = (value: number | null, team: number | null) => ({ value, team });
const stats: AgentStatsDto = {
  agentId: ID(1),
  windowDays: 30,
  from: new Date(0).toISOString(),
  to: new Date(0).toISOString(),
  cardsTouched: 3,
  cardsDone: stat(3, 1.5),
  blockedRate: stat(0, 0.1),
  reworkRate: stat(1 / 3, 0.2),
  bugsEscaped: stat(null, null),
  utilisation: stat(0.0011, 0.0006),
  tokensPerCard: stat(1600, 1600),
  doneByDay: [0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 4],
};
const quality: WorkQuality = {
  reviewScoreAvg: 3.67,
  reviewCount: 3,
  reworkByReason: [
    { reason: 'weak_tests', count: 2, countsAgainstBuilder: true },
    { reason: 'spec_unclear', count: 1, countsAgainstBuilder: false },
  ],
  reworkRoundsPerCard: { avg: 0.33, max: 3, cardsWithThreeOrMore: 1 },
  bugsEscaped: 1,
  criteriaMissed: 1,
  testCoverage: { cardsWithTests: 1, cardsMeasured: 2, rate: 0.5 },
};

describe('hr formatting', () => {
  it('formats rates, counts, tokens and durations', () => {
    expect(pct(0.3333)).toBe('33%');
    expect(pct(0.0004)).toBe('<1%');
    expect(pct(0)).toBe('0%');
    expect(pct(null)).toBe('–');
    expect(num(1.5)).toBe('1.5');
    expect(num(3)).toBe('3');
    expect(tokens(1600)).toBe('1.6k');
    expect(tokens(12_000)).toBe('12k');
    expect(tokens(400)).toBe('400');
    expect(duration(7_200_000)).toBe('2h');
    expect(duration(90_000)).toBe('1.5m');
    expect(duration(4000)).toBe('4s');
    expect(duration(null)).toBe('–');
  });

  it('compares against the team in the right direction', () => {
    expect(versusTeam(stat(0.1, 0.3), true)).toBe('better');
    expect(versusTeam(stat(0.5, 0.3), true)).toBe('worse');
    expect(versusTeam(stat(5, 3), false)).toBe('better');
    expect(versusTeam(stat(0.3, 0.3), true)).toBe('same');
    expect(versusTeam(stat(null, 0.3), true)).toBe('unknown');
    expect(describeStat(stat(0.5, 0.25), pct)).toBe('50% (team 25%)');
    expect(describeStat(stat(0.5, null), pct)).toBe('50%');
  });
});

describe('charts', () => {
  it('give every chart an accessible name with the numbers', () => {
    const { container } = render(
      <>
        <Sparkline values={[0, 1, 2]} label="Cards done per day" />
        <CompareBar value={0.3} team={0.1} label="Rework 30% (team 10%)" />
        <BarChart
          caption="Throughput"
          data={[
            { label: 'Mon', value: 2 },
            { label: 'Tue', value: 0 },
          ]}
        />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Cards done per day' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Rework 30% (team 10%)' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Throughput: Mon 2, Tue 0' })).toBeTruthy();
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });
});

describe('AgentStats', () => {
  it('shows each stat next to the team average', () => {
    render(<AgentStats stats={stats} roleName="builder" />);
    expect(within(screen.getByTestId('stat-cards-done')).getByTestId('stat-value').textContent).toBe('3');
    expect(within(screen.getByTestId('stat-cards-done')).getByTestId('stat-team').textContent).toBe(
      'team 1.5',
    );
    expect(within(screen.getByTestId('stat-rework-rate')).getByTestId('stat-value').textContent).toBe('33%');
    expect(within(screen.getByTestId('stat-rework-rate')).getByTestId('stat-team').textContent).toBe(
      'team 20%',
    );
    expect(within(screen.getByTestId('stat-bugs-escaped')).getByTestId('stat-value').textContent).toBe('–');
    expect(within(screen.getByTestId('stat-tokens-per-card')).getByTestId('stat-value').textContent).toBe(
      '1.6k',
    );
    expect(
      screen.getByRole('img', { name: /Rework rate: 33% \(team 20%\), worse than the team average/ }),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: /Cards done per day/ })).toBeTruthy();
  });
});

describe('WorkQualityPanel', () => {
  it('shows score, rounds, bugs, criteria, coverage and rework by reason (spec unclear not counted)', () => {
    render(<WorkQualityPanel quality={quality} />);
    expect(screen.getByTestId('quality-score').textContent).toContain('3.7 of 5');
    expect(screen.getByTestId('quality-rounds').textContent).toContain('max 3, 1 with 3+');
    expect(screen.getByTestId('quality-bugs').textContent).toContain('1');
    expect(screen.getByTestId('quality-criteria').textContent).toContain('1');
    expect(screen.getByTestId('quality-coverage').textContent).toContain('50% (1 of 2 cards)');
    expect(screen.getByTestId('reason-weak_tests').textContent).toContain('No or weak tests');
    expect(screen.getByTestId('reason-spec_unclear').textContent).toContain(
      'not counted against the builder',
    );
    expect(screen.getByTestId('reason-weak_tests').textContent).not.toContain('not counted');
  });

  it('is calm when there is nothing yet', () => {
    render(
      <WorkQualityPanel
        quality={{
          ...quality,
          reviewScoreAvg: null,
          reviewCount: 0,
          reworkByReason: [],
          testCoverage: { cardsWithTests: 0, cardsMeasured: 0, rate: null },
        }}
      />,
    );
    expect(screen.getByTestId('quality-score').textContent).toContain('–');
    expect(screen.getByText('No review bounces.')).toBeTruthy();
  });
});

const rec = (over: Partial<Recommendation>): Recommendation => ({
  id: 'model_up:x',
  kind: 'model_up',
  title: 'Bea struggles on large cards: try opus',
  summary: 'On large cards 2 of 2 came back.',
  agentId: ID(1),
  agentName: 'Bea',
  roleKey: 'builder',
  evidence: {
    metrics: [{ label: 'Large cards', value: '2' }],
    items: [{ text: 'Bounced with score 2', ref: 'TOY-3' }],
  },
  action: { type: 'change_model', agentId: ID(1), model: 'opus', fromModel: 'sonnet' },
  canApply: true,
  ...over,
});

describe('RecommendationList', () => {
  it('shows the evidence and applies with one click', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            applied: true,
            effect: 'Bea moved from sonnet to opus',
            deskItemId: null,
            agentIds: [ID(1)],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    wrap(<RecommendationList recommendations={[rec({})]} />);
    expect(screen.getByText('Bea struggles on large cards: try opus')).toBeTruthy();
    expect(screen.getByTestId('rec-evidence').textContent).toContain('Large cards: 2');
    expect(screen.getByRole('link', { name: 'TOY-3' }).getAttribute('href')).toBe('/cards/TOY-3');
    await userEvent.click(screen.getByTestId('apply-model_up'));
    await waitFor(() =>
      expect(screen.getByTestId('rec-applied').textContent).toContain('moved from sonnet to opus'),
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/hr/recommendations/model_up%3Ax/apply');
    expect(call[1].method).toBe('POST');
  });

  it('a standing-order proposal shows its text and points to the desk once applied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              applied: true,
              effect: 'Proposed a standing order on the desk',
              deskItemId: ID(9),
              agentIds: [],
            }),
            { status: 200 },
          ),
      ),
    );
    wrap(
      <RecommendationList
        recommendations={[
          rec({
            id: 'rework_reason:a:weak_tests',
            kind: 'rework_reason',
            action: { type: 'standing_order', text: 'Always ship tests.', topic: 'No or weak tests' },
          }),
        ]}
      />,
    );
    expect(screen.getByTestId('rec-proposal').textContent).toContain('Always ship tests.');
    await userEvent.click(screen.getByTestId('apply-rework_reason'));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Approve it on the desk' })).toBeTruthy());
  });

  it('shows a not-yours badge without Apply, and advice-only items without a button', () => {
    wrap(
      <RecommendationList
        recommendations={[
          rec({ canApply: false }),
          rec({
            id: 'reviewer_strict:r',
            kind: 'reviewer_strict',
            action: { type: 'none' },
            canApply: false,
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('apply-model_up')).toBeNull();
    expect(screen.queryByTestId('apply-reviewer_strict')).toBeNull();
    expect(screen.getByText('Not yours to apply')).toBeTruthy();
    expect(screen.getAllByText('Advice only').length).toBeGreaterThan(0);
  });

  it('renders nothing without recommendations', () => {
    const { container } = wrap(<RecommendationList recommendations={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('RoleUpdates', () => {
  const update: RoleUpdate = {
    roleKey: 'tester',
    roleName: 'Tester',
    extensionBaseVersion: 1,
    latestVersion: 2,
    purpose: 'Runs the test plan',
    extensions: {
      instructions: 'Always run lint first.',
      skills: ['lint'],
      standingOrders: ['Never skip e2e'],
    },
    agentsOnOlderVersion: 1,
  };

  it('shows what a reset removes before confirming, then resets', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            roleKey: 'tester',
            toVersion: 2,
            droppedExtensions: update.extensions,
            updatedAgentIds: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    wrap(<RoleUpdates updates={[update]} />);
    expect(screen.getByTestId('role-update-tester').textContent).toContain('new default (version 2)');
    expect(screen.getByTestId('role-update-tester').textContent).toContain(
      '1 agent is still on the old version',
    );
    await userEvent.click(screen.getByTestId('reset-tester'));
    const diff = screen.getByTestId('reset-diff');
    expect(diff.textContent).toContain('Extra instructions: Always run lint first.');
    expect(diff.textContent).toContain('Skill: lint');
    expect(diff.textContent).toContain('Standing order: Never skip e2e');
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('confirm-reset'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/hr/roles/tester/reset');
  });
});

describe.each([
  ['desktop', false],
  ['mobile', true],
])('dismissing recommendations on %s', (_n, mobile) => {
  const realMM = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: mobile ? /max-width:\s*767/.test(query) : /min-width:\s*(1024|768|640)px/.test(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = realMM;
  });
  const two = [rec({}), rec({ id: 'model_down:y', kind: 'model_down' })];

  it('Dismiss asks (with an optional reason) and posts it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ dismissed: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    wrap(<RecommendationList recommendations={two} />);
    await userEvent.click(screen.getByTestId('dismiss-model_up'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'covered already');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/hr/recommendations/model_up%3Ax/dismiss');
    expect(JSON.parse(String(call[1].body))).toEqual({ reason: 'covered already' });
  });

  it('Dismiss all asks first, then dismisses everything', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ dismissed: 2 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    wrap(<RecommendationList recommendations={two} />);
    await userEvent.click(screen.getByTestId('dismiss-all-recs'));
    const dialog = await screen.findByRole('dialog');
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Dismiss all' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/hr/recommendations/dismiss-all');
  });

  it('a failed apply (409 duplicate) is explained on its own card, with Dismiss still there', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'duplicate_order', message: 'the organization already has this standing order' },
            }),
            { status: 409 },
          ),
      ),
    );
    wrap(
      <RecommendationList
        recommendations={[
          rec({
            id: 'rework_reason:a:weak_tests',
            kind: 'rework_reason',
            action: { type: 'standing_order', text: 'Always ship tests.', topic: 'No or weak tests' },
          }),
        ]}
      />,
    );
    await userEvent.click(screen.getByTestId('apply-rework_reason'));
    expect((await screen.findByTestId('rec-apply-error')).textContent).toContain(
      'already has this standing order',
    );
    expect(screen.getByTestId('dismiss-rework_reason')).toBeTruthy();
  });
});
