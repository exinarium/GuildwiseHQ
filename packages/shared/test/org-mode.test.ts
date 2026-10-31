import { describe, expect, it } from 'vitest';
import {
  ActiveOrgSchema,
  canSetOrgMode,
  DEV_ONLY_ROLE_KEYS,
  effectiveView,
  isBusinessOrg,
  isBusinessView,
  OrgModeSchema,
  SetMemberViewRequestSchema,
  isDevOnlyRoleKey,
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

describe('views: a user override beats the organization default', () => {
  it('falls back to the organization default when the member has no override', () => {
    expect(effectiveView({ mode: 'business' })).toBe('business');
    expect(effectiveView({ mode: 'dev', viewOverride: null })).toBe('dev');
    expect(effectiveView(null)).toBe('dev');
  });
  it('the override wins in both directions', () => {
    expect(effectiveView({ mode: 'dev', viewOverride: 'business' })).toBe('business');
    expect(effectiveView({ mode: 'business', viewOverride: 'dev' })).toBe('dev');
    expect(isBusinessView({ mode: 'business', viewOverride: 'dev' })).toBe(false);
    expect(isBusinessView({ mode: 'dev', viewOverride: 'business' })).toBe(true);
  });
  it('the organization default alone is not the view', () => {
    expect(isBusinessOrg({ mode: 'business', viewOverride: 'dev' })).toBe(true);
  });
  it('PUT /api/org/view takes a view or null, nothing else', () => {
    expect(SetMemberViewRequestSchema.safeParse({ view: 'business' }).success).toBe(true);
    expect(SetMemberViewRequestSchema.safeParse({ view: null }).success).toBe(true);
    expect(SetMemberViewRequestSchema.safeParse({ view: 'x' }).success).toBe(false);
  });
  it('an active org without an override parses as null', () => {
    const org = ActiveOrgSchema.parse({
      id: '8f1d2c3a-0000-4000-8000-000000000001',
      name: 'Acme',
      role: 'owner',
      status: 'active',
      plan: 'founding',
      planName: 'Founding',
      features: {},
      banners: [],
    });
    expect(org.viewOverride).toBeNull();
  });
});
