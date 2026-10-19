import { describe, expect, it } from 'vitest';
import {
  ACTION_CLASSES,
  agreementScores,
  clonePolicy,
  DEFAULT_CEO_POLICY,
  deskMode,
  evaluatePolicy,
  extendTraining,
  graduate,
  isStaffingClass,
  OWNER_RESERVED_KEYS,
  reservedKeyOfDesk,
  STAFFING_CLASSES,
  startTraining,
  sumScores,
  trainingDaysLeft,
  withDelegation,
} from '../src/index.ts';

const P = DEFAULT_CEO_POLICY;
const base = { confidence: 0.9 };

describe('the default policy', () => {
  it('gives every action class a mode', () => {
    for (const c of ACTION_CLASSES) expect(P.classes[c], c).toBeDefined();
  });

  it('lets the CEO decide the safe operational classes and recommends the risky ones', () => {
    for (const c of [
      'card.release',
      'card.release_backoff',
      'card.reprioritise',
      'shift.stop',
      'agent.pause',
      'devops.request',
      'notify.owner',
    ])
      expect(evaluatePolicy(P, c, base).verdict, c).toBe('allow');
    for (const c of ['card.cancel', 'agent.retire', 'devops.approve', 'standing_order.activate'])
      expect(evaluatePolicy(P, c, base).verdict, c).toBe('recommend');
  });

  it('decides agent questions only for the desk kinds the policy maps to decide', () => {
    expect(deskMode(P, 'question', null)).toBe('decide');
    expect(deskMode(P, 'question', 'manual_qa')).toBe('recommend');
    expect(deskMode(P, 'approval', 'large_merge')).toBe('recommend');
    expect(deskMode(P, 'alert', 'loop_backoff')).toBe('decide');
    expect(
      evaluatePolicy(P, 'desk.answer_question', { ...base, deskMode: deskMode(P, 'question', 'manual_qa') })
        .verdict,
    ).toBe('recommend');
  });
});

describe('the gate', () => {
  it('owner-reserved matters are recommendations unless delegated', () => {
    const r = evaluatePolicy(P, 'desk.answer_question', { ...base, reservedKey: 'manual_qa' });
    expect(r).toMatchObject({ verdict: 'recommend', cause: 'reserved' });
    const delegated = withDelegation(P, 'manual_qa', true);
    expect(
      evaluatePolicy(delegated, 'desk.answer_question', { ...base, reservedKey: 'manual_qa' }).verdict,
    ).toBe('allow');
    expect(
      evaluatePolicy(withDelegation(delegated, 'manual_qa', false), 'desk.answer_question', {
        ...base,
        reservedKey: 'manual_qa',
      }).verdict,
    ).toBe('recommend');
    expect(P.delegated).toEqual(['working_branch']); // the only default delegation
  });

  it("working-branch questions are the CEO's to decide by default, and the owner can take them back", () => {
    const key = reservedKeyOfDesk('question', 'working_branch');
    expect(key).toBe('working_branch');
    expect(
      evaluatePolicy(P, 'desk.answer_question', { ...base, reservedKey: key, deskMode: 'decide' }).verdict,
    ).toBe('allow');
    expect(
      evaluatePolicy(withDelegation(P, 'working_branch', false), 'desk.answer_question', {
        ...base,
        reservedKey: key,
      }),
    ).toMatchObject({ verdict: 'recommend', cause: 'reserved' });
  });

  it('maps desk items to their reserved key', () => {
    expect(reservedKeyOfDesk('alert', 'manual_qa')).toBe('manual_qa');
    expect(reservedKeyOfDesk('approval', 'large_merge')).toBe('finalize_merge');
    expect(reservedKeyOfDesk('approval', 'devops')).toBe('devops_destructive');
    expect(reservedKeyOfDesk('question', null)).toBeNull();
    for (const k of OWNER_RESERVED_KEYS) expect(typeof k).toBe('string');
  });

  it('a confidence below the threshold, a missing citation and a reached limit downgrade to a recommendation', () => {
    expect(evaluatePolicy(P, 'card.release', { confidence: 0.5 })).toMatchObject({
      verdict: 'recommend',
      cause: 'confidence',
    });
    expect(evaluatePolicy(P, 'desk.answer_question', { ...base, evidenceMissing: true })).toMatchObject({
      verdict: 'recommend',
      cause: 'evidence',
    });
    expect(evaluatePolicy(P, 'card.release', { ...base, limitReached: '3 per day' })).toMatchObject({
      verdict: 'recommend',
      cause: 'limit',
    });
  });

  it('text from outside cannot cause staffing, standing orders or memories', () => {
    for (const c of ['agent.hire', 'agent.change_model', 'standing_order.propose', 'memory.write'])
      expect(evaluatePolicy(P, c, { ...base, untrustedOrigin: true }), c).toMatchObject({
        verdict: 'recommend',
        cause: 'untrusted',
      });
    expect(evaluatePolicy(P, 'card.release', { ...base, untrustedOrigin: true }).verdict).toBe('allow');
  });

  it('never-mode and hard-never classes are refused, and an unknown class too', () => {
    const p = clonePolicy(P);
    p.classes['card.release'] = { mode: 'never', delayMinutes: 0 };
    expect(evaluatePolicy(p, 'card.release', base).verdict).toBe('deny');
    for (const c of [
      'ceo.policy',
      'budget.raise',
      'budget.override',
      'billing',
      'secrets',
      'agent.widen_permissions',
      'devops.fire',
    ])
      expect(evaluatePolicy(P, c, { confidence: 1, ...{ reservedKey: null } }), c).toMatchObject({
        verdict: 'deny',
        cause: 'never',
      });
    expect(evaluatePolicy(P, 'made.up', base).verdict).toBe('deny');
    expect(evaluatePolicy(P, 'card.release', { ...base, deskMode: 'never' }).verdict).toBe('deny');
  });
});

