import { canonicalWorkflowKey } from './legacy.ts';
import { getStage, type Stage, type WorkflowDefinition } from './schema.ts';

/**
 * Why a manual move to `stage` is refused for a card of this workflow, or `null` when it is accepted. The server's
 * `moveCard` enforces it and the card query lists the accepted stages from it, so the pickers and the server agree.
 */
export function moveRefusal(
  def: Pick<WorkflowDefinition, 'key' | 'stages'>,
  stage: Stage | undefined,
): { code: 'unknown_stage' | 'invalid_stage'; message: string } | null {
  if (!stage) return { code: 'unknown_stage', message: "this stage does not exist in this card's workflow" };
  if (stage.kind === 'terminal')
    return { code: 'invalid_stage', message: 'use cancel or finalize to close a card' };
  // A person's step (manual QA, an approval) opens by itself when the card reaches it: it is not a place to move to.
  if (
    stage.kind === 'human' ||
    stage.kind === 'server' ||
    (stage.id === 'qa_steps' && canonicalWorkflowKey(def.key) === 'code')
  )
    return {
      code: 'invalid_stage',
      message: 'a step for a person starts by itself when the card reaches it',
    };
  return null;
}

/** The stages a manager may move a card at `currentStage` to: every accepted stage except the one it is in. */
export function movableStages(
  def: Pick<WorkflowDefinition, 'key' | 'stages'>,
  currentStage: string,
): Stage[] {
  return def.stages.filter((s) => s.id !== currentStage && moveRefusal(def, getStage(def, s.id)) === null);
}
