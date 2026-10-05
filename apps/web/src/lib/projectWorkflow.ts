import { type WorkflowDefinition, workflowHasTestStage, workflowUsesRepos } from '@aom/shared';
import { useWorkflows } from '../api/queries/agents.ts';

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