describe('the training period forces recommendations on staffing', () => {
  it('whatever the table says, staffing and model changes are recommendations while training is on', () => {
    expect(STAFFING_CLASSES.length).toBeGreaterThan(5);
    const allDecide = clonePolicy(P);
    for (const c of STAFFING_CLASSES) allDecide.classes[c] = { mode: 'decide', delayMinutes: 0 };
    for (const c of STAFFING_CLASSES) {
      expect(evaluatePolicy(allDecide, c, { ...base, training: true }), c).toMatchObject({
        verdict: 'recommend',
        cause: 'training',
      });
      expect(evaluatePolicy(allDecide, c, { ...base, training: false }).verdict, c).toBe('allow');
    }
    expect(isStaffingClass('agent.pause')).toBe(false);
    expect(evaluatePolicy(P, 'agent.pause', { ...base, training: true }).verdict).toBe('allow');
    expect(evaluatePolicy(P, 'card.release', { ...base, training: true }).verdict).toBe('allow');
  });

  it('a hard never stays a denial during training', () => {
    expect(evaluatePolicy(P, 'budget.raise', { ...base, training: true }).verdict).toBe('deny');
  });
});

describe('training state and agreement', () => {
  const now = new Date('2026-10-14T10:00:00Z');
  it('starts for 14 days, can be extended and ends when the owner graduates', () => {
    const t = startTraining(now);
    expect(t.on).toBe(true);
    expect(trainingDaysLeft(t, now)).toBe(14);
    expect(trainingDaysLeft(t, new Date(now.getTime() + 10 * 86_400_000))).toBe(4);
    const late = new Date(now.getTime() + 20 * 86_400_000);
    expect(trainingDaysLeft(t, late)).toBe(0);
    expect(t.on).toBe(true); // still training: only graduating ends it
    const ext = extendTraining(t, late);
    expect(ext.extensions).toBe(1);
    expect(trainingDaysLeft(ext, late)).toBe(7);
    const g = graduate(ext, late);
    expect(g).toMatchObject({ on: false });
    expect(g.graduatedAt).toBe(late.toISOString());
    expect(trainingDaysLeft(g, late)).toBe(0);
  });

  it('scores agreement per class: only an accepted recommendation counts as agreed', () => {
    const scores = agreementScores([
      { class: 'agent.hire', response: 'accepted' },
      { class: 'agent.hire', response: 'rejected' },
      { class: 'agent.hire', response: 'accepted_changed' },
      { class: 'agent.change_model', response: 'accepted' },
      { class: 'desk.answer_question', response: 'different' },
    ]);
    expect(scores.find((s) => s.class === 'agent.hire')).toEqual({
      class: 'agent.hire',
      agreed: 1,
      total: 3,
    });
    expect(sumScores(scores)).toEqual({ agreed: 2, total: 5 });
    expect(scores[0]!.class).toBe('agent.hire'); // most answered first
  });
});
