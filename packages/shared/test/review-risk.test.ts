import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  CardDtoSchema,
  DomainEventSchema,
  effortBelowRoleMinimum,
  QA_FOCUS_MAX,
  REWORK_REASON_LABEL,
  REWORK_STANDING_ORDER,
  ReviewData,
  ReworkReason,
  RISK_ANALYSIS_MAX,
  renderShiftPrompt,
  StoredReviewRisk,
} from '../src/index.ts';
import { buildBrief, reworkReviewBrief, U } from './fixtures.ts';

describe('review risk schemas (backlog #70)', () => {
  it('accepts a review without risk (an older runner)', () => {
    expect(ReviewData.parse({ score: 4 })).toEqual({ score: 4 });
  });

  it('keeps the risk fields and caps their size', () => {
    const ok = ReviewData.parse({
      score: 4,
      risk: 'high',
      riskAnalysis: '## Blast radius',
      qaFocus: 'Try X',
    });
    expect(ok).toMatchObject({ risk: 'high', riskAnalysis: '## Blast radius', qaFocus: 'Try X' });
    expect(ReviewData.safeParse({ score: 4, risk: 'extreme' }).success).toBe(false);
    expect(ReviewData.safeParse({ score: 4, riskAnalysis: 'x'.repeat(RISK_ANALYSIS_MAX + 1) }).success).toBe(
      false,
    );
    expect(ReviewData.safeParse({ score: 4, qaFocus: 'x'.repeat(QA_FOCUS_MAX + 1) }).success).toBe(false);
  });

  it('knows the regression_risk rework reason', () => {
    expect(ReworkReason.safeParse('regression_risk').success).toBe(true);
    expect(REWORK_REASON_LABEL.regression_risk).toBeTruthy();
    expect(REWORK_STANDING_ORDER.regression_risk).toBeTruthy();
  });

  it('stores unknown for a missing risk', () => {
    expect(StoredReviewRisk.options).toContain('unknown');
  });

  it('parses ReviewApproved events with and without risk fields', () => {
    const base = {
      cardId: U.a,
      reviewerAgentId: U.b,
      score: 4,
      comments: 'ok',
      approvalsSoFar: 1,
      approvalsRequired: 1,
      toStage: 'test',
    };
    const env = { v: 1, id: U.e, ts: '2026-10-03T12:00:00.000Z', type: 'ReviewApproved' };
    expect(DomainEventSchema.safeParse({ ...env, payload: base }).success).toBe(true);
    const withRisk = DomainEventSchema.safeParse({
      ...env,
      payload: { ...base, risk: 'high', riskAnalysis: 'a', qaFocus: 'b' },
    });
    expect(withRisk.success).toBe(true);
  });

  it('exposes reviewRisk on the card DTO as optional', () => {
    expect(CardDtoSchema.shape.reviewRisk.safeParse(undefined).success).toBe(true);
    expect(
      CardDtoSchema.shape.reviewRisk.safeParse({ level: 'high', analysis: 'a', qaFocus: 'b' }).success,
    ).toBe(true);
  });
});

describe('reviewer role v3', () => {
  const role = BUILTIN_ROLES.find((r) => r.key === 'reviewer')!;

  it('is version 3 and keeps high effort', () => {
    expect(role.version).toBe(7);
    expect(role.defaultModel.effort).toBe('high');
  });

  it('asks for an adversarial pass and a risk analysis, and the new report flags', () => {
    const text = role.instructions;
    for (const phrase of [
      'Adversarial pass',
      'Risk analysis',
      'Blast radius',
      'Failure scenarios',
      'Verified',
      'Unverified',
      'Mitigations',
      'you never build or test it',
      'NEVER in the worktree',
      '--risk <low|medium|high>',
      '--risk-file',
      '--qa-focus',
      'regression_risk',
      'Do not nit-pick',
    ])
      expect(text).toContain(phrase);
    expect(role.coreRules.join('\n')).toContain('--risk-file');
  });
});

describe('protected effort', () => {
  it('flags an effort below high for reviewers only', () => {
    expect(effortBelowRoleMinimum('reviewer', 'medium')).toBe(true);
    expect(effortBelowRoleMinimum('reviewer', 'low')).toBe(true);
    expect(effortBelowRoleMinimum('reviewer', 'high')).toBe(false);
    expect(effortBelowRoleMinimum('reviewer', 'max')).toBe(false);
    expect(effortBelowRoleMinimum('reviewer', null)).toBe(false);
    expect(effortBelowRoleMinimum('builder', 'low')).toBe(false);
  });
});

describe('risk in the shift prompt', () => {
  it('review commands carry --risk and --risk-file', () => {
    const p = renderShiftPrompt(reworkReviewBrief());
    expect(p).toContain('--risk <low|medium|high> --risk-file');
  });

  it('a test stage gets the QA focus and the failure scenarios', () => {
    const b = buildBrief();
    const p = renderShiftPrompt({
      ...b,
      shift: { ...b.shift, stage: 'test', stageLabel: 'Test' },
      reviewRisk: {
        level: 'high',
        analysis: 'Scenario: retries double-charge',
        qaFocus: 'Pay twice quickly',
      },
    });
    expect(p).toContain("Reviewer's risk analysis");
    expect(p).toContain('Overall risk: HIGH');
    expect(p).toContain('Pay twice quickly');
    expect(p).toContain('retries double-charge');
    expect(p).toContain('Test the QA focus');
  });

  it('a qa_steps stage is told to write steps for the focus', () => {
    const b = buildBrief();
    const p = renderShiftPrompt({
      ...b,
      shift: { ...b.shift, stage: 'qa_steps', stageLabel: 'QA steps' },
      reviewRisk: { level: 'medium', analysis: '', qaFocus: 'Check the export' },
    });
    expect(p).toContain('Write explicit steps for the QA focus');
  });

  it('no risk, no section', () => {
    expect(renderShiftPrompt(buildBrief())).not.toContain("Reviewer's risk analysis");
  });
});
