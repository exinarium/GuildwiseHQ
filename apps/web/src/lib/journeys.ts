import type { JourneyDefinition, JourneyHandoff, JourneyStep } from '@aom/shared';

/** Pure edits of a journey definition for the designer (testable without React). */

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** A step id that is free in the definition: `step_2`, `step_3`, ... */
export function freeId(taken: Iterable<string>, base = 'step'): string {
  const set = new Set(taken);
  const b = /^[a-z]/.test(slug(base)) ? slug(base).slice(0, 50) : 'step';
  if (!set.has(b) && b !== 'end') return b;
  for (let n = 2; ; n++) if (!set.has(`${b}_${n}`)) return `${b}_${n}`;
}

export function addStep(def: JourneyDefinition, kind: JourneyStep['kind'], label: string): JourneyDefinition {
  const id = freeId(def.steps.map((s) => s.id), label);
  const step: JourneyStep =
    kind === 'workflow' ? { kind, id, label, workflowKey: null, fieldsIn: [] } : { kind, id, label };
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

export function updateStep(def: JourneyDefinition, id: string, patch: Record<string, unknown>): JourneyDefinition {
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
  const id = freeId(def.handoffs.map((h) => h.id), 'handoff');
  const h: JourneyHandoff = { id, from, on: 'done', to };
  return { ...def, handoffs: [...def.handoffs, h] };
}

export function updateHandoff(def: JourneyDefinition, id: string, patch: Partial<JourneyHandoff>): JourneyDefinition {
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
