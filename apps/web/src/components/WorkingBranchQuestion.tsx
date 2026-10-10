import type { DeskItemDto } from '@aom/shared';
import { WORKING_BRANCH_OTHER_OPTION } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useAnswerDeskItem, useDismissDeskItem } from '../api/queries/desk.ts';
import { defaultOption } from '../lib/desk.ts';
import { useExpertMode } from '../lib/expert-mode.ts';
import { Badge, Button, ErrorBox, TextInput } from './ui.tsx';

/**
 * The DevOps engineer asks which branch is the working branch of a repository (desk item `working_branch`): the
 * repository's branches, "keep" when one is set, and "another branch" (type the name). Answering stores the branch on
 * the repository and writes a ledger entry, so later runs do not ask again.
 */
export function WorkingBranchQuestion({ item }: { item: DeskItemDto }) {
  const expert = useExpertMode();
  const answer = useAnswerDeskItem();
  const dismiss = useDismissDeskItem();
  const [optionId, setOptionId] = useState<string | null>(defaultOption(item));
  const [other, setOther] = useState('');
  const [err, setErr] = useState('');
  const isOther = optionId === WORKING_BRANCH_OTHER_OPTION;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!optionId) return setErr('Choose a branch, or choose another branch and name it');
    if (isOther && !other.trim()) return setErr('Type the name of the branch');
    setErr('');
    const label = item.options.find((o) => o.id === optionId)?.label ?? optionId;
    answer.mutate({
      id: item.id,
      body: {
        answer: isOther ? other.trim() : label,
        optionId,
        ledger: { scope: 'decision' },
      },
    });
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Working branch"
      className="mt-3 flex flex-col gap-3"
      noValidate
      data-testid="working-branch-question"
    >
      {!expert && (
        <p className="text-sm text-muted">
          Guildwise could not tell on its own where finished work should go. Pick the main line of this
          repository (usually the first choice); agents will deliver into it.
        </p>
      )}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-xs font-medium text-muted">
          {expert ? 'Working branch' : 'Where finished work goes'}
        </legend>
        {item.options.map((o) => (
          <label
            key={o.id}
            className="flex cursor-pointer items-start gap-2 rounded-control border border-line p-2 text-sm"
          >
            <input
              type="radio"
              name={`branch-${item.id}`}
              value={o.id}
              checked={optionId === o.id}
              onChange={() => setOptionId(o.id)}
              className="mt-0.5"
            />
            <span className="flex-1">
              {o.label}
              {o.description && <span className="block text-xs text-subtle">{o.description}</span>}
            </span>
            {item.recommendation === o.id && <Badge tone="green">Recommended</Badge>}
          </label>
        ))}
      </fieldset>
      {isOther && (
        <TextInput
          label="Branch name"
          placeholder="e.g. develop"
          value={other}
          onChange={(e) => setOther(e.target.value)}
        />
      )}
      {err && (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
      )}
      <ErrorBox error={answer.error ?? dismiss.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={answer.isPending}>
          Set working branch
        </Button>
        <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(item.id)}>
          Dismiss
        </Button>
      </div>
    </form>
  );
}
