import { describe, expect, it } from 'vitest';
import {
  CreateProjectRequestSchema,
  DomainEventSchema,
  InterestBodySchema,
  RankProjectsRequestSchema,
  VaultMergeCommandSchema,
} from '../src/index.ts';

const U = (n: number) => `0192f3a0-0000-7000-8000-00000000000${n}`;

describe('projects are ranked, not typed by domain and tier', () => {
  it('a create request no longer takes a domain or a tier (they are ignored)', () => {
    const r = CreateProjectRequestSchema.parse({
      key: 'WEB',
      name: 'Web',
      domain: 'personal',
      priorityTier: 1,
    });
    expect(r).not.toHaveProperty('domain');
    expect(r).not.toHaveProperty('priorityTier');
  });

  it('a ranking request names projects once each, at least one', () => {
    expect(RankProjectsRequestSchema.safeParse({ projectIds: [U(1), U(2)] }).success).toBe(true);
    expect(RankProjectsRequestSchema.safeParse({ projectIds: [] }).success).toBe(false);
    expect(RankProjectsRequestSchema.safeParse({ projectIds: ['x'] }).success).toBe(false);
  });

  it('ProjectsRanked parses, with the reason defaulting to manual', () => {
    const e = DomainEventSchema.parse({
      type: 'ProjectsRanked',
      payload: { orgId: U(1), projectIds: [U(2)] },
    });
    expect(e.type === 'ProjectsRanked' && e.payload.reason).toBe('manual');
  });

  it('events written before the ranking still replay: ProjectCreated and ProjectUpdated with a domain and a tier', () => {
    const created = DomainEventSchema.safeParse({
      type: 'ProjectCreated',
      payload: {
        projectId: U(1),
        orgId: U(2),
        key: 'OLD',
        name: 'Old',
        domain: 'personal',
        workflowKey: 'code',
        priorityTier: 3,
        branchPrefix: 'aom/',
        workingBranch: 'main',
        subCategories: [],
        vaultFolder: null,
      },
    });
    expect(created.success).toBe(true);
    const updated = DomainEventSchema.safeParse({
      type: 'ProjectUpdated',
      payload: { projectId: U(1), changes: { domain: 'work', priorityTier: 1, name: 'Renamed' } },
    });
    expect(updated.success).toBe(true);
    const interest = InterestBodySchema.safeParse({
      interestId: U(3),
      orgId: U(2),
      name: 'Old interest',
      status: 'active',
      domain: 'personal',
    });
    expect(interest.success).toBe(true);
  });
});

describe('vaults without the work/personal kinds', () => {
  const reg = (kind: string) =>
    DomainEventSchema.safeParse({
      type: 'VaultRegistered',
      payload: {
        vaultId: U(1),
        orgId: U(2),
        kind,
        name: 'v',
        remoteUrl: 'git@x:y.git',
        syncIntervalSec: 300,
      },
    }).success;
  it('accepts the old kinds in events and the new organization kind', () => {
    for (const k of ['org', 'work', 'personal', 'project']) expect(reg(k), k).toBe(true);
    expect(reg('other')).toBe(false);
  });

  it('VaultMerged names the vault merged and where it went (null: it became the organization vault)', () => {
    for (const into of [U(2), null])
      expect(
        DomainEventSchema.safeParse({
          type: 'VaultMerged',
          payload: { vaultId: U(1), orgId: U(3), intoVaultId: into, folder: 'personal' },
        }).success,
      ).toBe(true);
  });

  it('vault.merge carries the source URL, the target folder and the lifted folders', () => {
    const c = VaultMergeCommandSchema.parse({
      vaultId: 'org1',
      from: { vaultId: 'pers1', remoteUrl: 'git@x:personal.git' },
      into: 'personal',
      commitMessage: 'aom: merge',
    });
    expect(c).toMatchObject({ lift: [], push: true });
    expect(
      VaultMergeCommandSchema.safeParse({ ...c, from: { vaultId: '../x', remoteUrl: 'u' } }).success,
    ).toBe(false);
  });
});
