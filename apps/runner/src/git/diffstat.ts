import type { DiffStats } from '@aom/shared';
import picomatch from 'picomatch';
import { git, gitOk, revParse } from './git.ts';

const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];

/** Ref to diff against: `origin/<base>` when present, else `<base>`. */
export async function baseRef(worktree: string, baseBranch: string): Promise<string> {
  return (await revParse(worktree, `refs/remotes/origin/${baseBranch}`))
    ? `origin/${baseBranch}`
    : baseBranch;
}

export interface DiffInput {
  worktree: string;
  baseBranch: string;
  architecturalGlobs: string[];
  affectedAreas?: string;
}

/** `git diff --numstat <base>...HEAD` summarised, plus architectural path matches and the out-of-scope test heuristic. */
export async function computeDiffStats(input: DiffInput): Promise<DiffStats> {
  const base = await baseRef(input.worktree, input.baseBranch);
  const out = await gitOk(input.worktree, ['diff', '--numstat', `${base}...HEAD`]);
  let added = 0;
  let removed = 0;
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split('\t');
    added += a === '-' ? 0 : Number(a);
    removed += r === '-' ? 0 : Number(r);
    paths.push(rest.join('\t'));
  }
  const isArch = picomatch(input.architecturalGlobs.length ? input.architecturalGlobs : ['!**'], {
    dot: true,
  });
  const architecturalPaths = input.architecturalGlobs.length ? paths.filter((p) => isArch(p)) : [];

  // Heuristic: modified (not added) test files that also exist on the base and are not named in affectedAreas.
  const mod = await git(input.worktree, ['diff', '--name-only', '--diff-filter=M', `${base}...HEAD`]);
  const isTest = picomatch(TEST_GLOBS, { dot: true });
  const areas = input.affectedAreas ?? '';
  const outOfScopeTestChange =
    mod.exitCode === 0 && mod.stdout.split('\n').some((p) => p && isTest(p) && !areas.includes(p));

  // M9: how many changed files are tests (the HR board's "test coverage of its changes").
  const stats: DiffStats = {
    files: paths.length,
    added,
    removed,
    architecturalPaths,
    testFiles: paths.filter((p) => isTest(p)).length,
  };
  if (outOfScopeTestChange) stats.outOfScopeTestChange = true;
  return stats;
}

export function riskTier(stats: DiffStats, cardType: string): 'small' | 'large' {
  if (stats.added + stats.removed >= 200 || stats.architecturalPaths.length > 0 || cardType === 'refactor') {
    return 'large';
  }
  return 'small';
}
