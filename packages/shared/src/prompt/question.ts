import type { QuestionShift } from '../intake/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { AOM_NO_PIPES_NOTE } from './commands.ts';
import { renderShiftPrompt } from './shift-prompt.ts';

export const ANSWER_COMMAND = 'aom answer --item <id> --text "<your answer>" [--option <option id>]';
export const ESCALATE_COMMAND =
  'aom escalate --item <id> --note "<what you checked, and what exactly needs deciding>"';

/**
 * Instructions of a `question` shift (docs/ARCHITECTURE.md section 15): a colleague's question reached you along the
 * escalation chain (a senior of the same role or the card's previous holder, then the BA, then the manager's desk).
 * You answer it or pass it on; you do not work the card. Pure and deterministic.
 */
export function renderQuestionInstructions(brief: ShiftBrief, q: QuestionShift): string {
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, a ${brief.agent.seniority} ${brief.role.name}. A colleague asked a question while working on card ${brief.card.ref} in project ${brief.project.key}. Names are handles, not personas: do not roleplay.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.coreRules.length > 0) {
    out.push('# Core rules');
    out.push(brief.role.coreRules.map((r) => `- ${r}`).join('\n'));
  }
  out.push('# Standing orders');
  out.push(
    brief.standingOrders.length > 0
      ? brief.standingOrders.map((s) => `## ${s.title}\n${s.body.trim()}`).join('\n\n')
      : 'None.',
  );
  out.push('# Your job in this shift');
  out.push(
    [
      q.level === 'ba'
        ? 'The question was passed to you, the BA, because the senior peer could not settle it. The manager is next: escalate only what only the manager can decide.'
        : 'You were picked as a senior peer (or the previous holder of the card). If you can answer from the card, the code or the ledger, answer; otherwise pass it to the BA.',
      'Search the ledger first (`aom ledger search "<query>"`): the entries that matched are listed in the prompt.',
      'You may read the repository and documents, but you do not change anything and you do not work the card.',
      'A wrong answer costs more than an escalation: do not guess.',
    ].join('\n'),
  );
  out.push('# How to report');
  out.push(
    [
      'End the shift with exactly one terminal command:',
      `- Answer it: \`${ANSWER_COMMAND}\``,
      `- Pass it on: \`${ESCALATE_COMMAND}\``,
      '',
      'Other commands: `aom card [--json]` prints the card, `aom ledger search "<query>"` searches decisions and standing orders.',
      AOM_NO_PIPES_NOTE,
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

/** The prompt of a question shift: the card, what was tried and matched, then the question last. */
export function renderQuestionPrompt(brief: ShiftBrief, q: QuestionShift): string {
  // The card comes first and the question last: the card is the same for every question about it, so its prompt-cache
  // prefix is shared between the question shifts of a card; what changes (the question) is at the end.
  const out: string[] = [];
  out.push('## The card');
  out.push(
    renderShiftPrompt({ ...brief, shift: { ...brief.shift, outcomes: [] } }).split(
      '\n## Your job',
    )[0] as string,
  );
  out.push('## Ledger entries that matched');
  out.push(
    q.ledgerMatches.length > 0
      ? q.ledgerMatches
          .map((m) => `- [${m.scope}] ${m.title} (id ${m.id})\n  ${m.body.trim().replace(/\n/g, '\n  ')}`)
          .join('\n')
      : 'None.',
  );
  if (q.trail.length > 0) {
    out.push('## Already looked at by');
    out.push(q.trail.map((t) => `- ${t}`).join('\n'));
  }
  out.push(`# Question ${q.deskItemId}`);
  out.push(
    `Asked by ${q.askedBy.name}${q.askedBy.role ? ` (${q.askedBy.role})` : ''} on ${brief.card.ref} ${brief.card.title}${q.blocking ? '; the card is blocked until it is answered' : ' (non-blocking)'}.`,
  );
  if (q.doing.trim()) {
    out.push('## What the asker was doing');
    out.push(q.doing.trim());
  }
  if (q.options.length > 0) {
    out.push('## Options offered');
    out.push(
      q.options
        .map((o) => `- ${o.id}: ${o.label}${q.recommendation === o.id ? ' (recommended by the asker)' : ''}`)
        .join('\n'),
    );
  }
  out.push('## The question');
  out.push(q.text.trim());
  out.push('## Your job in this shift');
  out.push(
    [
      `Item id: ${q.deskItemId}`,
      `- Answer: \`${ANSWER_COMMAND.replace('<id>', q.deskItemId)}\``,
      `- Pass it on: \`${ESCALATE_COMMAND.replace('<id>', q.deskItemId)}\``,
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}
