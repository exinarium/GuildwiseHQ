import {
  BUILTIN_WORKFLOWS,
  investigateInsertion,
  materialiseVariant,
  resolveOutcome,
  type WorkflowDefinition,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { designCompletionOutcome } from '../src/commands/design-size.ts';

/**
 * The outcome that hands an over-budget design on when the needs-split question is answered "build it": the handoff's
 * own outcome, else the stage's first success outcome that completes it. A design step inserted with the
 * "Investigate & design" template calls it `done`, not `handoff`.
 */

const code = [...BUILTIN_WORKFLOWS]
  .filter((w) => w.key === 'code' && w.stages.some((s) => s.id === 'investigate'))
  .sort((a, b) => b.version - a.version)[0] as WorkflowDefinition;
const variant = materialiseVariant(code, {
  key: 'code_designed_after_test',
  name: 'Code, designed after test',
  base: { key: code.key, version: code.version },
  insertions: [investigateInsertion('test')],
} as never);
const card = { designNeeded: true, fields: {} };

describe('designCompletionOutcome', () => {
  it("keeps the handoff's outcome on the built-in design stage", () => {
    expect(designCompletionOutcome(code, card, 'investigate', 'handoff')).toBe('handoff');
  });

  it("an investigate_after_* stage completes with its own 'done' outcome, and it resolves", () => {
    expect(designCompletionOutcome(variant, card, 'investigate_after_test', 'done')).toBe('done');
    const outcome = designCompletionOutcome(variant, card, 'investigate_after_test', undefined)!;
    expect(outcome).toBe('done');
    expect(() => resolveOutcome(variant, card, 'investigate_after_test', outcome)).not.toThrow();
  });

  it("falls back to the stage's success outcome when the stored id is missing or unknown (no 'handoff' assumed)", () => {
    expect(designCompletionOutcome(variant, card, 'investigate_after_test', 'handoff')).toBe('done');
    expect(designCompletionOutcome(code, card, 'investigate', 'nope')).toBe('handoff');
    expect(designCompletionOutcome(code, card, 'investigate', null)).toBe('handoff');
  });

  it('gives null for a stage with no success outcome that completes it, or an unknown stage', () => {
    const noSuccess = {
      stages: [
        {
          id: 'investigate',
          outcomes: [{ id: 'blocked', kind: 'failure', event: 'StageCompleted', to: 'spec' }],
        },
      ],
    } as never;
    expect(designCompletionOutcome(noSuccess, card, 'investigate', 'blocked')).toBeNull();
    expect(designCompletionOutcome(code, card, 'nowhere', 'handoff')).toBeNull();
  });
});
