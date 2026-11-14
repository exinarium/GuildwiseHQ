import { describe, expect, it } from 'vitest';
import {
  LIVE_REVIEWERS,
  type PostedFindingRow,
  PrReviewRunPayloadSchema,
  REPLAY_REVIEWERS,
  replayFindingView,
  replayOrderKey,
  replayResult,
  SetReviewTargetsRequestSchema,
} from '../src/index.ts';

const row = (over: Partial<PostedFindingRow> = {}): PostedFindingRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  prReviewId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  rank: 1,
  severity: 'high',
  path: 'a.ts',
  line: 3,
  title: 't',
  body: 'b',
  postedAt: null,
  reviewUrl: null,
  mark: null,
  markedAt: null,
  reviewers: [{ key: 'second', label: 'Opus reviewer', model: 'opus' }],
  ...over,
});

describe('replayFindingView (AC2)', () => {
  it('hides the reviewer even when the finding is marked, until the replay is revealed', () => {
    const v = replayFindingView(row({ mark: 'useful', markedAt: '2026-01-01T00:00:00Z' }), {
      revealed: false,
      canMark: true,
    });
    expect(v.reviewers).toBeNull();
    const text = JSON.stringify(v).toLowerCase();
    for (const w of ['first', 'second', 'sonnet', 'opus']) expect(text).not.toContain(w);
  });
  it('shows the reviewer once revealed', () => {
    const v = replayFindingView(row({ mark: 'noise' }), { revealed: true, canMark: false });
    expect(v.reviewers?.[0]?.key).toBe('second');
  });
  it('orders by a hash of the id, not the id', () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const byId = [...ids];
    const byKey = [...ids].sort((a, b) =>
      replayOrderKey({ prIdx: 0, id: a }).localeCompare(replayOrderKey({ prIdx: 0, id: b })),
    );
    expect(byKey).not.toEqual(byId);
    expect(
      replayOrderKey({ prIdx: 1, id: ids[0] as string }) > replayOrderKey({ prIdx: 0, id: ids[1] as string }),
    ).toBe(true);
  });
});

describe('replayResult (AC3)', () => {
  const prs = Array.from({ length: 20 }, (_, i) => ({
    id: `pr${i}`,
    mergedAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
  }));
  const mk = (n: number, reviewer: 'first' | 'second', useful: number, held = 0) => {
    const out = [] as {
      id: string;
      reviewer: 'first' | 'second';
      model: string;
      disposition: 'posted' | 'held_back';
      mark: 'useful' | 'noise' | null;
    }[];
    for (let i = 0; i < n; i++)
      out.push({
        id: `${reviewer}-${i}`,
        reviewer,
        model: reviewer === 'first' ? 'sonnet' : 'opus',
        disposition: 'posted',
        mark: i < useful ? 'useful' : 'noise',
      });
    for (let i = 0; i < held; i++)
      out.push({ id: `${reviewer}-h${i}`, reviewer, model: 'm', disposition: 'held_back', mark: null });
    return out;
  };
  it('computes precision per reviewer from would-post findings only, without the posted flag', () => {
    const r = replayResult({
      prs,
      runs: [],
      findings: [...mk(10, 'first', 7, 2), ...mk(8, 'second', 6)],
      views: [],
    });
    const first = r.reviewers.find((x) => x.reviewer === 'first');
    const second = r.reviewers.find((x) => x.reviewer === 'second');
    expect(first).toMatchObject({ wouldPost: 10, heldBack: 2, useful: 7, noise: 3, precision: 0.7 });
    expect(second).toMatchObject({ wouldPost: 8, useful: 6, precision: 0.75 });
    expect(REPLAY_REVIEWERS).toEqual(['first', 'second']);
  });
  it('sums marking time with a 10 minute cap per finding', () => {
    const t0 = Date.UTC(2026, 1, 1);
    const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
    const findings = mk(3, 'first', 2);
    const r = replayResult({
      prs,
      runs: [],
      findings,
      views: [
        { findingId: 'first-0', shownAt: at(0), markedAt: at(2) },
        { findingId: 'first-1', shownAt: at(2), markedAt: at(5) },
        { findingId: 'first-2', shownAt: at(5), markedAt: at(30) },
      ],
    });
    expect(r.effort.activeMs).toBe(15 * 60_000);
    expect(r.effort.perPrMs).toBe(45_000);
    expect(r.effort.findingsMarked).toBe(3);
    expect(r.effort.wallClockMs).toBe(30 * 60_000);
    expect(r.reviewers[0]?.effortMs).toBe(15 * 60_000);
    // 20 PRs over 19 days: 20 / (19/7) = 7.37 per week; 45 s each = 0.0125 h
    expect(r.effort.prsPerWeek).toBeCloseTo(7.37, 1);
    expect(r.effort.hoursPerWeekEstimate).toBeCloseTo(0.09, 2);
  });
  it('has null precision and zero effort without findings, and counts reviewed PRs', () => {
    const r = replayResult({
      prs,
      runs: [{ replayPrId: 'pr0', reviewer: 'first', model: 'sonnet', state: 'offline_completed' }],
      findings: [],
      views: [],
    });
    expect(r.reviewers.every((x) => x.precision === null)).toBe(true);
    expect(r.effort.activeMs).toBe(0);
    expect(r.effort.perFindingMs).toBeNull();
    expect(r.reviewers[0]).toMatchObject({ prsReviewed: 1, prsNotReviewed: 19 });
  });
});

describe('payload and targets', () => {
  const base = {
    runId: '33333333-3333-4333-8333-333333333333',
    projectId: '33333333-3333-4333-8333-333333333333',
    prReviewId: '33333333-3333-4333-8333-333333333333',
    projectRepoId: '33333333-3333-4333-8333-333333333333',
    remoteUrlNormalized: 'github.com/o/r',
    prNumber: 4,
    baseRef: 'main',
    title: 't',
    reviewer: 'second',
    runtime: 'claude-code',
    model: 'opus',
    timeoutMs: 600000,
  };
  it('a replay block requires offline', () => {
    const replay = {
      replayId: base.runId,
      replayPrId: base.runId,
      headSha: 'a'.repeat(40),
      mergeCommitSha: 'b'.repeat(40),
    };
    expect(PrReviewRunPayloadSchema.safeParse({ ...base, replay }).success).toBe(false);
    expect(PrReviewRunPayloadSchema.safeParse({ ...base, replay, offline: true }).success).toBe(true);
    expect(PrReviewRunPayloadSchema.safeParse(base).success).toBe(true);
  });
  it('live reviewers stay on the first reviewer', () => {
    expect([...LIVE_REVIEWERS]).toEqual(['first']);
  });
  it('validates the targets', () => {
    expect(
      SetReviewTargetsRequestSchema.safeParse({ precisionTarget: 0.7, effortTargetHoursPerWeek: 3 }).success,
    ).toBe(true);
    expect(
      SetReviewTargetsRequestSchema.safeParse({ precisionTarget: 1.2, effortTargetHoursPerWeek: 3 }).success,
    ).toBe(false);
    expect(
      SetReviewTargetsRequestSchema.safeParse({ precisionTarget: 0.7, effortTargetHoursPerWeek: -1 }).success,
    ).toBe(false);
    expect(
      SetReviewTargetsRequestSchema.safeParse({ precisionTarget: 0.123, effortTargetHoursPerWeek: 3 })
        .success,
    ).toBe(false);
  });
});
