import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { git } from './git.ts';
import { removeWorktree } from './worktrees.ts';

/**
 * Runs `fn` inside a throwaway worktree of the clone on `tempBranch`, cut from `startPoint` (a merge into the working
 * branch is made here, never in the card's worktree or the user's checkout). The worktree and the temporary branch are
 * removed afterwards, whatever `fn` did. Returns `{ ok: false, error }` when the worktree could not be created.
 */
export async function withIntegrationWorktree<T>(
  input: { repoPath: string; dir: string; root: string; tempBranch: string; startPoint: string },
  fn: (integration: string) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const cleanup = () =>
    removeWorktree({
      path: input.dir,
      branchName: input.tempBranch,
      deleteBranch: true,
      roots: [input.root],
    });
  await cleanup();
  await mkdir(dirname(input.dir), { recursive: true });
  const add = await git(input.repoPath, [
    'worktree',
    'add',
    '--no-track',
    '-B',
    input.tempBranch,
    '--',
    input.dir,
    input.startPoint,
  ]);
  if (add.exitCode !== 0)
    return { ok: false, error: `could not create the integration worktree: ${add.stderr.trim()}` };
  try {
    return { ok: true, value: await fn(input.dir) };
  } finally {
    await cleanup();
  }
}
