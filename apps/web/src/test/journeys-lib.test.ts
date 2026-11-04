import { JOURNEY_TEMPLATES, type JourneyDefinition } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  addHandoff,
  addStep,
  freeId,
  isLoop,
  moveHandoff,
  moveStep,
  removeStep,
  updateHandoff,
} from '../lib/journeys.ts';

const rentals = (): JourneyDefinition => structuredClone(JOURNEY_TEMPLATES[0]!.definition);

describe('journey designer edits', () => {
  it('opens the rentals template with all ten steps and shows the monthly loop', () => {
    const d = rentals();
    expect(d.steps).toHaveLength(10);
    expect(isLoop(d, d.handoffs.find((h) => h.from === 'monthly_rent' && h.to === 'monthly_rent')!)).toBe(
      true,
    );
    expect(isLoop(d, d.handoffs.find((h) => h.from === 'lead' && h.to === 'viewing')!)).toBe(false);
  });
  it('moves a step up and down and stops at the ends', () => {
    const d = rentals();
    expect(
      moveStep(d, 'viewing', -1)
        .steps.map((s) => s.id)
        .slice(0, 2),
    ).toEqual(['viewing', 'lead']);
    expect(moveStep(d, 'lead', -1)).toBe(d);
    expect(moveStep(d, 'monthly_rent', 1)).toBe(d);
  });
  it('adds a step with a free id and a handoff with a condition, then reorders handoffs', () => {
    let d = addStep(rentals(), 'workflow', 'Lead');
    expect(d.steps.at(-1)?.id).toBe('lead_2');
    d = addHandoff(d, 'lead', 'lead_2');
    const h = d.handoffs.at(-1)!;
    d = updateHandoff(d, h.id, { condition: { source: 'card', field: 'rooms', op: 'gte', value: 2 } });
    expect(d.handoffs.find((x) => x.id === h.id)?.condition?.field).toBe('rooms');
    const before = d.handoffs.filter((x) => x.from === 'lead').map((x) => x.id);
    const after = moveHandoff(d, h.id, -1)
      .handoffs.filter((x) => x.from === 'lead')
      .map((x) => x.id);
    // one step up swaps with its neighbour
    expect(before.at(-1)).toBe(h.id);
    expect(after).toEqual([...before.slice(0, -2), h.id, before.at(-2)]);
  });
  it('removing a step removes its handoffs and moves the first step on', () => {
    const d = removeStep(rentals(), 'lead');
    expect(d.firstStepId).toBe('viewing');
    expect(d.handoffs.some((h) => h.from === 'lead' || h.to === 'lead')).toBe(false);
  });
  it('freeId never returns the reserved id end', () => {
    expect(freeId([], 'end')).toBe('end_2');
  });
});
