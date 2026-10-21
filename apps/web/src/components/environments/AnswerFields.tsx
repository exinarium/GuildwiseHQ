import type { ProposalQuestion } from '@aom/shared';
import { useState } from 'react';
import type { QuestionAnswer } from '../../api/queries/environments.ts';
import { Badge, Button, ErrorBox, Select, TextInput } from '../ui.tsx';
import { Choice } from './Choice.tsx';

/** A question may carry more than the shared schema says today (`kind`, `optional`); the control is inferred when it does not. */
export type Question = ProposalQuestion & {
  kind?: 'text' | 'choice' | 'number' | 'yesno';
  optional?: boolean;
};
export type AnswerValue = string | number | boolean;
export type Answered = Record<string, AnswerValue>;

export type QuestionKind = 'text' | 'choice' | 'number' | 'yesno';

const YES_NO = /^(yes|no)\b/i;

/** The control a question needs, from `kind` or from its options and default. */
export function questionKind(q: Question): QuestionKind {
  if (q.kind) return q.kind;
  const o = q.options ?? [];
  if (o.length === 2 && o.every((x) => YES_NO.test(x.trim()))) return 'yesno';
  if (o.length > 0) return 'choice';
  if (q.default !== undefined && /^\d+$/.test(q.default.trim())) return 'number';
  if (/\b(port|how many|number of)\b/i.test(q.question)) return 'number';
  return 'text';
}

/** A question with a default does not stop anyone: "we will use 3000 unless you change it". */
export const isOptional = (q: Question): boolean => q.optional === true || q.default !== undefined;

/** The questions that still stop "Use this": required ones with no saved answer. */
export const blockingQuestions = (qs: Question[], answered: Answered): Question[] =>
  qs.filter((q) => !isOptional(q) && answered[q.path] === undefined);

/**
 * The questions of a DevOps suggestion as real fields (docs/design/environments-ux.md journey G): radios for a few choices, a
 * select for many, two radios for yes/no, a number or a text field, each with its default said in words. "Use these answers"
 * sends them; the server merges each at the question's place in the suggestion and checks it again.
 */
export function AnswerFields({
  questions,
  answered,
  pending,
  error,
  onSubmit,
  onLater,
}: {
  questions: Question[];
  answered: Answered;
  pending: boolean;
  error?: unknown;
  onSubmit: (a: QuestionAnswer[]) => void;
  onLater?: (() => void) | undefined;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      questions.map((q) => [
        q.path,
        answered[q.path] !== undefined ? String(answered[q.path]) : (q.default ?? ''),
      ]),
    ),
  );
  const set = (path: string, v: string) => setValues((c) => ({ ...c, [path]: v }));
  const open = blockingQuestions(questions, answered).length;
  const ready = questions.every((q) => isOptional(q) || (values[q.path] ?? '').trim() !== '');
  const submit = () =>
    onSubmit(
      questions
        .filter((q) => (values[q.path] ?? '').trim() !== '')
        .map((q) => {
          const v = (values[q.path] ?? '').trim();
          const kind = questionKind(q);
          return {
            path: q.path,
            value:
              kind === 'number' && /^\d+$/.test(v)
                ? Number(v)
                : kind === 'yesno'
                  ? YES_NO.exec(v)?.[0].toLowerCase() === 'yes'
                  : v,
          };
        }),
    );
  return (
    <section className="flex flex-col gap-3" aria-label="Questions" data-testid="proposal-questions">
      <h4 className="text-sm font-semibold text-fg">
        {open > 0
          ? `${questions.filter((q) => answered[q.path] === undefined).length} ${questions.filter((q) => answered[q.path] === undefined).length === 1 ? 'question' : 'questions'} before you can use this`
          : 'Your answers'}
      </h4>
      <ol className="flex flex-col gap-4">
        {questions.map((q, i) => {
          const kind = questionKind(q);
          const id = `q-${i}`;
          const v = values[q.path] ?? '';
          const saved = answered[q.path] !== undefined;
          return (
            <li key={q.path + q.question} className="flex flex-col gap-1.5" data-testid={`answer-${i}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg" id={`${id}-label`}>
                  {i + 1}. {q.question}
                </span>
                {saved && <Badge tone="success">Answered</Badge>}
                {!saved && isOptional(q) && <Badge>Optional</Badge>}
              </div>
              {(kind === 'choice' || kind === 'yesno') && (q.options?.length ?? 0) <= 5 && (
                <fieldset className="flex flex-col gap-1.5" aria-labelledby={`${id}-label`}>
                  {(q.options ?? []).map((o) => (
                    <Choice
                      key={o}
                      name={id}
                      checked={v === o}
                      onSelect={() => set(q.path, o)}
                      title={o}
                      testId={`answer-${i}-${o}`}
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
