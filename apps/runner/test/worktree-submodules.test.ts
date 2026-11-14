import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  fillSubmodules,
  isSafeSubmoduleName,
  isSafeSubmodulePath,
  redactGitError,
} from '../src/git/submodule-fill.ts';
import { readSubmodules, resolveRelativeSubmoduleUrl } from '../src/git/submodule-pin.ts';
import { ensureWorktree, initWorktreeSubmodules } from '../src/git/worktrees.ts';
import { runGuard, snapshotBranches } from '../src/shifts/guard.ts';
import { prepareWorktree, SUBMODULES_NOT_PREPARED } from '../src/toolchain/prepare-worktree.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

const spec = {
  mode: 'create' as const,
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'x',
  baseBranch: 'main',
  branchName: 'aom/toy-1-x',
};

const sha256 = (file: string): string | null =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;

/**
 * X (the "core") and D (the "cloud") that holds X as a submodule at `core`. The submodule section `git submodule add`
 * wrote into D's clone config is removed: the fill must work from `.gitmodules` and one-shot options alone.
 */
function twoRepos(url?: string): { x: TestRepo; d: TestRepo } {
  const x = makeRepo();
  const d = makeRepo();
  sh(d.clone, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', x.origin, 'core']);
  if (url) sh(d.clone, 'git', ['config', '--file', '.gitmodules', 'submodule.core.url', url]);
  sh(d.clone, 'git', ['add', '-A']);
  sh(d.clone, 'git', ['commit', '-m', 'add core']);
  sh(d.clone, 'git', ['push', 'origin', 'main']);
  sh(d.clone, 'git', ['config', '--remove-section', 'submodule.core']);
  return { x, d };
}

async function cardWorktree(d: TestRepo): Promise<string> {
  const path = join(tmp(), 'wt');
  const w = await ensureWorktree({ repoPath: d.clone, roots: ['/'], spec, defaultPath: path });
  expect(w.added).toBe(true);
  return path;
}

const mirrorOf =
  (x: TestRepo, seen: string[] = []) =>
  async (n: string) => {
    seen.push(n);
    return n === x.remoteNormalized ? { localPath: x.clone } : undefined;
  };

const gitPath = (wt: string, rel: string) =>
  sh(wt, 'git', ['rev-parse', '--path-format=absolute', '--git-path', rel]);

const readOnlyRole = (() => {
  const r = BUILTIN_ROLES.find((x) => x.permissions.mayCommit === false);
  if (!r) throw new Error('no read-only role');
  return r;
})();

describe('card worktree submodules', () => {
  it('fills the submodule at the pinned commit from the local clone; config unchanged (even read-only), status clean, guard quiet', async () => {
    const { x, d } = twoRepos();
    const pinned = sh(d.clone, 'git', ['rev-parse', 'HEAD:core']);
    const wt = await cardWorktree(d);
    expect(readdirSync(join(wt, 'core'))).toEqual([]);
    const commonConfig = join(d.clone, '.git', 'config');
    const wtConfig = join(gitPath(wt, 'config.worktree'));
    const before = { common: sha256(commonConfig), wt: sha256(wtConfig) };
    chmodSync(commonConfig, 0o444);
    const startSha = sh(wt, 'git', ['rev-parse', 'HEAD']);
    const branchesAtStart = await snapshotBranches(wt);
    const seen: string[] = [];
    try {
      const fills = await initWorktreeSubmodules(wt, { findRepo: mirrorOf(x, seen) });
      expect(fills).toMatchObject([{ name: 'core', path: 'core', status: 'filled', pinned }]);
    } finally {
      chmodSync(commonConfig, 0o644);
    }
    expect(seen).toEqual([x.remoteNormalized]);
    expect(sh(join(wt, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(pinned);
    expect(existsSync(join(wt, 'core', 'README.md'))).toBe(true);
    expect({ common: sha256(commonConfig), wt: sha256(wtConfig) }).toEqual(before);
    expect(readFileSync(commonConfig, 'utf8')).not.toContain('submodule');
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    expect(sh(wt, 'git', ['diff', '--', '.gitmodules'])).toBe('');
    // the submodule repository lives in the worktree's own git dir
    expect(existsSync(gitPath(wt, 'modules/core'))).toBe(true);
    const violations = await runGuard({
      worktree: wt,
      roleKey: readOnlyRole.key,
      permissions: readOnlyRole.permissions,
      branchName: spec.branchName,
      startSha,
      branchesAtStart,
      e2eGlobs: ['e2e/**'],
    });
    expect(violations).toEqual([]);
  });

  it('a repository without .gitmodules: nothing runs, the worktree is as before', async () => {
    const repo = makeRepo();
    const wt = await cardWorktree(repo);
    const fills = await initWorktreeSubmodules(wt, {
      findRepo: async () => {
        throw new Error('must not be asked');
      },
    });
    expect(fills).toEqual([]);
    expect(existsSync(gitPath(wt, 'modules'))).toBe(false);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('an unreachable url: the worktree stays, the failure names the submodule, credentials are redacted, no throw', async () => {
    const { d } = twoRepos('https://user:SECRET123@127.0.0.1:9/x.git');
    const wt = await cardWorktree(d);
    const before = sha256(join(d.clone, '.git', 'config'));
    const fills = await initWorktreeSubmodules(wt, { findRepo: async () => undefined });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ name: 'core', path: 'core', status: 'failed' });
    expect(fills[0]?.detail).toBeTruthy();
    expect(JSON.stringify(fills)).not.toContain('SECRET123');
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe(spec.branchName);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
    expect(sha256(join(d.clone, '.git', 'config'))).toBe(before);
  });

  it('the host auth of the submodule url is used, not that of the superproject', async () => {
    const { d } = twoRepos('https://127.0.0.1:9/x.git');
    const wt = await cardWorktree(d);
    const asked: string[] = [];
    await initWorktreeSubmodules(wt, {
      findRepo: async () => undefined,
      auth: async (url) => {
        asked.push(url);
        return { args: [], env: {} };
      },
    });
    expect(asked).toEqual(['https://127.0.0.1:9/x.git']);
  });

  it('a local path url without a registered clone gets no file protocol and fails', async () => {
    const { d } = twoRepos();
    const wt = await cardWorktree(d);
    const fills = await initWorktreeSubmodules(wt, { findRepo: async () => undefined });
    expect(fills).toMatchObject([{ name: 'core', status: 'failed' }]);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('reopening does not clone again: an existing submodule repository is left alone, and its hooks do not run', async () => {
    const { x, d } = twoRepos();
    const wt = await cardWorktree(d);
    expect((await initWorktreeSubmodules(wt, { findRepo: mirrorOf(x) }))[0]?.status).toBe('filled');
    const modules = gitPath(wt, 'modules/core');
    writeFileSync(join(modules, 'marker'), 'keep\n');
    const noLookup = async () => {
      throw new Error('must not be asked');
    };
    expect(await initWorktreeSubmodules(wt, { findRepo: noLookup })).toMatchObject([
      { name: 'core', status: 'present' },
    ]);
    expect(readFileSync(join(modules, 'marker'), 'utf8')).toBe('keep\n');

    // an emptied folder with the repository still there: left as it is, a planted hook never runs
    const ran = join(tmp(), 'hook-ran');
    mkdirSync(join(modules, 'hooks'), { recursive: true });
    writeFileSync(join(modules, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o755 });
    for (const e of readdirSync(join(wt, 'core')))
      rmSync(join(wt, 'core', e), { recursive: true, force: true });
    expect(await initWorktreeSubmodules(wt, { findRepo: noLookup })).toMatchObject([
      { name: 'core', status: 'present' },
    ]);
    expect(existsSync(ran)).toBe(false);
  });

  it('a non-empty submodule folder without a repository is agent content: left alone', async () => {
    const { x, d } = twoRepos();
    const wt = await cardWorktree(d);
    writeFileSync(join(wt, 'core', 'mine.txt'), 'x');
    expect(await initWorktreeSubmodules(wt, { findRepo: mirrorOf(x) })).toMatchObject([
      { name: 'core', status: 'present' },
    ]);
    expect(existsSync(gitPath(wt, 'modules/core'))).toBe(false);
  });

  it('a pin that exists nowhere fails with the redacted git error', async () => {
    const { x, d } = twoRepos();
    sh(d.clone, 'git', ['update-index', '--cacheinfo', `160000,${'a'.repeat(40)},core`]);
    sh(d.clone, 'git', ['commit', '-m', 'bad pin']);
    sh(d.clone, 'git', ['push', 'origin', 'main']);
    const wt = await cardWorktree(d);
    const fills = await fillSubmodules(wt, { findRepo: mirrorOf(x) }, { onlyUninitialised: true });
    expect(fills).toMatchObject([{ name: 'core', status: 'failed', pinned: 'a'.repeat(40) }]);
  });
});

describe('submodule helpers', () => {
  it('resolves relative urls against the raw origin url the way git does', () => {
    expect(resolveRelativeSubmoduleUrl('https://h.test/o/r.git', '../core.git')).toBe(
      'https://h.test/o/core.git',
    );
    expect(resolveRelativeSubmoduleUrl('https://h.test/o/r', './sub')).toBe('https://h.test/o/r/sub');
    expect(resolveRelativeSubmoduleUrl('git@h.test:o/r.git', '../core.git')).toBe('git@h.test:o/core.git');
    expect(resolveRelativeSubmoduleUrl('git@h.test:r.git', '../core.git')).toBe('git@h.test:core.git');
    expect(resolveRelativeSubmoduleUrl('/srv/git/r.git', '../core.git')).toBe('/srv/git/core.git');
  });

  it('readSubmodules returns the clonable url next to the normalized one', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo.clone, '.gitmodules'), '[submodule "a"]\n\tpath = libs/a\n\turl = ../core.git\n');
    expect(await readSubmodules(repo.clone, 'git@github.com:acme/cloud.git')).toEqual([
      { name: 'a', path: 'libs/a', url: 'git@github.com:acme/core.git', normalized: 'github.com/acme/core' },
    ]);
  });

  it('redacts url userinfo and secret shapes from git errors', () => {
    const msg =
      "fatal: clone of 'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz@github.com/o/r.git' failed";
    const out = redactGitError(msg);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('x-access-token');
    expect(out).toContain('https://***@github.com/o/r.git');
    expect(redactGitError('x'.repeat(500))).toHaveLength(300);
  });

  it('rejects names and paths that could escape a -c key or the worktree', () => {
    expect(isSafeSubmoduleName('core')).toBe(true);
    expect(isSafeSubmoduleName('libs/a.b')).toBe(true);
    expect(isSafeSubmoduleName('a=b')).toBe(false);
    expect(isSafeSubmoduleName('a\nb')).toBe(false);
    expect(isSafeSubmoduleName('../x')).toBe(false);
    expect(isSafeSubmodulePath('core')).toBe(true);
    expect(isSafeSubmodulePath('../x')).toBe(false);
    expect(isSafeSubmodulePath('/abs')).toBe(false);
    expect(isSafeSubmodulePath('-x')).toBe(false);
  });

  it('an unsafe submodule name is skipped, not run', async () => {
    const { x, d } = twoRepos();
    const wt = await cardWorktree(d);
    writeFileSync(join(wt, '.gitmodules'), '[submodule "a=b"]\n\tpath = core\n\turl = ../x.git\n');
    const fills = await fillSubmodules(wt, { findRepo: mirrorOf(x) }, { onlyUninitialised: true });
    expect(fills).toMatchObject([{ name: 'a=b', status: 'skipped' }]);
  });
});

describe('preparation with a submodule step', () => {
  it('uses the given step instead of the fixed sentence', async () => {
    const { d } = twoRepos();
    const wt = await cardWorktree(d);
    const r = await prepareWorktree({
      worktree: wt,
      platform: 'linux',
      stacks: () => [],
      submodules: { name: 'submodules', status: 'done', ms: 5 },
    });
    expect(r.steps).toEqual([{ name: 'submodules', status: 'done', ms: 5 }]);
    expect(JSON.stringify(r)).not.toContain(SUBMODULES_NOT_PREPARED);
  });
});
