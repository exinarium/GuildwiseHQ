import { z } from 'zod';

/**
 * A rebase (or the merge that replaces it) of a card branch onto its base failed for a reason other than a conflict:
 * a held `index.lock`, a read-only git dir, an untracked file in the way, a missing base ref, an identity error. Sent
 * next to the generic failure (finalize result, shift rejection with `worktree_failed`, failed test run) so the server
 * can name the base branch and quote git. Never a conflict: a conflict always lists its files.
 */
export const RebaseErrorInfoSchema = z.object({
  /** The ref the rebase used: `origin/<base>` when the remote branch exists, else `<base>`. */
  baseRef: z.string().max(300),
  /** The git command that failed, without hardening flags or auth arguments (`git rebase origin/main`). */
  command: z.string().max(500),
  exitCode: z.number().int(),
  /** Git's stderr (stdout when stderr was empty), with secrets redacted, trimmed. */
  stderr: z.string().max(2000),
});
export type RebaseErrorInfo = z.infer<typeof RebaseErrorInfoSchema>;

/** The longest stderr a {@link RebaseErrorInfo} carries. */
export const REBASE_ERROR_STDERR_MAX = 2000;
