import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseShipPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { shipReleaseCommit } from '../src/git/release-ship.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const rule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
  level: 'patch' as const,
  approvedTo: '0.1.63',
};
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const CHANGELOG = `# Changelog

## [Unreleased]

Hand written intro.

### Added

- One.
- Two.

## [1.3.0] - 2026-10-20

Runner 0.1.62 (unchanged).

### Added

- Old.
`;

const payload = (over: Partial<ReleaseShipPayload> = {}): ReleaseShipPayload => ({
  shipId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'unused',
  projectName: 'Toy',
  workingBranch: 'develop',
  version: '1.4.0',
  tag: 'v1.4.0',
  date: '2026-11-01',
  lastTag: 'v1.3.0',
  components: [rule],
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
  ...over,
});

function commit(clone: string, path: string, text: string, message: string) {
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), text);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', message]);
}

/** main with the release v1.3.0, then develop pushed with (by default) a change under apps/runner/. */
function setup(opts: { runnerChange?: boolean; dco?: boolean; handBump?: boolean } = {}) {
  const repo = makeRepo();
  commit(repo.clone, 'apps/runner/src/version.ts', file('0.1.62'), 'feat: runner');
  commit(repo.clone, 'CHANGELOG.md', CHANGELOG.replace('Hand written intro.\n\n', ''), 'docs: changelog');
  sh(repo.clone, 'git', ['tag', '-a', 'v1.3.0', '-m', 'Guildwise HQ 1.3.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
  if (opts.dco)
    commit(repo.clone, 'CONTRIBUTING.md', '## DCO\n\nSign off: Signed-off-by: you\n', 'docs: dco');
  if (opts.runnerChange ?? true) commit(repo.clone, 'apps/runner/src/other.ts', 'x', 'fix(runner): other');
  if (opts.handBump) commit(repo.clone, 'apps/runner/src/version.ts', file('0.1.63'), 'chore: bump');
  commit(repo.clone, 'CHANGELOG.md', CHANGELOG, 'docs: unreleased');
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
  return { repo, integrationDir: tmp('aom-integration-') };
}

const originShow = (origin: string, path: string) => sh(origin, 'git', ['show', `develop:${path}`]);
const commitsOn = (origin: string) => Number(sh(origin, 'git', ['rev-list', '--count', 'develop']));
const refs = (dir: string) => sh(dir, 'git', ['for-each-ref', '--format=%(refname) %(objectname)']);

const ship = (s: ReturnType<typeof setup>, over: Partial<ReleaseShipPayload> = {}) =>
  shipReleaseCommit({
    payload: payload({ remoteUrlNormalized: s.repo.remoteNormalized, ...over }),
    repoPath: s.repo.clone,
    integrationDir: s.integrationDir,
  });

describe('release.ship', () => {
  it('makes one release commit on the working branch: changelog, bumped runner, identity, sign-off', async () => {
    const s = setup({ dco: true });
    const before = commitsOn(s.repo.origin);
    const old = sh(s.repo.origin, 'git', ['rev-parse', 'develop']);
    const r = await ship(s);
    expect(r.ok).toBe(true);
    expect(r.step).toBe('push');
    expect(r.signedOff).toBe(true);
    expect(r.signOffReason).toBe('CONTRIBUTING.md');
    expect(commitsOn(s.repo.origin)).toBe(before + 1);
    const log = sh(s.repo.origin, 'git', ['log', '-1', '--format=%H%n%an <%ae>%n%B', 'develop']);
    expect(log).toContain(r.commit);
    expect(log).toContain('Release Owner <owner@example.test>');
    expect(log).toContain('chore(release): 1.4.0');
    expect(log).toContain('Signed-off-by: Release Owner <owner@example.test>');
    // a fast-forward: the old tip is an ancestor
    sh(s.repo.origin, 'git', ['merge-base', '--is-ancestor', old, 'develop']);
    const md = originShow(s.repo.origin, 'CHANGELOG.md');
    expect(md).toContain(
      '## [Unreleased]\n\n## [1.4.0] - 2026-11-01\n\nRunner 0.1.63. Hand written intro.\n\n### Added\n\n- One.\n- Two.',
    );
    expect(md).toContain('## [1.3.0] - 2026-10-20');
    expect(originShow(s.repo.origin, 'apps/runner/src/version.ts')).toContain("'0.1.63'");
    expect(r.components).toEqual([
      { name: 'runner', state: 'bump', from: '0.1.62', to: '0.1.63', changedCount: 1 },
    ]);
    expect(r.section).toContain('## [1.4.0] - 2026-11-01');
    // the kept ref is gone and nothing was tagged
    expect(refs(s.repo.clone)).not.toContain('refs/guildwise/release');
    expect(sh(s.repo.origin, 'git', ['tag', '--list'])).toBe('v1.3.0');
  });

  it('leaves the runner version alone and says "(unchanged)" when nothing under apps/runner changed', async () => {
    const s = setup({ runnerChange: false });
    const r = await ship(s);
    expect(r.ok).toBe(true);
    expect(originShow(s.repo.origin, 'apps/runner/src/version.ts')).toContain("'0.1.62'");
    expect(originShow(s.repo.origin, 'CHANGELOG.md')).toContain(
      'Runner 0.1.62 (unchanged). Hand written intro.',
    );
    expect(r.components[0]?.state).toBe('unchanged');
    expect(sh(s.repo.origin, 'git', ['show', '--stat', '--format=', 'develop']).split('\n').length).toBe(2);
  });

  it('does not bump a version that was raised by hand since the tag', async () => {
    const s = setup({ handBump: true });
    const r = await ship(s);
    expect(r.ok).toBe(true);
    expect(r.components[0]?.state).toBe('already_set');
    expect(originShow(s.repo.origin, 'CHANGELOG.md')).toContain('Runner 0.1.63. Hand written intro.');
    expect(sh(s.repo.origin, 'git', ['show', '--name-only', '--format=', 'develop'])).toBe('CHANGELOG.md');
  });

  it('adds no sign-off when the repository does not ask for one', async () => {
    const s = setup();
    const r = await ship(s);
    expect(r.ok).toBe(true);
    expect(r.signedOff).toBe(false);
    expect(sh(s.repo.origin, 'git', ['log', '-1', '--format=%B', 'develop'])).not.toContain('Signed-off-by');
  });

  it('is a no-op the second time: alreadyDone, still one release commit', async () => {
    const s = setup();
    const first = await ship(s);
    const count = commitsOn(s.repo.origin);
    const again = await ship(s);
    expect(again.ok).toBe(true);
    expect(again.alreadyDone).toBe(true);
    expect(again.commit).toBe(first.commit);
    expect(again.section).toContain('## [1.4.0]');
    expect(commitsOn(s.repo.origin)).toBe(count);
  });

  it("a rejected push fails with git's message at the push step; Retry pushes the same commit", async () => {
    const s = setup();
    const hook = join(s.repo.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "policy says no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const old = sh(s.repo.origin, 'git', ['rev-parse', 'develop']);
    const failed = await ship(s);
    expect(failed.ok).toBe(false);
    expect(failed.step).toBe('push');
    expect(failed.error).toContain('policy says no');
    expect(sh(s.repo.origin, 'git', ['rev-parse', 'develop'])).toBe(old);
    expect(refs(s.repo.clone)).toContain('refs/guildwise/release/1.4.0');
    rmSync(hook);
    const retried = await ship(s);
    expect(retried.ok).toBe(true);
    expect(retried.resumed).toBe(true);
    expect(retried.commit).toBe(failed.commit);
    expect(sh(s.repo.origin, 'git', ['rev-list', '--count', `${old}..develop`])).toBe('1');
    expect(refs(s.repo.clone)).not.toContain('refs/guildwise/release/1.4.0');
  });

  it('makes the commit again when the branch moved after a failed push', async () => {
    const s = setup();
    const hook = join(s.repo.origin, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "no" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const failed = await ship(s);
    expect(failed.ok).toBe(false);
    rmSync(hook);
    // someone pushes to develop meanwhile
    const other = tmp('aom-other-');
    sh(other, 'git', ['clone', '-b', 'develop', s.repo.origin, 'c']);
    commit(join(other, 'c'), 'late.txt', 'late', 'fix: late');
    sh(join(other, 'c'), 'git', ['push', 'origin', 'develop']);
    const retried = await ship(s);
    expect(retried.ok).toBe(true);
    expect(retried.resumed).toBeFalsy();
    expect(retried.commit).not.toBe(failed.commit);
    expect(retried.notices.join(' ')).toContain('moved');
    expect(originShow(s.repo.origin, 'late.txt')).toBe('late');
  });

  it('fails at the components step when the version file is missing', async () => {
    const s = setup();
    const r = await ship(s, { components: [{ ...rule, versionFile: 'apps/runner/src/nope.ts' }] });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('components');
    expect(commitsOn(s.repo.origin)).toBe(
      Number(sh(s.repo.clone, 'git', ['rev-list', '--count', 'develop'])),
    );
    expect(originShow(s.repo.origin, 'CHANGELOG.md')).toContain('## [Unreleased]\n\nHand written intro.');
  });

  it('fails at the components step when the pattern is not found', async () => {
    const s = setup();
    const r = await ship(s, { components: [{ ...rule, pattern: 'NOT_THERE = (.*)' }] });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('components');
  });

  it('refuses when the tag exists already', async () => {
    const s = setup();
    sh(s.repo.clone, 'git', ['tag', '-a', 'v1.4.0', '-m', 'x', 'main']);
    sh(s.repo.clone, 'git', ['push', 'origin', 'v1.4.0']);
    const r = await ship(s);
    expect(r.ok).toBe(false);
    expect(r.step).toBe('prepare');
    expect(r.error).toContain('v1.4.0 already exists');
  });

  it('fails at the changelog step without an Unreleased section', async () => {
    const s = setup();
    commit(s.repo.clone, 'CHANGELOG.md', '# Changelog\n\n## [1.3.0] - 2026-10-20\n', 'docs: no unreleased');
    sh(s.repo.clone, 'git', ['push', 'origin', 'develop']);
    const r = await ship(s);
    expect(r.ok).toBe(false);
    expect(r.step).toBe('changelog');
    expect(r.error).toContain('no ## [Unreleased]');
  });

  it('writes a new CHANGELOG.md from the notes when the repository has none', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
    commit(repo.clone, 'a.txt', 'a', 'feat: a');
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
    const integrationDir = tmp('aom-integration-');
    const base = payload({
      remoteUrlNormalized: repo.remoteNormalized,
      lastTag: null,
      components: [],
      version: '0.1.0',
      tag: 'v0.1.0',
    });
    const without = await shipReleaseCommit({ payload: base, repoPath: repo.clone, integrationDir });
    expect(without.ok).toBe(false);
    expect(without.step).toBe('changelog');
    const r = await shipReleaseCommit({
      payload: { ...base, notes: '- feat: a' },
      repoPath: repo.clone,
      integrationDir,
    });
    expect(r.ok).toBe(true);
    const md = originShow(repo.origin, 'CHANGELOG.md');
    expect(md).toContain('## [Unreleased]');
    expect(md).toContain('## [0.1.0] - 2026-11-01\n\n### Changed\n\n- feat: a');
  });
});
