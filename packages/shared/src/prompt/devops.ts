import type { DevopsShift } from '../devops/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { commandForOutcome } from './commands.ts';

/** Appended by the runner to the instructions of card shifts (kept out of `renderInstructions` on purpose). */
export const ENVIRONMENT_HELP_SECTION = `# Environment help

Need the app started, a tool installed or the environment fixed? Run \`aom devops "<request>"\`: it asks this workstation's DevOps engineer and does not end your shift. Do not change the machine yourself.
`;

/** The card a DevOps request was filed for, as plain text for the prompt. */
function cardSection(card: NonNullable<DevopsShift['card']>): string {
  const lines = [`${card.ref}: ${card.title}`];
  const meta = [
    card.cardType ? `type ${card.cardType}` : '',
    card.stage ? `stage ${card.stage}` : '',
    card.status ? `status ${card.status}` : '',
    card.project ? `project ${card.project.name} (${card.project.key})` : '',
    card.repo ? `repository ${card.repo}` : '',
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(', '));
  const fields = JSON.stringify(card.fields ?? {}, null, 2);
  if (fields !== '{}')
    lines.push(
      `Fields:\n${fields.length > 6000 ? `${fields.slice(0, 6000)}\n... (cut; \`aom card show\` has all)` : fields}`,
    );
  if (card.comments?.length)
    lines.push(
      `Latest comments:\n${card.comments.map((m) => `- ${m.authorName} (${m.kind}, ${m.at}): ${m.body.slice(0, 1000)}`).join('\n')}`,
    );
  return lines.join('\n');
}

const accessLines = (a: DevopsShift['access']): string[] => [
  `- Install packages and tools: ${a.allowInstall ? 'allowed' : 'NOT allowed (needs approval)'}`,
  `- Docker (install, run, manage containers): ${a.allowDocker ? 'allowed' : 'NOT allowed (needs approval)'}`,
  `- Elevated privileges (sudo): ${a.sudo ? 'allowed: run privileged commands as `aom sudo -- <command> [args]` (the runner supplies the stored password; a bare `sudo` may prompt and hang; never ask for, print or store a password)' : 'NOT allowed (needs approval)'}`,
  `- Paths you may write (beyond your scratch dir): ${a.allowedPaths.length ? a.allowedPaths.join(', ') : 'none'}`,
];

/**
 * Instructions file for a DevOps shift (docs/ARCHITECTURE.md section 16.2): who you are, the role text, the
 * workstation's granted access, and how to end the request. Pure and deterministic.
 */
export function renderDevopsInstructions(brief: ShiftBrief, devops: DevopsShift): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the DevOps engineer for the workstation "${devops.workstationName}". Names are handles, not personas: do not roleplay, just do the work.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  out.push('# Core rules');
  out.push(brief.role.coreRules.length ? brief.role.coreRules.map((r) => `- ${r}`).join('\n') : '- (none)');
  out.push('# Granted access');
  out.push(
    [
      'You may do the following on this workstation without asking:',
      ...accessLines(devops.access),
      '',
      'Anything destructive (deleting data, wiping, formatting) or outside this access must NOT be run. Ask for approval instead with `aom devops-approval`; the shift then ends and resumes after the manager approves.',
      'Tools for the agents: the sandboxed agents only see tools the runner knows. After you install a tool for them, register it with `aom toolchain add <name> --bin <dir> [--read <dir>] [--env KEY=VALUE]` (`aom toolchain list` shows what they have; `remove <name>` undoes it; no credentials in --env). Prefer user-space installs (~/.dotnet, ~/.local, ~/go/sdk, nvm, pyenv/uv, sdkman, mise/asdf) so no sudo is needed and the registered folder is not a system one.',
      "A new repository (GitHub, GitLab, Azure DevOps or Bitbucket Cloud) is created by the owner's runner after they approve it on the desk: ask with `aom repo create [--provider github|gitlab|azure-devops|bitbucket-cloud] --name <name> --private|--public --project <KEY>` (the name has the host's shape: owner/repo, group/subgroup/project, organization/project/repo, workspace/repo; never `gh repo create` yourself). You may fetch, pull and push with the user's git credentials. To check or set up this workstation's login to a git host use `aom git status` and `aom git connect <provider>`: show the user any URL and code it prints; never ask for or type a token, tell the user to run `aom-runner git-connect <provider>` or use the app's Connect helper.",
    ].join('\n'),
  );
  out.push('# How to report');
  out.push(
    [
      'End the shift with exactly one terminal command:',
      ...brief.shift.outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandForOutcome(o)}\``),
      '',
      'Log every command that changed the environment with --command so the record is complete.',
    ].join('\n'),
  );
  if (devops.card) {
    out.push('# The card of this request');
    out.push(
      [
        `This request was filed for card ${devops.card.ref}. You can read and update that one card (no other card):`,
        '- `aom card show` prints the card with its fields and latest comments.',
        '- `aom card comment --note "<text>"` comments on it (what you found or changed, for the card\'s people and agents).',
        '- `aom card update ' +
          devops.card.ref +
          ' --json \'{"fields":{"<name>":"<value>"}}\'` sets the card fields your task needs (a field set to null is removed). Only fields: title, stage and status stay as they are.',
        'Report the outcome of the request with `aom devops-done` as usual; use the card commands for what the card needs to know.',
      ].join('\n'),
    );
  }
  out.push('# Boundaries');
  out.push(
    [
      '- You work on one request per shift; do not touch repositories or worktrees of cards.',
      "- You run unsandboxed with the user's own credentials (their home, Docker, SSH keys). The granted access above is your limit, not a technical barrier: stay inside it, and ask with `aom devops-approval` for anything else.",
      '- Never read or print the runner data directory or credentials you do not need for this request.',
      `- This shift may run for at most ${brief.shift.maxShiftMinutes} minutes.`,
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

/** The prompt of a DevOps shift: the request, who asked, earlier thread messages and any granted approval. */
export function renderDevopsPrompt(devops: DevopsShift): string {
  const out: string[] = [];
  out.push('# DevOps request');
  out.push(
    `Requested by ${devops.requestedBy.name ?? devops.requestedBy.kind}${devops.card ? ` while working on ${devops.card.ref} ${devops.card.title}` : ''}.`,
  );
  out.push('## Request');
  out.push(devops.summary.trim());
  if (devops.card) {
    out.push('## Card');
    out.push(cardSection(devops.card));
  }
  if (devops.approval) {
    out.push('## Approved by the manager');
    out.push(
      [
        `The manager approved: ${devops.approval.action}`,
        `Reason given: ${devops.approval.reason}`,
        devops.approval.commands.length ? `Commands: ${devops.approval.commands.join('; ')}` : '',
        devops.approval.note ? `Manager's note: ${devops.approval.note}` : '',
        'You may now carry this action out.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (devops.history.length) {
    out.push('## Thread so far');
    out.push(devops.history.map((m) => `- ${m.authorName} (${m.kind}): ${m.body}`).join('\n'));
  }
  out.push('## Your job in this shift');
  out.push(
    devops.hygiene
      ? 'This is a repository hygiene request. Run `aom hygiene run`: it fetches, commits uncommitted changes to the confirmed working branch, pulls, pushes and deletes merged agent branches in the repositories above, tells you what it could not resolve and ends the request. Do not run the git commands yourself, and never commit or push to a repository whose working branch is not confirmed: the command already refuses and asks the manager.'
      : 'Do the request within your granted access, then report with `aom devops-done` or `aom devops-approval`.',
  );
  return `${out.join('\n\n')}\n`;
}
