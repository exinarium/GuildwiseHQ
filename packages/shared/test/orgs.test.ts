import { describe, expect, it } from 'vitest';
import {
  actorRank,
  canAddPeople,
  canChangeOrgRole,
  canCreateProject,
  canDirectAgentInOrg,
  canEditInterest,
  canEditSchedule,
  canHireAgentInOrg,
  canInviteOrgMember,
  canManageAgentInOrg,
  canRemoveOrgMember,
  DEFAULT_PLAN,
  DomainEventSchema,
  effectiveCreatorRank,
  effectiveFeatures,
  eventAccess,
  ORG_FEATURES,
  PLANS,
  rankOf,
} from '../src/index.ts';
import { U } from './fixtures.ts';

describe('ranks', () => {
  it('orders Owner > Admin > Member > Guest > none', () => {
    expect(rankOf('owner', false)).toBe(4);
    expect(rankOf('admin', false)).toBe(3);
    expect(rankOf('member', false)).toBe(2);
    expect(rankOf(null, true)).toBe(1);
    expect(rankOf(null, false)).toBe(0);
    expect(actorRank({ orgRole: 'admin', isGuest: true })).toBe(3);
  });
});

describe('plans', () => {
  it('has the single Founding plan without limits and with every feature on', () => {
    expect(Object.keys(PLANS)).toEqual(['founding']);
    expect(DEFAULT_PLAN).toBe('founding');
    expect(PLANS.founding.limits).toEqual({
      maxMembers: null,
      maxWorkstations: null,
      maxAgents: null,
      maxProjects: null,
    });
    for (const f of ORG_FEATURES) expect(PLANS.founding.features[f]).toBe(true);
  });
  it('applies feature overrides; null and missing fall back to the plan default', () => {
    const f = effectiveFeatures('founding', { phases: false, interests: null });
    expect(f.phases).toBe(false);
    expect(f.interests).toBe(true);
    expect(effectiveFeatures('unknown-plan', {}).research).toBe(true);
  });
});

describe('org predicates', () => {
  const o = { orgRole: 'owner' as const };
  const a = { orgRole: 'admin' as const };
  const m = { orgRole: 'member' as const };
  const g = { orgRole: null };
  it('only the Owner and Admins create projects and add people', () => {
    expect([o, a, m, g].map(canCreateProject)).toEqual([true, true, false, false]);
    expect([o, a, m, g].map(canAddPeople)).toEqual([true, true, false, false]);
  });
  it('Admins invite Members only; the Owner invites Admins, changes roles and removes Admins', () => {
    expect(canInviteOrgMember(a, 'member')).toBe(true);
    expect(canInviteOrgMember(a, 'admin')).toBe(false);
    expect(canInviteOrgMember(o, 'admin')).toBe(true);
    expect(canChangeOrgRole(a)).toBe(false);
    expect(canRemoveOrgMember(a, 'admin')).toBe(false);
    expect(canRemoveOrgMember(a, 'member')).toBe(true);
    expect(canRemoveOrgMember(o, 'owner')).toBe(false);
  });
  it('agents: O/A everything; Members and Guests their own hires and projects they are on', () => {
    expect(canHireAgentInOrg({ orgRole: 'member', projectScoped: false, projectMember: true })).toBe(false);
    expect(canHireAgentInOrg({ orgRole: 'member', projectScoped: true, projectMember: true })).toBe(true);
    expect(canHireAgentInOrg({ orgRole: null, projectScoped: true, projectMember: true })).toBe(true);
    expect(canHireAgentInOrg({ orgRole: 'admin', projectScoped: false, projectMember: false })).toBe(true);
    expect(canManageAgentInOrg({ userId: U.a, orgRole: 'member', managerUserId: U.a })).toBe(true);
    expect(canManageAgentInOrg({ userId: U.a, orgRole: 'member', managerUserId: U.b })).toBe(false);
    expect(canManageAgentInOrg({ userId: U.a, orgRole: 'admin', managerUserId: U.b })).toBe(true);
    expect(canDirectAgentInOrg({ orgRole: 'member', agentProjectId: null, projectMember: true })).toBe(false);
    expect(canDirectAgentInOrg({ orgRole: 'member', agentProjectId: U.c, projectMember: true })).toBe(true);
  });
  it('interest edit: the creator or an equal or higher rank, and only when the interest can be viewed', () => {
    expect(canEditInterest({ userId: U.a, rank: 2 }, { userId: U.b, rank: 3 }, true)).toBe(false);
    expect(canEditInterest({ userId: U.a, rank: 3 }, { userId: U.b, rank: 3 }, true)).toBe(true);
    expect(canEditInterest({ userId: U.a, rank: 1 }, { userId: U.a, rank: 4 }, true)).toBe(true);
    expect(canEditInterest({ userId: U.a, rank: 4 }, { userId: U.b, rank: 1 }, false)).toBe(false);
    // the creator's current rank counts; the stored one only when they have no relationship any more
    expect(effectiveCreatorRank(2, 3)).toBe(2);
    expect(effectiveCreatorRank(0, 3)).toBe(3);
    expect(effectiveCreatorRank(0, undefined)).toBe(1);
  });
  it('schedules: project-bound for people on the project, org-level for O/A, workstation-targeted for its user', () => {
    const base = { userId: U.a };
    expect(canEditSchedule({ ...base, orgRole: 'member' }, { projectId: U.c, projectMember: true })).toBe(
      true,
    );
    expect(canEditSchedule({ ...base, orgRole: 'member' }, { projectId: U.c, projectMember: false })).toBe(
      false,
    );
    expect(canEditSchedule({ ...base, orgRole: 'member' }, { projectId: null, projectMember: false })).toBe(
      false,
    );
    expect(canEditSchedule({ ...base, orgRole: 'admin' }, { projectId: null, projectMember: false })).toBe(
      true,
    );
    expect(
      canEditSchedule(
        { ...base, orgRole: 'member' },
        { projectId: null, projectMember: false, targetWorkstationUserId: U.a },
      ),
    ).toBe(true);
  });
});

