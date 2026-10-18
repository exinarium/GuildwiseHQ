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

/**
 * Fold of the short-lived `lean team` workflow into `code` version 6 (owner decision, 18 Oct 2026; lean-rollout step 5). New
 * events only: nothing written before them changes meaning; the legacy key is aliased in `workflows/legacy.ts`.
 */
export const workflowFoldEvents = [
  /** A project's primary workflow key changed without a conversion (no card decisions, no repositories). */
  defineEvent(
    'ProjectPrimaryWorkflowChanged',
    z.object({ projectId: Id, from: z.string().min(1), to: z.string().min(1), by: Id }),
  ),
  /** A card moved to another registered version of the same stages (identical stage ids; `reason` says why). */
  defineEvent(
    'CardWorkflowVersionChanged',
    z.object({ cardId: Id, fromVersionId: Id, toVersionId: Id, reason: z.string().min(1) }),
  ),
  /** A built-in workflow version nothing refers to any more was removed from the catalogue (never done by replay of its users). */
  defineEvent(
    'WorkflowVersionRetired',
    z.object({
      workflowVersionId: Id,
      key: z.string(),
      version: z.number().int().min(1),
      reason: z.string().min(1),
    }),
  ),
] as const;
