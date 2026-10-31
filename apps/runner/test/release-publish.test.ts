import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleasePublishPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { MemoryTokenStore } from '../src/forge/index.ts';
import type { ForgeEnv } from '../src/forge/types.ts';
import { publishRelease } from '../src/git/release-publish.ts';
import type { ExecResult, Executor } from '../src/toolchain/exec.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.4.0] - 2026-11-01

Runner 0.1.63.

### Added

- One.

## [1.3.0] - 2026-10-20

### Added

- Old.
`;

const noExec: Executor = {
  async run(): Promise<ExecResult> {
    return { exitCode: 127, stdout: '', stderr: 'not found' };
  },
};
const forgeEnv: ForgeEnv = {
  exec: noExec,
  fetch: (async () => {
    throw new Error('no network in tests');
  }) as unknown as typeof fetch,
  tokens: new MemoryTokenStore(),
};

function commit(clone: string, path: string, text: string, message: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', message]);
}

/** main (tagged v1.3.0) and develop with the release commit R, pushed. */
function setup(opts: { dco?: boolean } = {}) {
  const repo = makeRepo();
  commit(repo.clone, 'CHANGELOG.md', CHANGELOG.replace('## [1.4.0]', '## [1.3.0-x]'), 'docs: changelog');
  if (opts.dco)
    commit(repo.clone, 'CONTRIBUTING.md', '## DCO\n\nSign off: Signed-off-by: you\n', 'docs: dco');
  sh(repo.clone, 'git', ['tag', '-a', 'v1.3.0', '-m', 'Guildwise HQ 1.3.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
  commit(repo.clone, 'feature.txt', 'x', 'feat: thing');
  commit(repo.clone, 'CHANGELOG.md', CHANGELOG, 'chore(release): 1.4.0');
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
  const R = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
  sh(repo.clone, 'git', ['checkout', 'main']);
  return { repo, R, integrationDir: tmp('aom-integration-') };
}

const payload = (
  s: ReturnType<typeof setup>,
  over: Partial<ReleasePublishPayload> = {},
): ReleasePublishPayload => ({
  shipId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: s.repo.remoteNormalized,
  forge: 'git',
  version: '1.4.0',
  tag: 'v1.4.0',
  title: 'Guildwise HQ 1.4.0',
  workingBranch: 'develop',
  mainBranch: 'main',
  releaseCommitSha: s.R,
  land: { mode: 'pr' },
  notesSource: 'changelog',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  ...over,
});

const run = (s: ReturnType<typeof setup>, over: Partial<ReleasePublishPayload> = {}) =>
  publishRelease({
    payload: payload(s, over),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
    forgeEnv,
  });

/** The release PR merged by someone else: a --no-ff merge pushed to origin/main from a second clone. */
function mergeOnOrigin(s: ReturnType<typeof setup>, ff = false) {
  const other = tmp('aom-other-');
  sh(other, 'git', ['clone', s.repo.origin, 'c']);
  const dir = join(other, 'c');
  sh(dir, 'git', ['merge', ff ? '--ff-only' : '--no-ff', '-m', 'Merge pull request #7', 'origin/develop']);
  sh(dir, 'git', ['push', 'origin', 'main']);
  return sh(dir, 'git', ['rev-parse', 'HEAD']);
}

const originRef = (s: ReturnType<typeof setup>, ref: string) => sh(s.repo.origin, 'git', ['rev-parse', ref]);
const tags = (s: ReturnType<typeof setup>) => sh(s.repo.origin, 'git', ['tag', '--list']);

describe('release.publish', () => {
  it('fails the land step when the merged pull request does not contain the release commit (an earlier release PR)', async () => {
    const s = setup();
    const oldMerge = originRef(s, 'main');
    const gh: Executor = {
      async run(_cmd: string, args: string[]): Promise<ExecResult> {
        const line = args.join(' ');
        if (/pr view 3 .*--json state/.test(line)) return { exitCode: 0, stdout: 'MERGED\n', stderr: '' };
        if (/pr view 3 .*mergeCommit/.test(line)) return { exitCode: 0, stdout: `${oldMerge}\n`, stderr: '' };
        return { exitCode: 127, stdout: '', stderr: 'not found' };
      },
    };
    const r = await publishRelease({
      payload: payload(s, { forge: 'github', land: { mode: 'pr', prUrl: 'https://github.com/acme/web/pull/3' } }),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
      forgeEnv: { ...forgeEnv, exec: gh },
    });
    expect(r.stage).toBe('failed');
    expect(r.ok).toBe(false);
    expect(tags(s)).toBe('v1.3.0');
  });

  it('waits while the release PR is not merged and tags nothing', async () => {
    const s = setup();
    const r = await run(s);
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('waiting');
    expect(tags(s)).toBe('v1.3.0');
  });

  it('tags the merge commit with an annotated tag, pushes it, and says there is no release page on plain git', async () => {
    const s = setup();
    const M = mergeOnOrigin(s);
    const r = await run(s);
    expect(r).toMatchObject({ ok: true, stage: 'done' });
    expect(r.land).toMatchObject({ by: 'found', mergeSha: M });
    expect(r.tag).toMatchObject({ name: 'v1.4.0', target: M, state: 'created' });
    expect(r.release).toMatchObject({ state: 'none', url: null });
    expect(r.release?.message).toContain('No release page was created');
    expect(sh(s.repo.origin, 'git', ['cat-file', '-t', 'v1.4.0'])).toBe('tag');
    expect(originRef(s, 'v1.4.0^{commit}')).toBe(M);
    expect(sh(s.repo.origin, 'git', ['tag', '-l', '--format=%(contents:subject)', 'v1.4.0'])).toBe(
      'Guildwise HQ 1.4.0',
    );
    expect(sh(s.repo.origin, 'git', ['tag', '-l', '--format=%(taggername) %(taggeremail)', 'v1.4.0'])).toBe(
      'Release Owner <owner@example.test>',
    );
  });

  it('tags the release commit itself after a fast-forward merge', async () => {
    const s = setup();
    mergeOnOrigin(s, true);
    const r = await run(s);
    expect(r.tag?.target).toBe(s.R);
    expect(originRef(s, 'v1.4.0^{commit}')).toBe(s.R);
  });

  it('is safe to repeat: the tag is reported, nothing moves or is created again', async () => {
    const s = setup();
    mergeOnOrigin(s);
    await run(s);
    const before = sh(s.repo.origin, 'git', ['for-each-ref', '--format=%(refname) %(objectname)']);
    const again = await run(s);
    expect(again.ok).toBe(true);
    expect(again.tag?.state).toBe('existed');
    expect(sh(s.repo.origin, 'git', ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
  });

  it('refuses to move a tag that points elsewhere', async () => {
    const s = setup();
    mergeOnOrigin(s);
    const main = originRef(s, 'main~1');
    sh(s.repo.origin, 'git', ['tag', '-a', 'v1.4.0', '-m', 'wrong', main]);
    const before = originRef(s, 'v1.4.0');
    const r = await run(s);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('tag');
    expect(r.error).toContain('never moved');
    expect(originRef(s, 'v1.4.0')).toBe(before);
  });

  it("fails the tag step with git's message when the push is rejected, and Retry pushes the local tag", async () => {
    const s = setup();
    mergeOnOrigin(s);
    const hook = join(s.repo.origin, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/tags/*) echo "tags are locked" >&2; exit 1;; esac; done\n',
    );
    chmodSync(hook, 0o755);
    const r = await run(s);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('tag');
    expect(r.error).toContain('tags are locked');
    expect(tags(s)).toBe('v1.3.0');
    rmSync(hook);
    const retry = await run(s);
    expect(retry).toMatchObject({ ok: true, stage: 'done' });
    expect(tags(s)).toContain('v1.4.0');
    expect(sh(s.repo.origin, 'git', ['cat-file', '-t', 'v1.4.0'])).toBe('tag');
  });

  it('fails when CHANGELOG.md on main has no section for the version, and makes no tag', async () => {
    const s = setup();
    mergeOnOrigin(s);
    const r = await run(s, { version: '1.4.1', tag: 'v1.4.1', title: 'Guildwise HQ 1.4.1' });
    expect(r.failedStep).toBe('tag');
    expect(r.error).toContain('no section for 1.4.1');
    expect(tags(s)).toBe('v1.3.0');
  });

  it('merge mode: merges the release commit into main without force, signs off for a DCO repository, then tags', async () => {
    const s = setup({ dco: true });
    const r = await run(s, { land: { mode: 'merge' } });
    expect(r).toMatchObject({ ok: true, stage: 'done' });
    expect(r.land).toMatchObject({ mode: 'merge', by: 'guildwise', signedOff: true });
    const M = originRef(s, 'main');
    expect(r.tag?.target).toBe(M);
    expect(originRef(s, 'v1.4.0^{commit}')).toBe(M);
    expect(sh(s.repo.origin, 'git', ['log', '-1', '--format=%B', 'main'])).toContain(
      'Signed-off-by: Release Owner',
    );
    expect(sh(s.repo.origin, 'git', ['rev-list', '--parents', '-n', '1', 'main']).split(' ')).toHaveLength(3);
    // a second run finds R on main and creates nothing new
    const again = await run(s, { land: { mode: 'merge' } });
    expect(again.land?.by).toBe('found');
    expect(originRef(s, 'main')).toBe(M);
  });

  it('merge mode: a conflict fails the land step and leaves main alone', async () => {
    const s = setup();
    const main = originRef(s, 'main');
    commit(
      s.repo.clone,
      'CHANGELOG.md',
      '# Changelog\n\n## [Unreleased]\n\nchanged on main\n',
      'docs: main edit',
    );
    sh(s.repo.clone, 'git', ['push', 'origin', 'main']);
    const r = await run(s, { land: { mode: 'merge' } });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('land');
    expect(r.error).toContain('conflicts in CHANGELOG.md');
    expect(originRef(s, 'main')).not.toBe(main);
    expect(sh(s.repo.origin, 'git', ['log', '-1', '--format=%s', 'main'])).toBe('docs: main edit');
    expect(tags(s)).toBe('v1.3.0');
  });

  it('uses the approved notes when there was no CHANGELOG.md', async () => {
    const s = setup();
    mergeOnOrigin(s);
    const r = await run(s, { notesSource: 'commits', notes: 'From commit titles.' });
    expect(r.ok).toBe(true);
  });
});
