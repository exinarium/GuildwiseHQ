import { existsSync, type Stats } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RunnerPaths } from '../paths.ts';
import { agentTmpDir, agentTmpHeld } from './sandbox.ts';

/**
 * Retention of an agent's `scratch/` folder (the on-disk working directory under `agents/<id>/`). Nothing used to clean it
 * until the agent was fired, and reviewers/testers copied repositories (node_modules and build output included) into it:
 * 200 GB on one workstation. Only top-level entries are judged, as a unit; nothing is ever followed through a symlink.
 */
export interface ScratchPolicy {
  /** Master switch (`scratch.enabled`). */
  enabled: boolean;
  /** Entries whose newest file is older than this many days go. */
  maxAgeDays: number;
  /** Per-agent cap in bytes (0: none); oldest entries are evicted first until the folder fits. */
  maxBytes: number;
  /** Top-level names that are never pruned (small notes an agent keeps across shifts). */
  keep: string[];
}

export const DEFAULT_SCRATCH_POLICY: ScratchPolicy = {
  enabled: true,
  maxAgeDays: 3,
  maxBytes: 10 * 1024 ** 3,
  keep: [],
};

export interface ScratchPruneResult {
  /** Entries removed, with the reason and size. */
  pruned: Array<{ name: string; bytes: number; reason: 'age' | 'cap' }>;
  /** Bytes left in the folder afterwards (kept entries included). */
  bytesLeft: number;
  skipped?: string;
}

interface Measured {
  name: string;
  bytes: number;
  newest: number;
}

/** Size on disk and newest mtime of an entry. Uses lstat only: a symlink counts as itself and is never entered. */
async function measure(path: string, st: Stats): Promise<{ bytes: number; newest: number }> {
  let bytes = typeof st.blocks === 'number' ? st.blocks * 512 : st.size;
  let newest = st.mtimeMs;
  if (!st.isDirectory()) return { bytes, newest };
  for (const name of await readdir(path).catch(() => [] as string[])) {
    const child = join(path, name);
    const cst = await lstat(child).catch(() => null);
    if (!cst) continue;
    const m = await measure(child, cst);
    bytes += m.bytes;
    if (m.newest > newest) newest = m.newest;
  }
  return { bytes, newest };
}

/**
 * Prunes one agent's scratch folder. `inUse` is checked again before every removal. Refuses a folder that is a symlink,
 * not a directory, or not named `scratch`. Never throws.
 */
export async function pruneScratch(
  scratch: string,
  policy: ScratchPolicy,
  inUse: () => boolean,
  now: number = Date.now(),
): Promise<ScratchPruneResult> {
  const result: ScratchPruneResult = { pruned: [], bytesLeft: 0 };
  try {
    if (!policy.enabled) return { ...result, skipped: 'disabled' };
    if (basename(scratch) !== 'scratch') return { ...result, skipped: 'not a scratch folder' };
    const st = await lstat(scratch).catch(() => null);
    if (!st) return { ...result, skipped: 'missing' };
    if (st.isSymbolicLink() || !st.isDirectory()) return { ...result, skipped: 'not a plain directory' };
    if (inUse()) return { ...result, skipped: 'in use' };
    const keep = new Set(policy.keep);
    const entries: Measured[] = [];
    let kept = 0;
    for (const name of await readdir(scratch)) {
      const p = join(scratch, name);
      const est = await lstat(p).catch(() => null);
      if (!est) continue;
      const m = await measure(p, est);
      if (keep.has(name)) kept += m.bytes;
      else entries.push({ name, ...m });
    }
    const remove = async (e: Measured, reason: 'age' | 'cap'): Promise<boolean> => {
      if (inUse()) return false;
      try {
        // rm unlinks a symlink and never follows it
        await rm(join(scratch, e.name), { recursive: true, force: true, maxRetries: 2 });
        result.pruned.push({ name: e.name, bytes: e.bytes, reason });
        return true;
      } catch {
        return false;
      }
    };
    const cutoff = now - policy.maxAgeDays * 86_400_000;
    const left: Measured[] = [];
    for (const e of entries.sort((a, b) => a.newest - b.newest)) {
      if (e.newest < cutoff) {
        if (!(await remove(e, 'age'))) left.push(e);
      } else left.push(e);
    }
    let total = kept + left.reduce((n, e) => n + e.bytes, 0);
    if (policy.maxBytes > 0) {
      for (const e of [...left]) {
        if (total <= policy.maxBytes) break;
        if (await remove(e, 'cap')) {
          total -= e.bytes;
          left.splice(left.indexOf(e), 1);
        }
      }
    }
    result.bytesLeft = total;
  } catch (err) {
    result.skipped = `failed: ${String(err)}`;
  }
  return result;
}

export function describePrune(agentId: string, r: ScratchPruneResult): string {
  const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
  return `scratch prune of agent ${agentId}: removed ${r.pruned.length} entr${r.pruned.length === 1 ? 'y' : 'ies'} (${r.pruned
    .map((p) => `${p.name} ${mb(p.bytes)} ${p.reason}`)
    .join(', ')}), ${mb(r.bytesLeft)} left`;
}

/**
 * Prunes the scratch folder of every agent under `<data dir>/agents`, except `skipAgentIds` (shifts about to be resumed)
 * and agents with a shift or chat running (their TMPDIR is held). Run at start and periodically.
 */
export async function sweepAgentScratch(
  paths: RunnerPaths,
  policy: ScratchPolicy,
  opts: { skipAgentIds?: Iterable<string>; log?: (msg: string) => void; now?: number } = {},
): Promise<{ agents: number; pruned: number; bytes: number }> {
  const skip = new Set(opts.skipAgentIds ?? []);
  const out = { agents: 0, pruned: 0, bytes: 0 };
  if (!policy.enabled) return out;
  const ids = await readdir(paths.agents).catch(() => [] as string[]);
  for (const id of ids) {
    if (skip.has(id)) continue;
    const scratch = join(paths.agentDir(id), 'scratch');
    if (!existsSync(scratch)) continue;
    out.agents++;
    const r = await pruneScratch(scratch, policy, () => agentTmpHeld(agentTmpDir(paths, id)), opts.now);
    if (r.pruned.length) {
      out.pruned += r.pruned.length;
      out.bytes += r.pruned.reduce((n, p) => n + p.bytes, 0);
      opts.log?.(describePrune(id, r));
    }
  }
  return out;
}
