import type { ProposalDto, ProposalQuestion } from '@aom/shared';
import type { ReactNode } from 'react';
import { Badge, Button, Callout, Disclosure } from '../ui.tsx';

export interface ReviewQuestion extends ProposalQuestion {
  /** The person answered it (edited the part it is about). */
  answered: boolean;
  /** Opens the part the question is about. */
  onAnswer?: () => void;
}

/**
 * The frame of a scan review, shared by the run steps (v1a) and the deploy setup (v1b) (docs/design/deploy-run-ux-design.md
 * sections 3.1 R2 and 5.3): what DevOps read, its notes, the questions only the user can answer (they block "Use"), the
 * proposed items as `children`, and the three ways out. The proposal is data; nothing is saved until the user confirms.
 */
export function ProposalReview({
  proposal,
  questions,
  blocking,
  useLabel,
  onUse,
  onDismiss,
  busy,
  children,
  testSlot,
}: {
  proposal: ProposalDto;
  questions: ReviewQuestion[];
  /** How many things must still be answered before the proposal can be used. */
  blocking: number;
  useLabel: string;
  onUse: () => void;
  onDismiss: () => void;
  busy?: boolean;
  children: ReactNode;
  /** The result of a test, shown under the buttons. */
  testSlot?: ReactNode;
}) {
  const p = proposal.proposal;
  const open = questions.filter((q) => !q.answered);
  return (
    <div className="flex flex-col gap-4" data-testid="proposal-review">
      <div>
        <h3 className="text-base font-semibold text-fg">DevOps has a suggestion</h3>
        <p className="text-sm text-muted">
          {p.filesRead.length > 0
            ? `DevOps read ${p.filesRead.slice(0, 4).join(', ')}${p.filesRead.length > 4 ? ` and ${p.filesRead.length - 4} more` : ''} on ${proposal.workstationName}.`
            : `DevOps looked at the project on ${proposal.workstationName}.`}{' '}
          Nothing is saved until you press <strong>{useLabel}</strong>.
        </p>
        {p.filesRead.length > 4 && (
          <Disclosure summary="Everything it read" className="mt-1">
            <ul className="list-disc pl-5 text-xs text-muted">
              {p.filesRead.map((f) => (
                <li key={f} className="font-mono [overflow-wrap:anywhere]">
                  {f}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>

      {p.notes.trim() && (
        <Callout tone="info" title="DevOps says" data-testid="proposal-notes">
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{p.notes}</p>
        </Callout>
      )}

      {questions.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="Questions" data-testid="proposal-questions">
          <h4 className="text-sm font-semibold text-fg">
            {open.length > 0
              ? `${open.length} ${open.length === 1 ? 'question' : 'questions'} before you can use this`
              : 'Your answers'}
          </h4>
          <ul className="flex flex-col gap-2">
            {questions.map((q) => (
              <li
                key={`${q.path}-${q.question}`}
                className="flex flex-col gap-1 rounded-control border border-line p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{q.question}</span>
                  {q.answered && <Badge tone="success">Answered</Badge>}
                </div>
                {(q.default || (q.options && q.options.length > 0)) && (
                  <p className="text-xs text-muted">
                    {q.options && q.options.length > 0 ? `Options: ${q.options.join(', ')}. ` : ''}
                    {q.default ? `Usually ${q.default}.` : ''}
                  </p>
                )}
                {q.onAnswer && !q.answered && (
                  <div>
                    <Button size="sm" onClick={q.onAnswer}>
                      Answer
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {children}

      {p.secretsNeeded.length > 0 && (
        <Callout tone="warning" title="Passwords or keys the app needs">
          {p.secretsNeeded.join(', ')}. Guildwise never asks for their values here: keep them in a settings
          file on the computer.
        </Callout>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Button
          variant="primary"
          onClick={onUse}
          disabled={blocking > 0 || busy}
          loading={busy}
          data-testid="proposal-use"
        >
          {useLabel}
        </Button>
        <Button variant="ghost" onClick={onDismiss} disabled={busy} data-testid="proposal-dismiss">
          Dismiss
        </Button>
        {blocking > 0 && (
          <span className="text-xs text-subtle" data-testid="proposal-blocking">
            Answer {blocking === 1 ? 'the open question' : `the ${blocking} open questions`} first.
          </span>
        )}
      </div>
      {testSlot}
    </div>
  );
}
