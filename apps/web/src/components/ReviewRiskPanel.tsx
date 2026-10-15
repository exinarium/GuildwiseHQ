import type { ReviewRiskDto } from '@aom/shared';
import { Badge, Panel } from './ui.tsx';

const TONE = { low: 'green', medium: 'amber', high: 'red', unknown: 'neutral' } as const;
const LABEL = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
  unknown: 'Risk not reported',
} as const;

/** The reviewer's risk badge (backlog #70). */
export function RiskBadge({ level }: { level: keyof typeof TONE }) {
  return (
    <Badge tone={TONE[level]} data-testid="risk-badge" title="The reviewer's overall risk of this change">
      {LABEL[level]}
    </Badge>
  );
}

/** The reviewer's risk call on a card: level, what to test by hand and the analysis. Shown from review to done. */
export function ReviewRiskPanel({ risk }: { risk: ReviewRiskDto | null | undefined }) {
  if (!risk || (risk.level === 'unknown' && !risk.analysis)) return null;
  return (
    <Panel>
      <div data-testid="review-risk-panel" data-level={risk.level} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-fg">Reviewer risk analysis</h2>
          <RiskBadge level={risk.level} />
        </div>
        {risk.mergeApprovalReason && (
          <p className="text-sm text-warning-soft-fg" data-testid="risk-merge-reason">
            Merging needs the manager's approval: {risk.mergeApprovalReason}.
          </p>
        )}
        {risk.qaFocus.trim() && (
          <div data-testid="risk-qa-focus">
            <h3 className="text-sm font-medium text-fg">What to test by hand</h3>
            <p className="whitespace-pre-wrap text-sm text-fg">{risk.qaFocus}</p>
          </div>
        )}
        {risk.analysis.trim() && (
          <details open={risk.level === 'high'} data-testid="risk-analysis">
            <summary className="cursor-pointer text-sm font-medium text-fg">
              Analysis (blast radius, failure scenarios, verified, unverified, mitigations)
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{risk.analysis}</p>
          </details>
        )}
      </div>
    </Panel>
  );
}
