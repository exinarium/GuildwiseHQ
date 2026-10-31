import { describe, expect, it } from 'vitest';
import { renderInstructions, renderShiftPrompt, type ShiftBrief } from '../src/index.ts';
import { buildBrief } from './fixtures.ts';

const business = (): ShiftBrief => {
  const b = buildBrief();
  return {
    ...b,
    card: {
      ...b.card,
      cardType: 'enquiry',
      completionAction: null,
      fields: { whoAsked: 'Mia Jones', question: 'Do you open on Sundays?', dueBy: '2026-11-03' },
      fieldLabels: { whoAsked: 'Who asked', channel: 'Channel', question: 'Question', dueBy: 'Due by' },
    },
    project: { ...b.project, repoless: true },
  };
};

describe('a business card brief', () => {
  it('lists the filled fields under their labels and prints no completion action', () => {
    const p = renderShiftPrompt(business());
    expect(p).toContain('## Details');
    expect(p).toContain('- Who asked: Mia Jones');
    expect(p).toContain('- Question: Do you open on Sundays?');
    expect(p).toContain('- Due by: 2026-11-03');
    expect(p).not.toContain('Channel');
    expect(p).not.toContain('## Completion action');
  });

  it('has no branch, worktree, build or test lines in the instructions', () => {
    const t = renderInstructions(business());
    expect(t).not.toContain('Working branch');
    expect(t).not.toContain('worktree');
    expect(t).not.toContain('dotnet');
    expect(t).not.toContain('Architectural paths');
    expect(t).toContain('Work only inside your current working directory.');
    expect(t).toContain('aom ledger search');
  });
});

describe('a developer card brief is unchanged', () => {
  it('keeps the branch and build boundaries and has no Details section', () => {
    const t = renderInstructions(buildBrief());
    expect(t).toContain('Working branch');
    expect(t).toContain('the card worktree');
    expect(t).toContain('dotnet test');
    expect(renderShiftPrompt(buildBrief())).not.toContain('## Details');
  });
});
