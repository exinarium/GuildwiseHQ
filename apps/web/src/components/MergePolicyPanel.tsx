import type { ProjectDetailResponse } from '@aom/shared';
import { useState } from 'react';
import { useSetMergePolicy } from '../api/queries/projects.ts';
import { Badge, Button, ErrorBox, Panel } from './ui.tsx';

const when = (iso: string) => new Date(iso).toLocaleString();

/**
 * "Merge large changes without my approval": the project owner's override of the large-merge desk approval (default
 * off). Only the owner can change it; additional managers see the state read-only. Turning it on asks for a
 * confirmation that spells out what it does, and every change is listed with who made it and when.
 */
export function MergePolicyPanel({
  projectId,
  project,
  history,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  history: ProjectDetailResponse['mergePolicyHistory'];
}) {
  const set = useSetMergePolicy(projectId);
  const [confirming, setConfirming] = useState(false);
  const on = project.mergeLargeWithoutApproval ?? false;
  const isOwner = project.myRole === 'owner';
  const changed = project.mergeLargeChanged;

  return (
    <Panel>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        Large changes
        <Badge tone={on ? 'amber' : 'neutral'}>
          <span data-testid="merge-policy-state">{on ? 'Merge without approval' : 'Approval required'}</span>
        </Badge>
      </h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        Merge large changes without my approval. By default a large change (two reviewers approved it) waits
        for your approval on the desk before it is merged into the working branch.
      </p>
      <p
        role="note"
        data-testid="merge-policy-warning"
        className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
      >
        Warning: when this is on, large changes are merged into the working branch as soon as they are
        finalized, without asking anyone. Only the review, the tests and the full suite that runs afterwards
        stand between a large change and your main branch. Approvals already waiting on the desk are not
        touched; you can still approve them there.
      </p>
      {changed && (
        <p className="mt-2 text-xs text-zinc-500" data-testid="merge-policy-changed">
          {on ? 'Turned on' : 'Turned off'} by {changed.byName} on {when(changed.at)}.
        </p>
      )}
      {isOwner ? (
        <div className="mt-3 flex flex-col gap-2">
          {!on && !confirming && (
            <Button
              className="self-start"
              onClick={() => setConfirming(true)}
              data-testid="merge-policy-enable"
            >
              Merge large changes without my approval
            </Button>
          )}
          {!on && confirming && (
            <div
              role="alertdialog"
              aria-label="Confirm merge without approval"
              className="flex flex-col gap-2"
            >
              <p className="text-sm font-medium">
                Large changes will merge without asking you. Turn this on?
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={set.isPending}
                  data-testid="merge-policy-confirm"
                  onClick={() => set.mutate(true, { onSuccess: () => setConfirming(false) })}
                >
                  Yes, merge without my approval
                </Button>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
              </div>
            </div>
          )}
          {on && (
            <Button
              variant="primary"
              className="self-start"
              disabled={set.isPending}
              data-testid="merge-policy-disable"
              onClick={() => set.mutate(false)}
            >
              Require my approval again
            </Button>
          )}
          <ErrorBox error={set.error} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-zinc-500" data-testid="merge-policy-readonly">
          Only the project owner can change this setting.
        </p>
      )}
      {history.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">History</summary>
          <ul className="mt-1 flex flex-col gap-0.5" data-testid="merge-policy-history">
            {history.map((h) => (
              <li key={`${h.at}-${h.enabled}`}>
                {when(h.at)}: {h.byName} turned merging without approval {h.enabled ? 'on' : 'off'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
