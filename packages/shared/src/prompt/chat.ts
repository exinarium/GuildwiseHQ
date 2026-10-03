import { JIRA_SKILL_MD } from '../external/index.ts';
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
  if (ctx.intake) out.push(renderIntakeSection(ctx.intake));
  return `${out.join('\n\n')}\n`;
}

/** The BA's intake chat (M7): the ticket, the projects it may map to, the cards created so far and the verbs to use. */
function renderIntakeSection(intake: NonNullable<ChatContext['intake']>): string {
  const out: string[] = ['# Intake'];
  out.push(
    [
      intake.externalKey
        ? `The manager opened an intake for ${intake.externalSystem === 'github' ? 'GitHub issue' : intake.externalSystem === 'jira' ? 'Jira ticket' : 'ticket'} ${intake.externalKey}.`
        : 'The manager opened an intake without a ticket reference: work from what they tell you.',
      intake.mappedProjectKey
        ? `The ticket is mapped to project ${intake.mappedProjectKey}.`
        : 'The ticket is not mapped to a project yet: map it (or ask the manager through the desk) before drafting cards.',
    ].join('\n'),
  );
  out.push('## Projects you may map to');
  out.push(
    intake.projects.length > 0
      ? intake.projects
          .map(
            (p) =>
              `- ${p.key}: ${p.name} (${p.domain})${p.repos.length ? `, repos: ${p.repos.join(', ')}` : ''}`,
          )
          .join('\n')
      : 'None. Tell the manager to create a project first.',
  );
  if (intake.cards.length > 0) {
    out.push('## Cards created in this intake');
    out.push(intake.cards.map((c) => `- ${c.ref} ${c.title} (${c.status})`).join('\n'));
  }
  out.push('## How to run the intake');
  out.push(
    [
      '1. Read the source (GitHub: `aom source read`; Jira: the Jira skill). Never invent ticket content.',
      '2. Map the ticket to a project; if none fits, run `aom intake unmapped` instead of guessing. `aom ledger search` shows earlier mapping decisions.',
      '3. Investigate (project docs, the repository read-only, the ledger) and ask the manager only what the sources cannot answer.',
      '4. Draft one card per independently deliverable change with every field a builder needs: context, requirements, acceptance criteria (each one checkable), affected areas, constraints, test plan, completion action (pr, push_branch or merge, chosen now), repo, dependencies and the ticket key as externalRef.',
      '5. Specify each complete card with `aom card specify`, and tell the manager which cards you created.',
    ].join('\n'),
  );
  out.push('## Intake commands');
  out.push(
    [
      '- `aom source read --ref <owner/repo#n>`: read a GitHub issue (read-only, through `gh` on this workstation). Jira is read with the Jira skill below.',
      '- `aom intake map --project <KEY>`: the ticket belongs to this project.',
      '- `aom intake unmapped --note "<why>"`: no project fits; the manager is asked on the desk and you are told the answer.',
      '- `aom card create --file <draft.json>`: draft a card (project, title, cardType, completionAction, docsNeeded, priority, repo, dependencies, externalRef, fields). Prints the new ref and what is still missing.',
      '- `aom card update <REF> --file <patch.json>`: change a card you created.',
      '- `aom card specify <REF>`: validate the card and move it to the build queue; refused while required fields are missing.',
      '',
      'Intake is read-only towards external systems: never post, comment on or transition a ticket.',
    ].join('\n'),
  );
  out.push('## Jira skill');
  out.push(JIRA_SKILL_MD.trim());
  return out.join('\n\n');
}
