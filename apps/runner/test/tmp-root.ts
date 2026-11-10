import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * One temp root per test run (test/global-setup.ts) and one dir per test file inside it (test/setup-git.ts): every
 * `tmpdir()` path and every agent temp dir a test makes lands there, and goes when the file or the run ends, also when a
 * test fails, times out or the run is interrupted.
 */

/** Prefix of the per-run roots under the system temp dir (`aom-vt-runner-XXXXXX`). */
export const ROOT_PREFIX = 'aom-vt-';
/** A root this old belongs to a run that was killed before its teardown: the next run removes it. */
const STALE_MS = 12 * 3600_000;

/** Points `tmpdir()` and the runner's agent temp root at `dir` (read on every call, so later calls follow). */
export function useTmp(dir: string): void {
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  process.env.AOM_AGENT_TMP_ROOT = dir;
}

const uid = (): number | undefined => process.getuid?.();

/** Linux: our processes (not this one) with an argument that is `dir` or a path inside it. Empty elsewhere. */
export function procsUnder(dir: string): number[] {
  if (process.platform !== 'linux' || !dir) return [];
  const me = uid();
  const inside = `${dir.replace(/\/+$/, '')}/`;
  const found: number[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    try {
      if (me !== undefined && statSync(`/proc/${name}`).uid !== me) continue;
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0');
      if (args.some((a) => a === dir || a.includes(inside))) found.push(pid);
    } catch {
      /* gone meanwhile */
    }
  }
  return found;
}

const signal = (pid: number, sig: NodeJS.Signals): void => {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    // a zombie still answers signal 0; it holds nothing
    return !/\)\s+Z\s/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
};

/** SIGTERM the processes under `dir`, wait up to 2 s, SIGKILL the rest. Never throws. */
export async function killProcsUnder(dir: string): Promise<void> {
  const pids = procsUnder(dir);
  if (!pids.length) return;
  for (const p of pids) signal(p, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && pids.some(alive)) await new Promise((r) => setTimeout(r, 100));
  for (const p of pids) if (alive(p)) signal(p, 'SIGKILL');
}

/** SIGKILL the processes under `dir` (for exit handlers, which cannot wait). */
export function killProcsUnderSync(dir: string): void {
  for (const p of procsUnder(dir)) signal(p, 'SIGKILL');
}

/** Linux: the pids of all descendants of `pid` (children, their children, ...). Empty elsewhere. */
export function descendantsOf(pid: number): number[] {
  if (process.platform !== 'linux') return [];
  const children = new Map<number, number[]>();
  let entries: string[] = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      // `pid (comm) state ppid ...`: the command name may hold spaces and parentheses
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(name));
      children.set(ppid, list);
    } catch {
      /* gone meanwhile */
    }
  }
  const found: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length) {
    const p = queue.shift() as number;
    found.push(p);
    queue.push(...(children.get(p) ?? []));
  }
  return found;
}

/**
 * For an interrupted run (exit handler, synchronous): SIGKILL this process's descendants first (the test workers, which
 * otherwise go on starting processes and writing files after the main process exits), then what still runs under `dir`
 * (daemons that left the process tree), then remove `dir`.
 */
export function killAndRemoveSync(dir: string): void {
  for (let round = 0; round < 3; round++) {
    const pids = descendantsOf(process.pid);
    if (!pids.length) break;
    for (const p of pids) signal(p, 'SIGKILL');
  }
  killProcsUnderSync(dir);
  removeTree(dir);
}

/** Removes `dir` and everything in it. Never throws. */
export function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {
    /* busy: a stale-root sweep of a later run tries again */
  }
}

/** Removes the `aom-vt-*` roots under `base` that are ours and older than 12 h (runs killed before their teardown). */
export function sweepStaleRoots(base: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const me = uid();
  for (const name of names) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir, { throwIfNoEntry: false });
      if (!st?.isDirectory() || (me !== undefined && st.uid !== me)) continue;
      if (Date.now() - st.mtimeMs < STALE_MS) continue;
    } catch {
      continue;
    }
    killProcsUnderSync(dir);
    removeTree(dir);
  }
}
