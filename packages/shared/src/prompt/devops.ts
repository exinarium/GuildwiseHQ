import type { DevopsShift } from '../devops/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { commandForOutcome } from './commands.ts';

/** Appended by the runner to the instructions of card shifts (kept out of `renderInstructions` on purpose). */
export const ENVIRONMENT_HELP_SECTION = `# Environment help

Need the app started, a tool installed or the environment fixed? Run \`aom devops "<request>"\`: it asks this workstation's DevOps engineer and does not end your shift. Do not change the machine yourself.
`;

const accessLines = (a: DevopsShift['access']): string[] => [
  `- Install packages and tools: ${a.allowInstall ? 'allowed' : 'NOT allowed (needs approval)'}`,
  `- Docker (install, run, manage containers): ${a.allowDocker ? 'allowed' : 'NOT allowed (needs approval)'}`,
  `- Elevated privileges (sudo): ${a.sudo ? 'allowed' : 'NOT allowed (needs approval)'}`,
  `- Paths you may write outside the agent sandbox: ${a.allowedPaths.length ? a.allowedPaths.join(', ') : 'none'}`,
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
  out.push('# Boundaries');
  out.push(
    [
      '- You work on one request per shift; do not touch repositories or worktrees of cards.',
      '- Work only inside the agent sandbox unless the granted access names a path.',
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
  out.push('Do the request within your granted access, then report with `aom devops-done` or `aom devops-approval`.');
  return `${out.join('\n\n')}\n`;
}
