import { describe, expect, it } from 'vitest';
import {
  CardDraftSchema,
  type ChatContext,
  getBuiltinRole,
  JIRA_SKILL_MD,
  renderChatInstructions,
} from '../src/index.ts';

const intake: NonNullable<ChatContext['intake']> = {
  intakeId: '0192f3a0-0000-7000-8000-000000000001',
  externalSystem: 'jira',
  externalKey: 'DCPL-1',
  mappedProjectKey: 'P4',
  projects: [{ key: 'P4', name: 'P4', repos: ['p4'] }],
  cards: [],
} as never;

describe('BA prompts (#47, #49, #52)', () => {
  const ba = getBuiltinRole('ba');

  it('the BA role never reads code and never sets the completion action', () => {
    const text = `${ba?.instructions}\n${ba?.coreRules.join('\n')}`;
    expect(text).toMatch(/without reading code/);
    expect(text).toMatch(/Architect/);
    expect(text).not.toMatch(/the repository \(read-only\)/);
    expect(text).toMatch(/Never set completionAction/);
    expect(text).not.toMatch(/draft has: .*completionAction/);
    expect(ba?.coreRules.join(' ')).toMatch(/Never read source code/);
  });

  it('the BA reads Jira through the runner and knows jira-connect', () => {
    const text = `${ba?.instructions}\n${JIRA_SKILL_MD}`;
    expect(text).toContain('aom source read --ref <KEY>');
    expect(text).toContain('aom source attachments <KEY>');
    expect(text).toContain('aom-runner jira-connect');
    expect(JIRA_SKILL_MD).toMatch(/Atlassian MCP server/);
  });

  it('the intake chat says the same and lists no completionAction in the card draft', () => {
    const text = renderChatInstructions({ name: 'Bea', roleKey: 'ba', seniority: 'senior' }, {
      intake,
    } as ChatContext);
    expect(text).toContain('aom source read --ref <KEY or owner/repo#n>');
    expect(text).toContain('aom-runner jira-connect');
    expect(text).toMatch(/Do not read source code and never ask the manager for repository/);
    expect(text).not.toMatch(/completion action \(pr, push_branch or merge/);
    expect(text).not.toMatch(/cardType, completionAction/);
  });

  it('an intake draft still parses with a completion action, so the server can refuse it by name', () => {
    expect(CardDraftSchema.safeParse({ title: 't', completionAction: 'pr' }).success).toBe(true);
  });
});
