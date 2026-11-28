import { CHANGED_PATHS_MAX, capDiff, type DiffUpload } from '@aom/shared';
import { baseRef, cardPlaceholders, ownChangedPaths, scoped } from './diffstat.ts';
import { git, gitOk, hasCommit, hasRemote, originTip, revParse } from './git.ts';

/** gate-fixes-2 S9 (R3-S3): the review diff base could not be read from origin; the handoff is refused (fail closed). */
export class DiffBaseError extends Error {}

export interface CardDiff {
  headSha: string;
  /** Paths of the card diff (`<base>...HEAD`), for the server's high-risk flag and the area E2E mapping. */
  changedPaths: string[];
  diff: DiffUpload;
}

/**
 * What the server keeps from a build handoff (lean team): the commit the branch is at (the build evidence is bound to it),
 * the paths the card changes and the unified diff `<base>...HEAD`, capped at 2 MB with a note (`capDiff`). Taken after the
 * shift's autocommit, so what is measured is what the reviewers read.
 */
export async function computeCardDiff(
  worktree: string,
  baseBranch: string,
  /** The host's credentials for origin (the project's app when it posts as one); absent: git's own. */
  auth?: { args: string[]; env: Record<string, string> },
): Promise<CardDiff> {
  const label = await baseRef(worktree, baseBranch);
  // gate-fixes-2 S9: with a remote the base is origin's tip read with ls-remote (a sha), so a `refs/remotes/origin/<base>`
  // an agent session forged cannot change what the reviewers read; it fails closed (R3-S3)
  let base = label;
  if (await hasRemote(worktree)) {
    let sha: string | null;
    try {
      sha = await originTip(worktree, baseBranch, auth);
    } catch (err) {
      throw new DiffBaseError(`origin could not be asked for ${baseBranch}: ${String(err).slice(0, 300)}`);
    }
    if (sha) {
      if (!(await hasCommit(worktree, sha)))
        await git(worktree, [...(auth?.args ?? []), 'fetch', '--', 'origin', baseBranch], {
          ...(auth ? { env: auth.env } : {}),
        });
      if (!(await hasCommit(worktree, sha)))
        throw new DiffBaseError(`origin's ${baseBranch} (${sha.slice(0, 10)}) could not be fetched`);
      base = sha;
    }
  }
  const headSha = await gitOk(worktree, ['rev-parse', 'HEAD']);
  // A branch that merged `main` (or the working branch) in: only what the card itself changed, not what the merge brought.
  // sandbox placeholders a commit put on the branch are not the card's change: not shown to the reviewers
  const hide = await cardPlaceholders(worktree, base);
  const own = (await ownChangedPaths(worktree, base))?.filter((p) => !hide.has(p)) ?? null;
  const none = { exitCode: 0, stdout: '', stderr: '' };
  const names =
    own?.length === 0
      ? none
      : await git(worktree, scoped(['diff', '--name-only', '-z', `${base}...HEAD`], own, hide));
  const changedPaths =
    names.exitCode === 0 ? names.stdout.split('\0').filter(Boolean).slice(0, CHANGED_PATHS_MAX) : [];
  const d =
    own?.length === 0
      ? none
      : await git(
          worktree,
          scoped(['diff', '--no-color', '--no-ext-diff', '-M', `${base}...HEAD`], own, hide),
        );
  const capped = capDiff(d.exitCode === 0 ? d.stdout : '');
  return {
    headSha,
    changedPaths,
    diff: {
      text: capped.text,
      bytes: capped.bytes,
      truncated: capped.truncated,
      base: label,
      ...((await revParse(worktree, base)) ? { baseSha: await gitOk(worktree, ['rev-parse', base]) } : {}),
    },
  };
}
