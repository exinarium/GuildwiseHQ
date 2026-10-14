import type { ProjectDetailResponse } from '@aom/shared';
import { useSetManualQa } from '../api/queries/projects.ts';
import { Badge, ErrorBox, Panel } from './ui.tsx';

/**
 * "Manual QA before a card is done": whether the person who started a card tests it after Finalize. On by default;
 * the project Owner and organization Owners/Admins change it (docs/design/manual-qa.md).
 */
export function ManualQaPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetManualQa(projectId);
  const on = project.manualQa ?? true;

  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Manual QA before done
        <Badge tone={on ? 'brand' : 'neutral'}>
          <span data-testid="manual-qa-state">{on ? 'On' : 'Off'}</span>
        </Badge>
      </h2>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={!canChange || set.isPending}
          data-testid="manual-qa-toggle"
          onChange={(e) => set.mutate(e.target.checked)}
        />
        <span>The person who started a card tests it after it is finalized</span>
      </label>
      <p className="mt-2 text-sm text-muted">
        When this is on, a finalized card goes to the person who started it (the intake chat, the batch or the
        card itself) with test steps written by an agent. They pass it, skip the test, send it back with a
        comment, or hand it to someone else. The update on the ticket is held until the card passes or the
        test is skipped, and the card moves to Done after that. A failed test sends the card back to rework:
        you never have to reopen a closed card. Turning this off only affects cards that have not been
        finalized yet.
      </p>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle" data-testid="manual-qa-readonly">
          Only the project Owner and the organization's Owners and Admins can change this setting.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
