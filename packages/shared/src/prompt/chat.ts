import { JIRA_SKILL_MD } from '../external/index.ts';
import type { AgentRuntimeSpec, ChatContext } from '../protocol/runner.ts';

/**
 * Instructions for a chat session (docs/ARCHITECTURE.md section 14): the manager talks to the agent directly, from any
 * browser. The agent answers in the conversation; it does not claim cards or report outcomes. Pure and deterministic.
 */
export function renderChatInstructions(
  agent: Pick<AgentRuntimeSpec, 'name' | 'roleKey' | 'seniority'>,
  ctx: ChatContext,
  opts: { jiraSkill?: string } = {},
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
      'You are not working a card in this conversation: do not claim cards, do not report outcomes and do not change files outside your scratch directory.',
    ].join('\n'),
  );
  out.push('# Tools');
  out.push(
    [
      '- `aom ledger search "<query>"`: search recorded decisions and standing orders.',
      '- `aom comment --note "<text>"`: post a note on the card thread (only when a card is in context).',
      '- Run every `aom` command on its own: no pipes, redirects, `;`, `&&`, `cd` or `$(...)` around it (for example `aom ledger search "tech stack"`, not `aom ledger search "tech stack" | head`). Otherwise it runs inside the shell sandbox and cannot reach the runner.',
    ].join('\n'),
  );
  const intakeChat = ctx.intake && !ctx.intake.fromChat;
  if (agent.roleKey === 'devops')
    out.push(
      [
        '# Repositories',
        'You have no GitHub login in your sandbox and `git push` is denied, so never try `gh` or `git push` yourself.',
        '- `aom repo create --name <owner/repo> --private|--public --project <KEY> [--description "<text>"]`: ask the project owner to create a new GitHub repository for the project. They approve on the desk and their own runner creates it, pushes a first commit, clones it under their repository folder and adds it to the project; you are told the result in this conversation.',
      ].join('\n'),
    );
  if (agent.roleKey === 'ba' && !intakeChat) out.push(renderDesignSection());
  if (agent.roleKey === 'ba' && !intakeChat) out.push(renderChatCardsSection(ctx));
  if (ctx.intake && intakeChat) out.push(renderIntakeSection(ctx.intake, opts.jiraSkill));
  return `${out.join('\n\n')}\n`;
}

/**
 * The BA in a chat that is not an intake: it can still create cards (the chat becomes an intake without a ticket the
 * first time it does), reusing the intake verbs. Rights are the chatting manager's.
 */
function renderChatCardsSection(ctx: ChatContext): string {
  const intake = ctx.intake;
  const out: string[] = ['# Creating cards from this chat'];
  out.push(
    [
      'You can create cards from any chat, not only from an intake: when the manager asks for work to be specced or ticketed, draft the cards yourself. The conversation is then linked to every card you create.',
      ctx.projectKey
        ? `Project ${ctx.projectKey} is in context: cards go to it without mapping.`
        : intake?.mappedProjectKey
          ? `This chat is mapped to project ${intake.mappedProjectKey}.`
          : 'Map the project first with `aom intake map --project <KEY>` (the answer lists the projects the manager may use).',
    ].join('\n'),
  );
  if (intake && intake.cards.length > 0) {
    out.push('Cards created in this chat:');
    out.push(intake.cards.map((c) => `- ${c.ref} ${c.title} (${c.status})`).join('\n'));
  }
  out.push(
    [
      '- `aom intake map --project <KEY>`: cards of this chat belong to this project (skip it when a project is in context).',
      `- \`aom card create --json '<draft json>'\`: draft a card (project, title, cardType, completionAction, docsNeeded, priority, repo, dependencies, externalRef, fields). Prints the new ref and what is still missing. \`--file <path>\` or \`--file -\` (stdin) also work.`,
      "- `aom card update <REF> --json '<patch json>'`: change a card you created.",
      '- `aom card specify <REF>`: validate the card and move it to the build queue; refused while required fields are missing.',
      '- `aom repo create --name <owner/repo> --private|--public --project <KEY> [--description "<text>"]`: ask the project owner to create a new GitHub repository for the project. They approve on the desk and their own runner creates it, so never try `gh` or `git push` yourself; you are told the result in the conversation, then use the repo in your cards.',
      'You may write drafts and notes in your scratch directory with the file tools, but you do not need a file to create a card: pass the JSON inline.',
    ].join('\n'),
  );
  return out.join('\n\n');
}

/**
 * The BA's design chat (M10): the owner describes a role, workflow or department they need; the BA drafts it with
 * `aom org ...`, the server validates, and the owner approves on the desk. The full method is in the BA's role instructions.
 */
export function renderDesignSection(): string {
  return [
    '# Designing the organization',
    'When the manager describes a need that the built-in roles and workflows do not cover (a new kind of work, a new function), design it with them. Ask what is unclear first: who does each step, what must be known before a step starts, what counts as done, and where a failure goes.',
    [
      '- `aom org catalogue`: roles, workflows, departments and their versions.',
      '- `aom org department --name "<name>"`: create a department for a function.',
      "- `aom org role draft --json '<json>'` (or `--file <role.json>`, `--file -`): save a custom role (name, purpose, instructions, permissions, skills, default model, seniority levels, claimable stages). Prints every issue.",
      "- `aom org workflow draft --json '<json>'` (or `--file <workflow.json>`): save a custom workflow (stages with claiming role, required fields, done criteria, outcomes and failure routes). Prints every issue: unreachable stages, failure paths that never end, stages no role may claim.",
      '- `aom org validate <key>`: check a draft again.',
      "- `aom org submit <key> --role|--workflow`: put a valid draft on the owner's desk. Nothing is available until they approve it; submit roles before the workflow that uses them.",
    ].join('\n'),
    'Built-in roles and the Code, Research and Feed workflows can never be changed or removed. Changing a definition means drafting its next version: cards already in flight finish on the version they started with.',
  ].join('\n\n');
}

/** The BA's intake chat (M7): the ticket, the projects it may map to, the cards created so far and the verbs to use. */
function renderIntakeSection(intake: NonNullable<ChatContext['intake']>, jiraSkill?: string): string {
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
      "- `aom card create --json '<draft json>'`: draft a card (project, title, cardType, completionAction, docsNeeded, priority, repo, dependencies, externalRef, fields). Prints the new ref and what is still missing. `--file <path>` and `--file -` (stdin) also work: you do not need to write a file first.",
      "- `aom card update <REF> --json '<patch json>'`: change a card you created.",
      '- `aom card specify <REF>`: validate the card and move it to the build queue; refused while required fields are missing.',
      '',
      'Intake is read-only towards external systems: never post, comment on or transition a ticket.',
    ].join('\n'),
  );
  out.push('## Jira skill');
  out.push((jiraSkill?.trim() || JIRA_SKILL_MD).trim());
  return out.join('\n\n');
}
