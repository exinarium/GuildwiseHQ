import { describe, expect, it } from 'vitest';
import { CeoRpcSchema, DomainEventSchema } from '../src/index.ts';

const ID = '11111111-1111-4111-8111-111111111111';

describe('aom ceo topic', () => {
  it('accepts propose with notes, and propose without (from the conversation)', () => {
    const base = { op: 'topic', sub: 'propose', question: 'How can teams deploy safely?', area: 'deploy' };
    expect(CeoRpcSchema.safeParse({ ...base, from: ['11111111', '22222222'] }).success).toBe(true);
    const bare = CeoRpcSchema.safeParse(base);
    expect(bare.success && bare.data.op === 'topic' && bare.data.from).toEqual([]);
    expect(CeoRpcSchema.safeParse({ op: 'topic', sub: 'list' }).success).toBe(true);
  });
  it('rejects an unknown area and a too-short note id', () => {
    expect(
      CeoRpcSchema.safeParse({ op: 'topic', sub: 'propose', question: 'x', area: 'billing' }).success,
    ).toBe(false);
    expect(
      CeoRpcSchema.safeParse({ op: 'topic', sub: 'propose', question: 'x', area: 'cost', from: ['abc'] })
        .success,
    ).toBe(false);
  });
});

describe('the CeoTopic events', () => {
  const parse = (type: string, payload: unknown) => DomainEventSchema.safeParse({ type, payload });
  it('carry evidence as ids and kinds only', () => {
    expect(
      parse('CeoTopicNoted', {
        candidateId: ID,
        orgId: ID,
        sourceKind: 'repeat',
        evidence: [{ kind: 'repeat', id: ID }],
        note: 'Asked again and again: send-invoices',
      }).success,
    ).toBe(true);
    expect(
      parse('CeoTopicNoted', { candidateId: ID, orgId: ID, sourceKind: 'mail', evidence: [], note: 'x' })
        .success,
    ).toBe(false);
  });
  it('knows the review and the hand-off outcome', () => {
    expect(
      parse('CeoTopicReviewed', { candidateId: ID, orgId: ID, decision: 'accepted', topicId: ID, by: ID })
        .success,
    ).toBe(true);
    expect(
      parse('CeoTopicOutcome', { candidateId: ID, orgId: ID, outcome: 'published', postSlug: 'a-post' })
        .success,
    ).toBe(true);
    expect(parse('CeoTopicOutcome', { candidateId: ID, orgId: ID, outcome: 'queued' }).success).toBe(false);
  });
});
