import type { ProjectDetailResponse } from '@aom/shared';
import { useState } from 'react';
import { useRunFullSuite, useSetFullSuite } from '../api/queries/projects.ts';
import { Badge, Button, ErrorBox, Panel } from './ui.tsx';

/**
 * "Run the full end-to-end test suite after each finished card": whether finalizing a card automatically starts a
 * "Full E2E suite after ..." regression card. On by default; the project Owner and organization Owners/Admins change it.
 */
export function FullSuitePanel({
  projectId,
  project,
  canChange,
  repos = [],
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
  /** The project's active repositories: with more than one, the run asks which one. */
  repos?: Array<{ id: string; name: string; workingBranch: string | null }>;
}) {
  const [repoId, setRepoId] = useState('');
  const chosen = repos.find((r) => r.id === repoId) ?? repos[0];
  const set = useSetFullSuite(projectId);
  const run = useRunFullSuite(projectId);
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
      {/* The lean team workflow (lean team) turns the automatic run off: the full suite is a manual regression run. */}
      <div className="mt-4 border-t border-line pt-3">
        <p className="mb-2 text-sm text-muted">
          Run the whole suite now, for example after several cards are merged. It takes 10 to 20 minutes and
          starts one "Full E2E suite" card for a tester.
        </p>
        {repos.length > 1 && (
          <label className="mb-2 flex items-center gap-2 text-sm text-fg">
            Repository
            <select
              className="rounded border border-line bg-surface px-2 py-1"
              data-testid="full-suite-repo"
              value={chosen?.id ?? ''}
              onChange={(e) => setRepoId(e.target.value)}
            >
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.workingBranch ?? 'no working branch yet'})
                </option>
              ))}
            </select>
          </label>
        )}
        <Button
          variant="secondary"
          loading={run.isPending}
          disabled={run.isPending}
          data-testid="full-suite-run"
          onClick={() => run.mutate(repos.length > 1 ? chosen?.id : undefined)}
        >
          Run the full suite now
        </Button>
        {run.data && (
          <p className="mt-2 text-sm text-muted" data-testid="full-suite-started">
            Started {run.data.ref}.
          </p>
        )}
        <ErrorBox error={run.error} />
      </div>
    </Panel>
  );
}
