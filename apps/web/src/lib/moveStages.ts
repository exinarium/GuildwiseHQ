import { movableStages, type Stage, type WorkflowDefinition } from '@aom/shared';

/**
 * The stages a card may be moved to. `targetIds` is the server's list (`moveTargets` of the card query) and wins when
 * the caller has it; without it (a board card) the shared rules the server enforces in `moveCard` are applied to the
 * card's workflow. The current stage, closing stages and steps for a person are never offered.
 */
export function moveStageOptions(
  workflow: WorkflowDefinition,
  current: string,
  targetIds?: readonly string[],
): Stage[] {
  if (targetIds) return workflow.stages.filter((s) => s.id !== current && targetIds.includes(s.id));
  return movableStages(workflow, current);
}
