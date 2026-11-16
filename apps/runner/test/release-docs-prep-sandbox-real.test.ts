import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandboxedDocsPrepExec } from '../src/git/release-docs-prep-exec.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * The docs-prep exec against the REAL bubblewrap: a probe command run as a step cannot read the credential files, the
 * runner's secrets or a sibling pairing, and can write its worktree and scratch folder. Everything lives under a
 * temporary fake home and runner root (the real home is never pointed at). Skipped when bubblewrap cannot run here.
 */
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true'], {
    encoding: 'utf8',
  }).status === 0;

describe.skipIf(!bwrapOk)('docs-prep exec in the real bubblewrap sandbox', () => {
  it('hides credentials, runner secrets and sibling pairings; the worktree and scratch folder are writable', async () => {
    const home = realpathSync(tmp('aom-fake-home-'));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY');
    writeFileSync(join(home, '.npmrc'), 'NPM-TOKEN');
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'GH-TOKEN');
    const machine = realpathSync(tmp('aom-fake-machine-'));
    const root = join(machine, 'pairings', 'p1');
    mkdirSync(join(root, 'secrets'), { recursive: true });
    writeFileSync(join(root, 'secrets', 'k'), 'RUNNER-SECRET');
    mkdirSync(join(machine, 'pairings', 'other'), { recursive: true });
    writeFileSync(join(machine, 'pairings', 'other', 'config.json'), 'OTHER-PAIRING');
    const worktree = join(root, 'integration', 'wt');
    mkdirSync(worktree, { recursive: true });
    const outDir = realpathSync(tmp('docs-prep-probe-'));
    const exec = sandboxedDocsPrepExec({
      runnerRoot: root,
      realHome: home,
      cacheRoot: join(root, 'cache'),
      launcher: { sandboxAvailable: async () => true },
      toolchains: () => ({ pathDirs: [], env: {} }),
      tmpRoot: realpathSync(tmp('aom-docsprep-root-')),
    })({ step: 'guide', phase: 'apply', worktree, outDir, runId: 'r', repoId: 'p' });
    const script = [
      `cat ${home}/.ssh/id_ed25519`,
      `cat ${home}/.npmrc`,
      `cat ${home}/.config/gh/hosts.yml`,
      `cat ${root}/secrets/k`,
      `cat ${machine}/pairings/other/config.json`,
      `echo built > ${worktree}/out.txt`,
      `echo scratch > ${outDir}/o.txt`,
      'echo done',
    ].join('; ');
    const r = await exec('sh', ['-c', script], { cwd: worktree, timeoutMs: 30_000 });
    const all = `${r.stdout}\n${r.stderr}`;
    for (const secret of ['PRIVATE-KEY', 'NPM-TOKEN', 'GH-TOKEN', 'RUNNER-SECRET', 'OTHER-PAIRING'])
      expect(all).not.toContain(secret);
    expect(r.stdout).toContain('done');
    expect(readFileSync(join(worktree, 'out.txt'), 'utf8')).toBe('built\n');
    expect(readFileSync(join(outDir, 'o.txt'), 'utf8')).toBe('scratch\n');
    expect(existsSync(join(root, 'cache', 'ms-playwright'))).toBe(true);
  });
});
