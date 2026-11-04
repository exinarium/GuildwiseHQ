import { describe, expect, it } from 'vitest';
import {
  CEO_ACTIONS,
  MOVE_BLOCK_LABEL,
  MoveAgentsOffParamsSchema,
  MoveBlockReasonSchema,
  MoveWorkstationParamsSchema,
  renderCeoChatSection,
  renderCeoInstructions,
} from '../src/index.ts';

describe('MoveWorkstationParamsSchema aliases', () => {
  it('maps --agent and --to to the canonical names', () => {
    expect(MoveWorkstationParamsSchema.parse({ agent: ' Ada ', to: 'Laptop' })).toEqual({
      agentId: 'Ada',
      targetWorkstationId: 'Laptop',
    });
  });
  it('keeps the canonical names', () => {
    expect(MoveWorkstationParamsSchema.parse({ agentId: 'Ada', targetWorkstationId: 'L' })).toEqual({
      agentId: 'Ada',
      targetWorkstationId: 'L',
    });
  });
  it('refuses both spellings at once and a missing half', () => {
    expect(MoveWorkstationParamsSchema.safeParse({ agent: 'a', agentId: 'b', to: 'c' }).success).toBe(false);
    expect(MoveWorkstationParamsSchema.safeParse({ agent: 'a' }).success).toBe(false);
  });
});

describe('MoveAgentsOffParamsSchema', () => {
  it('accepts from and to', () => {
    expect(MoveAgentsOffParamsSchema.parse({ from: ' old ', to: 'new' })).toEqual({ from: 'old', to: 'new' });
  });
  it.each([
    [{ to: 'x' }],
    [{ from: 'x' }],
    [{ from: '', to: 'x' }],
    [{ from: 'x'.repeat(121), to: 'x' }],
    [{ from: 'a', to: 'b', extra: 1 }],
  ])('refuses %j', (v) => {
    expect(MoveAgentsOffParamsSchema.safeParse(v).success).toBe(false);
  });
});

describe('the CEO is told about the move actions', () => {
  it('lists both actions', () => {
    expect(CEO_ACTIONS).toContain('move-workstation');
    expect(CEO_ACTIONS).toContain('move-agents-off');
  });
  it('the shift and the chat instructions name them', () => {
    const chat = renderCeoChatSection('x');
    expect(chat).toContain('move-workstation --agent');
    expect(chat).toContain('move-agents-off --from');
    const brief = {
      agent: { name: 'Ada' },
      role: { instructions: 'Lead.', coreRules: [] },
      shift: { outcomes: [] },
    } as never;
    const shift = renderCeoInstructions(brief, { purpose: 'wake', brief: 'x' } as never);
    expect(shift).toContain('move-workstation --agent');
    expect(shift).toContain('move-agents-off --from');
  });
  it('every block reason has a label', () => {
    for (const reason of MoveBlockReasonSchema.options) expect(MOVE_BLOCK_LABEL[reason]).toBeTruthy();
  });
});
