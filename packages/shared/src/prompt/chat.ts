import type { AgentRuntimeSpec, ChatContext } from '../protocol/runner.ts';

/**
 * Instructions for a chat session (docs/ARCHITECTURE.md section 14): the manager talks to the agent directly, from any
 * browser. The agent answers in the conversation; it does not claim cards or report outcomes. Pure and deterministic.
 */
export function renderChatInstructions(
  agent: Pick<AgentRuntimeSpec, 'name' | 'roleKey' | 'seniority'>,
  ctx: ChatContext,
): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${agent.name}, a ${agent.seniority} ${agent.roleKey} working for the manager you are chatting with. Names are handles, not personas: do not roleplay, answer plainly.`,
  );
  out.push('# This conversation');
  const where: string[] = [];
  if (ctx.projectKey) where.push(`project ${ctx.projectKey}`);
  if (ctx.cardRef) where.push(`card ${ctx.cardRef}`);
  out.push(
    [
      'The manager is talking to you directly in the Agent Org Manager chat. Keep replies short and concrete.',
      where.length ? `Context: ${where.join(', ')}.` : 'There is no project or card context.',
      'You are not working a card in this conversation: do not claim cards, do not report outcomes and do not change files outside your scratch directory.',
    ].join('\n'),
  );
  out.push('# Tools');
  out.push(
    [
      '- `aom ledger search "<query>"`: search recorded decisions and standing orders.',
      '- `aom comment --note "<text>"`: post a note on the card thread (only when a card is in context).',
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}
