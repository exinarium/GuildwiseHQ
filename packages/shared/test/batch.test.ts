import { describe, expect, it } from 'vitest';
import {
  BATCH_MAX_TICKETS,
  BatchAskDataSchema,
  type BatchTask,
  baTaskBriefOutcomes,
  CreateBatchRequestSchema,
  commandForOutcome,
  DomainEventSchema,
  getBuiltinRole,
  parseBatchTickets,
  renderBaTaskInstructions,
  renderBaTaskPrompt,
  type ShiftBrief,
} from '../src/index.ts';

const U = '0192f3a0-0000-7000-8000-000000000001';

describe('parseBatchTickets', () => {
  it('accepts keys, URLs and GitHub issues, one per entry, and dedupes', () => {
    const r = parseBatchTickets([
      'abc-1\nABC-2, https://acme.atlassian.net/browse/ABC-3',
      'ABC-1',
      'acme/web#12',
      'https://github.com/acme/web/issues/13',
      '',
    ]);
    expect(r.tickets.map((t) => [t.system, t.key])).toEqual([
      ['jira', 'ABC-1'],
      ['jira', 'ABC-2'],
      ['jira', 'ABC-3'],
      ['github', 'acme/web#12'],
      ['github', 'acme/web#13'],
    ]);
    expect(r.duplicates).toEqual(['ABC-1']);
    expect(r.invalid).toEqual([]);
    expect(r.tickets[2]?.url).toBe('https://acme.atlassian.net/browse/ABC-3');
  });

  it('refuses text that only contains a ticket', () => {
    const r = parseBatchTickets(['ABC-1', 'please fix ABC-2 soon', 'nonsense']);
    expect(r.tickets.map((t) => t.key)).toEqual(['ABC-1']);
    expect(r.invalid).toEqual(['please fix ABC-2 soon', 'nonsense']);
  });

  it('the request schema holds the limit on the number of entries it accepts', () => {
    expect(CreateBatchRequestSchema.safeParse({ tickets: [] }).success).toBe(false);
    expect(CreateBatchRequestSchema.safeParse({ tickets: ['ABC-1'], projectId: U, note: 'x' }).success).toBe(
      true,
    );
    expect(BATCH_MAX_TICKETS).toBe(50);
  });
});

describe('batch events and outcomes', () => {
  it('the events parse and the task kind has its outcomes and commands', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'IntakeBatchCreated',
        payload: {
          batchId: U,
          createdBy: U,
          items: [{ itemId: U, position: 0, system: 'jira', key: 'ABC-1' }],
        },
      }).success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({ type: 'IntakeBatchCancelled', payload: { batchId: U, cancelledBy: U } })
        .success,
    ).toBe(true);
    const ids = baTaskBriefOutcomes('batch_intake').map((o) => o.id);
    expect(ids).toEqual(['batch_done', 'batch_ask', 'batch_skip', 'batch_fail']);
    for (const o of baTaskBriefOutcomes('batch_intake')) expect(commandForOutcome(o)).toMatch(/^aom batch /);
    expect(BatchAskDataSchema.parse({ question: 'Which?' }).options).toEqual([]);
  });
});

describe('the BA batch prompt', () => {
  const batch: BatchTask = {
    batchId: U,
    itemId: U,
    system: 'jira',
    ticketKey: 'ABC-9',
    ticketUrl: 'https://acme.atlassian.net/browse/ABC-9',
    note: 'Q4 release',
    projects: [{ key: 'TOY', name: 'Toy', repos: ['toy'] }],
    cards: [{ ref: 'TOY-4', title: 'Earlier card', status: 'queued' }],
    answers: [{ question: 'Web or API?', answer: 'API' }],
  };
  const task = { taskId: U, kind: 'batch_intake', batch, cards: [], followups: [], outstanding: [] } as never;
  const ba = getBuiltinRole('ba') as NonNullable<ReturnType<typeof getBuiltinRole>>;
  const brief = {
    agent: { name: 'Ben' },
    role: { instructions: ba.instructions, coreRules: ba.coreRules },
    shift: { outcomes: baTaskBriefOutcomes('batch_intake') },
  } as unknown as ShiftBrief;

  it('gives the ticket, the note, the projects, earlier cards and answers, and the intake steps', () => {
    const p = renderBaTaskPrompt(task);
    expect(p).toContain('# Batch intake: ABC-9');
    expect(p).toContain('Q4 release');
    expect(p).toContain('- TOY: Toy, repos: toy');
    expect(p).toContain('TOY-4 Earlier card');
    expect(p).toContain('Q: Web or API?\n  A: API');
    expect(p).toContain('aom source read --ref ABC-9');
    expect(p).toContain('aom source attachments ABC-9');
    expect(p).toContain('map the ticket to a project yourself');
    expect(p).toContain('Never set completionAction');
    expect(p).toContain('Do not read source code');
    expect(p).toContain('never post, comment on or transition a ticket');
  });

  it('a project chosen for the batch is mapped already', () => {
    const p = renderBaTaskPrompt({ ...(task as object), batch: { ...batch, projectKey: 'TOY' } } as never);
    expect(p).toContain('The owner chose project TOY for this batch');
    expect(p).not.toContain('map the ticket to a project yourself');
  });

  it('the instructions tell the BA to ask once, never guess, and list every terminal command', () => {
    const i = renderBaTaskInstructions(brief, task);
    expect(i).toContain('one ticket of a batch intake');
    expect(i).toContain('ONE precise question');
    expect(i).toContain('Never guess a project');
    for (const c of ['aom batch done', 'aom batch ask', 'aom batch skip', 'aom batch fail'])
      expect(i).toContain(c);
    expect(i).toMatch(/Never set completionAction/);
  });
});
