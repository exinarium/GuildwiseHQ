import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CommandPayloadSchemas,
  DomainEventSchema,
  GraphIndexPayloadSchema,
  GraphIndexResultSchema,
  graphRepoKey,
  RunnerCommandNameSchema,
  sha256Hex,
} from '../src/index.ts';

describe('sha256Hex (browser-safe, used for ids that server and runner must agree on)', () => {
  it('matches node:crypto for short, block-sized and long inputs, and for non-ASCII text', () => {
    for (const s of [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(64),
      'x'.repeat(1000),
      'héllo wörld ✓ 日本語',
    ]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
});

describe('graphRepoKey', () => {
  it('is 12 hex digits of the SHA-256 of the normalized remote, case-insensitive and stable', () => {
    const k = graphRepoKey('github.com/acme/web');
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    expect(k).toBe(createHash('sha256').update('github.com/acme/web').digest('hex').slice(0, 12));
    expect(graphRepoKey('GitHub.com/Acme/Web ')).toBe(k);
    expect(graphRepoKey('github.com/acme/api')).not.toBe(k);
  });
});

describe('graph events and commands (nothing derived from code travels)', () => {
  const ids = {
    projectId: '0192f3a0-0000-7000-8000-000000000001',
    orgId: '0192f3a0-0000-7000-8000-000000000002',
    repoId: '0192f3a0-0000-7000-8000-000000000003',
    repoKey: graphRepoKey('github.com/acme/web'),
  };

  it('the project graph events parse, and a failure reason is one of the fixed codes', () => {
    expect(
      DomainEventSchema.safeParse({ type: 'ProjectGraphRequested', payload: { ...ids, reason: 'attached' } })
        .success,
    ).toBe(true);
    const indexed = {
      ...ids,
      commit: 'a'.repeat(40),
      files: 1,
      nodes: 2,
      edges: 3,
      modules: 1,
      indexerVersion: '0.1.32',
      durationMs: 5,
      workstationId: ids.repoId,
      vaultId: 'v1',
    };
    expect(DomainEventSchema.safeParse({ type: 'ProjectGraphIndexed', payload: indexed }).success).toBe(true);
    expect(
      DomainEventSchema.safeParse({ type: 'ProjectGraphFailed', payload: { ...ids, reason: 'no_clone' } })
        .success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'ProjectGraphFailed',
        payload: { ...ids, reason: '/home/me/src/x.ts' },
      }).success,
    ).toBe(false);
  });

  it('graph.index and graph.update are runner commands with a payload of ids, a path inside the vault and a commit', () => {
    expect(RunnerCommandNameSchema.safeParse('graph.index').success).toBe(true);
    expect(RunnerCommandNameSchema.safeParse('graph.update').success).toBe(true);
    const payload = {
      ...ids,
      remoteUrlNormalized: 'github.com/acme/web',
      repoName: 'web',
      projectKey: 'WEB',
      workingBranch: 'main',
      vault: { vaultId: 'v1', storage: 'local', kind: 'project', folder: 'projects/web' },
    };
    expect(CommandPayloadSchemas['graph.index'].safeParse(payload).success).toBe(true);
    expect(
      GraphIndexPayloadSchema.safeParse({ ...payload, fromCommit: 'abc1234', toCommit: 'def5678' }).success,
    ).toBe(true);
    expect(GraphIndexPayloadSchema.safeParse({ ...payload, repoKey: 'nope' }).success).toBe(false);
  });

  it('the runner result schema has numbers, a commit and a fixed reason, and drops everything else', () => {
    const ok = GraphIndexResultSchema.parse({
      ok: true,
      commit: 'a'.repeat(40),
      files: 1,
      nodes: 2,
      edges: 3,
      modules: 1,
      indexerVersion: '1',
      durationMs: 2,
      symbolNames: ['secret'],
    });
    expect(Object.keys(ok)).not.toContain('symbolNames');
    expect(
      GraphIndexResultSchema.safeParse({ ok: false, reason: 'whatever the runner wants to say' }).success,
    ).toBe(false);
  });
});
