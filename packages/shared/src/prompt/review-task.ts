import type { BaTaskShift } from '../phases/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { AOM_NO_PIPES_NOTE, commandForOutcome } from './commands.ts';

/**
 * The BA's one remaining read-only analysis task: the CEO-BA review of a corrected decision (travels as the retired
 * reporter kind `scheduled_brief`; docs/design/ceo-front-door.md step 3). The BA reporter itself (triage, notes, signal
 * analysis, the floor report, schedules' reports) is retired: those are CEO work now.
 */
export function renderReviewInstructions(brief: ShiftBrief, _task: BaTaskShift): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the business analyst (BA). The CEO asks you for an analysis in the background. Names are handles, not personas: do not roleplay.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.coreRules.length > 0) {
    out.push('# Core rules');
    out.push(brief.role.coreRules.map((r) => `- ${r}`).join('\n'));
  }
  out.push('# Your job in this shift');
  out.push(
    [
      'Task: an analysis the CEO asked for.',
      'Do what the instructions below ask, using only what you can read (the ledger, the desk, the vault, the repositories read-only) and what the facts say. Do not change anything.',
      'Answer with one report in markdown: lead with the answer, then the evidence. Say plainly what you could not find out. Do not invent facts.',
    ].join('\n'),
  );
  out.push(
    'You are read-only. Never ask questions and never wait: anything that must be decided goes into what you write.',
  );
  out.push('# How to report');
  out.push(
    [
      'End the shift with exactly one terminal command:',
      ...brief.shift.outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandForOutcome(o)}\``),
      '',
      'Write the file first (your scratch directory).',
      AOM_NO_PIPES_NOTE,
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

export function renderReviewPrompt(task: BaTaskShift): string {
  const out: string[] = ['# Analysis for the CEO'];
  const b = task.reporter?.brief;
  if (!b) return `${out.join('\n\n')}\n\nNo data.\n`;
  out.push(`Task: ${b.scheduleName}${b.projectKey ? ` (project ${b.projectKey})` : ''}.`);
  out.push('## Instructions');
  out.push(b.instructions);
  return `${out.join('\n\n')}\n`;
}
