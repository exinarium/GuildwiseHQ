import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
const owner = () => ({ cookie: w.owner.cookie });

describe('owner-controlled strings are validated at the API (review M1, M5)', () => {
  it('refuses option-like or malformed branch names, prefixes and vault folders', async () => {
    const mk = (body: Record<string, unknown>) =>
      w.t.req('POST', '/api/projects', { ...owner(), body: { key: 'BAD', name: 'Bad', ...body } });
    expect((await mk({ branchPrefix: '--upload-pack=x/' })).status).toBe(400);
    expect((await mk({ workingBranch: '-D' })).status).toBe(400);
    expect((await mk({ workingBranch: 'a..b' })).status).toBe(400);
    expect((await mk({ vaultFolder: '../../etc' })).status).toBe(400);
    const patch = await w.t.req('PATCH', `/api/projects/${w.projectId}`, {
      ...owner(),
      body: { workingBranch: '--orphan=x' },
    });
    expect(patch.status).toBe(400);
    const okRes = await mk({ key: 'FINE', branchPrefix: 'aom/', workingBranch: 'release/1.0' });
    expect(okRes.status).toBe(201);
  });

  it('refuses credentials and local paths in repo URLs, and stores nothing', async () => {
    const add = (remoteUrl: string, workingBranch?: string) =>
      w.t.req('POST', `/api/projects/${w.projectId}/repos`, {
        ...owner(),
        body: { name: 'x', remoteUrl, ...(workingBranch ? { workingBranch } : {}) },
      });
    const before = (await q('SELECT 1 FROM project_repos')).length;
    for (const url of [
      'https://bob:ghp_secret@github.com/acme/other.git',
      'https://ghp_secret@github.com/acme/other.git',
      '--upload-pack=touch /tmp/x',
      'ext::sh -c id',
      'file:///tmp/evil.git',
      '/tmp/evil.git',
    ]) {
      const r = await add(url);
      expect(r.status, url).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain('ghp_secret');
    }
    expect((await add('https://github.com/acme/other.git', '-x')).status).toBe(400);
    expect((await q('SELECT 1 FROM project_repos')).length).toBe(before);
    // ssh with a user name only is fine
    expect((await add('git@github.com:acme/other.git')).status).toBe(201);
  });

  it('refuses credentials and local paths in vault URLs', async () => {
    for (const remoteUrl of ['https://u:p@github.com/acme/vault.git', 'file:///tmp/v.git', '-oProxy=x']) {
      const r = await w.t.req('POST', '/api/vaults', { ...owner(), body: { kind: 'work', remoteUrl } });
      expect(r.status, remoteUrl).toBe(400);
    }
    const vault = await ok<any>(
      w.t.req('POST', '/api/vaults', {
        ...owner(),
        body: { kind: 'work', remoteUrl: 'git@github.com:acme/vault.git' },
      }),
      201,
    );
    const patch = await w.t.req('PATCH', `/api/vaults/${vault.vault?.id ?? vault.id}`, {
      ...owner(),
      body: { remoteUrl: 'https://u:p@github.com/acme/vault.git' },
    });
    expect(patch.status).toBe(400);
  });
});
