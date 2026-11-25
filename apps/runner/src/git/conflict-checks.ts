import {
  AUTOCOMMIT_MAX_DELETED_FILES,
  AUTOCOMMIT_MAX_DELETED_PERCENT,
  AUTOCOMMIT_PERCENT_MIN_FILES,
  AUTOCOMMIT_TREE_REVERT_DEPTH,
} from '../shifts/autocommit.ts';
import { git } from './git.ts';

/**
 * quiet-approvals S7: before the runner moves a real branch onto a resolution made in the box, it checks the resolution
 * itself (the project's configured checks run separately, in the check sandbox, by the supervisor):
 * - the resolution never restores the tree of an earlier commit of the branch (`tree_revert`: it would undo work);
 * - it never deletes a mass of tracked files (the leftovers commit's limits).
 */

export type GuardVerdict = { ok: true; changedPaths: string[] } | { ok: false; reason: string };

export async function resolutionGuards(repo: string, head: string, candidate: string): Promise<GuardVerdict> {
  const tree = async (rev: string) => (await git(repo, ['rev-parse', `${rev}^{tree}`])).stdout.trim();
  const candTree = await tree(candidate);
  if (!candTree) return { ok: false, reason: 'the resolution is not a commit this clone has' };
  const headTree = await tree(head);
  // an earlier commit of the branch (not the head itself) with exactly this tree: a revert of the work after it
  const log = await git(repo, [
    'log',
    `--max-count=${AUTOCOMMIT_TREE_REVERT_DEPTH}`,
    '--format=%H %T',
    `${head}~1`,
  ]);
  for (const line of log.stdout.split('\n')) {
    const [sha, t] = line.trim().split(' ');
    if (t && t === candTree && t !== headTree)
      return {
        ok: false,
        reason: `the resolution's tree equals the earlier commit ${String(sha).slice(0, 7)} (tree_revert): it would undo the commits after it`,
      };
  }
  const diff = await git(repo, ['diff', '--name-status', '--no-renames', head, candidate]);
  const lines = diff.stdout.split('\n').filter(Boolean);
  const deleted = lines.filter((l) => l.startsWith('D')).length;
  const tracked = (await git(repo, ['ls-tree', '-r', '--name-only', head])).stdout
    .split('\n')
    .filter(Boolean).length;
  if (
    deleted > AUTOCOMMIT_MAX_DELETED_FILES ||
    (deleted >= AUTOCOMMIT_PERCENT_MIN_FILES && deleted * 100 > AUTOCOMMIT_MAX_DELETED_PERCENT * tracked)
  )
    return {
      ok: false,
      reason: `the resolution deletes ${deleted} of ${tracked} tracked files (mass_deletion)`,
    };
  return { ok: true, changedPaths: lines.map((l) => l.split('\t').at(-1) as string) };
}
