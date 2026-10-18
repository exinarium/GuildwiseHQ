import type { ProjectDetailResponse } from '@aom/shared';
import { useSetOwnerApproval, useUpgradeWorkflow } from '../api/queries/projects.ts';
import { Badge, Button, ErrorBox, Panel } from './ui.tsx';

/**
 * Lean team workflow (code-v6) settings of a project: when the project owner approves a card after the Opus review, and the
 * opt-in switch for a project that still runs an older workflow. A high-risk change always needs the owner's approval.
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
  const upgrade = useUpgradeWorkflow(projectId);
  const policy = project.ownerApprovalPolicy ?? 'large_or_high_risk';
  const newWorkflow = project.newCardWorkflowKey ?? project.workflowKey;
  const lean = newWorkflow === 'code-v6';
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
      {!lean && (
        <div className="mt-4 border-t border-line pt-3" data-testid="upgrade-lean">
          <p className="mb-2 text-sm text-muted">
            This project runs the <code>{newWorkflow}</code> workflow. The lean team workflow adds planning, a
            design for every card, a pre-review, a read-only Opus review, the owner approval with the diff, a
            test deploy and area-scoped E2E tests. New cards use it from now on; cards in flight finish as
            they are.
          </p>
          <Button
            variant="secondary"
            loading={upgrade.isPending}
            disabled={!canChange || upgrade.isPending}
            data-testid="upgrade-lean-button"
            onClick={() => upgrade.mutate()}
          >
            Use the lean team workflow for new cards
          </Button>
          <ErrorBox error={upgrade.error} />
        </div>
      )}
      {upgrade.data && (
        <p className="mt-2 text-sm text-muted" data-testid="upgrade-lean-result">
          Done. {upgrade.data.openCardsOnOlderVersion} open card(s) stay on their version.
          {upgrade.data.missingRoles.length > 0
            ? ` Missing roles: ${upgrade.data.missingRoles.join(', ')}.`
            : ''}
          {(upgrade.data.coveredByFallback ?? []).length > 0
            ? ` Covered for now: ${(upgrade.data.coveredByFallback ?? [])
                .map((c) => `${c.role} by the ${c.fallbackRole}`)
                .join(', ')}.`
            : ''}
          {(upgrade.data.uncoveredRoles ?? []).length > 0
            ? ` Hire a ${(upgrade.data.uncoveredRoles ?? []).join(' and a ')}: cards wait at their stage until you do.`
            : ''}
        </p>
      )}
    </Panel>
  );
}
