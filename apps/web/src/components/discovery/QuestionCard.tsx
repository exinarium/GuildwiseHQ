import type { AnswerQuestionRequest, QuestionDto } from '@aom/shared';
import { Bookmark, CircleHelp, SkipForward } from 'lucide-react';
import { useState } from 'react';
import { answerText, SOURCE_LABEL } from '../../lib/discovery.ts';
import { cx } from '../ui/cx.ts';
import { Badge, Button, TextArea } from '../ui.tsx';

/**
 * A question card. Open: quick-pick buttons, free text, skip and park. With a CEO proposal: the proposal is shown
 * clearly as the CEO's, and the owner confirms it, edits it, or overrides it by answering something else. Settled
 * questions fold into one line.
 */
export function QuestionCard({
  q,
  ceoName,
  onAnswer,
  busy,
  error,
}: {
  q: QuestionDto;
  ceoName: string | null;
  onAnswer: (body: AnswerQuestionRequest) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState(q.proposed?.text ?? '');
  const settled = q.status !== 'open' && q.status !== 'proposed';

  if (settled)
    return (
      <li
        data-testid="question-card"
        data-status={q.status}
        className="flex flex-col gap-0.5 rounded-card border border-line bg-sunken/60 px-3 py-2 text-sm"
      >
        <p className="flex items-start gap-2 text-muted">
          <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{q.question}</span>
        </p>
        <p className="pl-6 font-medium text-fg [overflow-wrap:anywhere]" data-testid="question-answer">
          {answerText(q)}
        </p>
        {q.answer && SOURCE_LABEL[q.answer.source] && (
          <p className="pl-6 text-xs text-subtle">{SOURCE_LABEL[q.answer.source]}</p>
        )}
      </li>
    );

  const proposed = q.proposed;
  const review = q.status === 'proposed';
  const who = proposed?.byName ?? ceoName ?? 'The CEO';
  return (
    <li
      data-testid="question-card"
      data-status={q.status}
      className="flex flex-col gap-3 rounded-card border border-brand/40 bg-surface p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{review ? 'Review' : 'Question'}</Badge>
        <span className="text-xs text-subtle">{q.askedByName}</span>
      </div>
      <div>
        <h3 className="text-base font-semibold text-fg [overflow-wrap:anywhere]">{q.question}</h3>
        {q.why && <p className="mt-0.5 text-sm text-muted">Why I ask: {q.why}</p>}
      </div>

      {proposed && (
        <div
          className="rounded-control border border-info-fill/40 bg-info-soft p-3 text-sm text-info-soft-fg"
          data-testid="ceo-proposal"
        >
          <p className="font-semibold">
            Proposed by {who} <span className="font-normal">(a suggestion, not an answer)</span>
          </p>
          <p className="mt-1 [overflow-wrap:anywhere]">{proposed.text}</p>
          {proposed.rationale && <p className="mt-1 text-xs opacity-90">Because: {proposed.rationale}</p>}
          {editing ? (
            <div className="mt-2 flex flex-col gap-2">
              <TextArea label="Your edit" rows={2} value={edit} onChange={(e) => setEdit(e.target.value)} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!edit.trim() || busy}
                  onClick={() =>
                    onAnswer({
                      kind: 'confirm',
                      edited: true,
                      text: edit.trim(),
                      ...(proposed.optionId ? { optionId: proposed.optionId } : {}),
                    })
                  }
                >
                  Use my edit
                </Button>
                <Button onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => onAnswer({ kind: 'confirm' })}
                data-testid="ceo-confirm"
              >
                Confirm
              </Button>
              <Button disabled={busy} onClick={() => setEditing(true)} data-testid="ceo-edit">
                Edit
              </Button>
            </div>
          )}
          <p className="mt-2 text-xs opacity-80">Or answer yourself below to override it.</p>
        </div>
      )}

      {q.options.length > 0 && (
        <div className="flex flex-col gap-2" role="group" aria-label="Quick answers">
          {q.options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={busy}
              data-testid={`option-${o.id}`}
              onClick={() => onAnswer({ kind: 'pick', optionId: o.id })}
              className={cx(
                'min-h-11 rounded-control border px-3 py-2 text-left text-sm font-medium transition-colors [overflow-wrap:anywhere] disabled:opacity-60',
                proposed?.optionId === o.id
                  ? 'border-info-fill bg-info-soft/40 text-fg'
                  : 'border-control bg-surface text-fg hover:border-brand hover:bg-brand-soft',
              )}
            >
              {o.label}
              {proposed?.optionId === o.id && <span className="ml-2 text-xs text-subtle">CEO's pick</span>}
            </button>
          ))}
        </div>
      )}

      {q.allowFreeText && (
        <form
          className="flex flex-col gap-2"
          aria-label="Answer in your own words"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer({ kind: 'text', text: text.trim() });
          }}
        >
          <TextArea
            label={q.options.length ? 'Or in your own words' : 'Your answer'}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div>
            <Button type="submit" variant="primary" disabled={!text.trim() || busy} data-testid="answer-send">
              Send answer
            </Button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap gap-2 border-t border-line pt-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onAnswer({ kind: 'skip' })}
          data-testid="answer-skip"
        >
          <SkipForward aria-hidden="true" className="size-4" />
          Skip
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onAnswer({ kind: 'park' })}
          data-testid="answer-park"
        >
          <Bookmark aria-hidden="true" className="size-4" />
          Park for later
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
