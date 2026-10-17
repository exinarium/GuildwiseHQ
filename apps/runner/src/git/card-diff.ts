import { CHANGED_PATHS_MAX, capDiff, type DiffUpload } from '@aom/shared';
import { baseRef } from './diffstat.ts';
import { git, gitOk, revParse } from './git.ts';

export interface CardDiff {
  headSha: string;
  /** Paths of the card diff (`<base>...HEAD`), for the server's high-risk flag and the area E2E mapping. */
  changedPaths: string[];
  diff: DiffUpload;
}

/**
 * What the server keeps from a build handoff (code-v6): the commit the branch is at (the build evidence is bound to it),
 * the paths the card changes and the unified diff `<base>...HEAD`, capped at 2 MB with a note (`capDiff`). Taken after the
 * shift's autocommit, so what is measured is what the reviewers read.
 */
export async function computeCardDiff(worktree: string, baseBranch: string): Promise<CardDiff> {
  const base = await baseRef(worktree, baseBranch);
  const headSha = await gitOk(worktree, ['rev-parse', 'HEAD']);
  const names = await git(worktree, ['diff', '--name-only', '-z', `${base}...HEAD`]);
  const changedPaths =
    names.exitCode === 0 ? names.stdout.split('\0').filter(Boolean).slice(0, CHANGED_PATHS_MAX) : [];
  const d = await git(worktree, ['diff', '--no-color', '--no-ext-diff', '-M', `${base}...HEAD`]);
  const capped = capDiff(d.exitCode === 0 ? d.stdout : '');
  return {
    headSha,
    changedPaths,
    diff: {
      text: capped.text,
      bytes: capped.bytes,
      truncated: capped.truncated,
      base,
      ...((await revParse(worktree, base)) ? { baseSha: await gitOk(worktree, ['rev-parse', base]) } : {}),
    },
  };
}
