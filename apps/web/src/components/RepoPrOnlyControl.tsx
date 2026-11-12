import type { ProjectRepoDto, PrReviewProblem } from '@aom/shared';
import { useSetRepoPrOnly } from '../api/queries/forges.ts';
import { Badge, ErrorBox } from './ui.tsx';

const PROBLEM_TEXT: Record<PrReviewProblem, string> = {
  no_clone: 'No workstation has a clone of this repository yet.',
  old_runner: 'The runner on the workstation with the clone needs an update.',
  unsupported: 'PR-only review is not available for this git host yet.',
  not_connected: 'The workstation is not signed in to the git host.',
  error: 'The open pull requests could not be listed.',
};

/**
 * PR-only review for one repository: its open pull requests are recorded for review and no card is started for them.
 * Only the project owner can switch it. A plain labelled checkbox: the whole row is the touch target and nothing needs
 * typing, so it works the same with a mouse, a keyboard or a finger.
 */
export function RepoPrOnlyControl({
  projectId,
  repo,
  isOwner,
}: {
  projectId: string;
  repo: ProjectRepoDto;
  isOwner: boolean;
}) {
  const set = useSetRepoPrOnly(projectId);
  const on = repo.prOnly ?? false;
  const status = repo.prReview ?? null;
  const inputId = `repo-pr-only-input-${repo.id}`;

  return (
    <div className="mt-2 text-sm">
      <label htmlFor={inputId} className="flex min-h-11 cursor-pointer items-center gap-3 text-fg">
        <input
          id={inputId}
          type="checkbox"
          className="size-5 shrink-0"
          checked={on}
          disabled={!isOwner || set.isPending}
          data-testid={`repo-pr-only-${repo.name}`}
          onChange={(e) => set.mutate({ repoId: repo.id, prOnly: e.target.checked })}
        />
        <span className="text-xs font-medium text-subtle">PR-only review</span>
        <Badge tone={on ? 'green' : 'neutral'} data-testid={`repo-pr-only-state-${repo.name}`}>
          {on ? 'On' : 'Off'}
        </Badge>
      </label>
      {on && status && (
        <p className="text-xs text-muted" data-testid={`repo-pr-only-status-${repo.name}`}>
          {status.problem
            ? PROBLEM_TEXT[status.problem]
            : `${status.waiting} pull ${status.waiting === 1 ? 'request' : 'requests'} waiting for review.`}
          {status.checkedAt ? ` Last checked ${new Date(status.checkedAt).toLocaleString()}.` : ''}
        </p>
      )}
      <p className="text-xs text-subtle">
        Open pull requests are recorded for review; no card is started for them. Pull requests opened before
        you turned this on are not picked up.
      </p>
      {!isOwner && <p className="text-xs text-subtle">Only the project owner can change this.</p>}
      {set.error && <ErrorBox error={set.error} />}
    </div>
  );
}
