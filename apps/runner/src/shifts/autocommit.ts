import { git } from '../git/git.ts';

export interface AutoCommitInput {
  worktree: string;
  ref: string;
  stage: string;
  shiftId: string;
  /** Agent identity so the commit is attributed to the agent. */
  env: Record<string, string>;
}

/** Commits leftovers as `aom: <REF> <stage> leftovers (shift <shortId>)`. Returns true when a commit was made. */
export async function autoCommit(input: AutoCommitInput): Promise<boolean> {
  // A merge of the main branch waiting for its conflicts to be resolved must not be committed half done (that would
  // record the conflict markers as the resolution): the next architect shift picks it up.
  if ((await git(input.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0) return false;
  const status = await git(input.worktree, ['status', '--porcelain', '--untracked-files=all']);
  if (status.exitCode !== 0 || !status.stdout.trim()) return false;
  const add = await git(input.worktree, ['add', '-A'], { env: input.env });
  if (add.exitCode !== 0) return false;
  const msg = `aom: ${input.ref} ${input.stage} leftovers (shift ${input.shiftId.slice(0, 8)})`;
  const c = await git(input.worktree, ['commit', '--no-verify', '-m', msg], { env: input.env });
  return c.exitCode === 0;
}
