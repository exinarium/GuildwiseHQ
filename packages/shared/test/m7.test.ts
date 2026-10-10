import { describe, expect, it } from 'vitest';
import {
  CardDraftPatchSchema,
  CardDraftSchema,
  commandForOutcome,
  DomainEventSchema,
  FinalizeReportDataSchema,
  getBuiltinRole,
  IpcRpcRequestSchema,
  isTerminalReport,
  JIRA_SKILL_MD,
  NotImplementedError,
  outcomeDataSchema,
  parseExternalRef,
  parseGithubKey,
  renderChatInstructions,
  renderQuestionInstructions,
  renderQuestionPrompt,
  ServerToRunnerSchema,
  ShiftReportSchema,
} from '../src/index.ts';
import { agentSpec, buildBrief, env, U } from './fixtures.ts';

describe('M7 events', () => {
  it('parses IntakeStarted, TicketMapped and QuestionShiftDispatched', () => {
    for (const e of [
      {
        type: 'IntakeStarted',
        payload: {
          intakeId: U.a,
          threadId: U.b,
          externalSystem: 'jira',
          externalKey: 'ABC-123',
          startedBy: U.c,
          baAgentId: U.d,
        },
      },
      { type: 'QuestionMerged', payload: { deskItemId: U.a, intoDeskItemId: U.b } },
      { type: 'TicketMapped', payload: { intakeId: U.a, unmapped: true, deskItemId: U.b } },
      { type: 'TicketMapped', payload: { intakeId: U.a, projectId: U.b, cardId: U.c, unmapped: false } },
      {
        type: 'QuestionShiftDispatched',
        payload: { deskItemId: U.a, shiftId: U.b, agentId: U.c, workstationId: U.d },
      },
    ])
      expect(DomainEventSchema.safeParse(e).success, e.type).toBe(true);
  });

  it('lets an agent answer: QuestionAnswered without a ledger entry, QuestionRaised starting in the chain', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'QuestionAnswered',
        payload: { deskItemId: U.a, answer: 'tabs', answeredBy: { kind: 'agent', agentId: U.b, role: 'ba' } },
      }).success,
    ).toBe(true);
    const raised = DomainEventSchema.parse({
      type: 'QuestionRaised',
      payload: {
        deskItemId: U.a,
        askedBy: { kind: 'agent', agentId: U.b },
        question: 'q?',
        blocking: true,
        routedTo: 'agent',
        routedAgentId: U.c,
        chainLevel: 'peer',
        subkind: 'unmapped_ticket',
      },
    });
    expect(raised.type === 'QuestionRaised' && raised.payload.chainLevel).toBe('peer');
  });
});

describe('external references', () => {
  it('finds Jira keys, GitHub issues and URLs in pasted text', () => {
    expect(parseExternalRef('please look at ABC-123 today')).toEqual({ system: 'jira', key: 'ABC-123' });
    expect(parseExternalRef('acme/toy#12')).toEqual({ system: 'github', key: 'acme/toy#12' });
    expect(parseExternalRef('https://github.com/acme/toy/issues/12')).toMatchObject({
      system: 'github',
      key: 'acme/toy#12',
    });
    expect(parseExternalRef('https://acme.atlassian.net/browse/WEB-7')).toMatchObject({
      system: 'jira',
      key: 'WEB-7',
    });
    expect(parseExternalRef('build a login page')).toBeNull();
    expect(parseGithubKey('acme/toy#12')).toEqual({ repo: 'acme/toy', number: 12 });
    expect(parseGithubKey('ABC-1')).toBeNull();
  });

  it('ships a provider neutral Jira skill and a typed post stub error', () => {
    expect(JIRA_SKILL_MD).toMatch(/read-only/);
    expect(new NotImplementedError('postApproved').message).toMatch(/not implemented/);
  });
});

describe('M7 reports and rpc', () => {
  it('answer and escalate are terminal reports', () => {
    const answer = ShiftReportSchema.parse({ kind: 'answer', itemId: U.a, text: 'use tabs', optionId: 'o1' });
    const escalate = ShiftReportSchema.parse({ kind: 'escalate', itemId: U.a, note: 'needs the manager' });
    expect(isTerminalReport(answer)).toBe(true);
    expect(isTerminalReport(escalate)).toBe(true);
    expect(ShiftReportSchema.safeParse({ kind: 'answer', itemId: 'nope', text: 'x' }).success).toBe(false);
  });

  it('finalize outcome data is the completion action', () => {
    expect(outcomeDataSchema('finalize').safeParse({ action: 'pr' }).success).toBe(true);
    expect(outcomeDataSchema('finalize').safeParse({ action: 'ship' }).success).toBe(false);
    expect(FinalizeReportDataSchema.parse({ action: 'merge' }).action).toBe('merge');
    expect(
      commandForOutcome({ id: 'finalized', label: 'Finalized', kind: 'success', data: 'finalize' }),
    ).toMatch(/aom finalize --action/);
  });

  it('knows the BA rpc methods', () => {
    for (const method of [
      'card.create',
      'card.update',
      'card.specify',
      'intake.map',
      'intake.unmapped',
      'source.read',
    ])
      expect(IpcRpcRequestSchema.safeParse({ method, params: {} }).success, method).toBe(true);
  });

  it('validates card drafts: a title is required, the card type defaults to feature', () => {
    expect(CardDraftSchema.safeParse({ fields: {} }).success).toBe(false);
    const d = CardDraftSchema.parse({
      title: 'Login page',
      fields: { context: 'c', acceptanceCriteria: ['a'], mock: {} },
    });
    expect(d.cardType).toBe('feature');
    expect(CardDraftPatchSchema.safeParse({ completionAction: 'pr' }).success).toBe(true);
    expect(CardDraftPatchSchema.safeParse({ completionAction: 'ship' }).success).toBe(false);
  });
});

