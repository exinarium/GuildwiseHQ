import type { ShiftBrief } from '../protocol/runner.ts';
import { commandForOutcome } from './commands.ts';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const section = (title: string, body: string): string | null =>
  body.trim() ? `## ${title}\n${body.trim()}` : null;

/**
 * Renders the card as a markdown prompt (`-p`): ref, title, type, risk tier, rework round; the card fields;
 * dependencies; all prior handoffs; latest review comments; last thread messages; then the job for this shift
 * (docs/ARCHITECTURE.md section 13.2). Pure and deterministic.
 */
export function renderShiftPrompt(brief: ShiftBrief): string {
  const { card, shift } = brief;
  const f = card.fields;
  const parts: Array<string | null> = [];

  parts.push(`# ${card.ref}: ${card.title}`);
  parts.push(
    [
      `- Type: ${card.cardType}`,
      `- Risk tier: ${card.riskTier ?? 'not yet assessed'}`,
      `- Rework round: ${card.reworkRound}`,
      ...(card.parent ? [`- Parent card: ${card.parent.ref} ${card.parent.title}`] : []),
    ].join('\n'),
  );

  parts.push(section('Context', text(f.context)));
  parts.push(section('Requirements', text(f.requirements)));
  const criteria = list(f.acceptanceCriteria);
  parts.push(section('Acceptance criteria', criteria.map((c) => `- [ ] ${c}`).join('\n')));
  parts.push(section('Affected areas', text(f.affectedAreas)));
  const constraintLines: string[] = [];
  if (text(f.constraints)) constraintLines.push(text(f.constraints));
  for (const l of brief.ledger) constraintLines.push(`- Ledger (${l.scope}) ${l.title}: ${l.body.trim()}`);
  parts.push(section('Constraints', constraintLines.join('\n')));
  parts.push(section('Test plan', text(f.testPlan)));
  parts.push(section('Completion action', card.completionAction ?? ''));
  parts.push(
    section('Dependencies', card.dependencies.map((d) => `- ${d.ref} ${d.title} (${d.status})`).join('\n')),
  );
  parts.push(
    section(
      'Previous handoffs',
      brief.handoffs
        .map((h) => `### ${h.stage} / ${h.agentName} / ${h.outcome} (${h.at})\n${h.note.trim()}`)
        .join('\n\n'),
    ),
  );
  if (card.reworkRound > 0) {
    parts.push(
      section(
        'Review comments to address',
        brief.reviewComments
          .map((r) => {
            const lines = [`### ${r.reviewerName} (${r.at})`];
            if (r.reasons.length) lines.push(`Reasons: ${r.reasons.join(', ')}`);
            if (r.criteriaMissed.length)
              lines.push(`Criteria missed:\n${r.criteriaMissed.map((c) => `- ${c}`).join('\n')}`);
            if (r.comments.trim()) lines.push(r.comments.trim());
            return lines.join('\n');
          })
          .join('\n\n'),
      ),
    );
  }
  parts.push(
    section(
      'Recent thread',
      brief.thread.map((m) => `- ${m.authorName} (${m.kind}, ${m.at}): ${m.body.trim()}`).join('\n'),
    ),
  );

  parts.push(
    [
      '## Your job in this shift',
      `Stage: ${shift.stageLabel}`,
      '',
      `Done criteria: ${shift.doneCriteria}`,
      '',
      'Allowed outcomes (run exactly one when you are done):',
      ...shift.outcomes.map((o) => `- ${o.id} (${o.kind}): ${o.label}\n  \`${commandForOutcome(o)}\``),
    ].join('\n'),
  );

  return `${parts.filter((p): p is string => p !== null).join('\n\n')}\n`;
}
