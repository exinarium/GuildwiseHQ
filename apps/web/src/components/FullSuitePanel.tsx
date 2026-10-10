import type { ProjectDetailResponse } from '@aom/shared';
import { useSetFullSuite } from '../api/queries/projects.ts';
import { Badge, ErrorBox, Panel } from './ui.tsx';

/**
 * "Run the full end-to-end test suite after each finished card": whether finalizing a card automatically starts a
 * "Full E2E suite after ..." regression card. On by default; the project Owner and organization Owners/Admins change it.
 */
export function FullSuitePanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetFullSuite(projectId);
  const on = project.fullSuiteAfterFinalize ?? true;

  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Full test run after each card
        <Badge tone={on ? 'brand' : 'neutral'}>
          <span data-testid="full-suite-state">{on ? 'On' : 'Off'}</span>
        </Badge>
      </h2>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={!canChange || set.isPending}
          data-testid="full-suite-toggle"
          onChange={(e) => set.mutate(e.target.checked)}
        />
        <span>Run the full end-to-end test suite after each finished card</span>
      </label>
      <p className="mt-2 text-sm text-muted">
        When this is on, every card that is finalized starts a "Full E2E suite" card that checks the whole
        project again. Turn it off if you do not want these extra cards; the usual testing of each card itself
        is not affected.
      </p>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle" data-testid="full-suite-readonly">
          Only the project Owner and the organization's Owners and Admins can change this setting.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
