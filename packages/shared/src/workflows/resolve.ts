import { getStage, type Outcome, type OutcomeEvent, type Stage, type WorkflowDefinition } from './schema.ts';

/** The slice of a card the workflow engine looks at. `when.field` is read from the card, then from `card.fields`. */
export interface WorkflowCardView {
  docsNeeded?: boolean | null;
  fields?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ResolvedOutcome {
  event: OutcomeEvent;
  toStage: string;
}

export class WorkflowResolveError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unknown_stage'
      | 'unknown_outcome'
      | 'skip_loop'
      | 'no_success_outcome'
      | 'outcome_not_allowed',
  ) {
    super(message);
    this.name = 'WorkflowResolveError';
  }
}

function readField(card: WorkflowCardView, field: string): unknown {
  return field in card ? card[field] : card.fields?.[field];
}

export function stageIsActive(stage: Stage, card: WorkflowCardView): boolean {
  if (!stage.when) return true;
  const { field, equals } = stage.when;
  return readField(card, field) === equals;
}

/**
 * True when the outcome's guard (`Outcome.when`) holds for the card. A missing/null boolean field counts as `false`,
 * so a guard `equals: false` still applies to a card view that does not carry the field.
 */
export function outcomeApplies(outcome: Pick<Outcome, 'when'>, card: WorkflowCardView): boolean {
  if (!outcome.when) return true;
  const { field, equals } = outcome.when;
  let value = readField(card, field);
  if (typeof equals === 'boolean' && (value === undefined || value === null)) value = false;
  return value === equals;
}

/** The outcomes of a stage that are offered for this card (guards evaluated). Unknown stage: empty. */
export function allowedOutcomes(
  def: Pick<WorkflowDefinition, 'stages'>,
  card: WorkflowCardView,
  stageId: string,
): Outcome[] {
  return (getStage(def, stageId)?.outcomes ?? []).filter((o) => outcomeApplies(o, card));
}

/** Follows `when`-skipped stages from `toStage` (via their first allowed success outcome) to the first active stage. */
export function skipInactive(
  def: Pick<WorkflowDefinition, 'stages'>,
  card: WorkflowCardView,
  toStage: string,
): string {
  const seen = new Set<string>();
  for (;;) {
    const target = getStage(def, toStage);
    if (!target) throw new WorkflowResolveError(`unknown stage '${toStage}'`, 'unknown_stage');
    if (stageIsActive(target, card)) return toStage;
    if (seen.has(toStage)) throw new WorkflowResolveError(`skip loop at stage '${toStage}'`, 'skip_loop');
    seen.add(toStage);
    const next = allowedOutcomes(def, card, toStage).find((o) => o.kind === 'success');
    if (!next)
      throw new WorkflowResolveError(
        `skipped stage '${toStage}' has no success outcome`,
        'no_success_outcome',
      );
    toStage = next.to;
  }
}

/**
 * Resolves a reported outcome to the event to append and the stage the card moves to.
 * An outcome whose guard (`Outcome.when`) does not hold is refused ('outcome_not_allowed'). If the target stage has
 * a `when` that evaluates false, follows that stage's first allowed `success` outcome recursively (skipping it). Pure; used by the server and written into the event payload.
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
  if (!outcomeApplies(outcome, card)) {
    throw new WorkflowResolveError(
      `outcome '${outcomeId}' of stage '${stageId}' does not apply to this card`,
      'outcome_not_allowed',
    );
  }
  const toStage = skipInactive(def, card, outcome.to);
  return { event: outcome.event, toStage };
}
