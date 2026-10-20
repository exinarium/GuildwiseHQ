import { renderBatchInstructions, renderBatchPrompt } from '../intake/batch.ts';
import { renderSpecCardInstructions, renderSpecCardPrompt } from '../intake/spec-card.ts';
import { renderMailDraftInstructions, renderMailDraftPrompt } from '../mail/draft.ts';
import type { BaTaskShift } from '../phases/index.ts';
import type { ShiftBrief } from '../protocol/runner.ts';
import { AOM_NO_PIPES_NOTE, commandForOutcome } from './commands.ts';
import { renderReviewInstructions, renderReviewPrompt } from './review-task.ts';
import { renderBindingStandingOrders } from './standing-orders.ts';

const TASK_TITLE: Record<
  'phase_report' | 'followups_brief' | 'followup_custom' | 'followups_report',
  string
> = {
  phase_report: 'Phase done: report to the manager',
  followups_brief: 'Follow-ups approved: brief the delegates',
  followup_custom: 'Custom follow-up: carry it out',
  followups_report: 'Follow-ups finished: report the results',
};

/**
 * Instructions of a `ba_task` shift (docs/design/phases.md A5.5, A9): the BA works for the manager on a phase, in the
 * background, with no card and no worktree. The server runs the sequence; the BA writes, delegates and reports.
 */
export function renderBaTaskInstructions(brief: ShiftBrief, task: BaTaskShift): string {
  if (task.batch) return renderBatchInstructions(brief, brief.shift.outcomes, commandForOutcome);
  if (task.mailDraft)
    return renderMailDraftInstructions(brief, task.mailDraft, brief.shift.outcomes, commandForOutcome);
  if (task.specCard)
    return renderSpecCardInstructions(brief, task.specCard, brief.shift.outcomes, commandForOutcome);
  if (!task.phase) return renderReviewInstructions(brief, task);
  const phase = task.phase;
  const kind = task.kind as keyof typeof TASK_TITLE;
  const out: string[] = [];
  out.push('# Who you are');
  out.push(
    `You are ${brief.agent.name}, the business analyst (BA), working for the manager in the background on phase ${phase.ref} "${phase.name}" of project ${phase.projectKey}. Names are handles, not personas: do not roleplay.`,
  );
  out.push('# Role instructions');
  out.push(brief.role.instructions.trim());
  if (brief.role.coreRules.length > 0) {
    out.push('# Core rules');
    out.push(brief.role.coreRules.map((r) => `- ${r}`).join('\n'));
  }
  if (brief.standingOrders.length > 0) out.push(renderBindingStandingOrders(brief.standingOrders));
  out.push('# Your job in this shift');
  out.push(
    [
      `Task: ${TASK_TITLE[kind]}.`,
      'You are read-only: you read the prompt (and `aom card <REF>` for a member card), you change nothing else.',
      'Never ask questions in this shift and never wait: anything the manager must decide goes into your report.',
    ].join('\n'),
  );
  out.push('# How to report');
  out.push(
    [
      'End the shift with exactly one terminal command:',
      ...brief.shift.outcomes.map((o) => `- ${o.id}: ${o.label}\n  \`${commandForOutcome(o)}\``),
      '',
      task.kind === 'followups_brief'
        ? 'Before the terminal command, delegate every follow-up with `aom phase followup brief <n> --to devops|tester|ba --text "<instructions>"`.'
        : 'Write the report as markdown in a file first (your scratch directory).',
      AOM_NO_PIPES_NOTE,
    ].join('\n'),
  );
  return `${out.join('\n\n')}\n`;
}

function followupLine(f: BaTaskShift['followups'][number]): string {
  const what =
    f.kind === 'deploy'
      ? `deploy to ${f.target?.name ?? '(target removed)'}`
      : f.kind === 'regression'
        ? `regression run (${f.platform ?? 'web'})${f.target ? ` against ${f.target.name}` : ''}`
        : `custom: ${f.instruction}`;
  return `${f.position}. ${what} [${f.status}${f.delegate ? `, to ${f.delegate}` : ''}]${f.note ? `\n   note: ${f.note}` : ''}`;
}

