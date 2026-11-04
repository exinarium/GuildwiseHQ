import type { JourneyDefinition, JourneyHandoff, JourneyStep } from '@aom/shared';

/** Pure edits of a journey definition for the designer (testable without React). */

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** A step id that is free in the definition: `step_2`, `step_3`, ... */
export function freeId(taken: Iterable<string>, base = 'step'): string {
  const set = new Set(taken);
  const b = /^[a-z]/.test(slug(base)) ? slug(base).slice(0, 50) : 'step';
  if (!set.has(b) && b !== 'end') return b;
  for (let n = 2; ; n++) if (!set.has(`${b}_${n}`)) return `${b}_${n}`;
}

export function addStep(def: JourneyDefinition, kind: JourneyStep['kind'], label: string): JourneyDefinition {
  const id = freeId(
    def.steps.map((s) => s.id),
    label,
  );
  const step: JourneyStep =
    kind === 'workflow'
      ? { kind, id, label, workflowKey: null, fieldsIn: [] }
      : kind === 'webhook_call'
        ? {
            kind,
            id,
            label,
            workstationId: null,
            url: '',
            method: 'POST',
            headers: [],
            credentialHeaders: [],
            contentType: 'application/json',
            body: '',
          }
        : { kind, id, label };
  return { ...def, steps: [...def.steps, step] };
}

/** Moves a step one place up (-1) or down (1). */
export function moveStep(def: JourneyDefinition, id: string, delta: -1 | 1): JourneyDefinition {
  const i = def.steps.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= def.steps.length) return def;
  const steps = [...def.steps];
  [steps[i], steps[j]] = [steps[j] as JourneyStep, steps[i] as JourneyStep];
  return { ...def, steps };
}

export function updateStep(
  def: JourneyDefinition,
  id: string,
  patch: Record<string, unknown>,
): JourneyDefinition {
  return { ...def, steps: def.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as JourneyStep) : s)) };
}

/** Removes a step and every handoff that leaves or enters it; the first step moves on when it was removed. */
export function removeStep(def: JourneyDefinition, id: string): JourneyDefinition {
  const steps = def.steps.filter((s) => s.id !== id);
  return {
    ...def,
    steps,
    firstStepId: def.firstStepId === id ? (steps[0]?.id ?? def.firstStepId) : def.firstStepId,
    handoffs: def.handoffs.filter((h) => h.from !== id && h.to !== id),
  };
}

export function addHandoff(def: JourneyDefinition, from: string, to: string): JourneyDefinition {
  const id = freeId(
    def.handoffs.map((h) => h.id),
    'handoff',
  );
  const h: JourneyHandoff = { id, from, on: 'done', to };
  return { ...def, handoffs: [...def.handoffs, h] };
}

export function updateHandoff(
  def: JourneyDefinition,
  id: string,
  patch: Partial<JourneyHandoff>,
): JourneyDefinition {
  return { ...def, handoffs: def.handoffs.map((h) => (h.id === id ? { ...h, ...patch } : h)) };
}

export function removeHandoff(def: JourneyDefinition, id: string): JourneyDefinition {
  return { ...def, handoffs: def.handoffs.filter((h) => h.id !== id) };
}

/** Order of a handoff among those leaving the same step (the first match wins): swap with the neighbour. */
export function moveHandoff(def: JourneyDefinition, id: string, delta: -1 | 1): JourneyDefinition {
  const h = def.handoffs.find((x) => x.id === id);
  if (!h) return def;
  const same = def.handoffs.filter((x) => x.from === h.from);
  const k = same.findIndex((x) => x.id === id) + delta;
  const other = same[k];
  if (!other) return def;
  const a = def.handoffs.findIndex((x) => x.id === id);
  const b = def.handoffs.findIndex((x) => x.id === other.id);
  const handoffs = [...def.handoffs];
  [handoffs[a], handoffs[b]] = [handoffs[b] as JourneyHandoff, handoffs[a] as JourneyHandoff];
  return { ...def, handoffs };
}

/** A handoff to a step at or before its own position goes back: shown as a loop. */
export function isLoop(def: JourneyDefinition, h: JourneyHandoff): boolean {
  if (h.to === 'end') return false;
  const from = def.steps.findIndex((s) => s.id === h.from);
  const to = def.steps.findIndex((s) => s.id === h.to);
  return to >= 0 && from >= 0 && to <= from;
}

// ------------------------------------------------------------------------- waits, gates and webhook calls

export type WaitKind = 'duration' | 'date' | 'form' | 'webhook';
export type TimeoutKind = 'remind' | 'goto' | 'escalate' | 'cancel';

/** A fresh `waitFor` of the chosen kind (what the wait step waits for). */
export function waitForOf(kind: WaitKind): Record<string, unknown> {
  if (kind === 'date') return { kind, dateFrom: { field: '' }, atTime: '09:00' };
  if (kind === 'form') return { kind, formId: null, purpose: 'answers', send: { via: 'desk' } };
  if (kind === 'webhook') return { kind, triggerId: null };
  return { kind };
}

/** A fresh timeout action of the chosen kind, with the defaults the server applies. */
export function timeoutOf(action: TimeoutKind, firstOther?: string): Record<string, unknown> {
  if (action === 'remind') return { action, maxReminders: 3, afterLast: 'escalate' };
  if (action === 'goto') return { action, stepId: firstOther ?? '' };
  return { action };
}

/** The units a duration is typed in; the server limits it to 5 minutes..365 days. */
export const DURATION_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const;

const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 604_800_000 } as const;
/** An error text for a duration that the server would refuse, or null. */
export function durationError(d: { amount: number; unit: keyof typeof UNIT_MS } | undefined): string | null {
  if (!d) return 'Pick how long to wait.';
  const ms = d.amount * UNIT_MS[d.unit];
  if (!Number.isInteger(d.amount) || ms < 5 * 60_000 || ms > 365 * 86_400_000)
    return 'Between 5 minutes and 365 days.';
  return null;
}

/** "in 2 days", "3 hours ago": the deadline of a wait as one short sentence. */
export function relativeTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const [n, unit] =
    abs < 3_600_000
      ? [Math.max(1, Math.round(abs / 60_000)), 'minute']
      : abs < 86_400_000
        ? [Math.round(abs / 3_600_000), 'hour']
        : [Math.round(abs / 86_400_000), 'day'];
  const t = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${t}` : `${t} ago`;
}

/** Plain words for what a wait does when it times out. */
export function timeoutSummary(
  a: { action: string; maxReminders?: number; stepId?: string } | undefined,
  label?: (id: string) => string,
): string {
  if (!a) return 'not set';
  if (a.action === 'remind') return `send up to ${a.maxReminders ?? 3} reminders, then ask the desk`;
  if (a.action === 'goto') return `go to "${label?.(a.stepId ?? '') ?? a.stepId}"`;
  if (a.action === 'escalate') return 'ask the desk what to do';
  return 'cancel the journey';
}
