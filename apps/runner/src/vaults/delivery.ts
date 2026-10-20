import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DELIVERY_DIR, isSafeVaultPath } from '@aom/shared';
import { git, gitOk } from '../git/git.ts';
import { type VaultIdentity, vaultCommitEnv } from './sync.ts';
import { VaultWriteError } from './write.ts';

export interface DeliveryFile {
  path: string;
  mode: '755' | '644';
  content: Buffer;
}

export interface DeliverySaveResult {
  changed: boolean;
  committed: boolean;
  /** The vault commit that holds the saved recipe (git vaults); null for a local folder. */
  commit: string | null;
}

/** Refuses a path that runs through a symlink (a vault committed with `projects -> /etc` must not redirect a write). */
function refuseSymlinks(root: string, path: string): void {
  let cur = root;
  for (const part of path.split('/')) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink())
        throw new VaultWriteError(`refusing to write through a symlink: ${path}`);
    } catch (err) {
      if (err instanceof VaultWriteError) throw err;
      return;
    }
  }
}

/**
 * `aom recipe save`: replaces `<folder>/delivery/` of the vault with these files (modes kept) and, in a git vault, commits it
 * (the caller pushes through a sync pass). Identical content is a success without a new commit. In a local vault there is
 * no repository: the folder is simply rewritten.
 */
export async function saveDeliveryDir(
  dir: string,
  folder: string,
  files: DeliveryFile[],
  identity: VaultIdentity,
  opts: { commit: boolean; message: string },
): Promise<DeliverySaveResult> {
  const rel = `${folder}/${DELIVERY_DIR}`;
  if (!isSafeVaultPath(rel)) throw new VaultWriteError(`unsafe vault path: ${rel}`);
  for (const f of files)
    if (!isSafeVaultPath(`${rel}/${f.path}`)) throw new VaultWriteError(`unsafe path: ${f.path}`);
  refuseSymlinks(dir, rel);
  const target = join(dir, ...rel.split('/'));
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const f of files) {
    const file = join(target, ...f.path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, f.content, { mode: f.mode === '755' ? 0o755 : 0o644 });
    chmodSync(file, f.mode === '755' ? 0o755 : 0o644);
  }
  if (!opts.commit) return { changed: true, committed: false, commit: null };
  const env = await vaultCommitEnv(dir);
  await gitOk(dir, ['add', '-A', '--', rel], { env });
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--', rel], { env });
  const head = (await git(dir, ['rev-parse', 'HEAD'], { env })).stdout.trim() || null;
  if (staged.exitCode === 0) return { changed: false, committed: false, commit: head };
  await gitOk(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', opts.message, '--', rel], { env });
  return {
    changed: true,
    committed: true,
    commit: (await gitOk(dir, ['rev-parse', 'HEAD'], { env })) || null,
  };
}
