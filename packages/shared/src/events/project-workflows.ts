import { z } from 'zod';
import { defineEvent, Id } from './define.ts';

/** One enabled workflow of a project and the card types it is the default for (docs/design/architect-and-workflows.md 4.1). */
export const ProjectWorkflowEntry = z.object({
  workflowKey: z.string().min(1),
  defaultCardTypes: z.array(z.string()).default([]),
});
export type ProjectWorkflowEntry = z.infer<typeof ProjectWorkflowEntry>;

export const projectWorkflowEvents = [
  /**
   * An Owner or Admin set the workflows a project has enabled (the full set; the primary workflow, `projects.workflow_key`,
   * is always in it). Cards pick one at creation; running cards keep the workflow version they were created with.
   */
  defineEvent(
    'ProjectWorkflowsSet',
    z.object({ projectId: Id, enabled: z.array(ProjectWorkflowEntry).min(1), by: Id }),
  ),
] as const;
