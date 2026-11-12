import type { PrReviewDto } from '@aom/shared';
import { GitPullRequest } from 'lucide-react';
import { useParams } from 'react-router';
import { usePullRequests } from '../api/queries/pr-reviews.ts';
import { useProjects } from '../api/queries/projects.ts';
import { ProjectTabs } from '../components/ProjectTabs.tsx';
import { Badge, Callout, EmptyState, ErrorBox, ListSkeleton, PageHeader } from '../components/ui.tsx';

const REVIEWER_LABEL: Record<string, string> = { first: 'Sonnet reviewer' };

/** "3 min 12 s", "45 s". */
export function fmtRunTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const when = (iso: string): string => new Date(iso).toLocaleString();

/** What happened to the review of one pull request, in words. Never colour alone: every state has its own text. */
function Detail({ pr }: { pr: PrReviewDto }) {
  const run = pr.lastRun;
  if (pr.state === 'reviewed' && pr.reviewedAt) {
    return (
      <p data-testid={`pr-review-detail-${pr.changeId}`}>
        Reviewed {when(pr.reviewedAt)} by {REVIEWER_LABEL[pr.reviewer ?? ''] ?? 'the reviewer'}
        {run?.durationMs != null && ` · run took ${fmtRunTime(run.durationMs)}`}
        {run && ` · ${run.postedCount} comment${run.postedCount === 1 ? '' : 's'}`}
        {run?.reviewUrl && (
          <>
            {' · '}
            <a href={run.reviewUrl} target="_blank" rel="noreferrer" className="text-brand-text underline">
              View on GitHub
            </a>
          </>
        )}
      </p>
    );
  }
  if (run?.state === 'running' || run?.state === 'completed')
    return (
      <p data-testid={`pr-review-detail-${pr.changeId}`}>
        {run.state === 'running'
          ? `Review running, started ${when(run.startedAt)} (stops after ${Math.round(run.timeoutMs / 60_000)} min)`
          : 'Review finished, posting the comments'}
      </p>
    );
  if (run?.state === 'timed_out')
    return (
      <Callout tone="warning" data-testid={`pr-review-timeout-${pr.changeId}`} role="status">
        Not reviewed: the review run timed out after {Math.round(run.timeoutMs / 60_000)} minutes. No comments
        were posted.
      </Callout>
    );
  if (run?.state === 'failed')
    return (
      <Callout tone="danger" role="alert" data-testid={`pr-review-error-${pr.changeId}`}>
        <p>
          Not reviewed: the review{' '}
          {run.code && ['forbidden', 'not_found', 'stale_head', 'unreachable'].includes(run.code)
            ? 'could not be posted'
            : 'run failed'}
          . No comments were posted.
        </p>
        {run.error && <p className="break-words">{run.error}</p>}
      </Callout>
    );
  if (pr.reviewerToken === 'missing')
    return (
      <p data-testid={`pr-review-detail-${pr.changeId}`}>
        Reviewer token missing: no review runs until a workstation has one.
      </p>
    );
  return <p data-testid={`pr-review-detail-${pr.changeId}`}>Waiting for a review</p>;
}

function Row({ pr }: { pr: PrReviewDto }) {
  const attention = pr.lastRun?.state === 'timed_out' || pr.lastRun?.state === 'failed';
  return (
    <li
      className="space-y-2 rounded-control border border-border p-3 text-sm"
      data-testid={`pr-review-${pr.changeId}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 min-w-0 items-center break-words font-medium text-brand-text hover:underline"
        >
          {pr.title}
        </a>
        <Badge
          tone={pr.state === 'reviewed' ? 'green' : 'neutral'}
          data-testid={`pr-review-state-${pr.changeId}`}
        >
          {pr.state === 'reviewed' ? 'Reviewed' : 'Not reviewed'}
        </Badge>
        {attention && <Badge tone="amber">Needs attention</Badge>}
      </div>
      <p className="text-xs text-muted">
        #{pr.changeId} · {pr.repoName}
        {pr.author ? ` · ${pr.author}` : ''} · opened {when(pr.openedAt)}
      </p>
      <div className="text-xs text-muted">
        <Detail pr={pr} />
      </div>
    </li>
  );
}

/** The recorded pull requests of a PR-only project and what the reviewer did with each. Read-only; nothing to type. */
export function PullRequests() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const list = usePullRequests(project?.id);
  if (projects.isPending) return <PageHeader title="Pull requests" />;
  if (!project)
    return (
      <>
        <PageHeader title="Pull requests" />
        <EmptyState
          icon={GitPullRequest}
          tone="warning"
          title="That project does not exist or you do not have access"
          description={`Nothing is called ${projectKey}.`}
        />
      </>
    );
  const items = list.data?.pullRequests ?? [];
  return (
    <div>
      <PageHeader
        title={project.name}
        documentTitle={`${project.name} pull requests`}
        sub="Pull requests of PR-only repositories and their review."
      />
      <ProjectTabs projectKey={project.key} projectId={project.id} active="pull-requests" />
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No pull requests recorded yet"
          description="Open pull requests of a PR-only repository appear here once they are seen."
        />
      ) : (
        <ul className="space-y-3" aria-label="Pull requests">
          {items.map((pr) => (
            <Row key={pr.id} pr={pr} />
          ))}
        </ul>
      )}
    </div>
  );
}
