import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { alwaysPathRefusal } from '../devops/guard.ts';

/**
 * quiet-approvals phase B, R5-B1: the folder check of the local ceiling. A folder from a Desk click (`allowedPaths`) is
 * mounted into a box only when, by its REAL location:
 *  1. it is a ceiling root or under one (separator-aware: `/srv/app2` is not under `/srv/app`);
 *  2. it does not realpath outside that root (a link inside an allowed folder never opens a private one);
 *  3. it is not on the never-list (T10's R4-S2: `~`, `/`, parents of the runner root, the policy dir, the worktrees,
 *     `HOME_SECRETS`, shell start files, the private set), even under a ceiling root;
 *  4. it is bound through an fd: the runner opens it with `O_PATH|O_NOFOLLOW`, checks the fd's own real path
 *     (`/proc/self/fd/N`) against rules 1-3 and passes that fd to bubblewrap (`--bind-fd`/`--ro-bind-fd`), so the check
 *     and the bind see the same inode. A link swapped in between the check and the open is caught by the fd's path.
 */

/** Linux `O_PATH` (Node does not export it): open for the path only, never the content. */
export const O_PATH = 0o10000000;

/**
 * Rework 2 (REVIEW nit 3): the open flag for a checked folder. `O_PATH` is Linux-only (its value is `O_SYMLINK` on
 * Darwin, which would open the link itself); elsewhere the folder is opened read-only, which `O_DIRECTORY` keeps to a
 * directory. The Mac fd is never bound (sandbox-exec takes paths); it only pins the inode between the two checks.
 */
export const folderOpenFlag = (platform: NodeJS.Platform = process.platform): number =>
  platform === 'linux' ? O_PATH : constants.O_RDONLY;

