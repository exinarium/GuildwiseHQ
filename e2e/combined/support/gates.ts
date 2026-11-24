import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cross-process gate between a spec (the Playwright worker) and the scripted runner host (another process).
 * A scripted agent drops `reached/<name>` when it gets to a point, then polls `release/<name>`; the spec waits for the
 * marker (state, never time) and writes the release. Both sides only touch files under one directory in the temp dir.
 */
const safe = (name: string): string => {
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) throw new Error(`bad gate name: ${name}`);
  return name;
};

export const gateDirOf = (home: string): string => join(home, 'gates');

export function initGates(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'reached'), { recursive: true });
  mkdirSync(join(dir, 'release'), { recursive: true });
}

/** Script side: say where the agent is. The marker may carry a note (a path, a ref). */
export function reach(dir: string, name: string, note = ''): void {
  writeFileSync(join(dir, 'reached', safe(name)), note);
}

/** Script side: wait for the release until `signal` aborts (a stopped shift). Returns false when aborted. */
export async function waitRelease(dir: string, name: string, signal?: AbortSignal): Promise<boolean> {
  const file = join(dir, 'release', safe(name));
  while (!existsSync(file)) {
    if (signal?.aborted) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Spec side: wait for the marker; returns its note. */
export async function waitReached(dir: string, name: string, timeoutMs = 90_000): Promise<string> {
  const file = join(dir, 'reached', safe(name));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for the agent to reach gate "${name}" in ${dir}`);
}

export function release(dir: string, name: string): void {
  writeFileSync(join(dir, 'release', safe(name)), '');
}
