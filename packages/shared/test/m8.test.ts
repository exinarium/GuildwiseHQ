import { describe, expect, it } from 'vitest';
import {
  checkOutboundLeaks,
  DomainEventSchema,
  getBuiltinRole,
  OutboundPostPayloadSchema,
  OutboundPostResultSchema,
  RpcMethodSchema,
  RunnerCommandNameSchema,
  streamId,
} from '../src/index.ts';

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';

describe('the leak check for outbound drafts', () => {
  it('passes plain prose in the manager voice', () => {
    expect(
      checkOutboundLeaks('The export now includes archived items. It ships next week.', ['Bea', 'Rex']),
    ).toEqual({
      ok: true,
      matches: [],
    });
  });

  it('finds agent names as whole words only', () => {
    const r = checkOutboundLeaks('Bea fixed it.', ['Bea', 'Rex']);
    expect(r.ok).toBe(false);
    expect(r.matches).toEqual(['agent name "Bea"']);
    // part of another word, or another case, is not the agent
    expect(checkOutboundLeaks('Beautiful: a bear and the rexall store.', ['Bea', 'Rex']).ok).toBe(true);
    // punctuation and possessives still count
    expect(checkOutboundLeaks("Rex's review", ['Rex']).ok).toBe(false);
  });

  it('matches agent names case-insensitively, without flagging everyday words (review low)', () => {
    expect(checkOutboundLeaks('thanks bea, rex did this', ['Bea', 'Rex']).matches).toEqual([
      'agent name "Bea"',
      'agent name "Rex"',
    ]);
    expect(checkOutboundLeaks('BEA fixed it.', ['Bea']).ok).toBe(false);
    // names that are ordinary words: only a capitalized use is the agent
    expect(
      checkOutboundLeaks('I will mark the ticket as done, as we may agree.', ['Will', 'Mark', 'May']).ok,
    ).toBe(true);
    expect(checkOutboundLeaks('Will fixed the export.', ['Will']).ok).toBe(false);
  });

  it('catches internal branch names, the product name in any case and role words', () => {
    expect(checkOutboundLeaks('Pushed to aom/web-12-add-login.').ok).toBe(false);
    expect(checkOutboundLeaks('built with agent org manager').ok).toBe(false);
    expect(checkOutboundLeaks('The scout found it.').ok).toBe(false);
    expect(checkOutboundLeaks('A standing order says so.').ok).toBe(false);
  });

  it('keeps false positives low on realistic manager text', () => {
    for (const text of [
      'The export now includes archived items. AI-assisted search is unchanged.',
      'We shipped the fix to the login page; the team will monitor error rates this week.',
      'Rolled out to 10% of customers. The organization settings page has a new layout.',
      'Tested on Chrome and Safari; the checkout flow works as expected.',
      'Updated the API to return 404 instead of 500 for missing records.',
    ])
      expect(checkOutboundLeaks(text, ['Bea', 'Rex']), text).toEqual({ ok: true, matches: [] });
  });

  it.each([
    'It bounced back twice.',
    'The reviewer asked for changes.',
    'Review comments were addressed.',
    'Comments from the reviewer were fixed.',
    'Changes requested were made.',
    'After some rework it passed.',
    'We raised it on the decision desk.',
    'The question thread settled it.',
    'It was escalated to the manager.',
    'Per the ledger we use tabs.',
    'The builder implemented it.',
    'The BA drafted this.',
    'Guildwise HQ did it.',
    'Our agents wrote it.',
  ])('finds internal workings: %s', (text) => {
    expect(checkOutboundLeaks(text).ok).toBe(false);
  });

  it('reports every offender once, in order of appearance', () => {
    const r = checkOutboundLeaks('Rex said the rework bounced; Rex agreed.', ['Rex']);
    expect(r.matches).toEqual(['agent name "Rex"', '"rework" (rework)', '"bounced" (bounce)']);
  });
});

describe('the outbound contract', () => {
  it('has the events, the command and the rpc', () => {
    const draftId = U;
    for (const e of [
      {
        type: 'OutboundDrafted',
        payload: {
          draftId,
          cardId: U,
          externalSystem: 'jira',
          externalKey: 'ABC-1',
          kind: 'comment',
          body: 'x',
          deskItemId: U,
        },
      },
      { type: 'OutboundApproved', payload: { draftId, finalBody: 'x', approvedBy: U } },
      { type: 'OutboundRejected', payload: { draftId, by: U } },
      { type: 'OutboundPosted', payload: { draftId, externalRef: 'u' } },
      { type: 'OutboundPostFailed', payload: { draftId, error: 'no' } },
      {
        type: 'OutboundBlocked',
        payload: {
          draftId,
          cardId: U,
          externalSystem: 'github',
          externalKey: 'a/b#1',
          kind: 'decision',
          body: 'x',
          matches: [],
        },
      },
    ])
      expect(DomainEventSchema.safeParse(e).success, e.type).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'OutboundApproved',
        payload: { draftId, finalBody: '', approvedBy: U },
      }).success,
    ).toBe(false);
    expect(streamId.outbound(U)).toBe(`outbound-${U}`);
    expect(RunnerCommandNameSchema.options).toContain('outbound.post');
    expect(RpcMethodSchema.options).toContain('outbound.draft');
  });

  it('validates the post command payload and result', () => {
    const p = OutboundPostPayloadSchema.parse({
      draftId: U,
      cardId: U,
      cardRef: 'TOY-1',
      ref: { system: 'github', key: 'acme/toy#12' },
      kind: 'resolution',
      body: 'Done.',
    });
    expect(p.agentNames).toEqual([]);
    expect(OutboundPostPayloadSchema.safeParse({ ...p, body: '' }).success).toBe(false);
    expect(OutboundPostResultSchema.parse({ ok: true, externalRef: 'u', duplicate: true })).toMatchObject({
      ok: true,
    });
  });

  it('tells the BA to draft in the manager voice and never to name agents', () => {
    const ba = getBuiltinRole('ba');
    expect(ba?.instructions).toMatch(/aom outbound draft/);
    expect(ba?.instructions).toMatch(/manager's voice/);
    expect(ba?.instructions).toMatch(/never name an agent/);
  });
});
