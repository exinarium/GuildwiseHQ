import { existsSync, lstatSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isSafeVaultPath, normalizeRemoteUrl, type VaultMergeCommand } from '@aom/shared';
import { git, gitOk } from '../git/git.ts';
import { type VaultIdentity, vaultCommitEnv } from './sync.ts';
import { VaultWriteError } from './write.ts';

export interface VaultMergeResult {
  /** Files copied into the target now (0 when an earlier run already did it, or the source is empty). */
  copied: number;
  committed: boolean;
  /** Files that exist at the destination with different content: they stay as they are for the manager to sort out. */
  conflicts: string[];
  /** Set when the source is the same repository as the target: nothing was copied (a no-op success). */
  skipped?: string;
}

/** The normalized `origin` of a clone (null when it has none). */
async function originOf(dir: string): Promise<string | null> {
  const r = await git(dir, ['remote', 'get-url', 'origin']);
  return r.exitCode === 0 && r.stdout.trim() ? normalizeRemoteUrl(r.stdout.trim()) : null;
}

/** True when the two clones have the same `origin` after normalization (the safety net after cloning). */
export async function isSameRepository(dir: string, srcDir: string): Promise<boolean> {
  const [a, b] = [await originOf(dir), await originOf(srcDir)];
  return a !== null && a === b;
}

export const SAME_REPOSITORY_MESSAGE =
  'the source vault is the same repository as the target: nothing to merge, nothing copied';

/** Every regular file below `root` (relative, forward slashes), skipping `.git` and symlinks. */
async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name === '.git' && rel === '') continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...(await listFiles(root, r)));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

/** The destination of a source file: a lifted folder keeps its own path at the root, everything else goes under `into`. */
function destinationOf(rel: string, into: string, lift: string[]): string {
  return lift.some((f) => rel === f || rel.startsWith(`${f}/`)) ? rel : `${into}/${rel}`;
}

/**
 * `vault.merge` (the "drop personal" migration): copies the files of the vault clone
 * `srcDir` into the clone `dir` under the folder `into`, except the folders in `lift`, which keep their own path (a
 * personal interest's `interests/<slug>/` lands in the organization vault's `interests/<slug>/`). Nothing is
 * overwritten: identical files are skipped, differing ones are reported as conflicts. Idempotent and safe to repeat after
 * an interruption (a run that stopped after copying but before committing is finished by the next one). The source is
 * never changed, so the old repository stays as a backup. The caller pushes (sync) when `cmd.push`.
 */
export async function mergeVaultInto(
  dir: string,
  srcDir: string,
  cmd: VaultMergeCommand,
  identity: VaultIdentity,
): Promise<VaultMergeResult> {
  const { into, lift } = cmd;
  if (
    (await isSameRepository(dir, srcDir)) ||
    normalizeRemoteUrl(cmd.from.remoteUrl) === (await originOf(dir))
  )
    return { copied: 0, committed: false, conflicts: [], skipped: SAME_REPOSITORY_MESSAGE };
  for (const p of [into, ...lift])
    if (!isSafeVaultPath(p)) throw new VaultWriteError(`unsafe vault path: ${p}`);
  if (lift.some((f) => f === into || f.startsWith(`${into}/`) || into.startsWith(`${f}/`)))
    throw new VaultWriteError(`cannot lift ${lift.join(', ')} into ${into}: they overlap`);
  const conflicts: string[] = [];
  let copied = 0;
  const files = existsSync(srcDir) ? await listFiles(srcDir) : [];
  for (const rel of files) {
    if (!isSafeVaultPath(rel)) continue;
    const dest = destinationOf(rel, into, lift);
    const from = join(srcDir, ...rel.split('/'));
    const to = join(dir, ...dest.split('/'));
    refuseSymlinkPath(dir, dest);
    if (existsSync(to)) {
      if (!(await readFile(from)).equals(await readFile(to))) conflicts.push(dest);
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    copied++;
  }
  const env = await vaultCommitEnv(dir);
  // Stage what the merge owns (the folder and the lifted folders); a side that is neither on disk nor tracked has nothing to stage.
  const known: string[] = [];
  for (const p of [into, ...lift]) {
    const tracked = (await git(dir, ['ls-files', '--', p], { env })).stdout.trim() !== '';
    if (existsSync(join(dir, ...p.split('/'))) || tracked) known.push(p);
  }
  if (known.length === 0) return { copied, committed: false, conflicts };
  await gitOk(dir, ['add', '-A', '--', ...known], { env });
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--', ...known], { env });
  if (staged.exitCode === 0) return { copied, committed: false, conflicts };
  await gitOk(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', cmd.commitMessage, '--', ...known], {
    env,
  });
  return { copied, committed: true, conflicts };
}

/** Refuses a destination that runs through a symlink of the target clone. */
function refuseSymlinkPath(root: string, path: string): void {
  let cur = root;
  for (const part of path.split('/')) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink())
        throw new VaultWriteError(`refusing to write through a symlink: ${path}`);
    } catch (err) {
      if (err instanceof VaultWriteError) throw err;
      return; // the rest does not exist yet
    }
  }
}
