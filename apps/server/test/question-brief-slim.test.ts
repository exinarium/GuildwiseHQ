import type { ShiftBrief } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { slimQuestionBrief } from '../src/runner-gateway/question-brief.ts';

const long = (n: number, c = 'x') => c.repeat(n);

/** A brief like P5-4's: 211 ledger entries and a full thread of long messages. */
const bloated = (): ShiftBrief =>
  ({
    shift: {
      id: 'a',
      kind: 'question',
      stage: 'question',
      stageLabel: 'Question',
      doneCriteria: '',
      outcomes: [],
    },
    agent: { id: 'b', name: 'Donald', seniority: 'senior' },
    card: {
      id: 'c',
      ref: 'P5-4',
      title: 'Test',
      cardType: 'feature',
      fields: { context: long(20_000), requirements: 'short' },
      dependencies: [],
      attachments: [{ name: 'f.png' }],
    },
    project: { id: 'p', key: 'P5', name: 'P5', workingBranch: 'main', e2eGlobs: [], architecturalGlobs: [] },
    role: { key: 'architect', name: 'Architect', instructions: 'i', coreRules: [], skills: [] },
    handoffs: Array.from({ length: 20 }, (_, i) => ({
      stage: 'build',
      agentName: 'Ken',
      outcome: 'handoff',
      note: long(5000),
      at: `2026-10-1${i % 9}T10:00:00.000Z`,
    })),
    reviewComments: [
      {
        reviewerName: 'Alan',
        reasons: [],
        criteriaMissed: [],
        comments: long(9000),
        at: '2026-10-16T10:00:00.000Z',
      },
    ],
    thread: Array.from({ length: 30 }, (_, i) => ({
      authorName: `a${i}`,
      kind: 'comment',
      body: long(20_000),
      at: '2026-10-16T10:00:00.000Z',
    })),
    standingOrders: [{ title: 'Order', body: long(3000) }],
    ledger: Array.from({ length: 211 }, (_, i) => ({
      id: String(i),
      scope: 'feature',
      title: `q${i}`,
      body: long(2500),
    })),
  }) as unknown as ShiftBrief;

describe('the slim question brief', () => {
  it('stays under the cap with 211 ledger entries and 30 long messages, and keeps the card and the question context', () => {
    const before = JSON.stringify(bloated()).length;
    const slim = slimQuestionBrief(bloated());
    const after = JSON.stringify(slim).length;
    expect(before).toBeGreaterThan(1_000_000);
    expect(after).toBeLessThan(48_000);
    expect(slim.ledger).toEqual([]);
    expect(slim.thread).toHaveLength(3);
    expect(slim.handoffs.length).toBeLessThanOrEqual(3);
    expect(slim.card.ref).toBe('P5-4');
    expect(slim.card.attachments).toEqual([]);
    expect((slim.card.fields.context as string).length).toBeLessThanOrEqual(3000);
    expect(slim.card.fields.requirements).toBe('short');
    expect(slim.standingOrders[0]?.body.length).toBeLessThanOrEqual(600);
  });

  it('drops the thread and handoffs when the card itself is huge', () => {
    const b = bloated();
    b.card.fields = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, long(3000)]));
    const slim = slimQuestionBrief(b);
    expect(slim.thread).toEqual([]);
    expect(slim.handoffs).toEqual([]);
  });
});
