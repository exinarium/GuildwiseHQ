import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  codeWorkflowV6,
  codeWorkflowV7,
  DESIGN_GATE_STAGE,
  designGateDecision,
  designHighRiskPredicate,
  designRiskPaths,
  getBuiltinWorkflow,
  pathsInText,
  resolveOutcome,
  validateWorkflow,
  workflowHasDesignGate,
} from '../src/index.ts';

describe('code v7: the design gate stage', () => {
  it('is the newest code, valid, and v6 plus one approval stage between Investigate & design and Build', () => {
    expect(getBuiltinWorkflow('code')).toBe(codeWorkflowV7);
    expect(validateWorkflow(codeWorkflowV7, BUILTIN_ROLES)).toEqual([]);
    const ids = codeWorkflowV7.stages.map((s) => s.id);
    const v6 = codeWorkflowV6.stages.map((s) => s.id);
    expect(ids).toEqual([
      ...v6.slice(0, v6.indexOf('investigate') + 1),
      DESIGN_GATE_STAGE,
      ...v6.slice(v6.indexOf('build')),
    ]);
    const gate = codeWorkflowV7.stages.find((s) => s.id === DESIGN_GATE_STAGE);
    expect(gate).toMatchObject({
      kind: 'human',
      column: 'Design',
      human: { purpose: 'approval', approver: { kind: 'project_owner' } },
      when: { field: 'designGate', equals: true },
    });
    // v6 keeps its owner approval stage and is unchanged
    expect(codeWorkflowV7.stages.some((s) => s.id === 'owner_approval')).toBe(true);
    expect(workflowHasDesignGate(codeWorkflowV7)).toBe(true);
    expect(workflowHasDesignGate(codeWorkflowV6)).toBe(false);
  });

  it('design hand-off goes to Build with the gate off and to the gate with it on; approve -> build, return -> investigate', () => {
    const card = { investigationOnly: false, designNeeded: true };
    expect(
      resolveOutcome(codeWorkflowV7, { ...card, designGate: false }, 'investigate', 'handoff').toStage,
    ).toBe('build');
    expect(resolveOutcome(codeWorkflowV7, card, 'investigate', 'handoff').toStage).toBe('build');
    expect(
      resolveOutcome(codeWorkflowV7, { ...card, designGate: true }, 'investigate', 'handoff').toStage,
    ).toBe(DESIGN_GATE_STAGE);
    expect(
      resolveOutcome(codeWorkflowV7, { ...card, designGate: true }, DESIGN_GATE_STAGE, 'approve').toStage,
    ).toBe('build');
    expect(
      resolveOutcome(codeWorkflowV7, { ...card, designGate: true }, DESIGN_GATE_STAGE, 'send_back').toStage,
    ).toBe('investigate');
    // investigation-only cards still report to finalize
    expect(
      resolveOutcome(codeWorkflowV7, { investigationOnly: true, designNeeded: true }, 'investigate', 'report')
        .toStage,
    ).toBe('finalize');
  });
});

describe('pathsInText', () => {
  it('finds path tokens and skips URLs and plain words', () => {
    expect(
      pathsInText(
        'Touches apps/server/src/db/pool.ts, packages/shared/src/orgs/ and docs/USER-GUIDE.md. See https://x.io/a/b',
      ),
    ).toEqual(['apps/server/src/db/pool.ts', 'packages/shared/src/orgs/', 'docs/USER-GUIDE.md']);
    expect(pathsInText('apps/server/src/db/** and ./apps/web')).toEqual(['apps/server/src/db/', 'apps/web']);
    expect(pathsInText('no paths here, 1/2')).toEqual([]);
    expect(pathsInText(null)).toEqual([]);
  });
});

describe('designRiskPaths', () => {
  it('derives high-risk paths from every source, folder tokens included, docs and tests exempt', () => {
    expect(designRiskPaths({ affectedAreas: 'apps/server: apps/server/src/db for the pool' })).toEqual([
      'apps/server/src/db',
    ]);
    expect(designRiskPaths({ planningNote: 'add apps/server/migrations/0300_x.sql' })).toEqual([
      'apps/server/migrations/0300_x.sql',
    ]);
    expect(designRiskPaths({ designSummary: 'edit apps/server/src/auth/login.ts' })).toEqual([
      'apps/server/src/auth/login.ts',
    ]);
    expect(designRiskPaths({ cardBrief: 'apps/web/src/billing/' })).toEqual(['apps/web/src/billing']);
    expect(
      designRiskPaths({
        affectedAreas:
          'apps/web/src/components/Panel.tsx, docs/auth/guide.md, apps/server/test/auth/x.test.ts',
      }),
    ).toEqual([]);
  });

  it('only adds paths: duplicates collapse, and the matcher is injectable', () => {
    expect(
      designRiskPaths({ affectedAreas: 'apps/server/src/db', designSummary: 'apps/server/src/db/ again' }),
    ).toEqual(['apps/server/src/db']);
    expect(designRiskPaths({ affectedAreas: 'apps/web/src/x.ts' }, (p) => p.startsWith('apps/web/'))).toEqual(
      ['apps/web/src/x.ts'],
    );
  });

  it("uses the project's path-to-risk map when it has one, the built-in rules otherwise", () => {
    const builtIn = designHighRiskPredicate(null);
    expect(builtIn('apps/server/src/db/pool.ts')).toBe(true);
    expect(designHighRiskPredicate([])('apps/server/src/db/pool.ts')).toBe(true);
    const map = designHighRiskPredicate([
      { pattern: 'apps/web/src/billing', risk: 'high' },
      { pattern: 'apps/server/src/db', risk: 'medium' },
    ]);
    expect(map('apps/web/src/billing/x')).toBe(true);
    expect(map('apps/server/src/db/pool.ts')).toBe(false);
    expect(map('apps/web/src/components/x')).toBe(false);
    expect(
      designRiskPaths(
        { affectedAreas: 'apps/server/src/db/pool.ts and apps/web/src/billing/' },
        designHighRiskPredicate([{ pattern: 'apps/web/src/billing/**', risk: 'high' }]),
      ),
    ).toEqual(['apps/web/src/billing']);
  });
});

describe('designGateDecision', () => {
  it('high risk > card switch > project setting > off', () => {
    expect(designGateDecision({ projectGate: false, cardGate: false, highRiskPaths: [] })).toEqual({
      required: false,
      reason: 'off',
    });
    expect(designGateDecision({ projectGate: true, cardGate: false, highRiskPaths: [] })).toEqual({
      required: true,
      reason: 'project',
    });
    expect(designGateDecision({ projectGate: true, cardGate: true, highRiskPaths: [] })).toEqual({
      required: true,
      reason: 'card',
    });
    expect(
      designGateDecision({ projectGate: false, cardGate: false, highRiskPaths: ['apps/server/src/db'] }),
    ).toEqual({
      required: true,
      reason: 'high_risk',
    });
  });
});