describe('event access', () => {
  const viewer = (orgRole: 'owner' | 'admin' | 'member' | null, projects: string[] = []) => ({
    userId: U.a,
    kind: 'user' as const,
    orgRole,
    visibleProjectIds: projects,
  });
  const orgEv = { audience: 'org' as const, orgId: U.b, projectId: null };
  it('org events: full for Owner and Admin, stripped for Members, hidden from outsiders and other orgs', () => {
    expect(eventAccess(viewer('owner'), orgEv, U.b)).toBe('full');
    expect(eventAccess(viewer('admin'), orgEv, U.b)).toBe('full');
    expect(eventAccess(viewer('member'), orgEv, U.b)).toBe('stripped');
    expect(eventAccess(viewer(null), orgEv, U.b)).toBe(false);
    expect(eventAccess(viewer('owner'), orgEv, U.c)).toBe(false);
    expect(eventAccess(viewer('owner'), orgEv, null)).toBe(false);
  });
  it('project, user and admin audiences', () => {
    expect(eventAccess(viewer(null, [U.c]), { audience: 'project', orgId: U.b, projectId: U.c }, null)).toBe(
      'full',
    );
    expect(eventAccess(viewer('owner'), { audience: 'project', orgId: U.b, projectId: U.c }, U.b)).toBe(
      false,
    );
    expect(
      eventAccess(viewer(null), { audience: 'user', orgId: null, projectId: null, userId: U.a }, null),
    ).toBe('full');
    expect(
      eventAccess(viewer(null), { audience: 'user', orgId: null, projectId: null, userId: U.b }, null),
    ).toBe(false);
    expect(eventAccess(viewer('owner'), { audience: 'admin', orgId: null, projectId: null }, U.b)).toBe(
      false,
    );
  });
  it('a super admin sees the admin audience only', () => {
    const sa = { userId: U.a, kind: 'super_admin' as const, orgRole: null, visibleProjectIds: [] };
    expect(eventAccess(sa, { audience: 'admin', orgId: null, projectId: null }, null)).toBe('full');
    expect(eventAccess(sa, orgEv, U.b)).toBe(false);
    expect(eventAccess(sa, { audience: 'project', orgId: U.b, projectId: U.c }, null)).toBe(false);
    expect(eventAccess(sa, { audience: 'user', orgId: null, projectId: null, userId: U.a }, null)).toBe(
      false,
    );
  });
});

describe('organization events', () => {
  it('parses the legacy-migration OrganizationCreated and an OrgMemberAdded', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'OrganizationCreated',
        payload: {
          orgId: U.a,
          name: "Ada's organization",
          ownerUserId: U.a,
          plan: 'founding',
          status: 'active',
          limits: { maxMembers: null, maxWorkstations: null, maxAgents: null, maxProjects: null },
          features: {},
          createdVia: 'legacy_migration',
        },
      }).success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'OrgMemberAdded',
        payload: { orgId: U.a, userId: U.a, role: 'owner', via: 'migration' },
      }).success,
    ).toBe(true);
  });
  it('rejects an invalid org status and keeps secrets out of the two-factor events', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'OrgStatusChanged',
        payload: { orgId: U.a, status: 'paused', reason: 'x' },
      }).success,
    ).toBe(false);
    const ev = DomainEventSchema.parse({
      type: 'TwoFactorEnabled',
      payload: { userId: U.a, secret: 'JBSWY3DP' },
    });
    expect(JSON.stringify(ev)).not.toContain('JBSWY3DP');
  });
});
