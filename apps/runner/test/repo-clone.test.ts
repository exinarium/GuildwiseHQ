import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRemoteUrl, type RepoClonePayload, type RepoCreatePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { scanRepos } from '../src/git/repo-scan.ts';
import { dirNameFromUrl, RepoCloner } from '../src/repo/clone.ts';
import { realExecutor } from '../src/toolchain/exec.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';

cleanupTmp();

const payload = (remoteUrl: string, over: Partial<RepoClonePayload> = {}): RepoClonePayload => ({
  requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a3',
  projectKey: 'TOY',
  projectName: 'Toy',
  name: 'toy',
  remoteUrl,
  ...over,
});

function setup() {
  const root = tmp('aom-clone-root-');
  const created: RepoCreatePayload[] = [];
  let createResult: Awaited<ReturnType<RepoCloner['run']>> | null = null;
  const cloner = new RepoCloner({
    repoRoots: () => [root],
    exec: realExecutor,
    findExisting: async (n) => (await scanRepos([root])).find((r) => normalizeRemoteUrl(r.remoteUrl) === n),
    creator: {
      run: async (p) => {
        created.push(p);
        return createResult
          ? { ok: false, error: 'gh is not installed on this workstation' }
          : { ok: true, remoteUrl: 'x', localPath: join(root, 'made') };
      },
    },
  });
  return {
    root,
    cloner,
    created,
    failCreate: () => {
      createResult = { ok: false, state: 'failed' };
    },
  };
}

describe('dirNameFromUrl', () => {
  it.each([
    ['https://github.com/acme/My-App.git', 'My-App'],
    ['git@github.com:acme/app', 'app'],
    ['ssh://git@host/x/y.git/', 'y'],
    ['/tmp/a/origin.git', 'origin'],
    ['https://github.com/acme/..', null],
    ['https://github.com/acme/', 'acme'],
  ])('%s -> %s', (url, expected) => {
    expect(dirNameFromUrl(url)).toBe(expected);
  });
});

describe('repo.clone', () => {
  it('clones an existing remote into the first repository folder, then reports "already cloned" the second time', async () => {
    const origin = makeRepo();
    const { root, cloner } = setup();
    const r = await cloner.run(payload(origin.origin));
    expect(r).toMatchObject({ ok: true, state: 'cloned' });
    expect(r.localPath).toContain(root);
    expect(existsSync(join(root, 'origin', '.git'))).toBe(true);
    expect(existsSync(join(root, 'origin', 'README.md'))).toBe(true);

    const again = await cloner.run(payload(origin.origin));
    expect(again).toMatchObject({ ok: true, state: 'cloned', existing: true });
    expect(again.detail).toContain('Already cloned');
  });

  it('knows a clone anywhere under the repository folders (made by hand under another name)', async () => {
    const origin = makeRepo();
    const { root, cloner } = setup();
    mkdirSync(join(root, 'mine'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['clone', origin.origin, join(root, 'mine', 'toy')], { stdio: 'ignore' });
    const r = await cloner.run(payload(origin.origin));
    expect(r).toMatchObject({ ok: true, existing: true });
    expect(r.localPath).toContain(join('mine', 'toy'));
    expect(readdirSync(root)).toEqual(['mine']); // nothing new was cloned
  });

  it('never overwrites a non-empty folder that is not the clone', async () => {
    const origin = makeRepo();
    const { root, cloner } = setup();
    mkdirSync(join(root, 'origin'));
    writeFileSync(join(root, 'origin', 'precious.txt'), 'mine');
    const r = await cloner.run(payload(origin.origin));
    expect(r.ok).toBe(false);
    expect(r.state).toBe('failed');
    expect(r.error).toContain('was not touched');
    expect(readdirSync(join(root, 'origin'))).toEqual(['precious.txt']);
  });

  it('clones into an empty folder', async () => {
    const origin = makeRepo();
    const { root, cloner } = setup();
    mkdirSync(join(root, 'origin'));
    expect((await cloner.run(payload(origin.origin))).ok).toBe(true);
    expect(existsSync(join(root, 'origin', 'README.md'))).toBe(true);
  });

  it('a remote that does not exist fails with the reason and hint, and creates nothing', async () => {
    const { root, cloner, created } = setup();
    const r = await cloner.run(payload(join(tmp(), 'nope.git')));
    expect(r).toMatchObject({ ok: false, state: 'failed' });
    expect(r.error).toContain('does not exist, or this workstation has no access');
    expect(r.error).toContain('Create new');
    expect(created).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('"create new": a missing remote is created by the creator (gh) with the manager\'s choices', async () => {
    const { cloner, created } = setup();
    const r = await cloner.run(
      payload('https://github.com/acme/brandnew.git', {
        workingBranch: 'develop',
        create: { name: 'acme/brandnew', visibility: 'public', description: 'hello' },
      }),
    );
    expect(r).toMatchObject({ ok: true, state: 'created' });
    expect(r.detail).toContain('Created acme/brandnew (public)');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'acme/brandnew',
      visibility: 'public',
      description: 'hello',
      branch: 'develop',
      projectKey: 'TOY',
    });
  });

  it('"create new" when the repository exists already just clones it', async () => {
    const origin = makeRepo();
    const { cloner, created } = setup();
    const r = await cloner.run(
      payload(origin.origin, { create: { name: 'acme/toy', visibility: 'private' } }),
    );
    expect(r).toMatchObject({ ok: true, state: 'cloned' });
    expect(created).toEqual([]);
  });

  it('a creation that fails asks the manager', async () => {
    const { cloner, failCreate } = setup();
    failCreate();
    const r = await cloner.run(
      payload('https://github.com/acme/brandnew.git', {
        create: { name: 'acme/brandnew', visibility: 'private' },
      }),
    );
    expect(r).toMatchObject({ ok: false, state: 'needs_manager' });
    expect(r.error).toContain('gh is not installed');
  });

  it('a workstation without a repository folder asks the manager to add one', async () => {
    const cloner = new RepoCloner({
      repoRoots: () => [],
      exec: realExecutor,
      findExisting: async () => undefined,
      creator: { run: async () => ({ ok: false }) },
    });
    const r = await cloner.run(payload('/tmp/whatever.git'));
    expect(r).toMatchObject({ ok: false, state: 'needs_manager' });
    expect(r.error).toContain('guildwise-runner repos add');
  });

  it('two requests for the same repository at once clone it once', async () => {
    const origin = makeRepo();
    const { cloner, root } = setup();
    const [a, b] = await Promise.all([
      cloner.run(payload(origin.origin)),
      cloner.run(payload(origin.origin)),
    ]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    expect(readdirSync(root)).toEqual(['origin']);
  });
});
