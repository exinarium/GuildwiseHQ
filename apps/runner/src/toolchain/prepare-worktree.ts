import { spawn as nodeSpawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProjectPath } from '@aom/shared';
import { type CheckLaunch, capture } from '../checks/run.ts';
import { fillDeploySubmodules } from '../delivery/submodules.ts';
import { git, revParse } from '../git/git.ts';
import { readSubmodules } from '../git/submodule-pin.ts';
import { detectStacks, viewOf } from './detect.ts';
import { depCommand } from './ensure.ts';
import { STACKS } from './stacks.ts';
import type { DepStep, Platform } from './types.ts';

/** The whole preparation of one new worktree may take this long; what is left over is reported as not prepared. */
export const PREPARE_BUDGET_MS = 5 * 60_000;
const MAX_STEPS = 20;

export interface PrepStep {
  name: string;
  status: 'done' | 'failed' | 'skipped';
  detail?: string;
  ms: number;
}

export interface PrepResult {
  /** False when a step failed (what failed is in its `detail`). */
  ok: boolean;
  steps: PrepStep[];
}

export interface PrepareWorktreeInput {
  /** The card worktree that was just added. */
  worktree: string;
  /** The local clone the worktree belongs to (submodules are cloned from the workstation's clones). */
  repoPath: string;
  /**
   * The project's trusted branches, first that exists wins: its working branch, then the repository's main branch (never
   * a card's base, which for a suite card is a card branch). Submodules are filled only when the card worktree's
   * `.gitmodules` is the very same blob as on that branch. Absent: no submodule is filled.
   */
  trustedBranches?: string[];
  /** The project's sub directory in the repository (absent: the root): dependencies are installed there. */
  projectPath?: string;
  findRepo: (remoteUrlNormalized: string) => Promise<{ localPath: string } | undefined>;
  /** The run-step sandbox command line (`RunsManager.checkLaunch`); may throw. Absent: dependencies are skipped. */
  launch?: (argv: string[], key: string) => Promise<CheckLaunch>;
  platform: Platform;
  budgetMs?: number;
  signal?: AbortSignal;
  /** Test hook: the dependency steps of the project folder (default: the toolchain table's `detectStacks` + `deps`). */
  stacks?: (dir: string) => Array<{ id: string; steps: DepStep[] }>;
  spawnImpl?: typeof nodeSpawn;
  now?: () => number;
}

/** The project's dependency installs, from the same table the toolchain step uses (D6), in its order. */
function defaultStacks(dir: string, platform: Platform): Array<{ id: string; steps: DepStep[] }> {
  return detectStacks(viewOf(dir, platform)).map((d) => ({
    id: d.id,
    steps: STACKS.find((s) => s.id === d.id)?.deps?.(d, platform) ?? [],
  }));
}

/**
 * Dependency steps whose output does not land in the worktree or a shared cache: inside the run-step sandbox they write to
 * its private home, which is removed after the step (bundler's user gem dir, cargo's unshared `CARGO_HOME`). They are
 * reported as not run instead of "done".
 */
const OUTPUT_OUTSIDE_WORKTREE = new Set(['bundle', 'cargo']);

/** Keeps the virtualenvs of poetry and pipenv in the project (`.venv`) instead of the sandbox's private home. */
const IN_PROJECT_ENV = { CI: 'true', POETRY_VIRTUALENVS_IN_PROJECT: 'true', PIPENV_VENV_IN_PROJECT: '1' };

const tail = (text: string, n = 400): string => {
  const t = text.trim();
  return t.length <= n ? t : `...${t.slice(-n)}`;
};

/** Changed and new paths in the worktree (`git status`), submodule contents left out. */
async function changedPaths(dir: string): Promise<Array<{ path: string; untracked: boolean }>> {
  const r = await git(dir, ['status', '--porcelain=v1', '-z', '--ignore-submodules=dirty']);
  if (r.exitCode !== 0) return [];
  const out: Array<{ path: string; untracked: boolean }> = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] as string;
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    out.push({ path: e.slice(3), untracked: code === '??' });
    if (code[0] === 'R' || code[0] === 'C') i++; // the rename's source path follows
  }
  return out;
}

/**
 * Prepares a card worktree the runner just added, so the agent can build and test without asking DevOps: each submodule
 * at its pinned commit (from the workstation's clones, `fillDeploySubmodules`), then the project's dependency installs
 * (`pnpm install`, `dotnet restore`, ...) in the run-step sandbox with `CI=true` (the worktree may hold agent-written
 * scripts, so nothing it holds runs unsandboxed). Submodules are filled on the host by git, but only when the worktree's
 * `.gitmodules` is the same blob as on the project's working branch (else none is), only from the workstation's own clone
 * of the submodule's repository, and the file protocol is allowed
 * only for that clone's path: no url from the branch's `.gitmodules` is ever fetched. Never throws: a failure is a step
 * with its detail. The whole run, submodules included, has one budget
 * and stops on `signal`. Afterwards no tracked file is left changed and no new unignored file is left behind (a rewritten
 * lockfile is restored, and said so), so the guard and the autocommit see nothing.
 *
 * It does not depend on the workstation's "Install packages and tools" DevOps setting: that setting governs installing
 * tools on the workstation itself (the toolchain step, unsandboxed). This only fills the project's own dependencies,
 * inside the sandbox, in the card's worktree and the shared package caches; its own switch is `prepareWorktrees`.
 */
