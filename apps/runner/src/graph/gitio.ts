import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { git } from '../git/git.ts';
import type { TreeEntry } from './types.ts';

/**
 * Reads a repository at a commit without touching its working tree (no checkout, no worktree): the clone's own object
 * store through `git ls-tree` and `git cat-file --batch` (docs/design/project-graphs.md section 5, step 1).
 */

export async function resolveCommit(
  repoPath: string,
  ref: string | null | undefined,
): Promise<string | null> {
  for (const r of [ref, 'HEAD']) {
    if (!r) continue;
    const out = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]);
    if (out.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(out.stdout.trim())) return out.stdout.trim();
    // a remote-tracking working branch when the local branch does not exist
    if (r === ref) {
      const remote = await git(repoPath, ['rev-parse', '--verify', '--quiet', `origin/${r}^{commit}`]);
      if (remote.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(remote.stdout.trim()))
        return remote.stdout.trim();
    }
  }
  return null;
}

/** Every blob of the commit (symlinks and submodules left out) with its size. */
export async function listTree(repoPath: string, commit: string): Promise<TreeEntry[]> {
  const r = await git(repoPath, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]);
  if (r.exitCode !== 0) throw new Error('could not list the commit');
  const out: TreeEntry[] = [];
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(/\s+/);
    const [mode, type, blob, size] = meta;
    if (type !== 'blob' || mode === '120000' || !blob) continue;
    out.push({ path: rec.slice(tab + 1), blob, size: Number(size) || 0 });
  }
  return out;
}

/** Paths that changed between two commits: added, modified and deleted (no rename detection, so a move is both). */
export async function changedPaths(
  repoPath: string,
  from: string,
  to: string,
): Promise<{ changed: string[]; deleted: string[] } | null> {
  const r = await git(repoPath, ['diff', '--name-status', '--no-renames', '-z', from, to]);
  if (r.exitCode !== 0) return null;
  const parts = r.stdout.split('\0').filter((x) => x !== '');
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] as string;
    const path = parts[i + 1] as string;
    if (status.startsWith('D')) deleted.push(path);
    else changed.push(path);
  }
  return { changed: changed.sort(), deleted: deleted.sort() };
}

export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  const r = await git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return r.exitCode === 0;
}

/** A long-running `git cat-file --batch`: blobs are read one request at a time over one process. */
export class BlobReader {
  private child: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private ended = false;

  constructor(repoPath: string) {
    this.child = spawn('git', ['cat-file', '--batch'], {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.waiter?.();
    });
    this.child.on('close', () => {
      this.ended = true;
      this.waiter?.();
    });
    this.child.on('error', () => {
      this.ended = true;
      this.waiter?.();
    });
    this.child.stdin.on('error', () => undefined);
    this.child.stderr.on('data', () => undefined);
  }

  private async need(pred: () => boolean): Promise<boolean> {
    while (!pred()) {
      if (this.ended) return false;
      await new Promise<void>((res) => {
        this.waiter = () => {
          this.waiter = null;
          res();
        };
      });
    }
    return true;
  }

  /** The blob's bytes, or null when it is missing. */
  read(blob: string): Promise<Buffer | null> {
    const run = async (): Promise<Buffer | null> => {
      this.child.stdin.write(`${blob}\n`);
      if (!(await this.need(() => this.buf.includes(0x0a)))) return null;
      const nl = this.buf.indexOf(0x0a);
      const header = this.buf.subarray(0, nl).toString('utf8');
      const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(nl + 1);
        return null; // "<sha> missing"
      }
      const size = Number(m[1]);
      if (!(await this.need(() => this.buf.length >= nl + 1 + size + 1))) return null;
      const body = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      return body;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  close(): void {
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

/** True when the buffer is probably binary (a NUL byte in the first 8 KB). */
export const looksBinary = (b: Buffer): boolean => b.subarray(0, 8192).includes(0);
