import { describe, expect, it } from 'vitest';
import {
  BRIEF_OWNER_ROLES,
  BRIEF_PLAYBOOKS,
  BUSINESS_DUE_FIELDS,
  BUSINESS_ROLES,
  briefPlaybookCron,
  briefPlaybookTemplate,
  briefWorkflow,
  briefWorkflowKey,
  CardTemplateSchema,
  InstallBriefPlaybookRequestSchema,
  isBriefWorkflowKey,
  validateCustomWorkflow,
  workflowUsesRepos,
} from '../src/index.ts';
import { BUILTIN_WORKFLOWS } from '../src/workflows/builtin/index.ts';

const ctx = { builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key), departments: [] };

describe('Brief workflow', () => {
  for (const role of BRIEF_OWNER_ROLES) {
    it(`validates for ${role} and has no repo, branch, build, review or merge step`, () => {
      const def = briefWorkflow(role);
      const issues = validateCustomWorkflow(def, BUSINESS_ROLES, ctx);
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(workflowUsesRepos(def)).toBe(false);
      expect(def.cardTypes).toEqual(['report']);
      for (const s of def.stages) {
        expect(s.worktree).toBe('none');
        expect(s.environment).toBe('none');
        expect(s.rebaseBefore).toBe(false);
        expect(s.syncMainBefore).toBe(false);
        expect(s.requireBuildEvidence).toBeFalsy();
        expect(s.kind === 'human').toBe(false); // no approval step
        for (const o of s.outcomes) {
          expect(['StageCompleted', 'CardSpecified']).toContain(o.event);
          expect(o.effect).toBe('none');
        }
      }
      expect(def.stages.map((s) => s.id)).toEqual(['request', 'brief', 'done']);
      expect(def.stages[1]?.claimRole).toBe(role);
    });
  }

  it('names the key per role and recognises it', () => {
    expect(briefWorkflowKey('personal_assistant')).toBe('business-brief-personal-assistant');
    expect(isBriefWorkflowKey('business-brief-billing-clerk')).toBe(true);
    expect(isBriefWorkflowKey('business-report')).toBe(false);
    expect(isBriefWorkflowKey(null)).toBe(false);
  });
});

describe('Brief playbooks', () => {
  it('build crons and templates that parse', () => {
    const m = BRIEF_PLAYBOOKS.morning_plan;
    const w = BRIEF_PLAYBOOKS.weekly_owner_brief;
    expect(briefPlaybookCron(m, '07:00')).toBe('0 7 * * 1-5');
    expect(briefPlaybookCron(m, '08:30', 3)).toBe('30 8 * * 1-5');
    expect(briefPlaybookCron(w, '07:00')).toBe('0 7 * * 1');
    expect(briefPlaybookCron(w, '16:05', 5)).toBe('5 16 * * 5');
    for (const p of [m, w]) {
      const t = CardTemplateSchema.parse(briefPlaybookTemplate(p, p.defaultOwnerRole));
      expect(t.workflowKey).toBe(briefWorkflowKey(p.defaultOwnerRole));
      expect(t.fields).toMatchObject({ requirements: p.requirements, maxWords: p.maxWords });
      expect(BRIEF_OWNER_ROLES).toContain(p.defaultOwnerRole);
    }
    expect(briefPlaybookTemplate(m, 'billing_clerk', 90).fields.maxWords).toBe(90);
  });

  it('defaults follow the design', () => {
    expect(BRIEF_PLAYBOOKS.morning_plan).toMatchObject({
      defaultOwnerRole: 'personal_assistant',
      maxWords: 150,
    });
    expect(BRIEF_PLAYBOOKS.weekly_owner_brief).toMatchObject({
      defaultOwnerRole: 'operations_analyst',
      maxWords: 300,
      defaultWeekday: 1,
    });
  });

  it('the install request needs destinations and limits the owner role', () => {
    const dest = [{ kind: 'webhook', url: 'https://example.com/h', format: 'generic' }];
    expect(InstallBriefPlaybookRequestSchema.safeParse({ destinations: dest }).success).toBe(true);
    expect(InstallBriefPlaybookRequestSchema.safeParse({ destinations: [] }).success).toBe(false);
    expect(
      InstallBriefPlaybookRequestSchema.safeParse({ destinations: dest, ownerRole: 'front_desk' }).success,
    ).toBe(false);
    expect(InstallBriefPlaybookRequestSchema.safeParse({ destinations: dest, time: '25:00' }).success).toBe(
      false,
    );
  });

  it('lists the due field of each business type', () => {
    expect(BUSINESS_DUE_FIELDS).toMatchObject({
      follow_up: 'dueDate',
      reminder: 'remindOn',
      quote: 'validUntil',
    });
  });
});
