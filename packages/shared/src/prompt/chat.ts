import { handlesNote, packAgentSection } from '../capabilities/pack-team.ts';
import { JIRA_SKILL_MD } from '../external/index.ts';
import type { AgentRuntimeSpec, ChatContext } from '../protocol/runner.ts';
import { renderCeoChatSection } from './ceo.ts';
import { type ReadableFolder, renderReadableFolders } from './readable.ts';
import { renderBindingStandingOrders } from './standing-orders.ts';

/** What the runner found in the vault clone for a chat: `missing` when this workstation has no clone of the vault. */
export interface ChatVaultNotes {
  missing?: boolean;
  projectDoc?: string;
  standingOrders?: Array<{ title: string; body: string }>;
}

const VAULT_NOTE_MAX = 3000;
const clip = (t: string): string =>
  t.length > VAULT_NOTE_MAX ? `${t.slice(0, VAULT_NOTE_MAX)}\n[...cut]` : t;

/** The vault's project doc and standing orders, kept short; a missing clone is said plainly. */
function renderChatVaultSection(v: ChatVaultNotes): string | undefined {
  if (v.missing)
    return [
      '# Knowledge vault',
      'This conversation has a knowledge vault, but it is not cloned on this workstation yet, so you cannot read it here. Say so if the manager asks about it; do not guess its contents.',
    ].join('\n');
  const out = ['# Knowledge vault'];
  if (v.projectDoc) out.push('## PROJECT.md', clip(v.projectDoc));
  for (const o of v.standingOrders ?? []) out.push(`## ${o.title}`, clip(o.body));
  return out.length > 1 ? out.join('\n') : undefined;
}

/**
 * Instructions for a chat session (docs/ARCHITECTURE.md section 14): the manager talks to the agent directly, from any
 * browser. The agent answers in the conversation; it does not claim cards or report outcomes. Pure and deterministic.
 */
