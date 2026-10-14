import { git } from '../git/git.ts';

export interface AutoCommitInput {
  worktree: string;
  /** The ticket key the card came from (`DCPL-4276`), when it has one: the only reference that may appear in the message. */
  ticket?: string | null;
  /** The resolved commit identity (project setting, repository, workstation), as git author and committer variables. */
  env: Record<string, string>;
}

/** Commits leftovers as `[<ticket>: ]Work in progress`: plain words, no agent, card or shift reference. Returns true when a commit was made. */
export async function autoCommit(input: AutoCommitInput): Promise<boolean> {
  // A merge of the main branch waiting for its conflicts to be resolved must not be committed half done (that would
  // record the conflict markers as the resolution): the next architect shift picks it up.
  if ((await git(input.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0) return false;
  const status = await git(input.worktree, ['status', '--porcelain', '--untracked-files=all']);
  if (status.exitCode !== 0 || !status.stdout.trim()) return false;
  const add = await git(input.worktree, ['add', '-A'], { env: input.env });
  if (add.exitCode !== 0) return false;
  const msg = input.ticket ? `${input.ticket}: Work in progress` : 'Work in progress';
  const c = await git(input.worktree, ['commit', '--no-verify', '-m', msg], { env: input.env });
  return c.exitCode === 0;
}

/** Files `git status` shows as changed or untracked in the worktree (porcelain lines), empty when clean. */
export async function uncommittedFiles(worktree: string): Promise<string[]> {
  const status = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  if (status.exitCode !== 0) return [];
  return status.stdout
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

const MAX_LISTED = 30;

/**
 * The card note for a shift that ended without a report but left work in the worktree: it lists the files so the next
 * shift (and the owner) can see where things stand. `committed` says whether the runner's leftovers commit kept them.
 */
export function unreportedWorkNote(
  files: string[],
  opts: { outcome: string; committed: boolean; sha?: string; branch?: string },
): string {
  const listed = files.slice(0, MAX_LISTED).map((f) => `- \`${f}\``);
  if (files.length > MAX_LISTED) listed.push(`- ... and ${files.length - MAX_LISTED} more`);
  const kept = opts.committed
    ? `The runner committed them as a leftovers commit${opts.sha ? ` (${opts.sha})` : ''}${opts.branch ? ` on ${opts.branch}` : ''}, so nothing is lost; the agent had not reported them as done.`
    : 'They are still uncommitted in the worktree (a merge of the main branch is waiting to be resolved).';
  return [
    `The shift ended without a report (${opts.outcome}) with ${files.length} uncommitted file${files.length === 1 ? '' : 's'} in the worktree:`,
    ...listed,
    kept,
    'The next shift should check these files first: run the build and tests, then finish or fix them and report.',
  ].join('\n');
}
