import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * gate-fixes-2 Rework 1 (R3-B1): agent sessions an earlier runner process started and left running (a crash, an update,
 * a kill) are killed at start, before the push records distrust the clones they were writing (`recoverActiveClones`) and
 * before any new session starts. A session is recognised by its environment: `AOM_SHIFT_ENV_FILE` (every shift, chat
 * turn and box session gets it) pointing inside THIS runner's data dir. Its whole process tree goes (the sandboxed
 * commands are its children). Linux only (`/proc`); elsewhere nothing is done and the caller logs it.
 */

interface Proc {
  pid: number;
  ppid: number;
}

const readProcs = (): Proc[] => {
  const out: Proc[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // pid (comm) state ppid ...: comm may hold spaces and parentheses, so read after the last ')'
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out.push({ pid: Number(name), ppid: Number(rest[1]) });
    } catch {
      // gone, or not ours to read
    }
  }
  return out;
};

const envOf = (pid: number): string[] => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
  } catch {
    return [];
  }
};

/** The pids of this runner's orphaned sessions and all their descendants (never this process or its ancestors). */
export function orphanSessionPids(root: string, procs: Proc[] = readProcs(), env = envOf): number[] {
  const prefix = `${resolve(root)}${sep}`;
  const self = new Set<number>();
  for (let p: number | undefined = process.pid; p && !self.has(p); ) {
    self.add(p);
    p = procs.find((x) => x.pid === p)?.ppid;
  }
  const heads = procs
    .filter((p) => !self.has(p.pid))
    .filter((p) =>
      env(p.pid).some((e) => e.startsWith('AOM_SHIFT_ENV_FILE=') && resolve(e.slice(19)).startsWith(prefix)),
    )
    .map((p) => p.pid);
  const all = new Set<number>(heads);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs)
      if (!all.has(p.pid) && all.has(p.ppid) && !self.has(p.pid)) {
        all.add(p.pid);
        grew = true;
      }
  }
  return [...all];
}

/** Kills the orphaned sessions (SIGKILL) and returns how many processes were signalled; null where `/proc` is missing. */
export function killOrphanSessions(root: string): number | null {
  if (process.platform !== 'linux') return null;
  const pids = orphanSessionPids(root);
  let n = 0;
  for (const pid of pids)
    try {
      process.kill(pid, 'SIGKILL');
      n++;
    } catch {
      // already gone, or not ours
    }
  return n;
}
