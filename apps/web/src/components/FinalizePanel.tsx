import type { CardDetailResponse, CompletionAction } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useFinalizeCard } from '../api/queries/testing.ts';
import { Button, ErrorBox, Panel, Select } from './ui.tsx';

type Testing = NonNullable<CardDetailResponse['testing']>;

const ACTIONS: ReadonlyArray<{ value: CompletionAction; label: string }> = [
  { value: 'pr', label: 'Open a pull request' },
  { value: 'push_branch', label: 'Push the branch' },
  { value: 'merge', label: 'Merge into the base branch' },
];

export function FinalizePanel({
  cardId,
  finalize,
  completionAction,
  canAct,
}: {
  cardId: string;
  finalize: Testing['finalize'];
  completionAction: CompletionAction | null;
  canAct: boolean;
}) {
  const run = useFinalizeCard(cardId);
  const [picked, setPicked] = useState<CompletionAction | null>(null);
  if (!finalize.available && finalize.state === 'idle') return null;
  const action = picked ?? finalize.action ?? completionAction ?? 'pr';
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
            <Select
              label="Completion action"
              value={action}
              onChange={(e) => setPicked(e.target.value as CompletionAction)}
              data-testid="finalize-action"
            >
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
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
            Finalizing: the {action.replace('_', ' ')} is running.
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
