import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentPermissions, getBuiltinRole, parseRemote, type ReviewerRunSpec } from '@aom/shared';
import {
  buildShiftSettings,
  type ClaudePolicyContext,
  type ClaudeSettings,
  type SandboxState,
} from '../adapters/claude-policy.ts';
import { confineAny } from '../fs-safe.ts';
import type { GitAuth } from '../git/worktrees.ts';
import type { RunnerPaths } from '../paths.ts';
import { agentTmpRoot, type Sandbox } from '../sandbox/sandbox.ts';
import { createReviewCheckout, removeRunDir } from './review-checkout.ts';
import type { ReviewerTokenStore } from './reviewer-tokens.ts';

export type ReviewerRefusal =
  | 'reviewer_token_missing'
  | 'unsupported_host'
  | 'sandbox_unavailable'
  | 'no_clone';

export interface ReviewerRun {
  spec: ReviewerRunSpec;
  /** `<runner root>/reviews/<runId>`: the checkout, home and scratch of this run and nothing else. */
  runDir: string;
  /** The standalone, read-only checkout (the reviewer's working directory). */
  checkout: string;
  /** This run's own home, scratch and tmp; `configDir` is the agent's account config (the shell cannot read it). */
  sandbox: Sandbox;
}

export interface ReviewerSandboxDeps {
  paths: RunnerPaths;
  tokens: ReviewerTokenStore;
  /** The owner's clone of the repository (by normalized remote url); undefined: none on this workstation. */
  findRepo: (remoteUrlNormalized: string) => string | undefined;
  /** The claude-code sandbox state; a reviewer never runs unless it is `enforced`. */
  sandboxState: SandboxState;
  /** The reviewer agent's CLAUDE_CONFIG_DIR. */
  configDir: string;
  agentId: string;
  /** Credentials the owner's clone uses to fetch from the host (never given to the reviewer). */
  auth?: GitAuth;
}

/** Runs prepared and not yet disposed: the startup sweep never touches them. */
const live = new Set<string>();

const tmpName = (runId: string): string =>
  `aom-r-${createHash('sha256').update(runId).digest('hex').slice(0, 10)}`;
const tmpDirOf = (runId: string): string => `${agentTmpRoot()}/${tmpName(runId)}`;

/**
 * Prepares one reviewer run: refuses, before anything is created, when no comment-only token is held for the
 * repository or the sandbox is not enforced; then builds a fresh standalone read-only checkout with its own home,
 * scratch and tmp. Nothing of an earlier run is visible to this one.
 */
export async function prepareReviewerRun(
  deps: ReviewerSandboxDeps,
  spec: ReviewerRunSpec,
  opts: { requireToken?: boolean } = {},
): Promise<ReviewerRun | { refused: ReviewerRefusal }> {
  // an offline run (20-PR replay) posts nothing, so it needs no comment-only token; every other check stays
  if ((opts.requireToken ?? true) && !deps.tokens.has(spec.remoteUrlNormalized))
    return { refused: 'reviewer_token_missing' };
  if (parseRemote(spec.remoteUrlNormalized)?.kind !== 'github') return { refused: 'unsupported_host' };
  if (deps.sandboxState.state !== 'enforced') return { refused: 'sandbox_unavailable' };
  const repoPath = deps.findRepo(spec.remoteUrlNormalized);
  if (!repoPath) return { refused: 'no_clone' };
  const runDir = confineAny([deps.paths.reviews], join(deps.paths.reviews, spec.runId));
  live.add(spec.runId);
  const tmp = tmpDirOf(spec.runId);
  try {
    const co = await createReviewCheckout({
      repoPath,
      runDir,
      spec,
      ...(deps.auth ? { auth: deps.auth } : {}),
    });
    const sandbox: Sandbox = {
      agentId: deps.agentId,
      root: runDir,
      home: join(runDir, 'home'),
      configDir: deps.configDir,
      scratch: join(runDir, 'scratch'),
      tmp,
    };
    await mkdir(sandbox.home, { recursive: true, mode: 0o700 });
    await mkdir(sandbox.scratch, { recursive: true, mode: 0o700 });
    await mkdir(tmp, { recursive: true, mode: 0o700 });
    return { spec, runDir, checkout: co.path, sandbox };
  } catch (err) {
    await removeRunDir(runDir);
    await removeRunDir(tmp);
    live.delete(spec.runId);
    throw err;
  }
}

/** Removes the run's folder and tmp dir (including the read-only checkout). Never throws. */
export async function disposeReviewerRun(run: ReviewerRun): Promise<void> {
  await removeRunDir(run.runDir);
  await removeRunDir(run.sandbox.tmp);
  live.delete(run.spec.runId);
}

/**
 * Removes every `reviews/<id>` folder and every `aom-r-*` tmp dir that no live run owns (a crash or a restart left it).
 * Returns how many it removed.
 */
export async function sweepReviewRuns(
  paths: RunnerPaths,
  liveRunIds: Iterable<string> = [],
): Promise<number> {
  const keep = new Set([...live, ...liveRunIds]);
  const keepTmp = new Set([...keep].map(tmpName));
  let removed = 0;
  if (existsSync(paths.reviews)) {
    for (const name of await readdir(paths.reviews).catch(() => [])) {
      if (keep.has(name)) continue;
      await removeRunDir(join(paths.reviews, name));
      removed++;
    }
  }
  for (const name of await readdir(agentTmpRoot()).catch(() => [])) {
    if (!/^aom-r-[0-9a-f]{10}$/.test(name) || keepTmp.has(name)) continue;
    await removeRunDir(`${agentTmpRoot()}/${name}`);
    removed++;
  }
  return removed;
}

/** What a reviewer may do: read and run read-only shell commands; no edit, no commit. */
export function reviewerPermissions(): AgentPermissions {
  const role = getBuiltinRole('reviewer');
  if (!role) throw new Error('the reviewer role is missing');
  return { ...role.permissions, allowedTools: ['read', 'shell'], mayCommit: false };
}

/**
 * The Claude Code settings of a reviewer run: the reviewer role's policy over the run's checkout, with the checkout
 * read-only to the shell, no git dir, no extra folder, and no network at all (`offline`).
 */
export function reviewerPolicy(
  run: ReviewerRun,
  base: ClaudePolicyContext,
): { ctx: ClaudePolicyContext; settings: ClaudeSettings } {
  const ctx: ClaudePolicyContext = {
    ...base,
    // `agentDir` stays the agent's own dir: a cwd inside it counts as the agent's scratch and is not locked read-only
    cwd: run.checkout,
    addDirs: [],
    gitDirs: [],
    readDirs: [],
    ownRepoDirs: [],
    scopedVaults: [],
    extraAllowedDomains: [],
    testServiceDomains: [],
    mode: 'required',
  };
  const settings = buildShiftSettings(
    reviewerPermissions(),
    ctx,
    {
      home: run.sandbox.home,
      configDir: run.sandbox.configDir,
      scratch: run.sandbox.scratch,
      tmp: run.sandbox.tmp,
    },
    'reviewer',
    false,
    { offline: true },
  );
  return { ctx, settings };
}
