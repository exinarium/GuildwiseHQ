import type { SessionToolDef } from '../sessions/tools.ts';
import { renderToolMapping } from '../sessions/tools.ts';
import { renderDirectTurnInstructions, type SessionTurnSpec } from '../sessions/index.ts';
import type { AgentRuntimeSpec, ChatContext } from '../protocol/runner.ts';
import { renderBindingStandingOrders } from './standing-orders.ts';

/**
 * Instructions for the direct-model runtime (docs/ARCHITECTURE.md section 38.3). Provider neutral: the same Markdown goes to
 * Anthropic, OpenAI, Gemini or any OpenAI-compatible endpoint as the system prompt (an AGENTS.md-style document: who you are,
 * what you may do, the rules). The runtime has no shell, so where the Claude Code instructions say "run `aom ...`" these say
 * "call the tool". The session turn sections are the ones `renderSessionTurnInstructions` writes for Claude Code.
 */
export function renderDirectSystemPrompt(input: {
  /** A turn of a discovery or boardroom session. */
  session?: { spec: SessionTurnSpec; persona: string };
  /** A plain chat. */
  chat?: { agent: Pick<AgentRuntimeSpec, 'name' | 'roleKey' | 'seniority'>; context: ChatContext };
  tools: readonly SessionToolDef[];
  /** The capability index (`CapabilityRegistry.instructionsIndex`), appended as it is. */
  capabilityIndex?: string;
}): string {
  const parts: string[] = [];
  if (input.session) {
    parts.push(
      renderDirectTurnInstructions(input.session.spec, input.session.persona, renderToolMapping(input.tools)),
    );
  } else if (input.chat) {
    parts.push(renderDirectChatInstructions(input.chat.agent, input.chat.context, input.tools));
  }
  const idx = input.capabilityIndex?.trim();
  if (idx) parts.push(idx);
  return `${parts.join('\n\n')}\n`;
}

function renderDirectChatInstructions(
  agent: Pick<AgentRuntimeSpec, 'name' | 'roleKey' | 'seniority'>,
  ctx: ChatContext,
  tools: readonly SessionToolDef[],
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
      'The manager is talking to you directly in the Guildwise HQ chat. Keep replies short and concrete.',
      where.length ? `Context: ${where.join(', ')}.` : 'There is no project or card context.',
      'You are not working a card in this conversation. You run on a model API without a shell or files: you cannot read the repositories, change anything or take actions for the organization here. Say so plainly when asked to, and suggest switching this conversation back to its default model.',
    ].join('\n'),
  );
  if (tools.length) {
    out.push('# Tools');
    out.push(tools.map((t) => `- \`${t.name}\`: ${t.description}`).join('\n'));
  }
  if (ctx.standingOrders?.length) out.push(renderBindingStandingOrders(ctx.standingOrders));
  return out.join('\n\n');
}
