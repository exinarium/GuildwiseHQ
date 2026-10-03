import { describe, expect, it } from 'vitest';
import {
  AgentStatsSchema,
  countsAgainstBuilder,
  DiffStats,
  DomainEventSchema,
  HR_RULES,
  HrBoardResponseSchema,
  isThinSpec,
  MetricsResponseSchema,
  modelTier,
  REWORK_STANDING_ORDER,
  RecommendationSchema,
  ReworkReason,
  scheduleBackoffMs,
  shiftModel,
  topicWords,
} from '../src/index.ts';

const ID = '0192f3a0-0000-7000-8000-000000000001';

describe('model ladder', () => {
  it('moves one step up or down and keeps the version suffix', () => {
    expect(shiftModel('sonnet', 1)).toBe('opus');
    expect(shiftModel('opus', -1)).toBe('sonnet');
    expect(shiftModel('claude-sonnet-5-5', 1)).toBe('claude-opus-5-5');
    expect(shiftModel('opus', 1)).toBeNull();
    expect(shiftModel('haiku', -1)).toBeNull();
    expect(shiftModel('mock', 1)).toBeNull();
    expect(modelTier('Claude-Haiku-4')).toBe(0);
  });
});

describe('HR rules helpers', () => {
  it('everything except an unclear spec counts against the builder, and every other reason has a standing order', () => {
    for (const r of ReworkReason.options) {
      expect(countsAgainstBuilder(r)).toBe(r !== 'spec_unclear');
      expect(REWORK_STANDING_ORDER[r] === null).toBe(r === 'spec_unclear');
    }
  });

  it('a spec is thin with fewer than two criteria or almost no requirements', () => {
    const rich = { acceptanceCriteria: ['a', 'b'], requirements: 'x'.repeat(60) };
    expect(isThinSpec(rich)).toBe(false);
    expect(isThinSpec({ ...rich, acceptanceCriteria: ['a'] })).toBe(true);
    expect(isThinSpec({ ...rich, requirements: 'reqs' })).toBe(true);
    expect(isThinSpec(null)).toBe(true);
  });

  it('finds the topic words of a question', () => {
    expect(topicWords('What naming should the orders schema use?')).toEqual(['naming', 'orders', 'schema']);
    expect(topicWords('Is it ok?')).toEqual([]);
  });

  it('schedule retries back off 1 min doubling to a 6 h cap', () => {
    expect([1, 2, 3, 4].map(scheduleBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(scheduleBackoffMs(30)).toBe(6 * 3600_000);
    expect(HR_RULES.minCards).toBeGreaterThan(1);
  });
});

describe('M9 contract', () => {
  it('registers the HR and scheduler-health events', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'RecommendationApplied',
        payload: { orgId: ID, recommendationId: 'model_up:x', kind: 'model_up', appliedBy: ID, effect: 'ok' },
      }).success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'ScheduleFireFailed',
        payload: { scheduleId: ID, error: 'no repo', attempts: 1, nextFireAt: new Date().toISOString() },
      }).success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({ type: 'ScheduleFireFailed', payload: { scheduleId: ID } }).success,
    ).toBe(false);
  });

  it('diff stats carry an optional count of test files', () => {
    expect(DiffStats.parse({ files: 1, added: 1, removed: 0 }).testFiles).toBeUndefined();
    expect(DiffStats.parse({ files: 1, added: 1, removed: 0, testFiles: 2 }).testFiles).toBe(2);
  });

  it('validates the response shapes', () => {
    const stat = { value: null, team: null };
    const stats = {
      agentId: ID,
      windowDays: 30,
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      cardsTouched: 0,
      cardsDone: stat,
      blockedRate: stat,
      reworkRate: stat,
      bugsEscaped: stat,
      utilisation: stat,
      tokensPerCard: stat,
      doneByDay: [],
    };
    expect(AgentStatsSchema.safeParse(stats).success).toBe(true);
    expect(
      RecommendationSchema.safeParse({
        id: 'fire_idle:x',
        kind: 'fire_idle',
        title: 't',
        summary: 's',
        agentId: ID,
        agentName: 'A',
        roleKey: 'builder',
        evidence: { metrics: [], items: [] },
        action: { type: 'fire', agentId: ID },
        canApply: true,
      }).success,
    ).toBe(true);
    expect(
      HrBoardResponseSchema.safeParse({ windowDays: 30, agents: [], recommendations: [], roleUpdates: [] })
        .success,
    ).toBe(true);
    expect(
      MetricsResponseSchema.safeParse({
        projectId: null,
        from: new Date().toISOString(),
        to: new Date().toISOString(),
        throughput: [],
        timeBlockedOnManager: { totalMs: 0, cards: 0, avgMsPerCard: null },
        bounceRate: [],
        bugsEscaped: { total: 0, byDay: [] },
        duration: { cards: 0, avgMsPerCard: null, medianMsPerCard: null, perAgent: [] },
        queueDepth: [],
      }).success,
    ).toBe(true);
  });
});
