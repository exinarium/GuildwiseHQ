import { getStage, type Outcome, type OutcomeEvent, type Stage, type WorkflowDefinition } from './schema.ts';

/** The slice of a card the workflow engine looks at. `when.field` is read from the card, then from `card.fields`. */
export interface WorkflowCardView {
  docsNeeded?: boolean;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResolvedOutcome {
  event: OutcomeEvent;
  toStage: string;
}

export class WorkflowResolveError extends Error {
  constructor(
    message: string,
    readonly code: 'unknown_stage' | 'unknown_outcome' | 'skip_loop' | 'no_success_outcome',
  ) {
    super(message);
    this.name = 'WorkflowResolveError';
  }
}

export function stageIsActive(stage: Stage, card: WorkflowCardView): boolean {
  if (!stage.when) return true;
  const { field, equals } = stage.when;
  const value = field in card ? card[field] : card.fields?.[field];
  return value === equals;
}

/**
 * Resolves a reported outcome to the event to append and the stage the card moves to.
 * If the target stage has a `when` that evaluates false, follows that stage's first `success`
 * outcome recursively (skipping it). Pure; used by the server and written into the event payload.
 */
export function resolveOutcome(
  def: Pick<WorkflowDefinition, 'stages'>,
  card: WorkflowCardView,
  stageId: string,
  outcomeId: string,
): ResolvedOutcome {
  const stage = getStage(def, stageId);
  if (!stage) throw new WorkflowResolveError(`unknown stage '${stageId}'`, 'unknown_stage');
  const outcome: Outcome | undefined = stage.outcomes.find((o) => o.id === outcomeId);
  if (!outcome) {
    throw new WorkflowResolveError(`stage '${stageId}' has no outcome '${outcomeId}'`, 'unknown_outcome');
  }
  let toStage = outcome.to;
  const seen = new Set<string>();
  for (;;) {
    const target = getStage(def, toStage);
    if (!target) throw new WorkflowResolveError(`unknown stage '${toStage}'`, 'unknown_stage');
    if (stageIsActive(target, card)) break;
    if (seen.has(toStage)) throw new WorkflowResolveError(`skip loop at stage '${toStage}'`, 'skip_loop');
    seen.add(toStage);
    const next = target.outcomes.find((o) => o.kind === 'success');
    if (!next)
      throw new WorkflowResolveError(
        `skipped stage '${toStage}' has no success outcome`,
        'no_success_outcome',
      );
    toStage = next.to;
  }
  return { event: outcome.event, toStage };
}
