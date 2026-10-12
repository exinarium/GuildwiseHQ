import type { ShiftBrief } from '../protocol/runner.ts';
import { commandForOutcome, QUESTION_COMMAND } from './commands.ts';

/**
 * Renders the agent's instructions file (`CLAUDE.md` in the agent's own config dir, regenerated each shift).
 * Sections in order: who you are, role instructions, core rules, standing orders, project, how to report, boundaries
 * (docs/ARCHITECTURE.md section 13.2). Pure and deterministic.
 */
export function renderInstructions(brief: ShiftBrief): string {
  const out: string[] = [];

  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, a ${brief.agent.seniority} ${brief.role.name} working for the owner of project ${brief.project.key} (${brief.project.name}). Names are handles, not personas: do not roleplay, just do the work.`,
  );

  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.extensions?.trim()) {
    out.push('## Owner extensions (they add to the role and never override the core rules below)');
    out.push(brief.role.extensions.trim());
  }
  if (brief.role.skills.length > 0) {
    out.push(`Skills available to you: ${brief.role.skills.join(', ')}.`);
  }

  out.push('# Core rules');
  out.push(
    brief.role.coreRules.length > 0 ? brief.role.coreRules.map((r) => `- ${r}`).join('\n') : '- (none)',
  );

  out.push('# Standing orders');
  out.push(
    brief.standingOrders.length > 0
      ? brief.standingOrders.map((s) => `## ${s.title}\n${s.body.trim()}`).join('\n\n')
      : 'None.',
  );

  out.push('# Project');
  const projectLines = [
    `- Key: ${brief.project.key}`,
    `- Name: ${brief.project.name}`,
    `- Working branch: ${brief.project.workingBranch}`,
  ];
  if (brief.project.projectPath)
    projectLines.push(
      `- Project path: the project lives in \`${brief.project.projectPath}\` inside the repository; build and test there (run builds, tests and package commands from that folder).`,
    );
  if (brief.project.architecturalGlobs.length > 0) {
    projectLines.push(
      `- Architectural paths (changes here make a card large): ${brief.project.architecturalGlobs.join(', ')}`,
    );
  }
  if (brief.project.e2eGlobs.length > 0)
    projectLines.push(`- End-to-end test paths: ${brief.project.e2eGlobs.join(', ')}`);
  out.push(projectLines.join('\n'));
  if (brief.project.projectDoc?.trim()) {
    out.push('## PROJECT.md (from the knowledge vault)');
    out.push(brief.project.projectDoc.trim());
  }

  out.push('# How to report');
  out.push(
    [
      'You report through the `aom` command, never through free text. Run exactly one terminal command to end the shift.',
      '',
      `Allowed outcomes for the "${brief.shift.stageLabel}" stage:`,
      ...brief.shift.outcomes.map((o) => `- ${o.id} (${o.kind}): ${o.label}\n  \`${commandForOutcome(o)}\``),
      '',
      'Other commands:',
      '- `aom card [--json]`: print this card and brief again.',
      '- `aom ledger search "<query>"`: search decisions and standing orders. Do this before asking a question.',
      '- Run every `aom` command on its own: no pipes, redirects, `;`, `&&`, `cd` or `$(...)` around it (for example `aom ledger search "tech stack"`, not `aom ledger search "tech stack" | head`). Otherwise it runs inside the shell sandbox and cannot reach the runner.',
      '- `aom comment --note "<text>"`: post a note on the card thread without ending the shift.',
      `- \`${QUESTION_COMMAND}\`: ask the manager when the card and ledger cannot answer; this ends the shift and parks the card as Blocked.`,
      '- `aom question ... --non-blocking`: ask the manager without ending the shift (add `--force` if the ledger already has a similar entry).',
      '',
      'If `aom` reports an error, read it, fix the cause and run the command again within this shift.',
    ].join('\n'),
  );

  out.push('# Boundaries');
  out.push(
    [
      '- Work only inside your current working directory (the card worktree).',
      '- Do not push, rebase, checkout or switch branches; do not touch other worktrees.',
      '- Search the ledger with `aom ledger search` before asking a question.',
      `- This shift may run for at most ${brief.shift.maxShiftMinutes} minutes.`,
    ].join('\n'),
  );

  return `${out.join('\n\n')}\n`;
}