export interface NeverListContext {
  home: string;
  policyRoot: string;
  worktrees: string;
  runnerRoot: string;
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** `child` is `root` or inside it, both already real, separator-aware. */
export function underRoot(child: string, root: string): boolean {
  const r = root.endsWith(sep) && root !== sep ? root.slice(0, -1) : root;
  return child === r || child.startsWith(r === sep ? sep : r + sep);
}

/** Why a folder may never be a ceiling root (the local page refuses it), or null. */
export function ceilingRootRefusal(dir: string, nl: NeverListContext): string | null {
  const r = real(dir);
  if (!r) return 'the folder does not exist';
  return (
    alwaysPathRefusal(r, nl) ??
    // the real location of the runner root may differ from its given path (a link): check that too
    alwaysPathRefusal(r, { ...nl, runnerRoot: real(nl.runnerRoot) ?? nl.runnerRoot })
  );
}

export type FolderCheck = { ok: true; real: string; root: string } | { ok: false; reason: string };

/** Rules 1-3 on a requested path against the ceiling roots. */
export function checkFolder(requested: string, roots: readonly string[], nl: NeverListContext): FolderCheck {
  const target = real(resolve(requested));
  if (!target) return { ok: false, reason: `${requested} does not exist` };
  const realRoots = roots.map((r) => real(r)).filter((r): r is string => !!r);
  const root = realRoots.find((r) => underRoot(target, r));
  if (!root)
    return {
      ok: false,
      reason: `${requested} is not inside a folder this computer allows (its real location is ${target})`,
    };
  const never = alwaysPathRefusal(target, nl);
  if (never) return { ok: false, reason: `${requested} is never given to DevOps: ${never}` };
  if (ceilingRootRefusal(root, nl))
    return { ok: false, reason: `${root} may not be a folder for DevOps on this computer` };
  return { ok: true, real: target, root };
}

export interface OpenedFolder {
  fd: number;
  real: string;
  close(): void;
}

/**
 * Rule 4: opens the checked folder with `O_PATH|O_NOFOLLOW|O_DIRECTORY` and re-checks the real path of the fd itself.
 * Returns the fd to hand to bubblewrap, or why not. `openFd` and `fdPath` are test hooks (a race between check and open).
 */
export function openCheckedFolder(
  requested: string,
  roots: readonly string[],
  nl: NeverListContext,
  hooks: { beforeOpen?: (real: string) => void; fdPath?: (fd: number) => string } = {},
): { ok: true; folder: OpenedFolder } | { ok: false; reason: string } {
  const first = checkFolder(requested, roots, nl);
  if (!first.ok) return first;
  hooks.beforeOpen?.(first.real);
  let fd: number;
  try {
    fd = openSync(first.real, folderOpenFlag() | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  } catch (err) {
    return {
      ok: false,
      reason: `${requested} could not be opened safely (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  }
  const close = () => {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  };
  let viaFd: string;
  try {
    viaFd = hooks.fdPath ? hooks.fdPath(fd) : readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    close();
    return { ok: false, reason: `${requested}: the opened folder cannot be checked` };
  }
  const again = checkFolder(viaFd, roots, nl);
  if (!again.ok || again.real !== first.real) {
    close();
    return {
      ok: false,
      reason: `${requested} changed while it was being opened (now ${viaFd}): not mounted`,
    };
  }
  return { ok: true, folder: { fd, real: again.real, close } };
}

/**
 * bubblewrap's arguments for the opened folders: each fd is passed to the bwrap process at the index given by
 * `fdIndex` (the spawn `stdio` slot), mounted at its real path.
 */
export function fdBindArgs(
  folders: ReadonlyArray<{ fdIndex: number; real: string; writable: boolean }>,
): string[] {
  return folders.flatMap((f) => [f.writable ? '--bind-fd' : '--ro-bind-fd', String(f.fdIndex), f.real]);
}

/**
 * quiet-approvals Rework 1 (REVIEW B2): a folder a server names for a CEO full-power turn (its cwd, its added folders) is
 * mounted only read-only, by its real location, never one of the never-list nor the home folder itself, through an
 * `O_PATH|O_NOFOLLOW` fd re-checked via `/proc/self/fd` (the bind sees the inode that was checked).
 */
export function openNamedFolder(
  requested: string,
  nl: NeverListContext,
  hooks: { beforeOpen?: (real: string) => void; fdPath?: (fd: number) => string } = {},
): { ok: true; folder: OpenedFolder } | { ok: false; reason: string } {
  const check = (p: string): { ok: true; real: string } | { ok: false; reason: string } => {
    const r = real(resolve(p));
    if (!r) return { ok: false, reason: `${p} does not exist` };
    const homeReal = real(nl.home) ?? nl.home;
    if (r === homeReal || r === sep) return { ok: false, reason: `${p} is the home folder or / as a whole` };
    const never =
      alwaysPathRefusal(r, nl) ??
      alwaysPathRefusal(r, { ...nl, home: homeReal, runnerRoot: real(nl.runnerRoot) ?? nl.runnerRoot });
    return never ? { ok: false, reason: `${p} is never given to an agent: ${never}` } : { ok: true, real: r };
  };
  const first = check(requested);
  if (!first.ok) return first;
  hooks.beforeOpen?.(first.real);
  let fd: number;
  try {
    fd = openSync(first.real, folderOpenFlag() | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  } catch (err) {
    return {
      ok: false,
      reason: `${requested} could not be opened safely (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
    };
  }
  const close = () => {
    try {
      closeSync(fd);
    } catch {}
  };
  let viaFd: string;
  try {
    viaFd = hooks.fdPath ? hooks.fdPath(fd) : readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    close();
    return { ok: false, reason: `${requested}: the opened folder cannot be checked` };
  }
  const again = check(viaFd);
  if (!again.ok || again.real !== first.real) {
    close();
    return { ok: false, reason: `${requested} changed while it was being opened: not mounted` };
  }
  return { ok: true, folder: { fd, real: first.real, close } };
}

/**
 * quiet-approvals Rework 1 (REVIEW S1): reads a file a box wrote, from a box-writable folder: its real location must be
 * under `base`, the last component is opened with `O_NOFOLLOW|O_NONBLOCK` (a link or a FIFO never blocks or redirects the
 * runner), it must be a regular file, and at most `max` bytes. Never echoes the content in an error.
 */
export function readBoxFile(file: string, base: string, max: number): string | { error: string } {
  const r = real(file);
  const b = real(base);
  if (!r || !b || !underRoot(r, b) || r !== resolve(file))
    return { error: 'not a plain file in your working folder' };
  let fd: number;
  try {
    fd = openSync(r, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { error: 'not a plain file in your working folder' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { error: 'not a regular file' };
    if (st.size > max) return { error: `larger than ${max} bytes` };
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return { error: 'could not be read' };
  } finally {
    closeSync(fd);
  }
}
