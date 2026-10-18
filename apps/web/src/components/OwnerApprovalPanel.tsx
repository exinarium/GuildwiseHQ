import type { ProjectDetailResponse } from '@aom/shared';
import { useSetOwnerApproval } from '../api/queries/projects.ts';
import { Badge, ErrorBox, Panel } from './ui.tsx';

/**
 * Lean team workflow (`code` version 6) settings of a project: when the project owner approves a card after the Opus review.
 * A high-risk change always needs the owner's approval. A project whose workflow has no such step shows nothing.
 */
export function OwnerApprovalPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetOwnerApproval(projectId);
  const policy = project.ownerApprovalPolicy ?? 'large_or_high_risk';
  if (project.leanTeam !== true) return null;
  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Owner approval after the review
        <Badge tone="brand">
          <span data-testid="owner-approval-state">
            {policy === 'always' ? 'Every card' : 'Large and high-risk cards'}
          </span>
        </Badge>
      </h2>
      <p className="mb-3 text-sm text-muted">
        After the Opus review the owner reads the final diff of the reviewed commit and approves it. The
        approval is for that commit: when the code changes, it is asked again. A change to authentication,
        permissions or secrets, data and migrations, or tenancy and billing always needs it; a small low-risk
        card is approved automatically unless you ask for every card.
      </p>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={policy === 'always'}
          disabled={!canChange || set.isPending}
          data-testid="owner-approval-always"
          onChange={(e) => set.mutate(e.target.checked ? 'always' : 'large_or_high_risk')}
        />
        <span>Ask me to approve every card, also small low-risk ones</span>
      </label>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle" data-testid="owner-approval-readonly">
          Only the project Owner and the organization's Owners and Admins can change this setting.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
