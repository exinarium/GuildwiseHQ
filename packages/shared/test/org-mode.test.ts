import { describe, expect, it } from 'vitest';
import {
  ActiveOrgSchema,
  canSetOrgMode,
  DEV_ONLY_ROLE_KEYS,
  isBusinessOrg,
  isDevOnlyRoleKey,
  OrgModeSchema,
  PatchOrgRequestSchema,
} from '../src/index.ts';

describe('isBusinessOrg', () => {
  it('is true only for the business mode', () => {
    expect(isBusinessOrg({ mode: 'business' })).toBe(true);
    expect(isBusinessOrg({ mode: 'dev' })).toBe(false);
    expect(isBusinessOrg({})).toBe(false);
    expect(isBusinessOrg({ mode: null })).toBe(false);
    expect(isBusinessOrg({ mode: 'something-else' })).toBe(false);
    expect(isBusinessOrg(null)).toBe(false);
    expect(isBusinessOrg(undefined)).toBe(false);
  });
});

describe('dev-only roles', () => {
  it('lists the builder, reviewers, tester and DevOps, and nothing else', () => {
    expect([...DEV_ONLY_ROLE_KEYS].sort()).toEqual([
      'builder',
      'devops',
      'pre_reviewer',
      'reviewer',
      'tester',
    ]);
    expect(isDevOnlyRoleKey('builder')).toBe(true);
    expect(isDevOnlyRoleKey('architect')).toBe(false);
    expect(isDevOnlyRoleKey('ba')).toBe(false);
  });
});

describe('the mode on the wire', () => {
  const org = {
    id: '8f1d2c3a-0000-4000-8000-000000000001',
    name: 'Acme',
    role: 'owner',
    status: 'active',
    plan: 'founding',
    planName: 'Founding',
    features: {},
    banners: [],
    gate: null,
  };
  it('an organization without a mode parses as dev (additive for older servers)', () => {
    expect(ActiveOrgSchema.parse(org).mode).toBe('dev');
    expect(ActiveOrgSchema.parse({ ...org, mode: 'business' }).mode).toBe('business');
  });
  it('PATCH /api/org accepts the mode alone and rejects an unknown one', () => {
    expect(PatchOrgRequestSchema.safeParse({ mode: 'business' }).success).toBe(true);
    expect(PatchOrgRequestSchema.safeParse({ mode: 'weird' }).success).toBe(false);
    expect(PatchOrgRequestSchema.safeParse({}).success).toBe(false);
    expect(OrgModeSchema.options).toEqual(['dev', 'business']);
  });
  it('only an Owner or Admin sets it', () => {
    expect(canSetOrgMode({ orgRole: 'owner' })).toBe(true);
    expect(canSetOrgMode({ orgRole: 'admin' })).toBe(true);
    expect(canSetOrgMode({ orgRole: 'member' })).toBe(false);
  });
});
