import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Process helpers for supervised services: a service is started in its own process group (`setsid`, Node's `detached`),
 * so the whole tree can be signalled with a negative pid, and it survives the runner. A pid alone is not an identity
 * (pids are reused): the start time is kept next to it and compared when the runner re-adopts a process.
 */

/** Is something running under this pid? */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, we may not signal it
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The kernel's start time of a process (an opaque string that is stable for the life of the process), or null. */
export async function procStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name (field 2) may contain spaces and parentheses: count fields after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return rest[19] ?? null; // field 22 (starttime), 0-based index 19 after "state"
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null),
    );
  });
}

/** Is `pid` still the process that was started at `startTime`? */
export async function sameProcess(pid: number, startTime: string | null): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  if (!startTime) return true;
  const now = await procStartTime(pid);
  return now === null ? false : now === startTime;
}

/** Signals the process group of a service (the leader is the group id). Returns false when there is no such group. */
export function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Stops a service: SIGTERM to the group, SIGKILL after `graceMs`. Resolves when the leader is gone. (A group member that
 * ignores SIGTERM is killed with the final SIGKILL to the group.)
 */
export async function stopGroup(pid: number, graceMs = 10_000): Promise<void> {
  if (!pidAlive(pid)) {
    signalGroup(pid, 'SIGKILL'); // stragglers of an exited leader
    return;
  }
  signalGroup(pid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && pidAlive(pid)) await sleep(100);
  signalGroup(pid, 'SIGKILL');
  const hard = Date.now() + 2000;
  while (Date.now() < hard && pidAlive(pid)) await sleep(50);
}
