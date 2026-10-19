import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { highRiskPaths } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { computeCardDiff } from '../src/git/card-diff.ts';
import { computeDiffStats } from '../src/git/diffstat.ts';
import { cleanupTmp, makeRepo, sh } from './helpers.ts';

cleanupTmp();

function write(dir: string, file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

function commit(dir: string, msg: string) {
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-m', msg]);
}

/** origin: `main` and the working branch `work`; a card branch `aom/C-1` off `work`. */
function setup() {
  const repo = makeRepo();
  const c = repo.clone;
  sh(c, 'git', ['checkout', '-b', 'work']);
  write(c, 'shared.txt', 'one\ntwo\nthree\n');
  commit(c, 'work base');
  sh(c, 'git', ['push', '-u', 'origin', 'work']);
  // main moves on with other people's work, high-risk paths included
  sh(c, 'git', ['checkout', 'main']);
  write(c, 'src/auth/secret-store.ts', 'export const s = 1;\n');
  write(c, 'migrations/001.sql', 'select 1;\n');
  commit(c, 'main: auth and migrations');
  sh(c, 'git', ['push', 'origin', 'main']);
  sh(c, 'git', ['remote', 'set-head', 'origin', 'main']);
  sh(c, 'git', ['checkout', '-b', 'aom/C-1', 'origin/work']);
  return { repo, c };
}

describe('the card diff of a branch that merged main', () => {
  it('lists only what the card changed, not what the merge brought', async () => {
    const { c } = setup();
    sh(c, 'git', ['merge', '--no-ff', '-m', 'Merge main into the card branch', 'origin/main']);
    write(c, 'src/ui/icon.tsx', 'export const icon = 1;\n');
    commit(c, 'the icon');

    const cd = await computeCardDiff(c, 'work');
    expect(cd.changedPaths).toEqual(['src/ui/icon.tsx']);
    expect(highRiskPaths(cd.changedPaths)).toEqual([]);
    expect(cd.diff.text).toContain('src/ui/icon.tsx');
    expect(cd.diff.text).not.toContain('secret-store');
    const st = await computeDiffStats({ worktree: c, baseBranch: 'work', architecturalGlobs: [] });
    expect(st.files).toBe(1);
  });

  it('counts the files whose merge conflict the card resolved', async () => {
    const { c } = setup();
    // main and the card both change shared.txt: the merge conflicts and the card resolves it
    sh(c, 'git', ['checkout', 'main']);
    write(c, 'shared.txt', 'one\nTWO (main)\nthree\n');
    commit(c, 'main edits shared');
    sh(c, 'git', ['push', 'origin', 'main']);
    sh(c, 'git', ['checkout', 'aom/C-1']);
    write(c, 'shared.txt', 'one\nTWO (card)\nthree\n');
    commit(c, 'card edits shared');
    try {
      sh(c, 'git', ['merge', 'origin/main']);
    } catch {
      // the conflict is expected
    }
    write(c, 'shared.txt', 'one\nTWO (both)\nthree\n');
    commit(c, 'Merge main, conflict resolved');

    const cd = await computeCardDiff(c, 'work');
    expect(cd.changedPaths).toEqual(['shared.txt']);
  });

  it('a branch without a merge keeps the whole range', async () => {
    const { c } = setup();
    write(c, 'src/auth/login.ts', 'export const l = 1;\n');
    commit(c, 'login');
    const cd = await computeCardDiff(c, 'work');
    expect(cd.changedPaths).toEqual(['src/auth/login.ts']);
    expect(highRiskPaths(cd.changedPaths).length).toBe(1);
  });
});
