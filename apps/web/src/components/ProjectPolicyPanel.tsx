import type { ProjectDetailResponse } from '@aom/shared';
import { useSetProjectPolicy } from '../api/queries/projects.ts';
import { Badge, ErrorBox, Panel } from './ui.tsx';

/**
 * Two project settings: whether a card may be tested without a test environment (it replaces the "Test mode" and "Test
 * Environment" standing orders), and whether the project keeps its decisions at project level (the platform project).
 */
export function ProjectPolicyPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetProjectPolicy(projectId);
  const testNoEnv = project.testWithoutEnvironment ?? false;
  const projectOnly = project.decisionsProjectOnly ?? false;

  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">Testing and decisions</h2>
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={testNoEnv}
          disabled={!canChange || set.isPending}
          data-testid="test-without-env-toggle"
          onChange={(e) => set.mutate({ testWithoutEnvironment: e.target.checked })}
        />
        <span>
          Test without an environment{' '}
          <Badge tone={testNoEnv ? 'brand' : 'neutral'}>
            <span data-testid="test-without-env-state">{testNoEnv ? 'Yes' : 'No'}</span>
          </Badge>
        </span>
      </label>
      <p className="mt-2 text-sm text-muted">
        Off (the default): when no test environment is ready, the card waits for DevOps to start one. On: the
        tester runs what it can without an environment and records that none was used.
      </p>
      <label className="mt-4 flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1"
          checked={projectOnly}
          disabled={!canChange || set.isPending}
          data-testid="decisions-project-only-toggle"
          onChange={(e) => set.mutate({ decisionsProjectOnly: e.target.checked })}
        />
        <span>Keep this project's decisions at project level</span>
      </label>
      <p className="mt-2 text-sm text-muted">
        When on, HR and the CEO cannot promote this project's answers to organization-wide orders, the desk
        refuses the organization-wide switch for its questions, and HR ignores its questions when it looks for
        patterns. Use it for the platform project.
      </p>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle" data-testid="policy-readonly">
          Only the project Owner and the organization's Owners and Admins can change these settings.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
