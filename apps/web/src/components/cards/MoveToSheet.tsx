import type { WorkflowDefinition } from '@aom/shared';
import { Check } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useWorkflows } from '../../api/queries/agents.ts';
import { useMoveCard } from '../../api/queries/cards.ts';
import { stageStyle } from '../../lib/stages.ts';
import { BottomSheet } from '../ui/BottomSheet.tsx';
import { cx } from '../ui/cx.ts';
import { Button, ErrorBox, Spinner, TextArea, useToast } from '../ui.tsx';

/**
 * "Move to..." as a bottom sheet (phones have no drag and drop). Lists the stages of the card's workflow, asks for the
 * reason (required, like the desktop Move dialog) and posts `POST /cards/:id/move` through `useMoveCard`, so the server
 * applies the same validation as the desktop dialog.
 *
 * Props:
 * - `card`: `{ id, stage, projectId?, workflowKey?, workflowVersion?, ref? }` (a card detail or a board card). `stage`
 *   is the current stage (shown as "Current", not selectable).
 * - `workflow`: the card's workflow definition when the caller has it; otherwise it is loaded from `card.projectId`
 *   and `card.workflowKey` / `card.workflowVersion`.
 * - `open` / `onClose`: visibility. `onClose` is called on dismiss and after a successful move.
 * - `onMoved`: optional, called after a successful move (the card queries are refetched either way).
 */
export function MoveToSheet({
  card,
  workflow,
  open,
  onClose,
  onMoved,
}: {
  card: {
    id: string;
    stage: string;
    ref?: string;
    projectId?: string;
    workflowKey?: string;
    workflowVersion?: number;
  };
  workflow?: WorkflowDefinition | undefined;
  open: boolean;
  onClose: () => void;
  onMoved?: (toStage: string) => void;
}) {
  const move = useMoveCard(card.id);
  const toast = useToast();
  const [toStage, setToStage] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const close = () => {
    setToStage(null);
    setReason('');
    setErr('');
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!toStage) return;
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    move.mutate(
      { toStage, reason: reason.trim() },
      {
        onSuccess: () => {
          const to = toStage;
          close();
          toast.success(`${card.ref ?? 'Card'} moved`);
          onMoved?.(to);
        },
      },
    );
  };
  return (
    <BottomSheet
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Move to..."
      description="Override the workflow and move this card to another stage."
      testId="move-to-sheet"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button
            type="submit"
            form="move-to-form"
            variant="primary"
            size="lg"
            disabled={!toStage || move.isPending}
            loading={move.isPending}
          >
            Move card
          </Button>
        </>
      }
    >
      <WithWorkflow card={card} workflow={workflow}>
        {(resolved) => (
          <form
            id="move-to-form"
            onSubmit={submit}
            className="flex flex-col gap-3"
            noValidate
            aria-label="Move card"
          >
            <ul className="flex flex-col gap-2" aria-label="Target stage">
              {resolved.stages.map((s) => {
                const current = s.id === card.stage;
                const picked = s.id === toStage;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      disabled={current}
                      aria-pressed={picked}
                      data-testid={`move-to-${s.id}`}
                      onClick={() => setToStage(s.id)}
                      className={cx(
                        'flex min-h-12 w-full items-center gap-3 rounded-card border px-3 text-left text-base',
                        picked ? 'border-brand bg-brand-soft' : 'border-control',
                        current && 'opacity-60',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: stageStyle(s.column).color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-fg">{s.label}</span>
                      {current && <span className="text-xs text-subtle">Current</span>}
                      {picked && <Check aria-hidden="true" className="size-4 text-brand-text" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            {toStage && (
              <TextArea
                label="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                error={err}
              />
            )}
            <ErrorBox error={move.error} />
          </form>
        )}
      </WithWorkflow>
    </BottomSheet>
  );
}

/** Uses the workflow the caller passed; only fetches the project's workflows when it did not (no request otherwise). */
function WithWorkflow({
  card,
  workflow,
  children,
}: {
  card: { projectId?: string; workflowKey?: string; workflowVersion?: number };
  workflow: WorkflowDefinition | undefined;
  children: (w: WorkflowDefinition) => ReactNode;
}) {
  if (workflow) return <>{children(workflow)}</>;
  return <Loaded card={card}>{children}</Loaded>;
}

function Loaded({
  card,
  children,
}: {
  card: { projectId?: string; workflowKey?: string; workflowVersion?: number };
  children: (w: WorkflowDefinition) => ReactNode;
}) {
  const workflows = useWorkflows(card.projectId);
  const found = (workflows.data ?? [])
    .map((w) => w.definition)
    .filter((d) => d.key === card.workflowKey)
    .sort((a, b) => b.version - a.version)
    .find((d) => d.version === card.workflowVersion || card.workflowVersion === undefined);
  if (found) return <>{children(found)}</>;
  return workflows.isPending ? (
    <Spinner label="Loading stages" />
  ) : (
    <p className="text-sm text-subtle">The stages of this card's workflow are not available.</p>
  );
}