export function renderChatInstructions(
  agent: Pick<AgentRuntimeSpec, 'name' | 'roleKey' | 'seniority' | 'packAgent'>,
  ctx: ChatContext,
  opts: { jiraSkill?: string; readFolders?: ReadableFolder[]; vault?: ChatVaultNotes } = {},
): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${agent.name}, a ${agent.seniority} ${agent.roleKey} working for the manager you are chatting with. ${handlesNote(agent, 'do not roleplay, answer plainly.')}`,
  );
  out.push(...packAgentSection(agent));
  out.push('# This conversation');
  const where: string[] = [];
  if (ctx.projectKey) where.push(`project ${ctx.projectKey}`);
  if (ctx.cardRef) where.push(`card ${ctx.cardRef}`);
  out.push(
    [
      'The manager is talking to you directly in the Guildwise HQ chat. Keep replies short and concrete.',
      where.length ? `Context: ${where.join(', ')}.` : 'There is no project or card context.',
      agent.roleKey === 'devops'
        ? 'You are not working a card in this conversation: do not claim cards or report outcomes. You may run commands on this workstation to do what the manager asks.'
        : 'You are not working a card in this conversation: do not claim cards, do not report outcomes and do not change files outside your scratch directory.',
    ].join('\n'),
  );
  out.push('# Tools');
  out.push(
    [
      '- `aom ledger search "<query>"`: search recorded decisions and standing orders.',
      '- `aom comment --note "<text>"`: post a note on the card thread (only when a card is in context).',
      ...(agent.roleKey === 'devops'
        ? []
        : [
            '- Run every `aom` command on its own: no pipes, redirects, `;`, `&&`, `cd` or `$(...)` around it (for example `aom ledger search "tech stack"`, not `aom ledger search "tech stack" | head`). Otherwise it runs inside the shell sandbox and cannot reach the runner.',
          ]),
    ].join('\n'),
  );
  // The ledger's standing orders bind every agent in a conversation too (DevOps included, backlog #75).
  if (ctx.standingOrders?.length) out.push(renderBindingStandingOrders(ctx.standingOrders));
  // The DevOps engineer reads anywhere (it runs as the user); everyone else only what the runner opened.
  if (agent.roleKey !== 'devops' && opts.readFolders) out.push(renderReadableFolders(opts.readFolders));
  const vaultSection =
    agent.roleKey !== 'devops' && opts.vault ? renderChatVaultSection(opts.vault) : undefined;
  if (vaultSection) out.push(vaultSection);
  const intakeChat = ctx.intake && !ctx.intake.fromChat;
  if (agent.roleKey === 'devops')
    out.push(
      [
        '# Repositories',
        'You run on this workstation as the user, outside any sandbox, in this chat just as in a DevOps shift: commands, installs, docker builds and deploys run here directly. Say what you are about to run when it changes the machine.',
        '- `aom devops "<instruction>"`: turn a longer or recurring instruction into a DevOps task (a request with its own thread; the conversation shows its progress). Use it when the work should be tracked or run as a shift.',
        '- `aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] [--host <host>] --name <name> --private|--public --project <KEY> [--description "<text>"]`: ask the project owner to create a new repository for the project. The name has the git host\'s shape: `owner/repo` (GitHub, default), `group/subgroup/project` (GitLab), `organization/project/repo` (Azure DevOps), `workspace/repo` (Bitbucket Cloud). They approve on the desk and their own runner creates it, pushes a first commit, clones it under their repository folder and adds it to the project; you are told the result in this conversation.',
        '- `aom toolchain add <name> --bin <dir> [--read <dir>] [--env KEY=VALUE]`: after you install a tool for the sandboxed agents, register it so they get it on PATH (`aom toolchain list`, `aom toolchain remove <name>`; no credentials in --env). Prefer user-space installs (~/.dotnet, ~/.local, ~/go/sdk, nvm, pyenv/uv, sdkman, mise/asdf).',
        "- `aom git status [<provider>]` and `aom git connect <github|gitlab|azure-devops|bitbucket-cloud>`: check or set up this workstation's login to a git host. A browser or device-code sign-in prints a URL and code: show them to the user exactly and ask them to finish it in their browser, then run `aom git status`. If a token is needed the command says so: never ask for, type or handle a token yourself; tell the user to run `guildwise-runner git-connect <provider>` in a terminal here or use the Connect helper under Workstations in the app. For Azure DevOps a Microsoft Entra service principal is the best sign-in (personal access tokens are the fallback; global ones stop working on 2026-12-01).",
      ].join('\n'),
    );
  if (agent.roleKey === 'ceo' && ctx.ceo) out.push(renderCeoChatSection(ctx.ceo.brief));
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
      `- \`aom card create --json '<draft json>'\`: draft a card (project, title, cardType, docsNeeded, priority, repo, dependencies, externalRef, fields). Prints the new ref and what is still missing. Never set completionAction: the project decides, and only the manager changes it. \`--file <path>\` or \`--file -\` (stdin) also work.`,
      "- `aom card update <REF> --json '<patch json>'`: change a card you created.",
      '- `aom card specify <REF>`: validate the card and move it to the build queue; refused while required fields are missing.',
      '- `aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] --name <name> --private|--public --project <KEY> [--description "<text>"]`: ask the project owner to create a new repository for the project (name shape: `owner/repo` for GitHub, `group/subgroup/project` GitLab, `organization/project/repo` Azure DevOps, `workspace/repo` Bitbucket Cloud). They approve on the desk and their own runner creates it, so never try `gh` or `git push` yourself; you are told the result in the conversation, then use the repo in your cards.',
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
      "- `aom org workflow variant --file <spec.json>`: a PROJECT's own version of a workflow: steps inserted after existing ones (the base steps cannot change). Spec: `{key, name, projectId (or project: KEY), base: {key, version}, insertions: [{after: <stage id>, stage: {id, label, claimRole, doneCriteria, requiredFields?, worktree: 'reuse'|'create', data?: 'none'|'investigation'}, redirect?: [outcome ids]}]}`. Prints every issue. Submit it like any workflow; the owner approves it on the desk, then an Owner or Admin enables it in the project's settings.",
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
          .map((p) => `- ${p.key}: ${p.name}${p.repos.length ? `, repos: ${p.repos.join(', ')}` : ''}`)
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
      "1. Read the source with `aom source read --ref <KEY or owner/repo#n>` (Jira: through the workstation's Jira connection; the Atlassian MCP server is only a fallback). If the runner says Jira is not connected, ask the manager to run `guildwise-runner jira-connect` on the workstation. Never invent ticket content.",
      '2. Map the ticket to a project; if none fits, run `aom intake unmapped` instead of guessing. `aom ledger search` shows earlier mapping decisions.',
      '3. Investigate with PROJECT.md, the vault, the ledger and the ticket. Do not read source code and never ask the manager for repository or reference-repository access: put code questions into the card and set designNeeded (or investigationOnly) so the Architect investigates.',
      '4. Draft one card per independently deliverable change with every field a builder needs: context, requirements, acceptance criteria (each one checkable), affected areas, constraints, test plan, repo, dependencies and the ticket key as externalRef.',
      '5. Specify each complete card with `aom card specify`, and tell the manager which cards you created.',
    ].join('\n'),
  );
  out.push('## Intake commands');
  out.push(
    [
      "- `aom source read --ref <KEY>`: read a Jira ticket (fields, description, comments, links) through the workstation's Jira connection, or a GitHub issue `<owner/repo#n>` through `gh` (read-only). The Atlassian MCP server is only a fallback; if the runner says Jira is not connected, ask the manager to run `guildwise-runner jira-connect` on the workstation.",
      ...(intake.externalSystem === 'jira' || !intake.externalSystem
        ? [
            '- `aom source attachments <KEY>` / `aom source attachment <KEY> [<filename|id> | --all]`: your shell has no network, so the runner downloads them through its own Jira connection into your scratch directory (20 MB per file) and prints the paths; open screenshots and SVG with the Read tool. Only the ticket of this intake.',
          ]
        : []),
      '- `aom card attach <path> [--card <REF>]`: attach a downloaded file (from your scratch directory) to a card you drafted, so the builder and tester can look at it.',
      '- `aom intake map --project <KEY>`: the ticket belongs to this project.',
      '- `aom intake unmapped --note "<why>"`: no project fits; the manager is asked on the desk and you are told the answer.',
      "- `aom card create --json '<draft json>'`: draft a card (project, title, cardType, docsNeeded, priority, repo, dependencies, externalRef, fields). Prints the new ref and what is still missing. Never set completionAction: the project decides, and only the manager changes it. `--file <path>` and `--file -` (stdin) also work: you do not need to write a file first.",
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