export async function prepareWorktree(i: PrepareWorktreeInput): Promise<PrepResult> {
  const now = i.now ?? Date.now;
  const started = now();
  const budget = i.budgetMs ?? PREPARE_BUDGET_MS;
  const left = () => budget - (now() - started);
  const steps: PrepStep[] = [];
  const add = (s: PrepStep) => {
    if (steps.length < MAX_STEPS) steps.push(s);
  };
  try {
    const before = new Set((await changedPaths(i.worktree)).map((c) => c.path));

    // 1. Submodules at the commits the checkout pins: only the trusted ones, only from local clones (see above).
    if (await hasGitmodules(i.worktree)) {
      const t = now();
      const skipped: string[] = [];
      const filled: string[] = [];
      const trusted = await trustedGitmodules(i.repoPath, i.trustedBranches ?? []);
      const mine = (
        await git(i.worktree, ['rev-parse', '--verify', '--quiet', 'HEAD:.gitmodules'])
      ).stdout.trim();
      if (!trusted || !mine || mine !== trusted.blob) {
        // A changed `.gitmodules` (an added entry can take over a trusted path): nothing is filled.
        const why = trusted
          ? ".gitmodules differs from the project's working branch, so no submodule was filled"
          : "the project's working branch has no .gitmodules (or is not in this clone), so no submodule was filled";
        const originUrl = (await git(i.repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
        const paths = [...new Set((await readSubmodules(i.worktree, originUrl)).map((x) => x.path))];
        add({
          name: 'submodules not filled',
          status: 'skipped',
          detail: `${paths.join(', ') || 'all submodules'}: ${why}`,
          ms: 0,
        });
      } else {
        try {
          const problem = await fillDeploySubmodules(i.worktree, i.repoPath, i.findRepo, {
            localOnly: true,
            allowed: trusted.submodules,
            deadline: started + budget,
            ...(i.signal ? { signal: i.signal } : {}),
            now,
            skipped,
            filled,
          });
          if (problem || filled.length)
            add({
              name: 'submodules',
              status: problem ? 'failed' : 'done',
              ...(problem ? { detail: problem } : {}),
              ms: now() - t,
            });
        } catch (err) {
          add({ name: 'submodules', status: 'failed', detail: errText(err), ms: now() - t });
        }
      }
      if (skipped.length)
        add({ name: 'submodules not filled', status: 'skipped', detail: skipped.join('; '), ms: 0 });
    }

    // 2. The project's dependencies, in its folder, sandboxed.
    let dir = i.worktree;
    try {
      const sub = i.projectPath ? normalizeProjectPath(i.projectPath) : '';
      if (sub) dir = join(i.worktree, sub);
    } catch {
      add({
        name: 'dependencies',
        status: 'failed',
        detail: `the project path "${i.projectPath}" is not valid`,
        ms: 0,
      });
      return finish();
    }
    let stacks: Array<{ id: string; steps: DepStep[] }> = [];
    try {
      stacks = (i.stacks ?? ((d: string) => defaultStacks(d, i.platform)))(dir);
    } catch (err) {
      add({
        name: 'dependencies',
        status: 'failed',
        detail: `detecting the stacks failed: ${errText(err)}`,
        ms: 0,
      });
    }
    for (const stack of stacks) {
      for (const step of stack.steps) {
        const t = now();
        const argv = [depCommand(step, dir), ...step.args];
        if (i.signal?.aborted) {
          add({ name: step.name, status: 'skipped', detail: 'the shift was stopped', ms: 0 });
          break;
        }
        if (!i.launch) {
          add({ name: step.name, status: 'skipped', detail: 'no sandboxed launcher on this runner', ms: 0 });
          break;
        }
        if (OUTPUT_OUTSIDE_WORKTREE.has(step.cmd)) {
          add({
            name: step.name,
            status: 'skipped',
            detail: 'not run: its output would not be kept in the worktree',
            ms: 0,
          });
          break;
        }
        const remaining = left();
        if (remaining <= 0) {
          add({
            name: step.name,
            status: 'failed',
            detail: `not run: over the ${minutes(budget)} budget`,
            ms: 0,
          });
          break;
        }
        let l: CheckLaunch;
        try {
          l = await i.launch(argv, `prep-${step.name}`);
        } catch {
          // No run-step sandbox here (no bubblewrap, macOS, Windows): like no launcher, not a failure of the card.
          add({
            name: step.name,
            status: 'skipped',
            detail: 'no run-step sandbox on this workstation, so it was not run',
            ms: now() - t,
          });
          break;
        }
        try {
          const c = await capture(
            { ...l, env: { ...l.env, ...IN_PROJECT_ENV } },
            dir,
            remaining,
            i.signal,
            i.spawnImpl ?? nodeSpawn,
          );
          const fail = (detail: string) => add({ name: step.name, status: 'failed', detail, ms: now() - t });
          if (c.aborted) fail('stopped: the shift ended');
          else if (c.spawnError !== undefined) fail(`could not start: ${c.spawnError}`);
          else if (c.timedOut) fail(`timed out: over the ${minutes(budget)} budget`);
          else if (c.exitCode !== 0) fail(`exit ${c.exitCode ?? '?'}: ${tail(c.output) || 'no output'}`);
          else add({ name: step.name, status: 'done', ms: now() - t });
          if (c.exitCode !== 0) break; // later steps of this stack depend on this one
        } finally {
          if (l.tmp) rmSync(l.tmp, { recursive: true, force: true });
        }
      }
    }

    // 3. Leave the tree as git had it: restore what an install changed, remove what it added outside .gitignore.
    const changed = (await changedPaths(i.worktree)).filter((c) => !before.has(c.path));
    if (changed.length) {
      const t = now();
      const tracked = changed.filter((c) => !c.untracked).map((c) => c.path);
      if (tracked.length) await git(i.worktree, ['checkout', 'HEAD', '--', ...tracked]);
      for (const c of changed.filter((x) => x.untracked))
        rmSync(join(i.worktree, c.path), { recursive: true, force: true });
      const still = (await changedPaths(i.worktree)).filter((c) => !before.has(c.path));
      const names = changed.map((c) => c.path);
      const list = `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`;
      add({
        name: 'restore changed files',
        status: still.length ? 'failed' : 'done',
        detail: still.length
          ? `the preparation changed files that could not be restored: ${still.map((c) => c.path).join(', ')}`
          : `the preparation changed files in the repository; they were restored: ${list}`,
        ms: now() - t,
      });
    }
  } catch (err) {
    add({ name: 'prepare', status: 'failed', detail: errText(err), ms: now() - started });
  }
  return finish();

  function finish(): PrepResult {
    return { ok: !steps.some((s) => s.status === 'failed'), steps };
  }
}

/** The `.gitmodules` of the first trusted branch that exists (on origin, else locally): its blob and its submodules. */
async function trustedGitmodules(
  repoPath: string,
  branches: string[],
): Promise<{ blob: string; submodules: Array<{ name: string; path: string; normalized: string }> } | null> {
  for (const b of branches) {
    if (!b) continue;
    const ref = (await revParse(repoPath, `refs/remotes/origin/${b}`))
      ? `refs/remotes/origin/${b}`
      : (await revParse(repoPath, `refs/heads/${b}`))
        ? `refs/heads/${b}`
        : null;
    if (!ref) continue;
    const blob = (
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}:.gitmodules`])
    ).stdout.trim();
    if (!blob) return null;
    const originUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
    return { blob, submodules: await readSubmodules(repoPath, originUrl, [`--blob=${ref}:.gitmodules`]) };
  }
  return null;
}

async function hasGitmodules(dir: string): Promise<boolean> {
  return (await git(dir, ['ls-files', '--', '.gitmodules'])).stdout.trim() !== '';
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 400);
const minutes = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}-minute` : `${Math.max(1, Math.round(ms / 1000))}-second`;

/** The paragraph for the agent's instructions; empty when there was nothing to prepare. */
export function prepNote(prep: PrepResult | undefined): string {
  if (!prep || prep.steps.length === 0) return '';
  const done = prep.steps
    .filter((s) => s.status === 'done' && s.name !== 'restore changed files')
    .map((s) => s.name);
  const restored = prep.steps.find((s) => s.name === 'restore changed files' && s.status === 'done');
  const notDone = prep.steps.filter((s) => s.status !== 'done');
  const lines = [
    '## Your worktree was prepared',
    `The runner prepared this card worktree when it created it${done.length ? `: ${done.join(', ')} done` : ''}.`,
  ];
  if (restored?.detail) lines.push(`Note: ${restored.detail}.`);
  if (notDone.length) {
    lines.push('Not prepared:');
    for (const s of notDone) lines.push(`- ${s.name}: ${s.detail ?? s.status}`);
    lines.push('Ask DevOps only for what is listed as not prepared, and only if you need it.');
  } else {
    lines.push('Do not ask DevOps to initialise submodules or install the dependencies.');
  }
  return lines.join('\n');
}
