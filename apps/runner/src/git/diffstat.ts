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

/** Most paths a card's own change may name before the diff falls back to the whole `<base>...HEAD` range. */
const OWN_PATHS_MAX = 1500;

/**
 * The paths the card itself changed, when its branch merged other work in (`main`, or the working branch again):
 * `<base>...HEAD` then also lists everything that merge brought, so a small change that merged `main` looked large and
 * high-risk (2,000+ files of other people's work). Looks at the commits only the card branch has (not on the base, not on
 * `main`): a normal commit adds the files it changed, a merge adds only the files where it differs from git's own automatic
 * merge (`--remerge-diff`: the conflict resolutions). Null when the branch has no merge (the plain range is exact) or the list is too long to pass on.
 */
export async function ownChangedPaths(
  worktree: string,
  base: string,
  mainRef?: string,
): Promise<string[] | null> {
  let main = mainRef;
  if (!main) {
    const h = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    main = h.exitCode === 0 && h.stdout.trim() ? h.stdout.trim() : undefined;
  }
  if (main && !(await revParse(worktree, main))) main = undefined;
  const log = await git(worktree, [
    'rev-list',
    '--parents',
    'HEAD',
    `^${base}`,
    ...(main ? [`^${main}`] : []),
  ]);
  if (log.exitCode !== 0) return null;
  const commits = log.stdout
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter((c) => c[0]);
  if (!commits.some((c) => c.length > 2)) return null;
  const out = new Set<string>();
  for (const [sha, ...parents] of commits) {
    const r =
      parents.length > 1
        ? await git(worktree, ['show', '--remerge-diff', '--name-only', '--format=', sha as string])
        : await git(worktree, ['diff-tree', '--name-only', '--no-commit-id', '-r', '--root', sha as string]);
    if (r.exitCode !== 0) return null;
    for (const p of r.stdout.split('\n')) if (p.trim() && p.trim() !== sha) out.add(p.trim());
    if (out.size > OWN_PATHS_MAX) return null;
  }
  return [...out];
}

/** `git diff` arguments limited to the card's own paths (literal pathspecs); the plain range when there is no limit. */
export function scoped(args: string[], own: string[] | null): string[] {
  return own === null ? args : [...args, '--', ...own.map((p) => `:(literal)${p}`)];
}

export interface DiffInput {
  worktree: string;
  baseBranch: string;
  architecturalGlobs: string[];
}

/** `git diff --numstat <base>...HEAD` summarised, plus architectural path matches and the test file count. */
export async function computeDiffStats(input: DiffInput): Promise<DiffStats> {
  const base = await baseRef(input.worktree, input.baseBranch);
  const own = await ownChangedPaths(input.worktree, base);
  const out =
    own?.length === 0
      ? ''
      : await gitOk(input.worktree, scoped(['diff', '--numstat', `${base}...HEAD`], own));
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

  // M9: how many changed files are tests (the HR board's "test coverage of its changes").
  const isTest = picomatch(TEST_GLOBS, { dot: true });
  const stats: DiffStats = {
    files: paths.length,
    added,
    removed,
    architecturalPaths,
    testFiles: paths.filter((p) => isTest(p)).length,
  };
  return stats;
}

export function riskTier(stats: DiffStats, cardType: string): 'small' | 'large' {
  if (stats.added + stats.removed >= 200 || stats.architecturalPaths.length > 0 || cardType === 'refactor') {
    return 'large';
  }
  return 'small';
}
