import type { ProposalQuestion } from '@aom/shared';
import { useState } from 'react';
import type { QuestionAnswer } from '../../api/queries/environments.ts';
import { Badge, Button, ErrorBox, Select, TextInput } from '../ui.tsx';
import { Choice } from './Choice.tsx';

export type Question = ProposalQuestion;

export type QuestionKind = 'text' | 'choice' | 'number' | 'yesno';

const YES_NO = /^(yes|no)\b/i;

/** The control a question needs, from `kind` or from its options and default. */
export function questionKind(q: Question): QuestionKind {
  if (q.kind === 'confirm') return 'yesno';
  if (q.kind === 'text') return /^\d+$/.test((q.default ?? '').trim()) ? 'number' : 'text';
  const o = q.options ?? [];
  if (o.length === 2 && o.every((x) => YES_NO.test(x.trim()))) return 'yesno';
  if (o.length > 0) return 'choice';
  if (q.default !== undefined && /^\d+$/.test(q.default.trim())) return 'number';
  if (/\b(port|how many|number of)\b/i.test(q.question)) return 'number';
  return 'text';
}

/** The choices of a yes or no question: its own words, or plain Yes and No (the stored answer is yes or no). */
const yesNoOptions = (q: Question): Array<{ label: string; value: string }> =>
  q.kind === 'confirm' || !q.options?.length
    ? [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ]
    : q.options.map((o) => ({ label: o, value: o }));

/** A question marked optional does not stop anyone: "we will use 3000 unless you change it". */
export const isOptional = (q: Question): boolean => q.optional === true;

export const isAnswered = (q: Question): boolean => q.answer !== undefined;

/** The questions that still stop "Use this": required ones with no stored answer. */
export const blockingQuestions = (qs: Question[]): Question[] =>
  qs.filter((q) => !isOptional(q) && !isAnswered(q));

/**
 * The questions of a DevOps suggestion as real fields (docs/design/environments-ux.md journey G): radios for a few choices, a
 * select for many, two radios for yes/no, a number or a text field, each with its default said in words. "Use these answers"
 * sends them; the server merges each at the question's place in the suggestion and checks it again.
 */
export function AnswerFields({
  questions,
  pending,
  error,
  onSubmit,
  onLater,
}: {
  questions: Question[];
  pending: boolean;
  error?: unknown;
  onSubmit: (a: QuestionAnswer[]) => void;
  onLater?: (() => void) | undefined;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.path, q.answer ?? q.default ?? ''])),
  );
  const set = (path: string, v: string) => setValues((c) => ({ ...c, [path]: v }));
  const open = blockingQuestions(questions).length;
  const unanswered = questions.filter((q) => !isAnswered(q)).length;
  const ready = questions.every((q) => isOptional(q) || (values[q.path] ?? '').trim() !== '');
  const submit = () =>
    onSubmit(
      questions
        .filter((q) => (values[q.path] ?? '').trim() !== '')
        .map((q) => ({ path: q.path, value: (values[q.path] ?? '').trim() })),
    );
  return (
    <section className="flex flex-col gap-3" aria-label="Questions" data-testid="proposal-questions">
      <h4 className="text-sm font-semibold text-fg">
        {open > 0
          ? `${unanswered} ${unanswered === 1 ? 'question' : 'questions'} before you can use this`
          : 'Your answers'}
      </h4>
      <ol className="flex flex-col gap-4">
        {questions.map((q, i) => {
          const kind = questionKind(q);
          const id = `q-${i}`;
          const v = values[q.path] ?? '';
          const saved = isAnswered(q);
          return (
            <li key={q.path + q.question} className="flex flex-col gap-1.5" data-testid={`answer-${i}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg" id={`${id}-label`}>
                  {i + 1}. {q.question}
                </span>
                {saved && <Badge tone="success">Answered</Badge>}
                {!saved && isOptional(q) && <Badge>Optional</Badge>}
              </div>
              {(kind === 'yesno' || (kind === 'choice' && (q.options?.length ?? 0) <= 5)) && (
                <fieldset className="flex flex-col gap-1.5" aria-labelledby={`${id}-label`}>
                  {(kind === 'yesno'
                    ? yesNoOptions(q)
                    : (q.options ?? []).map((o) => ({ label: o, value: o }))
                  ).map((o) => (
                    <Choice
                      key={o.value}
                      name={id}
                      checked={v === o.value}
                      onSelect={() => set(q.path, o.value)}
                      title={o.label}
                      testId={`answer-${i}-${o.value}`}
                    />
                  ))}
                </fieldset>
              )}
              {kind === 'choice' && (q.options?.length ?? 0) > 5 && (
                <Select
                  label="Choose one"
                  value={v}
                  onChange={(e) => set(q.path, e.target.value)}
                  data-testid={`answer-${i}-select`}
                >
                  <option value="">Choose</option>
                  {(q.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              )}
              {(kind === 'number' || kind === 'text') && (
                <TextInput
                  label="Your answer"
                  value={v}
                  inputMode={kind === 'number' ? 'numeric' : undefined}
                  onChange={(e) =>
                    set(q.path, kind === 'number' ? e.target.value.replace(/\D/g, '') : e.target.value)
                  }
                  data-testid={`answer-${i}-input`}
                />
              )}
              {q.default !== undefined && (
                <p className="text-xs text-muted">
                  DevOps guessed {q.default}. We will use {q.default} unless you change it.
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <ErrorBox error={error} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="primary"
          onClick={submit}
          disabled={!ready}
          loading={pending}
          data-testid="answers-submit"
        >
          Use these answers
        </Button>
        {onLater && (
          <Button variant="ghost" onClick={onLater} data-testid="answers-later">
            Answer later
          </Button>
        )}
        {!ready && (
          <span className="self-center text-xs text-subtle">Choose an answer for each question.</span>
        )}
      </div>
    </section>
  );
}