describe('BA instructions and prompts', () => {
  it('ships real BA instructions: intake, answering, finalize', () => {
    const ba = getBuiltinRole('ba');
    expect(ba?.version).toBe(8); // 8: repo create on every git host; 3: M8 outbound updates; 4: M10 organization designer; 5: chat cards, inline JSON, repo create; 6: phases; 7: BA reporter
    expect(ba?.instructions).not.toMatch(/TODO/);
    for (const w of [
      'aom intake map',
      'aom intake unmapped',
      'aom card create',
      'aom card specify',
      'aom answer',
      'aom escalate',
      'aom finalize',
    ])
      expect(ba?.instructions, w).toContain(w);
  });

  it('renders the intake context into the chat instructions, with the Jira skill', () => {
    const text = renderChatInstructions(
      { ...agentSpec, name: 'Bea', roleKey: 'ba' },
      {
        intake: {
          intakeId: U.a,
          externalSystem: 'jira',
          externalKey: 'ABC-123',
          projects: [{ key: 'TOY', name: 'Toy', repos: ['toy'] }],
          cards: [{ ref: 'TOY-1', title: 'Login', status: 'draft' }],
        },
      },
    );
    expect(text).toContain('Jira ticket ABC-123');
    expect(text).toContain('not mapped to a project yet');
    expect(text).toContain('- TOY: Toy, repos: toy');
    expect(text).toContain('TOY-1 Login (draft)');
    expect(text).toContain('Skill: read a Jira ticket');
    expect(renderChatInstructions(agentSpec, {})).not.toContain('# Intake');
  });

  it("uses the manager's own Jira skill text when the vault has one", () => {
    const intake = { intakeId: U.a, projects: [], cards: [] };
    const text = renderChatInstructions(
      { ...agentSpec, roleKey: 'ba' },
      { intake },
      { jiraSkill: '# My Jira skill\nUse jira-cli.' },
    );
    expect(text).toContain('Use jira-cli.');
    expect(text).not.toContain('Skill: read a Jira ticket');
    expect(
      renderChatInstructions({ ...agentSpec, roleKey: 'ba' }, { intake }, { jiraSkill: '  ' }),
    ).toContain('Skill: read a Jira ticket');
  });

  it('renders a question shift prompt with the question, the trail, the ledger matches and the way out', () => {
    const q = {
      deskItemId: U.c,
      level: 'ba' as const,
      text: 'Tabs or spaces?',
      doing: 'writing the formatter',
      options: [
        { id: 'o1', label: 'tabs' },
        { id: 'o2', label: 'spaces' },
      ],
      recommendation: 'o1',
      blocking: true,
      askedBy: { name: 'Ada', role: 'builder' },
      trail: ['Grace (builder)'],
      ledgerMatches: [{ id: U.d, scope: 'decision' as const, title: 'Indent', body: 'Use tabs.' }],
    };
    const prompt = renderQuestionPrompt(buildBrief(), q);
    expect(prompt).toContain('Tabs or spaces?');
    expect(prompt).toContain('o1: tabs (recommended by the asker)');
    expect(prompt).toContain('Grace (builder)');
    expect(prompt).toContain('Use tabs.');
    expect(prompt).toContain(`aom answer --item ${U.c}`);
    expect(prompt).toContain(`aom escalate --item ${U.c}`);
    const ins = renderQuestionInstructions(buildBrief(), q);
    expect(ins).toContain('passed to you, the BA');
    expect(ins).toContain('aom escalate');
  });

  it('accepts a question shift start with the question and a chat start with the intake context', () => {
    const base = { v: 1, id: U.e, ts: '2026-10-03T12:00:00.000Z' };
    expect(
      ServerToRunnerSchema.safeParse({
        ...base,
        type: 'chat.start',
        chatId: U.a,
        threadId: U.b,
        agent: agentSpec,
        message: 'hi',
        context: { intake: { intakeId: U.a, projects: [] } },
      }).success,
    ).toBe(true);
    void env;
  });
});
