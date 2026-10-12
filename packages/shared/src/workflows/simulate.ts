import { allowedOutcomes, outcomeApplies, stageIsActive, type WorkflowCardView } from './resolve.ts';
import { getStage, type Outcome, type Stage, type WorkflowDefinition } from './schema.ts';

/**
 * "Try a card" (docs/design/workflow-builder.md 2.4): walks a workflow from its first stage with the engine's own
 * rules (`when` skips, outcome guards) and the choices made so far. Pure; no server needed.
 */

export interface SimulatedOutcome {
  id: string;
  label: string;
  kind: Outcome['kind'];
  to: string;
  rework: boolean;
}

export interface SimulatedStep {
  stageId: string;
  label: string;
  kind: Stage['kind'];
  /** The role that works it (agent steps), else null. */
  role: string | null;
  /** The step was skipped because its `when` does not hold for the card; no choice is made. */
  skipped: boolean;
  /** Routes offered for this card (guards applied). Empty for skipped and final steps. */
  offered: SimulatedOutcome[];
  /** The route taken, if the walk continued past this step. */
  chosen: string | null;
  /** The route was not chosen by the caller: the first success route was assumed. */
  defaulted: boolean;
}

export type SimulationEnd =
  /** Reached a final step. */
  | 'finished'
  /** Looped back to the same step too many times (rework loops the walk would repeat forever). */
  | 'loop'
  /** A chosen route is unknown or not offered for this card, or the workflow is malformed. */
  | 'error'
  /** Walk stopped at the step cap. */
  | 'too_long';

export interface SimulationResult {
  steps: SimulatedStep[];
  end: SimulationEnd;
  error?: string;
  /** Step ids in order, skipped ones included (what the graph highlights). */
  path: string[];
  /** Index of the first step whose route was assumed, or -1 when every choice was explicit (UI: "choose here"). */
  firstDefaulted: number;
}

/** Route ids per visited step, in order (`undefined`: assume the first success route), or per step id (any visit). */
export type SimulationChoices = readonly (string | undefined)[] | Readonly<Record<string, string>>;

export interface SimulateOptions {
  /** Total steps recorded before giving up (default 60). */
  maxSteps?: number;
  /** Visits of one step before the walk is called a loop (default 3). */
  maxVisits?: number;
}

const toSimulated = (o: Outcome): SimulatedOutcome => ({
  id: o.id,
  label: o.label,
  kind: o.kind,
  to: o.to,
  rework: o.rework,
});

export function simulatePath(
  def: Pick<WorkflowDefinition, 'stages' | 'initialStage'>,
  card: WorkflowCardView,
  choices: SimulationChoices = [],
  opts: SimulateOptions = {},
): SimulationResult {
  const maxSteps = opts.maxSteps ?? 60;
  const maxVisits = opts.maxVisits ?? 3;
  const steps: SimulatedStep[] = [];
  const visits = new Map<string, number>();
  const result = (end: SimulationEnd, error?: string): SimulationResult => ({
    steps,
    end,
    error,
    path: steps.map((s) => s.stageId),
    firstDefaulted: steps.findIndex((s) => s.defaulted),
  });
  const choiceFor = (stageId: string, index: number): string | undefined =>
    Array.isArray(choices)
      ? (choices as readonly (string | undefined)[])[index]
      : (choices as Record<string, string>)[stageId];

  let stageId = def.initialStage;
  for (;;) {
    if (steps.length >= maxSteps) return result('too_long');
    const stage = getStage(def, stageId);
    if (!stage) return result('error', `unknown step '${stageId}'`);
    const n = (visits.get(stageId) ?? 0) + 1;
    visits.set(stageId, n);
    if (n > maxVisits) return result('loop', `step '${stageId}' is reached again and again`);
    const base = {
      stageId,
      label: stage.label,
      kind: stage.kind,
      role: stage.kind === 'agent' ? stage.claimRole : null,
    };

    if (!stageIsActive(stage, card)) {
      const next = allowedOutcomes(def, card, stageId).find((o) => o.kind === 'success');
      if (!next) {
        steps.push({ ...base, skipped: true, offered: [], chosen: null, defaulted: false });
        return result('error', `skipped step '${stageId}' has no success route`);
      }
      steps.push({ ...base, skipped: true, offered: [], chosen: next.id, defaulted: false });
      stageId = next.to;
      continue;
    }
    if (stage.kind === 'terminal') {
      steps.push({ ...base, skipped: false, offered: [], chosen: null, defaulted: false });
      return result('finished');
    }

    const offered = stage.outcomes.filter((o) => outcomeApplies(o, card));
    const wanted = choiceFor(stageId, steps.filter((s) => !s.skipped).length);
    let picked: Outcome | undefined;
    let defaulted = false;
    if (wanted !== undefined) {
      picked = offered.find((o) => o.id === wanted);
      if (!picked) {
        steps.push({
          ...base,
          skipped: false,
          offered: offered.map(toSimulated),
          chosen: null,
          defaulted: false,
        });
        return result('error', `route '${wanted}' is not offered at step '${stageId}' for this card`);
      }
    } else {
      picked = offered.find((o) => o.kind === 'success');
      defaulted = true;
    }
    if (!picked) {
      steps.push({
        ...base,
        skipped: false,
        offered: offered.map(toSimulated),
        chosen: null,
        defaulted: false,
      });
      return result('error', `step '${stageId}' has no route for this card`);
    }
    steps.push({ ...base, skipped: false, offered: offered.map(toSimulated), chosen: picked.id, defaulted });
    stageId = picked.to;
  }
}

/** "Step 1 Draft (Copywriter) -> Step 2 Check -> Done": a one-line text equivalent of the walked path. */
export function describePath(result: SimulationResult): string {
  return result.steps
    .filter((s) => !s.skipped)
    .map((s, i) => `${i + 1}. ${s.label}${s.role ? ` (${s.role})` : ''}`)
    .join(' -> ');
}
