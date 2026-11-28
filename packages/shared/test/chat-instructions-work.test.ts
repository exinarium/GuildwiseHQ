import { describe, expect, it } from 'vitest';
import { renderChatInstructions } from '../src/prompt/chat.ts';

/** gate-fixes-2 F7b: a work mention must not be told "scratch only" while its task says to edit the card's folder. */
describe('chat instructions for a work mention', () => {
  const agent = { name: 'Rex', roleKey: 'builder', seniority: 'senior', packAgent: undefined } as Parameters<
    typeof renderChatInstructions
  >[0];
  const ctx = { projectKey: 'RLB', cardRef: 'RLB-1' } as Parameters<typeof renderChatInstructions>[1];
  const SCRATCH = 'do not change files outside your scratch directory';

  it('with work: no scratch-only sentence, the card folder is named, and the limits stay', () => {
    const md = renderChatInstructions(agent, ctx, { work: { folder: '/w/worktrees/RLB/RLB-1' } });
    expect(md).not.toContain(SCRATCH);
    expect(md).toContain(
      "This comment gave you work on this card: change files only inside the card's working folder (`/w/worktrees/RLB/RLB-1`), only as the comment asks; do not change files outside the card's folder, your scratch folder and temporary files, and do not switch branches or push.",
    );
    expect(md).toContain('do not claim cards and do not report outcomes');
  });

  it('without work: unchanged', () => {
    const md = renderChatInstructions(agent, ctx);
    expect(md).toContain(
      'You are not working a card in this conversation: do not claim cards, do not report outcomes and do not change files outside your scratch directory.',
    );
    expect(md).not.toContain('working folder');
  });

  it('DevOps is unchanged by the flag', () => {
    const md = renderChatInstructions({ ...agent, roleKey: 'devops' }, ctx, { work: { folder: '/x' } });
    expect(md).toContain('You may run commands on this workstation');
    expect(md).not.toContain('/x');
  });
});
