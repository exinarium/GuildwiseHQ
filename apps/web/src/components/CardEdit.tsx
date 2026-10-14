import {
  COMPLETION_ACTION_LABELS,
  type CardDto,
  CompletionAction,
  type WorkflowDefinition,
} from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { usePatchCard } from '../api/queries/cards.ts';
import { useProject } from '../api/queries/projects.ts';
import { buildPatchRequest, type CardFormValues, formValuesFromCard } from '../lib/cardForm.ts';
import { PRIORITY_LEVELS, priorityLevel } from '../lib/priority.ts';
import { CardFormFields } from './CardFormFields.tsx';
import { Button, Dialog, ErrorBox, Select, TextArea } from './ui.tsx';

/** A refusal from the server, in words for the dialog (claimed card, wrong state, validation). */
function refusalText(e: unknown): string | null {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : null;
}

/** Mounted only while open (its form state starts fresh each time). Edit a draft or a queued, unclaimed card: the same fields and validation as the New card form. */
export function EditCardDialog({
  open,
  onOpenChange,
  card,
  workflow,
  mockUi,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  card: CardDto;
  workflow: WorkflowDefinition;
  mockUi: boolean;
}) {
  const patch = usePatchCard(card.id);
  const project = useProject(card.projectId);
  const repos = (project.data?.repos ?? []).filter((r) => !r.removedAt);
  const designDefault = project.data?.project.designStep ?? false;
  const [v, setV] = useState<CardFormValues>(() => formValuesFromCard(workflow, card, mockUi));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = buildPatchRequest(workflow, v, card, mockUi, designDefault);
    setErrors(r.errors);
    if (Object.keys(r.errors).length) return;
    patch.mutate(r.patch, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${card.ref}`}
      description="Change the card while it is a draft or waiting in a queue. The edit shows in the timeline."
    >
      <form onSubmit={submit} noValidate aria-label="Edit card" className="flex flex-col gap-3">
        <CardFormFields
          workflow={workflow}
          values={v}
          onChange={setV}
          errors={errors}
          repos={repos}
          mockUi={mockUi}
          designDefault={designDefault}
          projectDefault={project.data?.project.defaultCompletion}
        />
        {Object.keys(errors).length > 0 && (
          <p role="alert" className="text-sm font-medium text-danger">
            Fix the highlighted fields.
          </p>
        )}
        {patch.error && (
          <p role="alert" data-testid="edit-refused" className="text-sm font-medium text-danger">
            {refusalText(patch.error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="submit" variant="primary" disabled={patch.isPending}>
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Override the computed risk tier (or go back to the computed one), with a reason that lands in the timeline. */
export function RiskTierDialog({
  open,
  onOpenChange,
  card,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  card: CardDto;
}) {
  const patch = usePatchCard(card.id);
  const [tier, setTier] = useState<string>(card.riskTier ?? 'small');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    patch.mutate(
      { riskTier: tier === 'computed' ? null : (tier as 'small' | 'large'), reason: reason.trim() },
      {
        onSuccess: () => {
          setReason('');
          onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Risk tier"
      description="The risk tier is computed from the diff. Override it when it is wrong: it sets how many reviewers must approve and whether a merge needs your approval."
    >
      <form onSubmit={submit} noValidate aria-label="Risk tier" className="flex flex-col gap-3">
        <Select label="Risk tier" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="small">small (one reviewer, merges without approval)</option>
          <option value="large">large (two reviewers, a merge waits for your approval)</option>
          {card.riskTierOverridden && <option value="computed">Back to computed from the diff</option>}
        </Select>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
        <ErrorBox error={patch.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="submit" variant="primary" disabled={patch.isPending}>
            Set risk tier
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const SELECT_CLASS =
  'mt-1 h-9 w-full rounded-control border border-control bg-surface px-2 text-sm text-fg disabled:opacity-60';

/** Priority of an open card, changed in place at any time (also while the card is claimed): picked up in the new order. */
export function PriorityControl({ card }: { card: CardDto }) {
  const patch = usePatchCard(card.id);
  return (
    <div>
      <dt className="text-xs font-medium text-subtle">
        <label htmlFor={`priority-${card.id}`}>Priority</label>
      </dt>
      <dd className="text-fg">
        <select
          id={`priority-${card.id}`}
          data-testid="card-priority"
          className={SELECT_CLASS}
          value={priorityLevel(card.priority).value}
          disabled={patch.isPending}
          onChange={(e) => patch.mutate({ priority: Number(e.target.value) })}
        >
          {PRIORITY_LEVELS.map((l) => (
            <option key={l.key} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
        {patch.error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {refusalText(patch.error)}
          </p>
        )}
      </dd>
    </div>
  );
}

/** Completion action of an open card, changed in place; the value in effect at the next finalise is the one that counts. */
export function CompletionControl({ card }: { card: CardDto }) {
  const patch = usePatchCard(card.id);
  const project = useProject(card.projectId);
  const projectDefault = project.data?.project.defaultCompletion;
  return (
    <div>
      <dt className="text-xs font-medium text-subtle">
        <label htmlFor={`completion-${card.id}`}>Completion action</label>
      </dt>
      <dd className="text-fg">
        <select
          id={`completion-${card.id}`}
          data-testid="card-completion"
          className={SELECT_CLASS}
          value={card.completionAction ?? ''}
          disabled={patch.isPending}
          onChange={(e) =>
            patch.mutate({
              completionAction: e.target.value === '' ? null : (e.target.value as CompletionAction),
            })
          }
        >
          <option value="">
            {projectDefault
              ? `Project default (${COMPLETION_ACTION_LABELS[projectDefault].label})`
              : 'Project default'}
          </option>
          {CompletionAction.options.map((a) => (
            <option key={a} value={a}>
              {COMPLETION_ACTION_LABELS[a].label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-subtle" data-testid="completion-hint">
          Applies to the next finalise.
        </span>
        {patch.error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {refusalText(patch.error)}
          </p>
        )}
      </dd>
    </div>
  );
}
