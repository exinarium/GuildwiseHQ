import { describe, expect, it } from 'vitest';
import {
  BUSINESS_CARD_TYPES,
  BUSINESS_PREPARE_ROLE,
  BUSINESS_ROLE_KEYS,
  BUSINESS_ROLES,
  BUSINESS_WORKFLOW_KEY,
  BUSINESS_WORKFLOWS,
  CardType,
  isBusinessCardType,
  validateCustomWorkflow,
  workflowUsesRepos,
} from '../src/index.ts';
import { BUILTIN_WORKFLOWS } from '../src/workflows/builtin/index.ts';

const ctx = { builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key), departments: [] };

describe('business card types', () => {
  it('are part of CardType, additively', () => {
    for (const t of BUSINESS_CARD_TYPES) expect(CardType.options).toContain(t);
    for (const t of ['feature', 'bug', 'support', 'refactor', 'docs', 'research', 'feed', 'regression'])
      expect(CardType.options).toContain(t);
    expect(isBusinessCardType('quote')).toBe(true);
    expect(isBusinessCardType('feature')).toBe(false);
    expect(isBusinessCardType(null)).toBe(false);
  });

  it('every type has a workflow, a role and a distinct key', () => {
    expect(BUSINESS_WORKFLOWS).toHaveLength(6);
    expect(new Set(Object.values(BUSINESS_WORKFLOW_KEY)).size).toBe(6);
    for (const t of BUSINESS_CARD_TYPES) expect(BUSINESS_ROLE_KEYS).toContain(BUSINESS_PREPARE_ROLE[t]);
  });

  it('maps each type to the role fixed by the design', () => {
    expect(BUSINESS_PREPARE_ROLE).toEqual({
      enquiry: 'front_desk',
      follow_up: 'follow_up_assistant',
      document_request: 'compliance_officer',
      report: 'operations_analyst',
      reminder: 'compliance_officer',
      quote: 'front_desk',
    });
  });
});

describe.each(BUSINESS_WORKFLOWS.map((d) => [d.key, d] as const))('default workflow %s', (_k, def) => {
  it('passes validateCustomWorkflow', () => {
    const errors = validateCustomWorkflow(def, BUSINESS_ROLES, ctx).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('has no repository, branch, build, review or merge stage', () => {
    expect(workflowUsesRepos(def)).toBe(false);
    for (const s of def.stages) {
      expect(s.worktree).toBe('none');
      expect(s.environment).toBe('none');
      expect(s.rebaseBefore).toBe(false);
      expect(s.syncMainBefore).toBe(false);
      expect(s.kind).not.toBe('server');
      expect(['builder', 'reviewer', 'pre_reviewer', 'tester', 'devops']).not.toContain(s.claimRole);
      for (const o of s.outcomes) {
        expect(['StageCompleted', 'CardSpecified']).toContain(o.event);
        expect(o.effect).toBe('none');
      }
    }
  });

  it('runs request -> prepare -> approve -> done and requires the required fields on prepare', () => {
    expect(def.stages.map((s) => s.id)).toEqual(['request', 'prepare', 'approve', 'done']);
    const prepare = def.stages[1];
    expect(prepare?.requiredFields).toEqual(def.customFields.filter((f) => f.required).map((f) => f.key));
    expect(def.stages[2]?.human?.approver).toEqual({ kind: 'starter' });
    expect(def.stages[2]?.outcomes.map((o) => [o.id, o.to])).toEqual([
      ['approve', 'done'],
      ['send_back', 'prepare'],
    ]);
    expect(def.cardTypes).toHaveLength(1);
  });
});

describe('business card fields', () => {
  const keys = (t: (typeof BUSINESS_CARD_TYPES)[number]) =>
    BUSINESS_WORKFLOWS.find((w) => w.key === BUSINESS_WORKFLOW_KEY[t])?.customFields.map((f) => f.key);
  it('match the field lists of the design', () => {
    expect(keys('enquiry')).toEqual(['whoAsked', 'channel', 'question', 'dueBy']);
    expect(keys('follow_up')).toEqual(['person', 'about', 'dueDate', 'linkedCard']);
    expect(keys('document_request')).toEqual(['document', 'fromWhom', 'deadline']);
    expect(keys('reminder')).toEqual(['what', 'remindOn', 'forWhom']);
    expect(keys('report')).toEqual(['subject', 'period', 'audience']);
    expect(keys('quote')).toEqual(['customer', 'scope', 'amount', 'validUntil']);
  });
  it('mark dates with the date format', () => {
    const quote = BUSINESS_WORKFLOWS.find((w) => w.key === 'business-quote');
    expect(quote?.customFields.find((f) => f.key === 'validUntil')?.format).toBe('date');
    expect(quote?.customFields.find((f) => f.key === 'amount')?.type).toBe('number');
  });
});
