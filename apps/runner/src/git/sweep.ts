import { existsSync } from 'node:fs';
import { readdir, rmdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { WorktreeSweepResult } from '@aom/shared';
import { statusLinesWithoutStubs } from '../adapters/sandbox-placeholders.ts';
import { currentBranch, git } from './git.ts';
import { removeWorktree } from './worktrees.ts';

export interface SweepInput {
  /** `~/.aom-runner/worktrees`: card worktrees live at `<dir>/<KEY>-<project>/<REF>`. */
  worktreesDir: string;
  /** The server's answer: which of these paths belong to a live card. `null`: no answer (nothing is swept). */
  liveOf: (paths: string[]) => Promise<Set<string> | null>;
  /** Worktrees of shifts running right now; never touched. */
  busyPaths?: Iterable<string>;
  /** Clones to run `git worktree prune` in, besides the ones the removed worktrees belonged to. */
  repoPaths?: Iterable<string>;
  /** Messages about worktrees may still be in flight (a non-empty outbox): sweeping then could remove a live one. */
  outboxPending?: number;
}

/** First 50 changed paths of a worktree (`git status --porcelain`, untracked files included). */
export async function changedFiles(path: string): Promise<string[]> {
  const r = await statusLinesWithoutStubs(path);
  if (!r.ok) return [];
  return r.lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, ''))
    .slice(0, 50);
}

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

async function listCandidates(worktreesDir: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(worktreesDir)) return out;
  for (const proj of await readdir(worktreesDir).catch(() => [])) {
    const projDir = join(worktreesDir, proj);
    if (!(await isDir(projDir))) continue;
    for (const ref of await readdir(projDir).catch(() => [])) {
      const p = join(projDir, ref);
      if (await isDir(p)) out.push(resolve(p));
    }
  }
  return out;
}

/** A run environment's folder (`<project>/run-<env>`): it holds one detached worktree per repository. */
const isRunDir = (path: string): boolean => /^run-[0-9a-f]{8}$/.test(basename(path));

/**
 * Sweeps one run environment folder (backlog #58). The server said its environment is not live (stopped for more than the
 * 24 hours manual environments keep their worktrees, or unknown to it). A worktree with uncommitted changes is
 * reported, not deleted; the folder goes only when every worktree in it could be removed.
 */
async function sweepRunDir(
  dir: string,
  input: SweepInput,
  result: WorktreeSweepResult,
  repos: Set<string>,
): Promise<void> {
  const children: string[] = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const p = join(dir, name);
    if (await isDir(p)) children.push(p);
    else {
      result.kept++; // a stray file: not ours to judge
      return;
    }
  }
  let dirty = false;
  for (const c of children) {
    const repo = await repoOfWorktree(c);
    if (repo) repos.add(repo);
    if (!repo) {
      // not a worktree of ours
      result.kept++;
      dirty = true;
      continue;
    }
    const files = await changedFiles(c);
    if (files.length > 0) {
      result.dirty.push({ path: c, branch: await currentBranch(c), files });
      dirty = true;
      continue;
    }
    try {
      await removeWorktree({ path: c, deleteBranch: false, roots: [input.worktreesDir] });
      result.removed.push(c);
    } catch {
      result.kept++;
      dirty = true;
    }
  }
  if (!dirty) {
    await rmdir(dir).then(
      () => result.removed.push(dir),
      () => {},
    );
  }
}

/** The clone a linked worktree belongs to (its common git dir's parent), or null when it is not a worktree. */
async function repoOfWorktree(path: string): Promise<string | null> {
  if (!existsSync(join(path, '.git'))) return null;
  const r = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.exitCode !== 0) return null;
  const common = r.stdout.trim();
  return /[\\/]\.git$/.test(common) ? common.slice(0, -5) : common;
}

/**
 * The runner's safety net (docs/design/phases.md, worktree and branch cleanup addendum): removes card worktrees whose
 * card is finalized, cancelled or unknown to the server, removes empty project folders and runs `git worktree prune`.
 * Conservative on purpose:
 * - the server decides which worktrees are live; with no answer, or with messages still in the outbox, nothing is removed;
 * - a worktree of a running shift is never removed;
 * - a worktree with uncommitted changes is never removed, whatever its card: a dead card's one is reported;
 * - branches are never deleted here (an unmerged branch is the BA's to list).
 */
export async function sweepWorktrees(input: SweepInput): Promise<WorktreeSweepResult> {
  const result: WorktreeSweepResult = {
    scanned: 0,
    kept: 0,
    removed: [],
    dirty: [],
    emptyDirsRemoved: [],
    pruned: 0,
  };
  const repos = new Set<string>([...(input.repoPaths ?? [])].map((p) => resolve(p)));
  const prune = async () => {
    for (const repo of repos) {
      if (existsSync(repo) && (await git(repo, ['worktree', 'prune'])).exitCode === 0) result.pruned++;
    }
  };
  if ((input.outboxPending ?? 0) > 0) {
    await prune();
    return { ...result, skipped: 'messages to the server are still queued' };
  }
  const candidates = await listCandidates(input.worktreesDir);
  result.scanned = candidates.length;
  const live = candidates.length ? await input.liveOf(candidates) : new Set<string>();
  if (!live) {
    await prune();
    return { ...result, skipped: 'the server did not answer' };
  }
  const busy = new Set([...(input.busyPaths ?? [])].map((p) => resolve(p)));
  for (const path of candidates) {
    if (live.has(path) || busy.has(path)) {
      result.kept++;
      continue;
    }
    if (isRunDir(path)) {
      await sweepRunDir(path, input, result, repos);
      continue;
    }
    const repo = await repoOfWorktree(path);
    if (repo) repos.add(repo);
    if (repo) {
      const files = await changedFiles(path);
      if (files.length > 0) {
        result.dirty.push({ path, branch: await currentBranch(path), files });
        continue;
      }
    } else if ((await readdir(path).catch(() => ['?'])).length > 0) {
      // Not a git worktree and not empty: not ours to judge.
      result.kept++;
      continue;
    }
    try {
      await removeWorktree({ path, deleteBranch: false, roots: [input.worktreesDir] });
      result.removed.push(path);
    } catch {
      result.kept++;
    }
  }
  // Empty project folders (and the empty leftovers of removed worktrees).
  if (existsSync(input.worktreesDir)) {
    for (const proj of await readdir(input.worktreesDir).catch(() => [])) {
      const projDir = join(input.worktreesDir, proj);
      if (!(await isDir(projDir))) continue;
      if ((await readdir(projDir).catch(() => ['?'])).length === 0) {
        await rmdir(projDir).then(
          () => result.emptyDirsRemoved.push(projDir),
          () => {},
        );
      }
    }
  }
  await prune();
  return result;
}
