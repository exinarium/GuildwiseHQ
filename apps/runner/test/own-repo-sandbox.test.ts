import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildShiftSettings,
  isReadOnlyWorktreeRole,
  ruleAbs,
  shadowedWrites,
  splitOwnRepository,
} from '../src/adapters/claude-policy.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

/**
 * GWP-86: a commit-capable shift must be able to write `.git/worktrees/<card>` (index.lock) although its own main clone
 * is also a read-only folder (organization folder scan). Claude Code binds denyWrite after allowWrite, so that clone must
 * not reach denyWrite, --add-dir or the Edit denies; other cards' admin dirs, hooks and config stay read-only.
 */
const root = realpathSync(mkdtempSync(join(userInfo().homedir, '.aom-own-repo-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const sh = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

function fixture() {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  sh(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-m', 'one']);
  const x = join(root, 'X');
  const y = join(root, 'Y');
  sh(repo, ['worktree', 'add', '-b', 'fx', x]);
  sh(repo, ['worktree', 'add', '-b', 'fy', y]);
  return { repo, x, y, common: join(repo, '.git') };
}
const f = fixture();
const perms = (key: string) => {
  const role = BUILTIN_ROLES.find((r) => r.key === key);
  if (!role) throw new Error(key);
  return role.permissions;
};

describe('own repository split off the read-only folders', () => {
  it('splits a folder that holds the cwd or the git dir, keeps the others', () => {
    const other = join(root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    const r = splitOwnRepository([f.repo, other], f.x, [f.common]);
    expect(r.ownRepoDirs).toEqual([f.repo]);
    expect(r.readDirs).toEqual([other]);
  });

  for (const key of ['builder', 'architect']) {
    it(`${key}: the clone is not in denyWrite, additionalDirectories, allowRead or the Edit denies`, () => {
      const { readDirs, ownRepoDirs } = splitOwnRepository([f.repo], f.x, [f.common]);
      const settings = buildShiftSettings(
        perms(key),
        policyCtx({ cwd: f.x, gitDirs: [f.common], readDirs, ownRepoDirs }),
        POLICY_PATHS,
        key,
      );
      const fs = settings.sandbox?.filesystem;
      expect(fs?.denyWrite).not.toContain(f.repo);
      expect(fs?.allowRead).not.toContain(f.repo);
      expect(settings.permissions.additionalDirectories).not.toContain(f.repo);
      expect(settings.permissions.deny).not.toContain(`Edit(${ruleAbs(f.repo)}/**)`);
      expect(fs?.allowWrite).toContain(f.common);
      expect(shadowedWrites(fs ?? { allowWrite: [], denyWrite: [] }, f.x)).toEqual([]);
      // the clone's secret files stay masked
      expect(settings.permissions.deny.some((d) => d.includes(ruleAbs(f.repo)) && d.includes('.env'))).toBe(
        true,
      );
    });
  }

  it("other cards' admin dirs, hooks and config are read-only, the card's own is not", () => {
    const settings = buildShiftSettings(
      perms('builder'),
      policyCtx({ cwd: f.x, gitDirs: [f.common] }),
      POLICY_PATHS,
      'builder',
    );
    const dw = settings.sandbox?.filesystem.denyWrite ?? [];
    expect(dw).toContain(join(f.common, 'worktrees', 'Y'));
    expect(dw).toContain(join(f.common, 'hooks'));
    expect(dw).toContain(join(f.common, 'config'));
    expect(dw).not.toContain(join(f.common, 'worktrees', 'X'));
  });

  it('a read-only role keeps its read-only folder and a locked worktree', () => {
    expect(isReadOnlyWorktreeRole(perms('reviewer'))).toBe(true);
    expect(isReadOnlyWorktreeRole(perms('builder'))).toBe(false);
    const settings = buildShiftSettings(
      perms('reviewer'),
      policyCtx({ cwd: f.x, gitDirs: [f.common], readDirs: [f.repo] }),
      POLICY_PATHS,
      'reviewer',
    );
    expect(settings.sandbox?.filesystem.denyWrite).toContain(f.repo);
    expect(settings.sandbox?.filesystem.denyWrite).toContain(f.x);
    expect(settings.permissions.additionalDirectories).toContain(f.repo);
  });

  it('shadowedWrites reports a deny that covers a writable path', () => {
    expect(
      shadowedWrites({ allowWrite: ['/a/b/.git'], denyWrite: ['/a/b', '/a/b/.git/hooks'] }, '/w'),
    ).toEqual(['/a/b']);
  });
});
