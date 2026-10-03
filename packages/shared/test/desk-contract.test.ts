import { describe, expect, it } from 'vitest';
import {
  AnswerDeskItemRequestSchema,
  ChangePasswordRequestSchema,
  CreateLedgerEntryRequestSchema,
  DeskItemDtoSchema,
  DomainEventSchema,
  type EventType,
  formatLedgerMatches,
  optionId,
  renderChatInstructions,
  ThreadMessagesQuerySchema,
} from '../src/index.ts';
import { agentSpec, TS, U } from './fixtures.ts';

describe('M2 events', () => {
  it('registers the desk, ledger and chat events', () => {
    const types = DomainEventSchema.options.map((o) => o.shape.type.value) as EventType[];
    for (const t of [
      'QuestionRaised',
      'QuestionEscalated',
      'QuestionAnswered',
      'DeskItemCreated',
      'DeskItemResolved',
      'LedgerEntryAdded',
      'LedgerEntrySuperseded',
      'ChatThreadCreated',
      'WorkstationTokenRotated',
    ] as EventType[])
      expect(types).toContain(t);
  });

  it('QuestionRaised applies defaults and keeps option ids', () => {
    const r = DomainEventSchema.parse({
      type: 'QuestionRaised',
      payload: {
        deskItemId: U.a,
        cardId: U.b,
        askedBy: { kind: 'agent', agentId: U.c, role: 'builder' },
        question: 'Tabs or spaces?',
        options: [
          { id: optionId(0), label: 'tabs' },
          { id: optionId(1), label: 'spaces' },
        ],
        recommendation: optionId(0),
        blocking: true,
      },
    });
    expect(r.type === 'QuestionRaised' && r.payload).toMatchObject({
      doing: '',
      routedTo: 'manager',
      dedupLedgerIds: [],
      affectedCardIds: [],
      pinned: false,
    });
    expect(optionId(0)).toBe('o1');
  });

  it('QuestionAnswered needs the ledger entry id', () => {
    const base = { deskItemId: U.a, answer: 'tabs', answeredBy: { kind: 'user', userId: U.b } };
    expect(DomainEventSchema.safeParse({ type: 'QuestionAnswered', payload: base }).success).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        type: 'QuestionAnswered',
        payload: { ...base, ledgerEntryId: U.c, unblockedCardIds: [U.d] },
      }).success,
    ).toBe(true);
  });

  it('LedgerEntryAdded validates scope', () => {
    const ok = {
      entryId: U.a,
      scope: 'standing_order',
      title: 'Never push to main',
      body: 'Agents never push.',
    };
    expect(DomainEventSchema.safeParse({ type: 'LedgerEntryAdded', payload: ok }).success).toBe(true);
    expect(
      DomainEventSchema.safeParse({ type: 'LedgerEntryAdded', payload: { ...ok, scope: 'nope' } }).success,
    ).toBe(false);
  });
});

describe('M2 api schemas', () => {
  it('answer request defaults the ledger scope to decision', () => {
    expect(AnswerDeskItemRequestSchema.parse({ answer: 'tabs' }).ledger).toEqual({ scope: 'decision' });
    expect(
      AnswerDeskItemRequestSchema.parse({ answer: 'x', ledger: { scope: 'standing_order', orgWide: true } })
        .ledger,
    ).toEqual({ scope: 'standing_order', orgWide: true });
  });

  it('feature and decision entries need a project or card; standing orders may be org-wide', () => {
    const base = { title: 't', body: 'b' };
    expect(CreateLedgerEntryRequestSchema.safeParse({ ...base, scope: 'standing_order' }).success).toBe(true);
    expect(CreateLedgerEntryRequestSchema.safeParse({ ...base, scope: 'decision' }).success).toBe(false);
    expect(
      CreateLedgerEntryRequestSchema.safeParse({ ...base, scope: 'decision', projectId: U.a }).success,
    ).toBe(true);
  });

  it('desk item dto requires the fields the page renders', () => {
    const dto = {
      id: U.a,
      kind: 'question',
      subkind: null,
      status: 'open',
      routedTo: 'manager',
      title: 'Tabs or spaces?',
      body: '',
      doing: 'writing the formatter',
      options: [{ id: 'o1', label: 'tabs' }],
      recommendation: 'o1',
      blocking: true,
      pinned: true,
      urgent: true,
      affectedCardIds: [U.b],
      affectedCount: 1,
      askedBy: { kind: 'agent', agentId: U.c, agentName: 'Ada', role: 'builder' },
      card: { id: U.b, ref: 'TOY-1', title: 'T', stage: 'build', status: 'blocked', projectKey: 'TOY' },
      projectId: U.d,
      dedupEntries: [],
      answer: null,
      answerOption: null,
      answeredAt: null,
      answeredByName: null,
      decisionPolicy: 'owner_only',
      canAnswer: true,
      createdAt: TS,
    };
    expect(DeskItemDtoSchema.parse(dto)).toEqual(dto);
    expect(DeskItemDtoSchema.safeParse({ ...dto, doing: undefined }).success).toBe(false);
  });

  it('password change and thread paging', () => {
    expect(ChangePasswordRequestSchema.safeParse({ current: 'x', new: 'short' }).success).toBe(false);
    expect(ChangePasswordRequestSchema.safeParse({ current: 'x', new: 'long-enough-password' }).success).toBe(
      true,
    );
    expect(ThreadMessagesQuerySchema.parse({}).limit).toBe(50);
  });
});

describe('ledger text helpers', () => {
  it('formats matches for the agent terminal', () => {
    expect(formatLedgerMatches([])).toBe('No matching ledger entries.');
    const text = formatLedgerMatches([
      { id: U.a, scope: 'decision', title: 'Indentation', body: 'Use tabs.\nAlways.' },
    ]);
    expect(text).toContain('[decision] Indentation');
    expect(text).toContain('Use tabs.');
  });

  it('chat instructions name the agent, context and tools', () => {
    const text = renderChatInstructions(agentSpec, { projectKey: 'WEB', cardRef: 'WEB-12' });
    expect(text).toContain(`You are ${agentSpec.name}`);
    expect(text).toContain('card WEB-12');
    expect(text).toContain('aom ledger search');
    expect(renderChatInstructions(agentSpec, {})).toContain('no project or card context');
  });
});
