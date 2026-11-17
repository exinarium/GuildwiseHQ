import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { probeCommit } from '../src/delivery/commit-probe.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();

/** A real origin and a clone of it: the probe fetches the origin, so a commit pushed after the clone is found. */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'd@x.io',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'd@x.io',
    },
  }).trim();

let origin: string;
let clone: string;
let first: string;
let tip: string;
const deps = () => ({
  findRepo: async (n: string) => (n === 'example.com/acme/toy' ? { localPath: clone } : undefined),
});
const ask = (over: Record<string, unknown> = {}) =>
  probeCommit(deps(), {
    type: 'repo.commit.probe',
    requestId: '00000000-0000-4000-8000-000000000001',
    remoteUrlNormalized: 'example.com/acme/toy',
    branch: 'main',
    deadlineMs: 20_000,
    ...over,
  } as never);

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'probe-'));
  origin = join(root, 'origin.git');
  clone = join(root, 'clone');
  mkdirSync(origin);
  sh(origin, 'init', '--bare', '-b', 'main');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  sh(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'a.txt'), 'one');
  sh(seed, 'add', '.');
  sh(seed, 'commit', '-m', 'first commit');
  first = sh(seed, 'rev-parse', 'HEAD');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', 'origin', 'main');
  sh(root, 'clone', origin, clone);
  // a commit pushed AFTER the clone was made: only a fetch finds it
  writeFileSync(join(seed, 'a.txt'), 'two');
  sh(seed, 'commit', '-am', 'chore(release): 1.9.0');
  tip = sh(seed, 'rev-parse', 'HEAD');
  sh(seed, 'push', 'origin', 'main');
});

describe('repo.commit.probe', () => {
  it('without a sha: fetches and answers the tip of origin/<branch> with its subject, author and date', async () => {
    const r = await ask();
    expect(r).toMatchObject({
      ok: true,
      sha: tip,
      shortSha: tip.slice(0, 7),
      subject: 'chore(release): 1.9.0',
      author: 'Dev',
    });
    expect(r.committedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('a full sha and an abbreviated one answer the full sha', async () => {
    expect(await ask({ sha: first })).toMatchObject({ ok: true, sha: first, subject: 'first commit' });
    expect(await ask({ sha: first.slice(0, 9) })).toMatchObject({ ok: true, sha: first });
  });

  it('a sha that is not in the repository is not_found', async () => {
    expect(await ask({ sha: 'e'.repeat(40) })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('a branch that is not on origin is no_branch', async () => {
    expect(await ask({ branch: 'nope' })).toMatchObject({ ok: false });
    expect((await ask({ branch: 'nope' })).error).toBeDefined();
  });

  it('a name that is not a branch is refused without running git', async () => {
    expect(await ask({ branch: '--upload-pack=x' })).toMatchObject({ ok: false, error: 'no_branch' });
    expect(await ask({ branch: null })).toMatchObject({ ok: false, error: 'no_branch' });
  });

  it('a repository without a clone on this workstation is no_clone', async () => {
    expect(await ask({ remoteUrlNormalized: 'example.com/acme/other' })).toMatchObject({
      ok: false,
      error: 'no_clone',
    });
  });
});
