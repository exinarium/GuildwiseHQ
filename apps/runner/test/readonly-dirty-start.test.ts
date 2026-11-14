import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  discardOutOfScope,
  type GuardInput,
  runGuard,
  snapshotBranches,
  snapshotDirty,
} from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();
const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer')!;
const writer = BUILTIN_ROLES.find((r) => r.key === 'writer')!;

/**
 * D holds X as a submodule at `core` (set up as in deploy-submodules.test.ts); the worktree's submodule is checked out at
 * a newer commit of X than the one D pins: off its pin when the shift starts (BLOCKERS.md section 3).
 */
async function driftedWorktree() {
  const x = makeRepo();
  const d = makeRepo();
  sh(d.clone, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', x.origin, 'core']);
  sh(d.clone, 'git', ['commit', '-m', 'add core']);
  const other = join(tmp(), 'x-other');
  sh(x.root, 'git', ['clone', x.origin, other]);
  writeFileSync(join(other, 'feature.txt'), 'feature\n');
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', 'feature']);
  sh(other, 'git', ['push', 'origin', 'main']);
  const core = join(d.clone, 'core');
  sh(core, 'git', ['fetch', 'origin']);
  sh(core, 'git', ['checkout', '-q', 'origin/main']);
  // a file someone left behind before the shift as well
  writeFileSync(join(d.clone, 'notes.txt'), 'left behind\n');
  const wt = d.clone;
  const startSha = sh(wt, 'git', ['rev-parse', 'HEAD']);
  const branchesAtStart = await snapshotBranches(wt);
  const dirtyAtStart = await snapshotDirty(wt);
  const input = (over: Partial<GuardInput> = {}): GuardInput => ({
    worktree: wt,
    roleKey: 'reviewer',
    permissions: reviewer.permissions,
    branchName: 'main',
    startSha,
    branchesAtStart,
    e2eGlobs: ['e2e/**'],
    dirtyAtStart,
    ...over,
  });
  return { wt, input, dirtyAtStart };
}

describe('read-only roles are judged on their own shift only (BLOCKERS.md section 3)', () => {
  it('a submodule off its pin at shift start gives a reviewer guard of []; without the snapshot it was refused', async () => {
    const t = await driftedWorktree();
    expect(Object.keys(t.dirtyAtStart).sort()).toEqual(['core', 'notes.txt']);
    expect(t.dirtyAtStart.core).toMatch(/^sub:[0-9a-f]{40}:[0-9a-f]{40}$/);
    expect(await runGuard(t.input())).toEqual([]);
    expect(await runGuard(t.input({ roleKey: 'pre_reviewer' }))).toEqual([]);
    // the old behaviour, for comparison
    const { dirtyAtStart: _drop, ...without } = t.input();
    expect((await runGuard(without)).map((v) => v.rule)).toEqual(['reviewer_modified_code']);
  });

  it('a real edit is still refused', async () => {
    const t = await driftedWorktree();
    writeFileSync(join(t.wt, 'README.md'), '# changed by the reviewer\n');
    const v = await runGuard(t.input());
    expect(v.map((x) => x.rule)).toEqual(['reviewer_modified_code']);
    expect(v[0]?.detail).toContain('README.md');
    expect(v[0]?.detail).not.toContain('core');
  });

  it('an edit to an already-dirty file, or inside the drifted submodule, is still refused', async () => {
    const t = await driftedWorktree();
    writeFileSync(join(t.wt, 'notes.txt'), 'changed during the shift\n');
    expect((await runGuard(t.input()))[0]?.detail).toContain('notes.txt');

    const u = await driftedWorktree();
    writeFileSync(join(u.wt, 'core', 'hack.txt'), 'x\n');
    const v = await runGuard(u.input({ roleKey: 'ba' }));
    expect(v.map((x) => x.rule)).toEqual(['readonly_role_modified_code']);
    expect(v[0]?.detail).toContain('core');
  });

  it('a role that commits is judged on every path: leftovers from before the shift are flagged and discarded', async () => {
    const t = await driftedWorktree();
    const scoped = t.input({ roleKey: 'writer', permissions: writer.permissions });
    const v = await runGuard(scoped);
    expect(v.map((x) => x.rule)).toEqual(['writer_edited_non_docs']);
    expect(v[0]?.detail).toContain('notes.txt');
    const r = await discardOutOfScope(scoped);
    expect(r.discarded).toContain('notes.txt');
    expect(existsSync(join(t.wt, 'notes.txt'))).toBe(false);
  });
});