/** The prompt of a `ba_task` shift: the phase, its cards, the follow-ups and what is outstanding. */
export function renderBaTaskPrompt(task: BaTaskShift): string {
  if (task.batch) return renderBatchPrompt(task.batch);
  if (task.mailDraft) return renderMailDraftPrompt(task.mailDraft);
  if (task.specCard) return renderSpecCardPrompt(task.specCard);
  if (!task.phase) return renderReviewPrompt(task);
  const phase = task.phase;
  const out: string[] = [];
  out.push(`# ${TASK_TITLE[task.kind as keyof typeof TASK_TITLE]}`);
  out.push(
    `Phase ${phase.ref}: ${phase.name} (${phase.status}). Working branch: ${phase.workingBranch}.${phase.description.trim() ? `\n\n${phase.description.trim()}` : ''}`,
  );
  out.push('## Cards');
  out.push(
    task.cards.length
      ? task.cards
          .map((c) => {
            const how =
              c.outcome === 'finalized'
                ? `finalized (${c.action ?? 'merge'})${c.resultRef?.mergeCommit ? ` ${c.resultRef.mergeCommit.slice(0, 10)}` : ''}${c.resultRef?.prUrl ? ` ${c.resultRef.prUrl}` : ''}${c.resultRef?.pushedBranch ? ` branch ${c.resultRef.pushedBranch}` : ''}`
                : c.outcome === 'published'
                  ? 'research note published'
                  : c.outcome === 'closed_manually'
                    ? 'closed by hand (no completion action ran)'
                    : `cancelled${c.reason ? `: ${c.reason}` : ''}`;
            const suite = c.suite
              ? `\n   full E2E suite ${c.suite.ref}: ${c.suite.result ?? c.suite.status}${c.suite.bugRefs.length ? `, bugs ${c.suite.bugRefs.join(', ')}` : ''}`
              : '';
            return `- ${c.ref} ${c.title}: ${how}${c.unmergedBranch ? `; branch ${c.unmergedBranch} kept, not merged` : ''}${suite}`;
          })
          .join('\n')
      : 'None.',
  );
  out.push('## Outstanding');
  out.push(
    task.outstanding.length ? task.outstanding.map((o) => `- ${o.text}`).join('\n') : 'Nothing known.',
  );
  out.push('## Follow-ups');
  out.push(task.followups.length ? task.followups.map(followupLine).join('\n') : 'None.');
  if (task.kind === 'followups_brief') {
    out.push('## Targets');
    out.push(
      task.followups
        .filter((f) => f.target)
        .map((f) => {
          const t = f.target as NonNullable<typeof f.target>;
          return `- ${t.name} (${t.kind}${t.host ? `, host ${t.host}` : ''})${t.appUrl ? `, URL ${t.appUrl}` : ''}${t.notes.trim() ? `\n  notes: ${t.notes.trim().replace(/\n/g, '\n  ')}` : ''}`;
        })
        .join('\n') || 'None.',
    );
  }
  if (task.kind === 'followups_report') {
    out.push('## Results');
    out.push(
      task.followups
        .map(
          (f) =>
            `${f.position}. ${f.status}${f.resultSummary ? `: ${f.resultSummary}` : ''}${Object.keys(f.evidence).length ? `\n   evidence: ${JSON.stringify(f.evidence)}` : ''}`,
        )
        .join('\n') || 'None.',
    );
  }
  if (task.kind === 'followup_custom' && task.followupId) {
    const f = task.followups.find((x) => x.id === task.followupId);
    out.push('## The instruction');
    out.push(f ? `Follow-up ${f.position}: ${f.instruction}` : 'Follow-up not found.');
  }
  return `${out.join('\n\n')}\n`;
}
