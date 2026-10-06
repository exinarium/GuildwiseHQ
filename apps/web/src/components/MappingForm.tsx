import type { DeskItemDto } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAnswerDeskItem, useDismissDeskItem } from '../api/queries/desk.ts';
import { Button, ErrorBox } from './ui.tsx';

/**
 * The mapping question of an unmapped ticket (docs/SPEC.md "Operating model"): the BA could not tell which project an
 * intake's ticket belongs to. Picking one maps it and tells the BA to carry on; the choice is kept in the ledger so
 * the next ticket of that kind needs no question.
 */
export function MappingForm({ item }: { item: DeskItemDto }) {
  const answer = useAnswerDeskItem();
  const dismiss = useDismissDeskItem();
  const [optionId, setOptionId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const chosen = item.options.find((o) => o.id === optionId);
  const ticket = item.title.replace(/^Which project does /, '').replace(/ belong to\?$/, '');

  return (
    <form
      aria-label="Map the ticket to a project"
      data-testid="mapping-form"
      className="mt-3 flex flex-col gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen) return setErr('Pick the project this ticket belongs to');
        setErr('');
        answer.mutate({
          id: item.id,
          body: {
            answer: chosen.label,
            optionId: chosen.id,
            ledger: { scope: 'decision', title: `${ticket} belongs to ${chosen.label}`.slice(0, 300) },
          },
        });
      }}
    >
      <p className="text-sm text-muted">
        This is a ticket the BA could not map. Choosing a project maps it and tells the BA to carry on
        {item.intakeId && (
          <>
            {' '}
            (
            <Link to={`/intake/${item.intakeId}`} className="underline" data-testid="mapping-intake-link">
              open the intake
            </Link>
            )
          </>
        )}
        .
      </p>
      {item.options.length === 0 ? (
        <p className="text-sm text-subtle">There is no project to map to yet: create one first.</p>
      ) : (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium text-muted">Project</legend>
          {item.options.map((o) => (
            <label
              key={o.id}
              className="flex cursor-pointer items-center gap-2 rounded-control border border-line p-2 text-sm"
            >
              <input
                type="radio"
                name={`mapping-${item.id}`}
                value={o.id}
                checked={optionId === o.id}
                onChange={() => setOptionId(o.id)}
              />
              {o.label}
            </label>
          ))}
        </fieldset>
      )}
      {err && (
        <p role="alert" className="text-sm font-medium text-danger">
          {err}
        </p>
      )}
      <ErrorBox error={answer.error ?? dismiss.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={answer.isPending || item.options.length === 0}>
          Map to project
        </Button>
        <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(item.id)}>
          Dismiss
        </Button>
      </div>
    </form>
  );
}
