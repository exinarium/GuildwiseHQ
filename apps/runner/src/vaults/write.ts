import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  applyManagedSection,
  isSafeVaultPath,
  type VaultMoveCommand,
  type VaultWriteCommand,
} from '@aom/shared';
import { git, gitOk } from '../git/git.ts';
import { type VaultIdentity, vaultCommitEnv } from './sync.ts';

export class VaultWriteError extends Error {}

export interface VaultWriteResult {
  /** The file content changed (false: an identical write already happened, which is success). */
  written: boolean;
  committed: boolean;
}

/**
 * `vault.write` (docs/ARCHITECTURE.md section 16.4): writes one markdown file into the local vault clone and commits
 * it. Idempotent: `create` of identical content, `append` of a block that is already there and `replace` with
 * identical content are successes without a new commit. The caller pushes (sync) when `cmd.push`.
 */
export async function writeVaultFile(
  dir: string,
  cmd: VaultWriteCommand,
  identity: VaultIdentity,
  /** `commit: false`: a local vault folder, there is no repository to commit to. */
  opts: { commit?: boolean } = {},
): Promise<VaultWriteResult> {
  if (!isSafeVaultPath(cmd.path)) throw new VaultWriteError(`unsafe vault path: ${cmd.path}`);
  const file = join(dir, ...cmd.path.split('/'));
  refuseSymlinks(dir, cmd.path);
  const exists = existsSync(file);
  const current = exists ? await readFile(file, 'utf8') : '';
  let next: string;
  switch (cmd.mode) {
    case 'create':
      if (exists) {
        if (current === cmd.content) return { written: false, committed: false };
        throw new VaultWriteError(`${cmd.path} already exists with different content`);
      }
      next = cmd.content;
      break;
    case 'append':
      if (exists && current.includes(cmd.content)) return { written: false, committed: false };
      next = exists
        ? `${current}${current && !current.endsWith('\n') ? '\n' : ''}${cmd.content}`
        : `${cmd.header ?? ''}${cmd.content}`;
      break;
    case 'replace':
      if (exists && current === cmd.content) return { written: false, committed: false };
      next = cmd.content;
      break;
    case 'section': {
      // A site-managed block between markers; a stale or identical version changes nothing (idempotent).
      if (!cmd.section) throw new VaultWriteError('section mode needs a section id and version');
      const r = applyManagedSection(
        exists ? current : null,
        cmd.header ?? '',
        cmd.section.id,
        cmd.section.version,
        cmd.content,
      );
      if (!r.changed) return { written: false, committed: false };
      next = r.text;
      break;
    }
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, next);
  if (opts.commit === false) return { written: true, committed: false };
  const env = await vaultCommitEnv(dir);
  await gitOk(dir, ['add', '--', cmd.path], { env });
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--', cmd.path], { env });
  if (staged.exitCode === 0) return { written: true, committed: false };
  await gitOk(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', cmd.commitMessage, '--', cmd.path], {
    env,
  });
  return { written: true, committed: true };
}

/** Refuses a path that runs through a symlink (a vault committed with `docs -> /etc` must not redirect a write). */
function refuseSymlinks(root: string, path: string): void {
  let cur = root;
  for (const part of path.split('/')) {
    cur = join(cur, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(cur);
    } catch {
      return; // the rest does not exist yet: it will be created as plain directories
    }
    if (st.isSymbolicLink()) throw new VaultWriteError(`refusing to write through a symlink: ${path}`);
  }
}

export interface VaultMoveResult {
  /** Something was moved or merged now (false: it was moved before, or there was nothing to move). */
  moved: boolean;
  committed: boolean;
  /** Files that exist at both places with different content: they stay where they are for the manager to sort out. */
  conflicts: string[];
}

/** Moves every entry of `src` into `dst` without overwriting: identical files are dropped from `src`, differing ones are reported. */
async function mergeInto(src: string, dst: string, rel: string, conflicts: string[]): Promise<boolean> {
  let changed = false;
  for (const name of await readdir(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const here = rel ? `${rel}/${name}` : name;
    const st = await stat(from);
    if (!existsSync(to)) {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      changed = true;
    } else if (st.isDirectory()) {
      if (await mergeInto(from, to, here, conflicts)) changed = true;
    } else if ((await readFile(from)).equals(await readFile(to))) {
      await rm(from);
      changed = true;
    } else conflicts.push(here);
  }
  const left = await readdir(src);
  if (left.length === 0) await rm(src, { recursive: true });
  return changed;
}

/**
 * `vault.move`: renames a folder of the vault clone and commits it as one change, so the history follows the files.
 * Idempotent and safe if interrupted: a folder that is gone from `from` and present at `to` only needs its commit (a
 * crash between the rename and the commit is finished by running it again); a folder present at both places is merged
 * without overwriting. The caller pushes (sync) when `cmd.push`.
 */
export async function moveVaultFolder(
  dir: string,
  cmd: VaultMoveCommand,
  identity: VaultIdentity,
): Promise<VaultMoveResult> {
  const { from, to } = cmd;
  if (!isSafeVaultPath(from) || !isSafeVaultPath(to))
    throw new VaultWriteError(`unsafe vault path: ${from} -> ${to}`);
  if (from === to || to.startsWith(`${from}/`) || from.startsWith(`${to}/`))
    throw new VaultWriteError(`cannot move ${from} to ${to}: one is inside the other`);
  refuseSymlinks(dir, from);
  refuseSymlinks(dir, to);
  const src = join(dir, ...from.split('/'));
  const dst = join(dir, ...to.split('/'));
  const conflicts: string[] = [];
  let moved = false;
  if (existsSync(src)) {
    if (!(await stat(src)).isDirectory()) throw new VaultWriteError(`${from} is not a folder`);
    if (!existsSync(dst)) {
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);
      moved = true;
    } else moved = await mergeInto(src, dst, '', conflicts);
  }
  const env = await vaultCommitEnv(dir);
  // Stage both sides (the deletions of `from` and the files of `to`), then commit what changed, if anything. A side that
  // is neither on disk nor tracked has nothing to stage (git refuses such a pathspec).
  const known: string[] = [];
  for (const p of [from, to]) {
    const tracked = (await git(dir, ['ls-files', '--', p], { env })).stdout.trim() !== '';
    if (existsSync(join(dir, ...p.split('/'))) || tracked) known.push(p);
  }
  if (known.length === 0) return { moved, committed: false, conflicts };
  await gitOk(dir, ['add', '-A', '--', ...known], { env });
  const staged = await git(dir, ['diff', '--cached', '--quiet', '--', ...known], { env });
  if (staged.exitCode === 0) return { moved, committed: false, conflicts };
  await gitOk(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', cmd.commitMessage, '--', ...known], {
    env,
  });
  return { moved: true, committed: true, conflicts };
}
