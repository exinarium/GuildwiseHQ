import { type WorkflowDefinition, workflowHasTestStage, workflowUsesRepos } from '@aom/shared';
import { useWorkflows } from '../api/queries/agents.ts';
import { useProject } from '../api/queries/projects.ts';

/**
 * What a project's workflow needs from the UI. While the catalogue is loading (or the key is unknown) both flags are
 * true, so code projects never lose controls; research/feed lose them once the definition is known.
 */
export function useProjectWorkflowTraits(projectId: string | undefined, workflowKey: string | undefined) {
  const workflows = useWorkflows(projectId);
  const candidates = (workflows.data ?? [])
    .map((w) => w.definition)
    .filter((d: WorkflowDefinition) => d.key === workflowKey)
    .sort((a, b) => b.version - a.version);
  const def = candidates[0];
  return {
    hasTestStage: def ? workflowHasTestStage(def) : true,
    usesRepos: def ? workflowUsesRepos(def) : true,
  };
}

/**
 * Which phase follow-ups the project can run: a deploy needs a repository, a regression run a repository and a workflow
 * with a test stage (the server refuses the others with `followup_needs_repos`). A reason string means "greyed out".
 * While the project is loading nothing is blocked.
 */
export function useFollowupAvailability(projectId: string | undefined): {
  deploy?: string;
  regression?: string;
} {
  const detail = useProject(projectId);
  const traits = useProjectWorkflowTraits(projectId, detail.data?.project?.workflowKey);
  if (!detail.data?.project) return {};
  const repos = (detail.data.repos ?? []).filter((r) => !r.removedAt).length;
  const none = 'This project has no repository: convert it to a delivery project or add one first.';
  return {
    ...(repos === 0 ? { deploy: none } : {}),
    ...(repos === 0
      ? { regression: none }
      : !traits.hasTestStage
        ? { regression: 'This workflow has no test stage.' }
        : {}),
  };
}
