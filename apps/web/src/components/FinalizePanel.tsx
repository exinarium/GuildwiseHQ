import {
  type CardDetailResponse,
  COMPLETION_ACTION_LABELS,
  CompletionAction,
  type StoredCompletionAction,
} from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useFinalizeCard } from '../api/queries/testing.ts';
import { useExpertMode } from '../lib/expert-mode.ts';
import { Button, ErrorBox, Panel, Select } from './ui.tsx';

type Testing = NonNullable<CardDetailResponse['testing']>;

const ACTIONS: ReadonlyArray<{ value: CompletionAction; label: string }> = CompletionAction.options.map(
  (value) => ({ value, label: COMPLETION_ACTION_LABELS[value].label }),
);

export function FinalizePanel({
  cardId,
  finalize,
  completionAction,
  canAct,
}: {
  cardId: string;
  finalize: Testing['finalize'];
  completionAction: StoredCompletionAction | null;
  canAct: boolean;
}) {
  const run = useFinalizeCard(cardId);
  const expert = useExpertMode();
  const [picked, setPicked] = useState<CompletionAction | null>(null);
  if (!finalize.available && finalize.state === 'idle') return null;
  // `push_branch` is retired: a card that still shows it is finalized like the default.
  const live = (a: StoredCompletionAction | null | undefined): CompletionAction | null =>
    a === 'push_branch' ? null : (a ?? null);
  const action: CompletionAction = picked ?? live(finalize.action) ?? live(completionAction) ?? 'pr';
  const needsApproval = finalize.requiresApproval && action === 'merge';
  const deskItemId = run.data?.deskItemId ?? finalize.deskItemId;
  const state = run.data?.state ?? finalize.state;
  return (
    <Panel>
      <div data-testid="finalize-panel" data-state={state}>
        <h2 className="mb-3 text-lg font-semibold text-fg">Finalize</h2>
        {finalize.available && canAct && (
          <p className="mb-2 text-xs text-subtle" data-testid="finalize-override-note">
            A BA, if you have one, finalizes cards waiting here by itself; this is your override.
          </p>
        )}
        {finalize.available && canAct && (
          <div className="flex flex-col gap-2">
            {expert ? (
              <Select
                label="Completion action"
                value={action}
                onChange={(e) => setPicked(e.target.value as CompletionAction)}
                data-testid="finalize-action"
                hint={COMPLETION_ACTION_LABELS[action].description}
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm text-fg" data-testid="finalize-plain-action">
                {action === 'pr'
                  ? 'This change will arrive as a pull request for you to merge.'
                  : 'This change will go straight into main.'}
              </p>
            )}
            {needsApproval && (
              <p data-testid="finalize-approval-note" className="text-sm text-warning-soft-fg">
                Large change: merging needs your approval on the desk first.{' '}
                <Link to="/desk" className="underline">
                  Open the desk
                </Link>
              </p>
            )}
            <Button
              variant="primary"
              data-testid="finalize-button"
              className="self-start"
              disabled={run.isPending}
              onClick={() => run.mutate({ action })}
            >
              Finalize
            </Button>
          </div>
        )}
        <ErrorBox error={run.error} />
        {state === 'awaiting_approval' && (
          <p data-testid="finalize-state" className="mt-2 text-sm">
            Awaiting your approval of the merge on the{' '}
            <Link to={deskItemId ? `/desk#desk-item-${deskItemId}` : '/desk'} className="underline">
              desk
            </Link>
            .
          </p>
        )}
        {state === 'running' && (
          <p data-testid="finalize-state" className="mt-2 text-sm">
            {expert
              ? `Finalizing: the ${action.replace('_', ' ')} is running.`
              : 'Finalizing: your change is on its way.'}
          </p>
        )}
        {state === 'failed' && (
          <p data-testid="finalize-state" role="alert" className="mt-2 text-sm text-danger">
            Finalize failed{finalize.lastError ? `: ${finalize.lastError}` : '.'} Fix the cause and press
            Finalize again.
          </p>
        )}
      </div>
    </Panel>
  );
}
