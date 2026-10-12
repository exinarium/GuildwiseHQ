import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoOpenPrPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import type { PrCreator, PrInput } from '../src/git/gh.ts';
import { openReleasePr } from '../src/git/release-pr.ts';
import { cleanupTmp, makeRepo, sh } from './helpers.ts';

cleanupTmp();

class FakePr implements PrCreator {
  calls: PrInput[] = [];
  constructor(private readonly result: Awaited<ReturnType<PrCreator['create']>> | Error) {}
  async create(input: PrInput) {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

const payload = (
  repo: { remoteNormalized: string },
  over: Partial<RepoOpenPrPayload> = {},
): RepoOpenPrPayload => ({
  requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: repo.remoteNormalized,
  head: 'develop',
  title: 'Release',
  body: 'Body',
  ...over,
});

/** `develop` on origin with one commit the main branch lacks. */
function withDevelop() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
  writeFileSync(join(repo.clone, 'd.txt'), 'd');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'work on develop']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
  sh(repo.clone, 'git', ['checkout', 'main']);
  return repo;
}

describe('repo.open_pr: working branch to main branch', () => {
  it('opens the pull request from the working branch to the main branch (default branch when none is named)', async () => {
    const repo = withDevelop();
    const pr = new FakePr({ url: 'https://example.test/acme/toy/pull/9' });
    const res = await openReleasePr({ payload: payload(repo), repoPath: repo.clone, pr });
    expect(res).toEqual({ ok: true, base: 'main', url: 'https://example.test/acme/toy/pull/9' });
    expect(pr.calls).toEqual([
      expect.objectContaining({ base: 'main', branch: 'develop', title: 'Release' }),
    ]);
  });

  it('uses the named main branch', async () => {
    const repo = withDevelop();
    sh(repo.clone, 'git', ['branch', 'release', 'main']);
    sh(repo.clone, 'git', ['push', 'origin', 'release']);
    const pr = new FakePr({ url: 'https://example.test/pull/1' });
    const res = await openReleasePr({
      payload: payload(repo, { base: 'release' }),
      repoPath: repo.clone,
      pr,
    });
    expect(res.base).toBe('release');
    expect(pr.calls[0]).toMatchObject({ base: 'release', branch: 'develop' });
  });

  it('does nothing when the working branch is the main branch or has nothing new', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['branch', 'develop']);
    sh(repo.clone, 'git', ['push', 'origin', 'develop']);
    const pr = new FakePr({ url: 'x' });
    const same = await openReleasePr({ payload: payload(repo, { head: 'main' }), repoPath: repo.clone, pr });
    expect(same).toMatchObject({ ok: true, nothingToDo: true });
    const nothing = await openReleasePr({ payload: payload(repo), repoPath: repo.clone, pr });
    expect(nothing).toMatchObject({ ok: true, nothingToDo: true });
    expect(pr.calls).toHaveLength(0);
  });

  it('pushes a working branch that only exists locally, and says so when it does not exist at all', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
    writeFileSync(join(repo.clone, 'd.txt'), 'd');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local only']);
    const pr = new FakePr({ url: 'https://example.test/pull/2' });
    expect((await openReleasePr({ payload: payload(repo), repoPath: repo.clone, pr })).ok).toBe(true);
    expect(sh(repo.origin, 'git', ['rev-parse', '--verify', 'develop'])).toBeTruthy();
    const missing = await openReleasePr({
      payload: payload(repo, { head: 'nope' }),
      repoPath: repo.clone,
      pr,
    });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toContain('does not exist yet');
  });

  it('without gh it returns a notice; an existing pull request is reported; a real failure is a failure', async () => {
    const repo = withDevelop();
    const noGh = await openReleasePr({
      payload: payload(repo),
      repoPath: repo.clone,
      pr: new FakePr({ unavailable: 'gh is not available' }),
    });
    expect(noGh).toMatchObject({ ok: true });
    expect(noGh.url).toBeUndefined();
    expect(noGh.notice).toContain('open the pull request from develop to main by hand');
    const dup = await openReleasePr({
      payload: payload(repo),
      repoPath: repo.clone,
      pr: new FakePr(
        new Error('a pull request for branch develop already exists: https://example.test/pull/3'),
      ),
    });
    expect(dup).toMatchObject({ ok: true, url: 'https://example.test/pull/3' });
    const boom = await openReleasePr({
      payload: payload(repo),
      repoPath: repo.clone,
      pr: new FakePr(new Error('boom')),
    });
    expect(boom).toMatchObject({ ok: false, error: 'boom' });
  });
});
