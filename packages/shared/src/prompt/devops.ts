import type { DevopsRun, DevopsShift } from '../devops/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { formatCommandLine } from '../runs/plan.ts';
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

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n... (cut at ${n} characters)` : t);

/** The "Run this branch" request as plain text: what to run, the instructions, the plan so far, how to proceed. */
export function renderRunSection(run: DevopsRun): string {
  const out: string[] = [];
  out.push(`## Run request: ${run.projectName} (${run.projectKey})`);
  out.push(
    [
      `Environment id: ${run.envId} (every \`aom run\` command uses it: \`--env ${run.envId}\`)`,
      'The runner already prepared one detached worktree per repository at the commit below (`aom run info` prints their paths and the ports it allocated). Start every process through `aom run service`, so the runner supervises it: never start a server yourself (it would die with this shift).',
      run.services.length
        ? `Services wanted: ${run.services.join(', ')} (and what they depend on).`
        : 'Services wanted: all of the project.',
      `Ports: the plan's default port is used when it is free; otherwise the runner allocates one from ${run.portRange.from}-${run.portRange.to} and sets the variable you named with --port. Use \${svc.port} templates in --env values to point services at each other.`,
      "Sandbox: steps and services run in the runner's sandbox: they use the host network, may write only to the run worktrees, the shared package caches and a private /tmp, and cannot read credential folders or the runner's data. An env file is read by the runner and injected; do not copy secrets anywhere.",
      run.allowDocker
        ? 'Docker: allowed for this project (docker/compose steps and services run outside the sandbox and are flagged so in the app).'
        : 'Docker: NOT allowed for this project. If the project cannot run without it, end with `aom run fail --reason` saying so.',
      run.ttlAt ? `The environment stops by itself at ${run.ttlAt}.` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  out.push('### Repositories');
  out.push(
    run.sources
      .map(
        (r) =>
          `- ${r.name} (repo id ${r.repoId}): branch ${r.branch}${r.commit ? ` at ${r.commit.slice(0, 10)}` : ''}${r.projectPath ? `, project folder ${r.projectPath}` : ''}`,
      )
      .join('\n'),
  );
  if (run.runInstructions.trim()) {
    out.push('### Run instructions of the project (they override BUILD.md where they conflict)');
    out.push(clip(run.runInstructions.trim(), 8000));
  }
  for (const r of run.repoInstructions.filter((x) => x.text.trim())) {
    out.push(`### Run instructions for ${r.name}`);
    out.push(clip(r.text.trim(), 8000));
  }
  for (const d of run.buildDocs) {
    out.push(
      `### BUILD.md of ${run.sources.find((x) => x.repoId === d.repoId)?.name ?? d.repoId} (${d.path})`,
    );
    out.push(clip(d.content.trim(), 12000));
  }
  if (
    run.buildDocs.length === 0 &&
    !run.runInstructions.trim() &&
    run.repoInstructions.every((x) => !x.text.trim())
  )
    out.push(
      'There is no BUILD.md and no run instructions: read the README, compose files and package scripts of each repository.',
    );
  if (run.declared.length) {
    out.push(
      '### Services declared in the project settings (use these names, commands, ports and health checks; do not contradict them)',
    );
    out.push(
      run.declared
        .map(
          (d) =>
            `- ${d.name}: repo ${d.repoId}, cwd ${d.cwd}${d.cmd ? `, command ${formatCommandLine(d.cmd)}` : ''}${d.envFile ? `, env file ${d.envFile}` : ''}${d.ports.length ? `, ports ${d.ports.map((p) => `${p.name}:${p.default}${p.envVar ? `:${p.envVar}` : ''}`).join(' ')}` : ''}${d.health ? `, health ${JSON.stringify(d.health)}` : ''}${d.after.length ? `, after ${d.after.join(' ')}` : ''}`,
        )
        .join('\n'),
    );
  }
  if (run.currentPlan) {
    out.push(`### The plan saved earlier (${run.planStatus ?? 'active'}); repair it if it no longer works`);
    out.push(clip(JSON.stringify(run.currentPlan, null, 2), 8000));
  }
  if (run.replayFailure) {
    out.push(
      '### The saved plan was replayed first and failed. Fix the cause, then register the working steps again (`aom run ready` saves a new plan version)',
    );
    out.push(clip(run.replayFailure.trim(), 8000));
  }
  out.push('### Steps');
  out.push(
    [
      '1. `aom run info` (worktree paths, ports).',
      '2. Setup steps, in order: `aom run step --name "npm ci" --repo <name> --cwd . -- npm ci`.',
      '3. Each service: `aom run service --name api --repo <name> --cwd src/Api --port http:5000:ASPNETCORE_HTTP_PORTS --health http://localhost:${port}/health [--env-file <absolute path outside the repository>] [--env KEY=VALUE] [--after db] -- dotnet run`. It returns when the service is healthy or failed (`aom run logs <service>` shows why).',
      '4. `aom run status` to check; `aom run ready --notes "<what you learned>"` when every wanted service is healthy: the runner then saves the steps as the project\'s run plan. Never put secrets in --env; use an env file outside the repository.',
      '5. Give up with `aom run fail --reason "<why>"` (the environment ends as failed). Either way end the request with `aom devops-done` (summarise the URLs and ports).',
    ].join('\n'),
  );
  return out.join('\n\n');
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
  if (devops.run) out.push(renderRunSection(devops.run));
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
    devops.run
      ? 'This is a run request: bring the environment up with `aom run` as described above, then report with `aom devops-done`.'
      : devops.hygiene
        ? 'This is a repository hygiene request. Run `aom hygiene run`: it fetches, commits uncommitted changes to the confirmed working branch, pulls, pushes and deletes merged agent branches in the repositories above, tells you what it could not resolve and ends the request. Do not run the git commands yourself, and never commit or push to a repository whose working branch is not confirmed: the command already refuses and asks the manager.'
        : 'Do the request within your granted access, then report with `aom devops-done` or `aom devops-approval`.',
  );
  return `${out.join('\n\n')}\n`;
}
