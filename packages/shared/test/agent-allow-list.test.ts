import { describe, expect, it } from 'vitest';
import { agentAllowsProject, DomainEventSchema, HireAgentRequestSchema } from '../src/index.ts';

const U = '8f1d2c3a-0000-4000-8000-000000000001';
const V = '8f1d2c3a-0000-4000-8000-000000000002';

describe('agent allow-lists', () => {
  it('null means any project, a list means those projects only, an empty list nothing', () => {
    expect(agentAllowsProject(null, U)).toBe(true);
    expect(agentAllowsProject([U], U)).toBe(true);
    expect(agentAllowsProject([U], V)).toBe(false);
    expect(agentAllowsProject([], U)).toBe(false);
  });

  it('AgentHired from before allow-lists still parses; the new fields are optional', () => {
    const base = {
      agentId: U,
      orgId: V,
      hiredByUserId: V,
      workstationId: U,
      name: 'Ada',
      roleKey: 'builder',
      roleVersion: 1,
      seniority: 'junior',
      runtime: 'mock',
      model: 'mock',
      skills: [],
      permissions: {
        allowedTools: ['read'],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: false,
        repoIds: null,
      },
      capacity: 1,
      isDevops: false,
    };
    const parse = (payload: object) => DomainEventSchema.safeParse({ type: 'AgentHired', payload });
    expect(parse({ ...base, projectId: V }).success).toBe(true);
    expect(parse({ ...base, allowedProjectIds: null, focusProjectIds: [U] }).success).toBe(true);
    expect(parse({ ...base, allowedProjectIds: [U, V] }).success).toBe(true);
  });

  it('the new events and the hire request validate their input', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'AgentAllowedSet',
        payload: { agentId: U, projectIds: null, by: V },
      }).success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'AgentFocusSet',
        payload: { agentId: U, projectIds: Array.from({ length: 11 }, () => U), by: V },
      }).success,
    ).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        type: 'ProjectConcurrencyCapSet',
        payload: { projectId: U, cap: 0, by: V },
      }).success,
    ).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        type: 'ProjectConcurrencyCapSet',
        payload: { projectId: U, cap: null, by: V },
      }).success,
    ).toBe(true);
    const r = HireAgentRequestSchema.parse({
      name: 'A',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: U,
      allowedProjectIds: null,
    });
    expect(r.allowedProjectIds).toBeNull();
  });
});
