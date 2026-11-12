import type { ProjectRepoDto } from '@aom/shared';
import { Badge } from './ui.tsx';

/**
 * Whether reviewers can post on a PR-only repository: a workstation must hold a comment-only token. Text only, with no
 * input: the token is never typed into the browser because the server must never carry it. It is set on the workstation
 * (`guildwise-runner reviewer-token set <remote url>`). Plain flow layout, so it wraps on a phone and has nothing to tap.
 */
export function RepoReviewerTokenStatus({ repo }: { repo: ProjectRepoDto }) {
  if (!repo.prOnly || repo.reviewerToken == null) return null;
  const missing = repo.reviewerToken === 'missing';
  return (
    <div className="mt-1 text-xs" data-testid={`repo-reviewer-token-${repo.name}`}>
      <p className="flex flex-wrap items-center gap-2 text-muted">
        <Badge tone={missing ? 'amber' : 'green'}>
          {missing ? 'Reviewer token missing' : 'Reviewer token set'}
        </Badge>
        <span>
          {missing
            ? 'Reviewer token missing: no reviews run on this repository.'
            : 'Reviewer token set on a workstation.'}
        </span>
      </p>
      {missing && (
        <p className="text-subtle">
          DevOps sets a comment-only token on the workstation:{' '}
          <code>guildwise-runner reviewer-token set {'<remote url>'}</code>. The token stays on the
          workstation.
        </p>
      )}
    </div>
  );
}
