import type { CardDto, WorkflowDefinition } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { usePatchCard } from '../api/queries/cards.ts';
import { useProject } from '../api/queries/projects.ts';
import { buildPatchRequest, type CardFormValues, formValuesFromCard } from '../lib/cardForm.ts';
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
