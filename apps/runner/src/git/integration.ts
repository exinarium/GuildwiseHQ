import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { git } from './git.ts';
import { removeWorktree } from './worktrees.ts';

/** Temporary integration branches carry this prefix (a card branch is `<project prefix><ref>-<slug>`, never this). */
export const INTEGRATION_BRANCH_PREFIX = 'guildwise/integration/';
/** The prefix runners used before the rename. */
const LEGACY_INTEGRATION_BRANCH_PREFIX = 'aom-integration/';

export const integrationBranchName = (key: string): string => `${INTEGRATION_BRANCH_PREFIX}${key}`;

/** TODO(next release): remove this and the legacy prefix above. */
/** Deletes the leftover `aom-integration/<key>` branch of an older runner (best effort: a checked-out one stays). */
async function dropLegacyBranch(repoPath: string, tempBranch: string): Promise<void> {
  if (!tempBranch.startsWith(INTEGRATION_BRANCH_PREFIX)) return;
  const legacy = `${LEGACY_INTEGRATION_BRANCH_PREFIX}${tempBranch.slice(INTEGRATION_BRANCH_PREFIX.length)}`;
  await git(repoPath, ['branch', '-D', '--', legacy]);
}

/**
 * Runs `fn` inside a throwaway worktree of the clone, DETACHED at `startPoint` (a merge into the working branch is made
 * here, never in the card's worktree or the user's checkout). gate-fixes-2 Rework 2 (B3): no branch in the shared refs,
 * which an agent session could rewrite between the runner's merge and its `rev-parse HEAD`; the detached HEAD lives in
 * this worktree's own admin dir, which no session can write. `tempBranch` only names leftovers of older runners (a
 * temporary branch of that name, and the legacy prefix), removed before and after. The worktree is removed afterwards,
 * whatever `fn` did. Returns `{ ok: false, error }` when the worktree could not be created.
 */
export async function withIntegrationWorktree<T>(
  input: { repoPath: string; dir: string; root: string; tempBranch: string; startPoint: string },
  fn: (integration: string) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const cleanup = async () => {
    await removeWorktree({
      path: input.dir,
      branchName: input.tempBranch,
      deleteBranch: true,
      roots: [input.root],
    });
    await dropLegacyBranch(input.repoPath, input.tempBranch);
  };
  await cleanup();
  await mkdir(dirname(input.dir), { recursive: true });
  const add = await git(input.repoPath, ['worktree', 'add', '--detach', '--', input.dir, input.startPoint]);
  if (add.exitCode !== 0)
    return { ok: false, error: `could not create the integration worktree: ${add.stderr.trim()}` };
  try {
    return { ok: true, value: await fn(input.dir) };
  } finally {
    await cleanup();
  }
}
