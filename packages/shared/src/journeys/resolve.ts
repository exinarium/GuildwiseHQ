import type { WorkflowCardView } from '../workflows/resolve.ts';
import type { JourneyCondition, JourneyDefinition, JourneyHandoff, JourneyRecordType } from './schema.ts';

export const MAX_STEP_VISITS = 240;
export const MAX_INSTANCE_VISITS = 1000;

export type JourneyRecordStatus = 'active' | 'closed';

export interface HandoffContext {
  result: 'done' | 'cancelled';
  /** The ended card of a workflow step; null for a placeholder. */
  card: WorkflowCardView | null;
  record: { type: JourneyRecordType; status: JourneyRecordStatus };
  /** Visits of the from-step, including this one. */
  visits: number;
}

const isUnset = (v: unknown): boolean => v === undefined || v === null || v === '';

function readValue(c: JourneyCondition, ctx: HandoffContext): unknown {
  if (c.source === 'record') {
    if (c.field === 'type') return ctx.record.type;
    if (c.field === 'status') return ctx.record.status;
    if (c.field === 'visits') return ctx.visits;
    return undefined;
  }
  const card = ctx.card;
  if (!card) return undefined;
  return c.field in card ? card[c.field] : card.fields?.[c.field];
}

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
};

/** A missing boolean counts as false (same rule as workflow outcome guards). */
export function conditionHolds(c: JourneyCondition, ctx: HandoffContext): boolean {
  let v = readValue(c, ctx);
  if (typeof c.value === 'boolean' && isUnset(v)) v = false;
  switch (c.op) {
    case 'is_set':
      return !isUnset(v);
    case 'is_not_set':
      return isUnset(v);
    case 'equals':
      return !isUnset(v) || typeof c.value === 'boolean' ? same(v, c.value) : false;
    case 'not_equals':
      return isUnset(v) ? true : !same(v, c.value);
    case 'lt':
      return !isUnset(v) && c.value !== undefined && Number(v) < Number(c.value);
    case 'gte':
      return !isUnset(v) && c.value !== undefined && Number(v) >= Number(c.value);
  }
}

/** First handoff from `stepId` whose `on` matches `ctx.result` and whose condition holds; null: none. */
export function resolveHandoff(
  def: Pick<JourneyDefinition, 'handoffs'>,
  stepId: string,
  ctx: HandoffContext,
): JourneyHandoff | null {
  for (const h of def.handoffs) {
    if (h.from !== stepId) continue;
    if (h.on !== 'any' && h.on !== ctx.result) continue;
    if (h.condition && !conditionHolds(h.condition, ctx)) continue;
    return h;
  }
  return null;
}

export type NextMove =
  | { kind: 'next'; handoff: JourneyHandoff }
  | { kind: 'end' }
  | { kind: 'stuck'; reason: string };

/** What happens after a step ends: the next step, the end, or stuck (handoffs leave the step but none matches). */
export function nextMove(
  def: Pick<JourneyDefinition, 'handoffs'>,
  stepId: string,
  ctx: HandoffContext,
): NextMove {
  const leaving = def.handoffs.filter((h) => h.from === stepId);
  if (leaving.length === 0) return { kind: 'end' };
  const h = resolveHandoff(def, stepId, ctx);
  if (!h) return { kind: 'stuck', reason: `No handoff from "${stepId}" matches a step that ended ${ctx.result}.` };
  if (h.to === 'end') return { kind: 'end' };
  return { kind: 'next', handoff: h };
}

/** Fills `{record.name}`, `{record.type}`, `{record.externalId}` and `{step.label}` in a card field template. */
export function expandRecordTemplate(
  text: string,
  v: { name: string; type: string; externalId: string | null; stepLabel: string },
): string {
  const values: Record<string, string> = {
    'record.name': v.name,
    'record.type': v.type,
    'record.externalId': v.externalId ?? '',
    'step.label': v.stepLabel,
  };
  return text.replace(/\{([a-zA-Z.]+)\}/g, (whole, k: string) => values[k] ?? whole);
}
