import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  BUSINESS_PERMISSIONS,
  BUSINESS_ROLE_KEYS,
  BUSINESS_ROLES,
  BUSINESS_SEAT_KEYS,
  businessSeatFor,
  DEV_ONLY_ROLE_KEYS,
  isBusinessRoleKey,
  PACK_SEAT_KEYS,
  RoleDefinitionSchema,
  roleListedInMode,
  roleOfferedInMode,
  suggestSeat,
  validateCustomWorkflow,
  type WorkflowDefinitionInput,
} from '../src/index.ts';

// The names exactly as the research table ("Seven business roles") gives them, in its order.
const TABLE_NAMES = [
  'Front Desk',
  'Follow-up Assistant',
  'Billing Clerk',
  'Compliance Officer',
  'Marketing & Reputation',
  'Operations Analyst',
  'Personal Assistant',
];

describe('business roles (AC 1)', () => {
  it('are the seven roles of the table, built in, in the built-in catalogue', () => {
    expect(BUSINESS_ROLES.map((r) => r.name)).toEqual(TABLE_NAMES);
    for (const r of BUSINESS_ROLES) {
      expect(RoleDefinitionSchema.safeParse(r).success).toBe(true);
      expect(r.builtIn).toBe(true);
      expect(BUILTIN_ROLES).toContain(r);
    }
  });

  it('have unique keys that collide with no other built-in or pack seat', () => {
    expect(new Set(BUSINESS_ROLE_KEYS).size).toBe(7);
    const others = BUILTIN_ROLES.filter((r) => !isBusinessRoleKey(r.key)).map((r) => r.key);
    for (const k of BUSINESS_ROLE_KEYS) {
      expect(others).not.toContain(k);
      expect((PACK_SEAT_KEYS as readonly string[]).includes(k)).toBe(false);
    }
  });

  it('carry no repository, shell, commit or builder capability', () => {
    for (const r of BUSINESS_ROLES) {
      expect(r.permissions).toEqual(BUSINESS_PERMISSIONS);
      expect(r.permissions.allowedTools).not.toContain('shell');
      expect(r.permissions.mayCommit).toBe(false);
      expect(r.permissions.writableGlobs).toEqual([]);
      expect(r.permissions.readOrgRepos).toBe(false);
    }
  });

  it('keep the existing built-in roles ahead of them, unchanged in order', () => {
    const firstBusiness = BUILTIN_ROLES.findIndex((r) => isBusinessRoleKey(r.key));
    expect(BUILTIN_ROLES.slice(firstBusiness).map((r) => r.key)).toEqual([...BUSINESS_ROLE_KEYS]);
  });
});

describe('roleOfferedInMode / roleListedInMode (AC 5)', () => {
  it('a dev organization (or no mode) is offered no business role and every other role', () => {
    for (const mode of ['dev', null, undefined]) {
      for (const k of BUSINESS_ROLE_KEYS) expect(roleOfferedInMode(k, mode)).toBe(false);
      for (const r of BUILTIN_ROLES.filter((x) => !isBusinessRoleKey(x.key)))
        expect(roleOfferedInMode(r.key, mode)).toBe(true);
    }
  });

  it('a business organization is offered the business roles and no dev-only role', () => {
    for (const k of BUSINESS_ROLE_KEYS) expect(roleOfferedInMode(k, 'business')).toBe(true);
    for (const k of DEV_ONLY_ROLE_KEYS) expect(roleOfferedInMode(k, 'business')).toBe(false);
  });

  it('lists hide only the business roles, and only from a dev organization', () => {
    expect(roleListedInMode('front_desk', 'dev')).toBe(false);
    expect(roleListedInMode('front_desk', 'business')).toBe(true);
    expect(roleListedInMode('devops', 'business')).toBe(true);
    expect(roleListedInMode('builder', 'dev')).toBe(true);
  });
});

describe('seats (AC 2)', () => {
  it('seat keys are the business role keys', () => {
    expect([...BUSINESS_SEAT_KEYS]).toEqual([...BUSINESS_ROLE_KEYS]);
  });

  it('a persona named like a business role gets that seat in a business organization only', () => {
    const a = { key: 'front-desk', name: 'Front Desk' };
    expect(businessSeatFor(a)).toBe('front_desk');
    expect(suggestSeat(a, { mode: 'business' })).toBe('front_desk');
    expect(suggestSeat(a)).toBe('own');
    expect(suggestSeat(a, { mode: 'dev' })).toBe('own');
  });

  it('a business organization seats the Operations Analyst before the dev analyst rule', () => {
    const a = { key: 'ops', name: 'Operations Analyst' };
    expect(suggestSeat(a, { mode: 'business' })).toBe('operations_analyst');
    expect(suggestSeat(a)).toBe('analyst');
  });

  it('dev suggestions are unchanged by the mode argument', () => {
    for (const a of [
      { key: 'x', name: 'Technical Writer' },
      { key: 'x', name: 'QA Lead' },
      { key: 'x', name: 'Mystery' },
    ])
      expect(suggestSeat(a)).toBe(suggestSeat(a, { mode: 'dev' }));
    expect(businessSeatFor({ key: 'x', name: 'Mystery' })).toBeNull();
  });
});

const wf = (claimRole: string, worktree: 'none' | 'create'): WorkflowDefinitionInput =>
  ({
    key: 'enquiry_flow',
    version: 1,
    name: 'Enquiry flow',
    builtIn: false,
    fieldSet: 'custom',
    customFields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
    cardTypes: ['feature'],
    initialStage: 'a',
    stages: [
      {
        id: 'a',
        label: 'a',
        column: 'a',
        kind: 'agent',
        claimRole,
        doneCriteria: 'done',
        worktree,
        outcomes: [{ id: 'done', label: 'done', kind: 'success', to: 'end', event: 'StageCompleted' }],
      },
      {
        id: 'end',
        label: 'end',
        column: 'end',
        kind: 'terminal',
        claimRole: null,
        doneCriteria: 'done',
        outcomes: [],
      },
    ],
  }) as WorkflowDefinitionInput;

describe('workflow stage owners (AC 4)', () => {
  const ctx = { builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key), departments: [] as string[] };
  const errors = (key: string, worktree: 'none' | 'create') =>
    validateCustomWorkflow(wf(key, worktree), BUILTIN_ROLES, ctx)
      .filter((i) => i.severity === 'error')
      .map((i) => i.code);

  it('accepts a repo-less stage owned by each business role', () => {
    for (const k of BUSINESS_ROLE_KEYS) expect(errors(k, 'none')).toEqual([]);
  });

  it('refuses a business role on a stage that uses a worktree', () => {
    for (const k of BUSINESS_ROLE_KEYS) expect(errors(k, 'create')).toContain('business_role_worktree');
  });

  it('does not touch the worktree rule for other roles', () => {
    expect(errors('builder', 'create')).not.toContain('business_role_worktree');
  });

  it('a catalogue without the business roles (a dev organization) gives unknown_role', () => {
    const dev = BUILTIN_ROLES.filter((r) => !isBusinessRoleKey(r.key));
    const codes = validateCustomWorkflow(wf('front_desk', 'none'), dev, ctx).map((i) => i.code);
    expect(codes).toContain('unknown_role');
  });
});
