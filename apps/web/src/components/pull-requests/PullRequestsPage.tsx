import {
  PR_REVIEWER_LABEL,
  type PrReviewDto,
  type PrReviewQueueDto,
  type PrReviewQueueItem,
} from '@aom/shared';
import { GitPullRequest } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePrReviewQueue, usePullRequests, useTriggerPrReview } from '../../api/queries/pr-reviews.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { ProjectTabs } from '../ProjectTabs.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
} from '../ui.tsx';
import { HeldBackFindings } from './HeldBackFindings.tsx';
import { PostedFindings } from './PostedFindings.tsx';
import { ReviewerPrecisionPanel } from './ReviewerPrecisionPanel.tsx';

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
        Reviewed {when(pr.reviewedAt)}
        {pr.reviewersHidden
          ? ' · reviewer shown once every posted finding is marked'
          : ` by ${PR_REVIEWER_LABEL[(pr.reviewer ?? '') as 'first'] ?? 'the reviewer'}`}
        {run?.durationMs != null && ` · run took ${fmtRunTime(run.durationMs)}`}
        {run && (run.heldBackCount ?? 0) > 0
          ? ` · Posted ${(run.findingsCount ?? 0) - (run.heldBackCount ?? 0)} of ${run.findingsCount} findings: ${
              run.changedLines == null
                ? 'the limit is 5'
                : `${run.changedLines} changed lines allow ${run.findingsCap}`
            } (1 per 100 lines, at most 5)`
          : run && ` · ${run.postedCount} comment${run.postedCount === 1 ? '' : 's'}`}
        {run?.reviewUrl && (
          <>
            {' · '}
            <a
              href={run.reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center text-brand-text underline"
            >
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
  if (pr.queueSlot === 'later' && pr.queuePosition)
    return (
      <p data-testid={`pr-review-detail-${pr.changeId}`}>
        Not reviewed · queued #{pr.queuePosition} (waits for a following day)
      </p>
    );
  return <p data-testid={`pr-review-detail-${pr.changeId}`}>Waiting for a review</p>;
}

function Row({ pr, projectId }: { pr: PrReviewDto; projectId: string }) {
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
      {((pr.lastRun?.postedCount ?? 0) > 0 || (pr.unmarkedCount ?? 0) > 0) && (
        <div className="text-xs">
          <PostedFindings
            prReviewId={pr.id}
            projectId={projectId}
            count={Math.max(pr.lastRun?.postedCount ?? 0, pr.unmarkedCount ?? 0)}
            unmarked={pr.unmarkedCount ?? 0}
          />
        </div>
      )}
      {(pr.lastRun?.heldBackCount ?? 0) > 0 && (
        <div className="text-xs">
          <HeldBackFindings prReviewId={pr.id} count={pr.lastRun?.heldBackCount ?? 0} />
        </div>
      )}
    </li>
  );
}

const BLOCKED_TEXT: Record<string, string> = {
  reviewer_token_missing: 'no reviewer token on any workstation',
  runner_outdated: 'the runner needs an update',
  workstation_offline: 'no reviewer workstation is online',
};

const slotText = (i: PrReviewQueueItem): string =>
  i.slot === 'today'
    ? 'Today'
    : i.slot === 'later'
      ? 'Waits for a following day'
      : `Blocked: ${BLOCKED_TEXT[i.blockedReason ?? ''] ?? 'no reviewer is ready'}`;

/** Today's used count of the daily cap. Text only; nothing needs hover. */
function CapStrip({ q }: { q: PrReviewQueueDto }) {
  const usedUp = q.used >= q.cap;
  return (
    <div className="mb-4 space-y-2 text-sm" data-testid="pr-review-cap">
      <p>
        Automatic reviews today:{' '}
        <strong data-testid="pr-review-used">
          {q.used}/{q.cap}
        </strong>
        {q.manualToday > 0 && ` + ${q.manualToday} started by hand (not counted)`}
      </p>
      <p className="text-xs text-muted">Resets at midnight ({q.timeZone})</p>
      {usedUp && (
        <Callout tone="info" role="status">
          Today's {q.cap} automatic reviews are used up. New pull requests wait in the queue and are reviewed
          from tomorrow, oldest first. You can still review one now by hand.
        </Callout>
      )}
    </div>
  );
}

/** The waiting pull requests in run order, each with its slot; the owner can review one now. */
function Queue({ q, projectId, isOwner }: { q: PrReviewQueueDto; projectId: string; isOwner: boolean }) {
  const trigger = useTriggerPrReview(projectId);
  const [confirm, setConfirm] = useState<PrReviewQueueItem | null>(null);
  return (
    <section className="mb-4" aria-labelledby="pr-queue-heading" data-testid="pr-review-queue">
      <h2 id="pr-queue-heading" className="text-base font-semibold text-fg">
        Queue
      </h2>
      <p className="mb-2 text-xs text-muted">
        Oldest first; pull requests opened the same day run smallest first.
      </p>
      {q.items.length === 0 ? (
        <p className="text-sm text-muted">No pull requests waiting.</p>
      ) : (
        <ol className="space-y-2">
          {q.items.map((i) => (
            <li
              key={i.prReviewId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-border p-3 text-sm"
              data-testid={`pr-review-queue-item-${i.changeId}`}
            >
              <span className="font-medium">{i.position}</span>
              <a
                href={i.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 min-w-0 items-center break-words text-brand-text hover:underline"
              >
                {i.title}
              </a>
              <span className="text-xs text-muted">
                {i.repoName} · opened {i.openedDay} ·{' '}
                {i.changedLines === null ? 'size unknown' : `${i.changedLines} lines changed`}
              </span>
              <Badge tone={i.slot === 'blocked' ? 'amber' : 'neutral'}>{slotText(i)}</Badge>
              {isOwner && (
                <Button
                  className="min-h-11"
                  disabled={trigger.isPending}
                  onClick={() => setConfirm(i)}
                  data-testid={`pr-review-now-${i.changeId}`}
                >
                  Review now
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      <ErrorBox error={trigger.error} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Review now?"
        description="This review is not counted toward the daily cap and adds to today's spend. Review now?"
        confirmLabel="Review now"
        pending={trigger.isPending}
        onConfirm={() => {
          if (confirm) trigger.mutate(confirm.prReviewId, { onSettled: () => setConfirm(null) });
        }}
      />
    </section>
  );
}

/** The recorded pull requests of a PR-only project and what the reviewer did with each. Read-only; nothing to type. */
export function PullRequests() {
  const { projectKey = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.key === projectKey);
  const list = usePullRequests(project?.id);
  const queue = usePrReviewQueue(project?.id);
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
      <p className="mb-2">
        <Link
          to={`/p/${project.key}/pull-requests/replay`}
          className="inline-flex min-h-11 items-center text-brand-text underline"
          data-testid="replay-link"
        >
          20-PR replay
        </Link>
      </p>
      <ReviewerPrecisionPanel projectId={project.id} />
      {queue.data?.items && <CapStrip q={queue.data} />}
      {queue.data?.items && (
        <Queue q={queue.data} projectId={project.id} isOwner={project.myRole === 'owner'} />
      )}
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
            <Row key={pr.id} pr={pr} projectId={project.id} />
          ))}
        </ul>
      )}
    </div>
  );
}
