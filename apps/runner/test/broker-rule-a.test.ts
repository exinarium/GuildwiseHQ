import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoOpenPrPayload } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devopsPushPlan, resolveBrokerPush } from '../src/devops/devops-git.ts';
import type { PrCreator, PrInput } from '../src/git/gh.ts';
import {
  knowClone,
  recordTip,
  setTipStore,
  TipStore,
  tipStore,
  writerStart,
} from '../src/git/pushable-tips.ts';
import { openReleasePr } from '../src/git/release-pr.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

/** gate-fixes-2 B4 and Rule A outside hygiene: the DevOps push broker and `repo.open_pr`. */
cleanupTmp();

let saved: TipStore | null;
beforeEach(() => {
  saved = tipStore();
  setTipStore(TipStore.forRoot(mkdtempSync(join(tmp(), 'tips-'))));
});
afterEach(() => setTipStore(saved));

const noAuth = { args: [], env: {} };
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file);
  sh(cwd, 'git', ['add', '-A']);
  sh(cwd, 'git', ['commit', '-qm', file]);
  return sh(cwd, 'git', ['rev-parse', 'HEAD']);
};
/** A session (writer) moves `branch` onto a commit of its own. */
async function forge(repo: TestRepo, branch: string) {
  await knowClone(repo.clone);
  const release = await writerStart(repo.clone);
  const base = sh(repo.clone, 'git', ['rev-parse', `refs/heads/${branch}`]);
  const forged = sh(repo.clone, 'git', ['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'forged']);
  sh(repo.clone, 'git', ['update-ref', `refs/heads/${branch}`, forged]);
  await release();
  return forged;
}

describe('B4: the broker plan', () => {
  it('refuses --tags and card-branch destinations', () => {
    expect(devopsPushPlan('push', [], false, true)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['refs/tags/v1'], false, true)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['aom/toy-1-fix'], false, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['feature:guildwise/toy-2-x'], false, false)).toHaveProperty('error');
    expect(devopsPushPlan('push', ['feature'], false, false)).not.toHaveProperty('error');
  });
});

describe('Rule A and B4: what the broker sends', () => {
  it('a protected branch a session forged is refused; a recorded one goes by sha', async () => {
    const repo = makeRepo();
    await forge(repo, 'main');
    const refused = await resolveBrokerPush(repo.clone, ['main'], [], noAuth);
    expect(refused).toMatchObject({ error: expect.stringMatching(/refusing to push main/) });
    // the runner records a tip of its own (for example a conflict-ff move): sent by that sha
    sh(repo.clone, 'git', ['reset', '-q', '--hard', 'origin/main']);
    const mine = commit(repo.clone, 'mine.txt');
    await recordTip(repo.clone, 'refs/heads/main', mine, 'conflict-ff');
    expect(await resolveBrokerPush(repo.clone, ['main'], [], noAuth)).toEqual({
      refspecs: [`${mine}:refs/heads/main`],
    });
  });

  it('the shift’s own protected branches follow the same rule', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-qb', 'development']);
    sh(repo.clone, 'git', ['push', '-q', 'origin', 'development']);
    await forge(repo, 'development');
    expect(await resolveBrokerPush(repo.clone, ['development'], ['development'], noAuth)).toHaveProperty(
      'error',
    );
    expect(await resolveBrokerPush(repo.clone, ['development'], [], noAuth)).toEqual({
      refspecs: ['development'],
    });
  });

  it('a tag goes only at the sha the runner recorded; a swapped tag ref is refused', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['tag', '-a', 'v1', '-m', 'v1']);
    const t = sh(repo.clone, 'git', ['rev-parse', 'refs/tags/v1']);
    expect(await resolveBrokerPush(repo.clone, ['refs/tags/v1'], [], noAuth)).toHaveProperty('error');
    await recordTip(repo.clone, 'refs/tags/v1', t, 'tag');
    expect(await resolveBrokerPush(repo.clone, ['refs/tags/v1'], [], noAuth)).toEqual({
      refspecs: [`${t}:refs/tags/v1`],
    });
    // a session swaps the tag ref
    const other = sh(repo.clone, 'git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'x']);
    sh(repo.clone, 'git', ['update-ref', 'refs/tags/v1', other]);
    expect(await resolveBrokerPush(repo.clone, ['refs/tags/v1'], [], noAuth)).toHaveProperty('error');
  });
});

describe('Rule A: repo.open_pr sends the working branch only when the runner trusts it', () => {
  class FakePr implements PrCreator {
    calls: PrInput[] = [];
    async create(input: PrInput) {
      this.calls.push(input);
      return { url: 'https://example.test/pr/1' };
    }
  }
  const payload = (repo: TestRepo): RepoOpenPrPayload => ({
    requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
    projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    remoteUrlNormalized: repo.remoteNormalized,
    head: 'develop',
    title: 'Release',
    body: 'Body',
  });

  it('a develop a session forged (not on origin yet) is NOT PUSHED; no pull request', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['branch', 'develop', 'main']);
    await knowClone(repo.clone);
    const release = await writerStart(repo.clone);
    sh(repo.clone, 'git', [
      'update-ref',
      'refs/heads/develop',
      sh(repo.clone, 'git', ['commit-tree', 'main^{tree}', '-p', 'main', '-m', 'forged']),
    ]);
    await release();
    const pr = new FakePr();
    const res = await openReleasePr({ payload: payload(repo), repoPath: repo.clone, pr });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/^NOT PUSHED: /) });
    expect(pr.calls).toEqual([]);
    expect(sh(repo.origin, 'git', ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe(
      'refs/heads/main',
    );
  });

  it('the user’s own develop (made while no session ran) is sent and the pull request opened', async () => {
    const repo = makeRepo();
    await knowClone(repo.clone);
    sh(repo.clone, 'git', ['checkout', '-qb', 'develop']);
    commit(repo.clone, 'd.txt');
    const pr = new FakePr();
    const res = await openReleasePr({ payload: payload(repo), repoPath: repo.clone, pr });
    expect(res).toMatchObject({ ok: true, base: 'main' });
    expect(pr.calls).toHaveLength(1);
  });
});
