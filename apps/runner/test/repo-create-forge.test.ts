import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryTokenStore } from '../src/forge/index.ts';
import { RepoCreator } from '../src/repo/create.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const noFetch = (async () => {
  throw new Error('no network in tests');
}) as unknown as typeof fetch;

const payload = (name: string, provider: 'gitlab' | 'azure-devops' | 'bitbucket-dc' | 'github') => ({
  requestId: randomUUID(),
  name,
  provider,
  visibility: 'private' as const,
  projectKey: 'TOY',
  projectName: 'Toy',
  branch: 'main',
});

function creator() {
  const root = join(tmp(), 'repos');
  mkdirSync(root, { recursive: true });
  return new RepoCreator({
    dir: join(tmp(), 'outbound'),
    repoRoots: () => [root],
    forge: () => ({
      exec: { run: async () => ({ exitCode: 127, stdout: '', stderr: '' }) },
      fetch: noFetch,
      tokens: new MemoryTokenStore(),
    }),
  });
}

describe('repo.create on other git hosts', () => {
  it('refuses when the workstation is not connected to the provider, with the way to connect', async () => {
    const res = await creator().run(payload('grp/sub/app', 'gitlab'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected to gitlab/);
    expect(res.error).toMatch(/git-connect/);
  });

  it('refuses a provider that cannot create repositories', async () => {
    const res = await creator().run(payload('proj/app', 'bitbucket-dc'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/cannot be created/);
  });
});
