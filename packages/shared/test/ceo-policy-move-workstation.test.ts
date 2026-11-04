import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  CEO_ACTIONS,
  CLASS_LABEL,
  clonePolicy,
  DEFAULT_CEO_POLICY,
  evaluatePolicy,
  isStaffingClass,
  MoveWorkstationParamsSchema,
} from '../src/index.ts';

const P = DEFAULT_CEO_POLICY;
const base = { confidence: 0.9 };
const CLS = 'agent.move_workstation';
const ID = '3f0c6a4e-1b2d-4c5e-8f90-123456789abc';

describe('the move-workstation policy class', () => {
  it('is a listed class with a label, a staffing class, and recommended by default', () => {
    expect(ACTION_CLASSES).toContain(CLS);
    expect(CLASS_LABEL[CLS]).toBe('Move an agent to another workstation');
    expect(isStaffingClass(CLS)).toBe(true);
    expect(P.classes[CLS]?.mode).toBe('recommend');
    expect(CEO_ACTIONS).toContain('move-workstation');
  });

  it('is never looser than the default: recommend, inline on the owner turn, deny on never', () => {
    expect(evaluatePolicy(P, CLS, base).verdict).toBe('recommend');
    expect(evaluatePolicy(P, CLS, { ...base, origin: { kind: 'owner' } })).toMatchObject({
      verdict: 'recommend',
      inline: true,
    });
    const never = clonePolicy(P);
    never.classes[CLS] = { ...never.classes[CLS]!, mode: 'never' };
    expect(evaluatePolicy(never, CLS, base).verdict).toBe('deny');
  });

  it('only recommends when the wake came from outside text, even if the owner sets decide', () => {
    const decide = clonePolicy(P);
    decide.classes[CLS] = { ...decide.classes[CLS]!, mode: 'decide' };
    expect(evaluatePolicy(decide, CLS, base).verdict).toBe('allow');
    expect(evaluatePolicy(decide, CLS, { ...base, untrustedOrigin: true }).verdict).toBe('recommend');
  });
});

describe('MoveWorkstationParamsSchema', () => {
  it('accepts names and ids and trims them', () => {
    expect(MoveWorkstationParamsSchema.parse({ agentId: ' Ada ', targetWorkstationId: ID })).toEqual({
      agentId: 'Ada',
      targetWorkstationId: ID,
    });
  });

  it('refuses a missing, empty, too long or unknown parameter', () => {
    const bad = [
      { agentId: 'Ada' },
      { targetWorkstationId: ID },
      { agentId: '', targetWorkstationId: ID },
      { agentId: 'Ada', targetWorkstationId: '   ' },
      { agentId: 'x'.repeat(121), targetWorkstationId: ID },
      { agentId: 'Ada', targetWorkstationId: ID, workstation: 'Laptop' },
    ];
    for (const b of bad)
      expect(MoveWorkstationParamsSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });
});

describe('agent.allow_list is unchanged', () => {
  it('keeps its label, mode, staffing membership and untrusted downgrade', () => {
    expect(CLASS_LABEL['agent.allow_list']).toBe('Change where an agent works');
    expect(P.classes['agent.allow_list']?.mode).toBe('decide');
    expect(isStaffingClass('agent.allow_list')).toBe(true);
    expect(evaluatePolicy(P, 'agent.allow_list', base).verdict).toBe('allow');
    expect(evaluatePolicy(P, 'agent.allow_list', { ...base, untrustedOrigin: true }).verdict).toBe(
      'recommend',
    );
  });
});
