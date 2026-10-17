import type { ApprovalReviewInfo } from '@aom/shared';
import { useState } from 'react';
import { useCardDiff } from '../api/queries/approval.ts';
import { DiffView } from './DiffView.tsx';
import { Badge, Button, ErrorBox, Spinner } from './ui.tsx';

/**
 * What the owner reads before approving in code-v6 (design 5.5): why approval is needed, the commit it is bound to, the
 * builder's evidence, the review verdicts and the final diff (unified, per-file collapse). The approval is for this
 * commit: when the branch moves, the card asks again.
 */
export function ApprovalReview({
  cardId,
  review,
  defaultOpen = false,
}: {
  cardId: string;
  review: ApprovalReviewInfo;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const diff = useCardDiff(cardId, open && !!review.diff, review.sha);
  const short = review.sha ? review.sha.slice(0, 10) : null;
  return (
    <div className="flex flex-col gap-3" data-testid="approval-review">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {short && (
          <Badge tone="neutral" title={review.sha ?? undefined} data-testid="approval-sha">
            commit {short}
          </Badge>
        )}
        {review.highRisk && (
          <Badge tone="danger" data-testid="approval-high-risk">
            High risk
          </Badge>
        )}
        {review.riskTier && <Badge tone="neutral">{review.riskTier} change</Badge>}
        {review.stale && (
          <Badge tone="warning" data-testid="approval-stale">
            The code changed since this was shown
          </Badge>
        )}
      </div>
      {review.reason && (
        <p className="text-sm text-muted" data-testid="approval-reason">
          You are asked because {review.reason}.
        </p>
      )}
      {review.highRisk && review.highRiskPaths.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-fg">
            High-risk paths ({review.highRiskPaths.length})
          </summary>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs text-muted">
            {review.highRiskPaths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      {review.cardBrief && (
        <details className="text-sm">
          <summary className="cursor-pointer text-fg">Card Brief</summary>
          <p className="mt-1 whitespace-pre-wrap text-muted">{review.cardBrief}</p>
        </details>
      )}
      {review.designSummary && (
        <details className="text-sm">
          <summary className="cursor-pointer text-fg">Design note</summary>
          <p className="mt-1 whitespace-pre-wrap text-muted">{review.designSummary}</p>
        </details>
      )}
      {review.evidence && (
        <details className="text-sm" data-testid="approval-evidence">
          <summary className="cursor-pointer text-fg">Build and unit test evidence</summary>
          <ul className="mt-1 flex flex-col gap-1 text-muted">
            {review.evidence.commands.map((c) => (
              <li key={`${c.kind}-${c.command}`}>
                <span className="font-medium text-fg">{c.kind}</span>{' '}
                <code className="text-xs">{c.command}</code> {c.status}
                {c.result ? `: ${c.result}` : ''}
              </li>
            ))}
            {review.evidence.waived && <li>No build or tests, because: {review.evidence.waived}</li>}
          </ul>
        </details>
      )}
      {review.verdicts.length > 0 && (
        <div className="flex flex-col gap-1 text-sm" data-testid="approval-verdicts">
          <span className="font-medium text-fg">Review verdict{review.verdicts.length === 1 ? '' : 's'}</span>
          {review.verdicts.map((v, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the verdicts are a fixed list; one reviewer can approve twice
            <p key={`${v.reviewerName}-${i}`} className="text-muted">
              <span className="text-fg">{v.reviewerName}</span> approved (score {v.score}
              {v.risk ? `, risk ${v.risk}` : ''}){v.comments ? `: ${v.comments}` : ''}
            </p>
          ))}
        </div>
      )}
      {review.diff ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setOpen((o) => !o)} data-testid="approval-diff-toggle">
              {open
                ? 'Hide the diff'
                : `Show the diff (${review.diff.files} file${review.diff.files === 1 ? '' : 's'})`}
            </Button>
          </div>
          {open && diff.isLoading && <Spinner label="Loading the diff" />}
          {open && diff.error && <ErrorBox error={diff.error} onRetry={() => void diff.refetch()} />}
          {open && diff.data && <DiffView diff={diff.data.body} truncated={diff.data.truncated} />}
        </div>
      ) : (
        <p className="text-sm text-subtle" data-testid="approval-no-diff">
          No diff was stored for this card: open the branch on the git host.
        </p>
      )}
    </div>
  );
}
