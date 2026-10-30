import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import {
  formatCommandLine,
  type IpcRpcResponse,
  isSafeRelativeDir,
  RUN_WORKTREE_KEEP_HOURS,
  type RunDeclaredService,
  type RunEndReason,
  type RunExtendPayload,
  type RunHealth,
  type RunLogLines,
  type RunPlan,
  RunPlanSchema,
  type RunRestartPayload,
  type RunService,
  RunServiceSchema,
  type RunSetupStep,
  type RunStartPayload,
  type RunStatus,
  type RunStopPayload,
  runOrder,
  validateRunPlan,
  withDependencies,
} from '@aom/shared';
import picomatch from 'picomatch';
import { z } from 'zod';
import type { SandboxMode } from '../adapters/claude-policy.ts';
import { git } from '../git/git.ts';
import { RebaseConflictError, rebaseOntoBase } from '../git/rebase.ts';
import { withRepoLock } from '../git/repo-lock.ts';
import { type GitAuth, removeWorktree } from '../git/worktrees.ts';
import type { Logger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { cacheEnv, ensureSharedCaches, sharedCacheRoot } from '../sandbox/sandbox.ts';
import { checkEnvVar } from '../toolchain/registry.ts';
import { discoverExtraGuides, type ExtraGuide, findBuildDoc, guidesHash } from './discovery.ts';
import { probeHttp, probeTcp } from './health.ts';
import { FileFollower, rotateIfBig, tailLines } from './logs.ts';
import { PortAllocator, type PortRange } from './ports.ts';
import { pidAlive, procStartTime, sameProcess, signalGroup, stopGroup } from './proc.ts';
import { SERVICE_HOME, ServiceLauncher, sandboxCommand, scopeCommand, scrubEnv } from './sandbox.ts';
import {
  type EnvState,
  isLiveEnv,
  RunStore,
  type ServiceState,
  type SourceState,
  type StepState,
} from './state.ts';
import { readEnvFile, redactValues, substitute } from './text.ts';

/**
 * The runner side of "run a branch" (docs/design/run-and-integration-tests.md): detached run worktrees, setup steps and
 * services started on the DevOps engineer's behalf through `aom run`, supervised here, never by the Claude session.
 * Services get their own process group (they outlive the runner and are re-adopted after a restart), log to
 * `<data dir>/runs/<envId>/<service>.log` and are stopped with `stopCmd`, SIGTERM and finally SIGKILL.
 *
 * Phase 2: steps and services run under the runner's bubblewrap profile (`sandbox.ts`, D10) and in a systemd scope of their
 * own when the user manager is reachable (they then survive a runner restart or self-update); a current saved plan is
 * replayed without a model call and falls back to the DevOps engineer on any failure; Restart and Update & restart.
 */

export interface RunTiming {
  /** How long one `aom run` call waits for a step or a service before it answers "still running" (Claude's Bash limit). */
  waitMs: number;
  healthPollMs: number;
  superviseMs: number;
  logFlushMs: number;
  stopGraceMs: number;
  /** Re-check of healthy services. */
  recheckMs: number;
  backoffMs: number[];
  /** The runner stops an environment this long after its expiry when the server did not (it may be unreachable). */
  ttlGraceMs: number;
}
export const DEFAULT_TIMING: RunTiming = {
  waitMs: 100_000,
  healthPollMs: 1000,
  superviseMs: 2000,
  logFlushMs: 500,
  stopGraceMs: 10_000,
  recheckMs: 10_000,
  backoffMs: [1000, 5000, 15_000],
  ttlGraceMs: 10 * 60_000,
};

export interface RunManagerDeps {
  paths: RunnerPaths;
  findRepo(normalized: string): Promise<{ localPath: string } | undefined>;
  send(
    type: 'run.status' | 'run.log' | 'run.plan.saved' | 'run.replay.failed',
    payload: Record<string, unknown>,
  ): void;
  log: Logger;
  maxEnvironments(): number;
  portRange(): PortRange;
  /** Directories for the front of PATH (the registered toolchains). */
  pathDirs?(): string[];
  fetchImpl?: typeof fetch;
  timing?: Partial<RunTiming>;
  /** Test hook: where services are looked up for ports (default: real sockets). */
  isPortFree?: (port: number) => Promise<boolean>;
  /** The runner's sandbox setting for the claude-code runtime. Absent: no service sandbox (tests). */
  sandboxMode?(): { mode: SandboxMode; allowUnsandboxed: boolean };
  launcher?: ServiceLauncher;
  /** The real home directory (its credential folders are unreadable for services). */
  realHome?: string;
  /** The runner's `repoRoots`: build guides are looked for in the folders above a clone, up to the root that holds it. */
  repoRoots?(): string[];
  /** Credentials for git against a repository's host (submodules of the run worktrees are fetched with them). */
  gitAuth?: GitAuth;
}

interface ReplayCtx {
  /** A new worktree: `first` and `changed:` steps run. False for a restart in the same worktrees. */
  fresh: boolean;
  /** Files changed by Update & restart, per repository (a restart without update: nothing changed). */
  changed: Map<string, string[]>;
}

export interface RunCaller {
  /** The DevOps request the calling shift works. */
  requestId: string;
  declared: RunDeclaredService[];
}

const DOCKER_CMDS = new Set(['docker', 'docker-compose', 'podman', 'podman-compose']);
/** The user-bus variables `systemd-run --user` needs and a sandboxed service must not inherit. */
const SCOPE_ONLY_ENV = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
const sandboxNote = (k: 'sandboxed' | 'docker' | 'off'): string =>
  k === 'sandboxed' ? '' : k === 'docker' ? ' (outside the sandbox: Docker)' : ' (no sandbox)';
const isDockerCommand = (cmd: string[]): boolean =>
  DOCKER_CMDS.has(basename(cmd[0] ?? '')) || (cmd[1] === 'compose' && basename(cmd[0] ?? '') === 'docker');

/** The clone's git dir a linked worktree points at (`<clone>/.git`), so a sandboxed `git` can read it. */
function gitDirOf(worktree: string): string[] {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktree, '.git'), 'utf8'));
    if (!m) return [];
    // <clone>/.git/worktrees/<name>  ->  <clone>/.git
    return [resolve(m[1] as string, '..', '..')];
  } catch {
    return [];
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'x';

const StepParams = z.object({
  name: z.string().min(1).max(80),
  repo: z.string().optional(),
  cwd: z.string().max(300).default('.'),
  cmd: z.array(z.string()).min(1).optional(),
  timeoutSec: z.number().int().min(1).max(7200).default(1200),
  when: z.string().max(200).default('always'),
  env: z.record(z.string(), z.string()).default({}),
  wait: z.boolean().default(false),
});
const ServiceParams = RunServiceSchema.omit({ repoId: true }).extend({ repo: z.string().optional() });

type Runtime = {
  child?: import('node:child_process').ChildProcess;
  secrets: Set<string>;
  healthTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  failing: number;
  lastCheck: number;
  logRead?: FileFollower;
  logBuf: string;
  waiters: Array<() => void>;
};

export class RunManager {
  private readonly envs = new Map<string, EnvState>();
  private readonly store: RunStore;
  private readonly timing: RunTiming;
  private readonly runtime = new Map<string, Runtime>(); // key `${envId}/${service}`
  private readonly prepared = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly followers = new Map<string, { timer: NodeJS.Timeout; files: Map<string, FileFollower> }>();
  private readonly stepRuns = new Map<string, Promise<void>>(); // key `${envId}/${step}`
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  private allocator: PortAllocator | null = null;
  private readonly launcher: ServiceLauncher;
  private readonly restarting = new Set<string>();

  constructor(private readonly deps: RunManagerDeps) {
    this.store = new RunStore(join(deps.paths.root, 'runs'));
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) };
    this.launcher = deps.launcher ?? new ServiceLauncher();
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  /** Loads the environments of an earlier runner process and re-adopts the services that are still alive. */
  async adopt(): Promise<void> {
    for (const env of this.store.loadAll()) {
      if (this.envs.has(env.envId)) continue;
      this.envs.set(env.envId, env);
      this.prepared.set(env.envId, Promise.resolve());
      if (!isLiveEnv(env)) continue;
      let alive = 0;
      for (const svc of env.services) {
        const rt = this.rt(env, svc.def.name);
        if (svc.pid && (await sameProcess(svc.pid, svc.startTime ?? null))) {
          alive++;
          svc.state = svc.health === 'passing' ? 'healthy' : 'starting';
          this.loadSecrets(env, svc, rt);
          this.watch(env, svc);
        } else if (svc.state !== 'stopped' && svc.state !== 'failed') {
          svc.state = 'exited';
          svc.lastError = 'the process was gone when the runner restarted';
        }
      }
      if (env.state === 'stopping') {
        void this.stop({ envId: env.envId, reason: env.endReason ?? 'stopped' });
      } else if (env.replaying) {
        // the runner went down while the plan was being replayed: hand over to the DevOps engineer
        await this.replayFailed(
          env,
          'The runner restarted while the saved plan was being replayed.',
          '',
          false,
        );
      } else if (env.services.length > 0 && alive === 0) {
        await this.finish(
          env,
          'stopped',
          'runner_restarted',
          'The runner restarted and the services were not running any more.',
        );
      } else {
        env.activity = alive ? 'runner restarted: services re-adopted' : env.activity;
        this.recompute(env);
        this.save(env);
      }
    }
    await this.cleanOld();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => this.deps.log.warn(`run tick failed: ${String(e)}`)),
      this.timing.superviseMs,
    );
    this.timer.unref();
  }

  /** The runner is stopping: services keep running (they are re-adopted), only this process's bookkeeping ends. */
  shutdown(): void {
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const f of this.followers.values()) clearInterval(f.timer);
    this.followers.clear();
    for (const [, rt] of this.runtime) {
      if (rt.healthTimer) clearInterval(rt.healthTimer);
      if (rt.restartTimer) clearTimeout(rt.restartTimer);
    }
  }

  /** After (re)connecting: the server hears about every environment it may have missed. */
  reportAll(): void {
    for (const env of this.envs.values()) {
      if (isLiveEnv(env) || !env.reportedFinal) this.report(env, true);
    }
  }

  /** The `run-<env>` folders of environments that are live or keep their worktrees for a restart: the sweep skips them. */
  worktreeDirs(): string[] {
    const now = Date.now();
    return [...this.envs.values()]
      .filter((e) => isLiveEnv(e) || (e.keptUntil ?? 0) > now)
      .flatMap((e) => (e.sources[0] ? [resolve(e.sources[0].path, '..')] : []));
  }

  liveEnvIds(): string[] {
    return [...this.envs.values()].filter(isLiveEnv).map((e) => e.envId);
  }

  private async cleanOld(): Promise<void> {
    const cutoff = Date.now() - 3 * 24 * 3600_000;
    for (const env of [...this.envs.values()]) {
      if (!isLiveEnv(env) && env.reportedFinal && (env.endedAt ?? 0) < cutoff) {
        this.store.remove(env.envId);
        this.envs.delete(env.envId);
      }
    }
  }

  // ----------------------------------------------------------------------------------------- commands

  /** `run.start`: creates the environment and its run worktrees. Idempotent (a redelivered command changes nothing). */
  async startEnv(p: RunStartPayload): Promise<{ ok: boolean; error?: string }> {
    if (this.envs.has(p.envId)) return { ok: true };
    const live = [...this.envs.values()].filter(isLiveEnv).length;
    if (live >= this.deps.maxEnvironments())
      return {
        ok: false,
        error: `this workstation already runs ${live} environment${live === 1 ? '' : 's'} (limit ${this.deps.maxEnvironments()}); stop one first`,
      };
    const env: EnvState = {
      envId: p.envId,
      projectId: p.projectId,
      projectKey: p.projectKey,
      projectName: p.projectName,
      purpose: p.purpose,
      requestId: p.requestId,
      sources: [],
      wanted: p.services,
      portRange: p.portRange,
      ttlAt: p.ttlAt,
      allowDocker: p.allowDocker,
      ...(p.buildGuides?.length ? { buildGuides: p.buildGuides } : {}),
      state: 'preparing',
      activity: 'creating the worktrees',
      reportedFinal: false,
      services: [],
      steps: [],
      createdAt: Date.now(),
    };
    this.envs.set(env.envId, env);
    this.store.ensureDir(env.envId);
    this.save(env);
    this.report(env);
    const prep = this.prepare(env, p);
    this.prepared.set(
      env.envId,
      prep.catch(() => undefined),
    );
    try {
      await prep;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.finish(env, 'failed', 'failed', msg);
      return { ok: false, error: msg };
    }
    if (env.state === 'preparing') {
      env.state = 'starting';
      if (p.replay) {
        env.activity = `replaying the saved plan (version ${p.replay.version})`;
        env.plan = p.replay.plan;
        env.planId = p.replay.planId;
        env.replaying = true;
      } else {
        env.activity = 'waiting for the DevOps engineer';
      }
      this.save(env);
      this.report(env);
      if (p.replay) void this.replayStart(env, p.replay.buildHash);
    }
    this.flush();
    return { ok: true };
  }

  private async prepare(env: EnvState, p: RunStartPayload): Promise<void> {
    const base = join(
      this.deps.paths.worktrees,
      `${p.projectKey}-${p.projectId.slice(0, 8)}`,
      `run-${env.envId.slice(0, 8)}`,
    );
    mkdirSync(base, { recursive: true });
    if (p.rebaseCard) await this.rebaseCardBranch(env, p.rebaseCard);
    const used = new Set<string>();
    for (const s of p.sources) {
      const repo = await this.deps.findRepo(s.remoteUrlNormalized);
      if (!repo)
        throw new Error(
          `there is no local clone of ${s.name} (${s.remoteUrlNormalized}) on this workstation`,
        );
      const commit = await this.resolveCommit(repo.localPath, s.branch);
      if (!commit) throw new Error(`branch "${s.branch}" does not exist in the local clone of ${s.name}`);
      let dir = slug(s.name);
      for (let i = 2; used.has(dir); i++) dir = `${slug(s.name)}-${i}`;
      used.add(dir);
      const path = join(base, dir);
      await withRepoLock(repo.localPath, async () => {
        const r = await git(repo.localPath, ['worktree', 'add', '--detach', '--', path, commit]);
        if (r.exitCode !== 0)
          throw new Error(
            `could not create the run worktree for ${s.name}: ${r.stderr.trim().slice(0, 400)}`,
          );
      });
      const submoduleWarning = await this.initSubmodules(repo.localPath, path, s.name);
      env.sources.push({
        repoId: s.repoId,
        name: s.name,
        remoteUrlNormalized: s.remoteUrlNormalized,
        branch: s.branch,
        ...(s.projectPath ? { projectPath: s.projectPath } : {}),
        path,
        clonePath: repo.localPath,
        commit,
        ...(submoduleWarning ? { submoduleWarning } : {}),
      });
      this.save(env);
    }
  }

  /**
   * `git submodule update --init --recursive` in a new run worktree (a worktree starts with empty submodule folders), with
   * the repository's git auth. Not fatal: the warning is kept and shown to the DevOps engineer by `aom run info`.
   */
  private async initSubmodules(clone: string, worktree: string, name: string): Promise<string | null> {
    if (!existsSync(join(worktree, '.gitmodules'))) return null;
    const url = (await git(clone, ['remote', 'get-url', 'origin'])).stdout.trim();
    const a = this.deps.gitAuth && url ? await this.deps.gitAuth(url) : { args: [], env: {} };
    const r = await git(worktree, [...a.args, 'submodule', 'update', '--init', '--recursive'], {
      env: a.env,
      timeoutMs: 15 * 60_000,
    });
    if (r.exitCode === 0) return null;
    const why = r.stderr.trim().slice(-400) || `exit code ${r.exitCode}`;
    this.deps.log.warn(`could not initialise the submodules of the run worktree of ${name}: ${why}`);
    return why;
  }

  /**
   * A test environment runs the commit the tester will test: the card branch rebased onto its base branch (the `test`
   * stage's `rebaseBefore`, done here so the tester's own rebase finds nothing to do). A conflict fails the start; the
   * server sends the card to Rework with the files.
   */
  private async rebaseCardBranch(
    env: EnvState,
    rc: NonNullable<RunStartPayload['rebaseCard']>,
  ): Promise<void> {
    const root = resolve(this.deps.paths.worktrees);
    const wt = resolve(rc.cardWorktreePath);
    if (wt !== root && !wt.startsWith(`${root}/`) && !wt.startsWith(`${root}\\`))
      throw new Error("the card worktree is not inside this runner's worktrees folder");
    if (!existsSync(wt)) throw new Error('the card worktree does not exist on this workstation');
    env.activity = 'rebasing the card branch';
    this.save(env);
    this.report(env);
    try {
      await rebaseOntoBase(wt, rc.baseBranch, rc.commitAs ?? null);
    } catch (err) {
      if (err instanceof RebaseConflictError) {
        env.rebaseConflictFiles = err.conflictedFiles;
        throw new Error(`the card branch conflicts with ${rc.baseBranch}: ${err.conflictedFiles.join(', ')}`);
      }
      throw err;
    }
  }

  private async resolveCommit(clone: string, branch: string): Promise<string | null> {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`, branch]) {
      const r = await git(clone, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
  }

  /** `run.stop`: services are stopped in reverse start order, the run worktrees removed. Idempotent. */
  async stop(p: RunStopPayload): Promise<void> {
    const env = this.envs.get(p.envId);
    if (!env) {
      // Unknown here (it never arrived, or was cleaned): the server still wants a final answer.
      this.deps.send('run.status', { envId: p.envId, state: 'stopped', services: [], endReason: p.reason });
      return;
    }
    if (!isLiveEnv(env) && env.state !== 'stopping') {
      if (!env.reportedFinal) this.report(env, true);
      return;
    }
    const running = this.stopping.get(env.envId);
    if (running) return running;
    const run = this.doStop(env, p.reason).finally(() => this.stopping.delete(env.envId));
    this.stopping.set(env.envId, run);
    return run;
  }

  private async doStop(env: EnvState, reason: RunEndReason): Promise<void> {
    env.state = 'stopping';
    env.endReason = reason;
    env.activity = 'stopping';
    this.save(env);
    this.report(env);
    // A manual environment that has a plan keeps its worktrees for a day: Restart revives it with the build outputs.
    const keep = env.purpose === 'manual' && !!env.plan && reason !== 'failed';
    await this.teardown(env, keep);
    if (keep) env.keptUntil = Date.now() + RUN_WORKTREE_KEEP_HOURS * 3600_000;
    await this.finish(env, reason === 'failed' ? 'failed' : 'stopped', reason);
  }

  /** Stops every service and step, closes follow, removes the run worktrees (unless they are kept for a restart). */
  private async teardown(env: EnvState, keepWorktrees = false): Promise<void> {
    this.unfollow(env.envId);
    for (const s of env.steps) if (s.status === 'running') this.killStep(env, s);
    const order =
      runOrder(env.services.map((s) => ({ name: s.def.name, after: s.def.after }))) ??
      env.services.map((s) => ({ name: s.def.name, after: [] }));
    for (const o of [...order].reverse()) {
      const svc = env.services.find((s) => s.def.name === o.name);
      if (svc) await this.stopService(env, svc);
    }
    if (env.runTmp) rmSync(env.runTmp, { recursive: true, force: true });
    if (keepWorktrees) return;
    for (const src of env.sources) {
      await removeWorktree({ path: src.path, deleteBranch: false, roots: [this.deps.paths.worktrees] }).catch(
        (e) => this.deps.log.warn(`could not remove the run worktree ${src.path}: ${String(e)}`),
      );
    }
    const first = env.sources[0];
    if (first) {
      // the run-<env> folder itself
      try {
        rmdirSync(resolve(first.path, '..'));
      } catch {
        // not empty or gone
      }
    }
  }

  private async finish(
    env: EnvState,
    state: 'stopped' | 'failed',
    reason: RunEndReason,
    error?: string,
  ): Promise<void> {
    if (!isLiveEnv(env) && env.state === state && env.endedAt) return;
    if (error && state === 'failed') {
      // cleanup also on a failed start
      await this.teardown(env).catch(() => undefined);
    } else if (error && reason === 'runner_restarted') {
      await this.teardown(env).catch(() => undefined);
    }
    env.state = state;
    env.endReason = reason;
    if (error) env.error = error;
    env.activity = undefined;
    env.endedAt = Date.now();
    env.reportedFinal = false;
    for (const s of env.services) if (s.state !== 'failed' && s.state !== 'exited') s.state = 'stopped';
    this.save(env);
    this.report(env, true);
  }

  extend(p: RunExtendPayload): void {
    const env = this.envs.get(p.envId);
    if (!env || !isLiveEnv(env)) return;
    env.ttlAt = p.ttlAt;
    this.save(env);
  }

  // ----------------------------------------------------------------------------- replay and restart

  private currentBuildHash(env: EnvState): string {
    const { docs, extra } = this.guidesOf(env);
    return guidesHash(docs, extra);
  }

  /**
   * The build guides of an environment: the BUILD.md of each run worktree and the guides outside them (folders above the
   * clones, README fallbacks, or the project's "Build guide" setting, which replaces all of that).
   */
  private guidesOf(env: EnvState): {
    docs: Array<{ repoId: string; path: string; content: string }>;
    extra: ExtraGuide[];
  } {
    const configured = env.buildGuides ?? [];
    const found = configured.length
      ? []
      : env.sources.flatMap((s) => {
          const d = findBuildDoc(s.path, s.projectPath);
          return d ? [{ repoId: s.repoId, path: d.path, content: d.content }] : [];
        });
    const extra = discoverExtraGuides({
      sources: env.sources.map((s) => ({
        repoId: s.repoId,
        clonePath: s.clonePath,
        worktree: s.path,
        projectPath: s.projectPath,
      })),
      configured,
      repoRoots: this.deps.repoRoots?.() ?? [],
      home: this.deps.realHome ?? homedir(),
      repoHasBuildDoc: found.length > 0,
    });
    return { docs: found, extra };
  }

  /** The first start from a saved plan: BUILD.md must still be what the plan was made from, then the plan runs. */
  private async replayStart(env: EnvState, planBuildHash: string | null | undefined): Promise<void> {
    try {
      if (planBuildHash != null && planBuildHash !== this.currentBuildHash(env)) {
        await this.replayFailed(env, 'BUILD.md has changed since the plan was saved.', '', true);
        return;
      }
      const r = await this.replayPlan(env, { fresh: true, changed: new Map() });
      if (!r.ok && !r.aborted) await this.replayFailed(env, r.reason, r.tail, false);
    } catch (err) {
      await this.replayFailed(env, err instanceof Error ? err.message : String(err), '', false);
    }
  }

  private stepDue(step: RunSetupStep, ctx: ReplayCtx): boolean {
    const when = (step.when ?? 'always').trim();
    if (when === 'first') return ctx.fresh;
    if (when.startsWith('changed:')) {
      if (ctx.fresh) return true;
      const pattern = when.slice('changed:'.length).trim();
      if (!pattern) return true;
      const match = picomatch(pattern, { dot: true });
      return (ctx.changed.get(step.repoId) ?? []).some((f) => f === '*' || match(f));
    }
    return true; // 'always' (and anything this runner does not know)
  }

  /**
   * Runs the environment's plan: the setup steps that are due, then the services in `after` order, each until healthy.
   * `aborted`: the environment was stopped meanwhile (nothing to report).
   */
  private async replayPlan(
    env: EnvState,
    ctx: ReplayCtx,
  ): Promise<{ ok: true } | { ok: false; aborted?: boolean; reason: string; tail: string }> {
    const plan = env.plan as RunPlan;
    const gone = () => !isLiveEnv(env) || env.state === 'stopping';
    const aborted = { ok: false as const, aborted: true, reason: 'stopped', tail: '' };
    env.replaying = true;
    this.save(env);
    try {
      env.steps = [];
      env.services = [];
      for (const [i, st] of plan.setup.entries()) {
        if (gone()) return aborted;
        const src = env.sources.find((x) => x.repoId === st.repoId);
        if (!src)
          return {
            ok: false,
            reason: `the plan's step "${st.name}" names a repository this environment does not have`,
            tail: '',
          };
        const logFile = join(
          this.store.dir(env.envId),
          'steps',
          `${String(i + 1).padStart(2, '0')}-${slug(st.name)}.log`,
        );
        const step: StepState = {
          name: st.name,
          repoId: st.repoId,
          cwd: st.cwd,
          cmd: st.cmd,
          timeoutSec: st.timeoutSec,
          when: st.when,
          status: 'running',
          startedAt: Date.now(),
          logFile,
        };
        env.steps.push(step);
        if (!this.stepDue(st, ctx)) {
          step.status = 'ok';
          step.skipped = true;
          step.finishedAt = Date.now();
          continue;
        }
        this.checkDocker(env, st.cmd, false);
        const cwd = this.cwdIn(src, st.cwd);
        env.activity = `running ${st.name}`;
        this.save(env);
        this.report(env);
        await this.runStep(env, step, cwd, {});
        if (gone()) return aborted;
        if (step.status !== 'ok')
          return {
            ok: false,
            reason: `step "${st.name}" failed (exit ${step.exitCode ?? '?'})`,
            tail: tailLines(step.logFile, 40).join('\n'),
          };
      }
      for (const w of env.wanted)
        if (!plan.services.some((s) => s.name.toLowerCase() === w.toLowerCase()))
          return { ok: false, reason: `the plan has no service "${w}"`, tail: '' };
      const order = env.wanted.length
        ? withDependencies(plan.services, env.wanted)
        : (runOrder(plan.services) ?? plan.services);
      if (order.length === 0) return { ok: false, reason: 'the plan has no services', tail: '' };
      for (const def of order) {
        if (gone()) return aborted;
        const r = await this.bringUp(env, def, def.startTimeoutSec * 1000 + 15_000);
        if (gone()) return aborted;
        if (r.error || !r.svc)
          return { ok: false, reason: r.error ?? `service "${def.name}" did not start`, tail: '' };
        if (r.svc.state !== 'healthy')
          return {
            ok: false,
            reason: `service "${def.name}" ${r.svc.state}${r.svc.lastError ? `: ${r.svc.lastError}` : ''}`,
            tail: this.serviceTail(env, r.svc, 40),
          };
      }
      env.readyAt = Date.now();
      env.activity = undefined;
      this.recompute(env);
      this.save(env);
      this.report(env, true);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), tail: '' };
    } finally {
      env.replaying = false;
      this.save(env);
    }
  }

  private serviceTail(env: EnvState, svc: ServiceState, n: number): string {
    const secrets = this.runtime.get(`${env.envId}/${svc.def.name}`)?.secrets ?? new Set<string>();
    return tailLines(this.logPath(env, svc.def.name), n)
      .map((l) => redactValues(l, secrets))
      .join('\n');
  }

  /**
   * The plan could not bring the environment up: stop what it started and hand over to the DevOps engineer. The server
   * files the request (it repairs the plan and saves a new version); `stale`: the plan no longer matches BUILD.md.
   */
  private async replayFailed(env: EnvState, reason: string, tail: string, stale: boolean): Promise<void> {
    if (!isLiveEnv(env) || env.state === 'stopping') return;
    await this.dismantle(env);
    env.replaying = false;
    env.readyAt = undefined;
    env.requestId = null; // the DevOps request the server files now adopts the environment (see rpcInner)
    env.state = 'starting';
    env.error = undefined;
    env.activity = 'the saved plan failed: waiting for the DevOps engineer';
    this.save(env);
    this.report(env, true);
    this.deps.log.warn(`run ${env.envId}: the saved plan failed: ${reason}`);
    this.deps.send('run.replay.failed', {
      envId: env.envId,
      reason: reason.slice(0, 4000),
      logTail: tail.slice(-8000),
      stale,
    });
  }

  /** Stops every service and step of the environment (it keeps its worktrees) and forgets them. */
  private async dismantle(env: EnvState): Promise<void> {
    for (const s of env.steps) if (s.status === 'running') this.killStep(env, s);
    const order =
      runOrder(env.services.map((s) => ({ name: s.def.name, after: s.def.after }))) ??
      env.services.map((s) => ({ name: s.def.name, after: [] as string[] }));
    for (const o of [...order].reverse()) {
      const svc = env.services.find((s) => s.def.name === o.name);
      if (svc) await this.stopService(env, svc);
    }
    env.services = [];
    env.steps = [];
  }

  /**
   * `run.restart`: the services start again from the environment's plan in the same run worktrees. `update` first
   * fast-forwards the worktrees to the head of their branches (refused when a branch was rewritten). Also revives a
   * stopped manual environment whose worktrees are still kept. The answer says whether it was accepted; the rest runs
   * in the background and reports through `run.status` (and, when the plan fails, `run.replay.failed`).
   */
  async restart(p: RunRestartPayload): Promise<{ ok: boolean; error?: string }> {
    const env = this.envs.get(p.envId);
    if (!env)
      return {
        ok: false,
        error: 'this workstation does not know the environment (any more): start it again',
      };
    if (!env.plan)
      return {
        ok: false,
        error: 'the environment has no run plan to restart from: the DevOps engineer has not finished it',
      };
    if (this.restarting.has(env.envId) || env.replaying)
      return { ok: false, error: 'the environment is already (re)starting' };
    const revive = !isLiveEnv(env);
    if (revive) {
      if (env.purpose !== 'manual' || !env.keptUntil || env.keptUntil < Date.now())
        return { ok: false, error: 'the run worktrees were removed: start the branch again' };
      if (env.sources.some((s) => !existsSync(s.path)))
        return { ok: false, error: 'the run worktrees are gone: start the branch again' };
      const live = [...this.envs.values()].filter(isLiveEnv).length;
      if (live >= this.deps.maxEnvironments())
        return {
          ok: false,
          error: `this workstation already runs ${live} environment${live === 1 ? '' : 's'} (limit ${this.deps.maxEnvironments()}); stop one first`,
        };
    } else if (env.state === 'stopping' || env.state === 'preparing' || env.state === 'requested') {
      return { ok: false, error: `the environment is ${env.state}` };
    }
    // Update: look first, change nothing until it is known to be a fast-forward.
    const updates: Array<{ src: SourceState; to: string }> = [];
    if (p.update) {
      for (const src of env.sources) {
        const repo = await this.deps.findRepo(src.remoteUrlNormalized);
        if (!repo) return { ok: false, error: `there is no local clone of ${src.name} any more` };
        const to = await this.resolveCommit(repo.localPath, src.branch);
        if (!to)
          return {
            ok: false,
            error: `branch "${src.branch}" does not exist in the local clone of ${src.name}`,
          };
        if (src.commit && to !== src.commit) {
          const anc = await git(src.path, ['merge-base', '--is-ancestor', src.commit, to]);
          if (anc.exitCode !== 0)
            return {
              ok: false,
              error: `branch "${src.branch}" of ${src.name} was rewritten (it is not a fast-forward of ${src.commit.slice(0, 10)}): use Restart, or stop it and start the branch again`,
            };
        }
        if (to !== src.commit) updates.push({ src, to });
      }
    }
    this.restarting.add(env.envId);
    env.replaying = true; // also blocks `aom run` and a second restart from now on
    if (revive) {
      env.endedAt = undefined;
      env.endReason = undefined;
      env.error = undefined;
      env.keptUntil = undefined;
      env.reportedFinal = false;
    }
    env.state = 'starting';
    env.ttlAt = p.ttlAt;
    env.readyAt = undefined;
    env.activity = updates.length ? 'updating and restarting' : 'restarting';
    this.save(env);
    this.report(env, true);
    void this.doRestart(env, updates).finally(() => this.restarting.delete(env.envId));
    return { ok: true };
  }

  private async doRestart(env: EnvState, updates: Array<{ src: SourceState; to: string }>): Promise<void> {
    try {
      await this.dismantle(env);
      const changed = new Map<string, string[]>();
      for (const u of updates) {
        const from = u.src.commit;
        const co = await git(u.src.path, ['checkout', '--detach', u.to]);
        if (co.exitCode !== 0)
          throw new Error(
            `could not move the worktree of ${u.src.name} to the branch head: ${co.stderr.trim().slice(0, 300)}`,
          );
        const diff = from ? await git(u.src.path, ['diff', '--name-only', from, u.to]) : null;
        changed.set(
          u.src.repoId,
          diff && diff.exitCode === 0 ? diff.stdout.split('\n').filter(Boolean) : ['*'],
        );
        u.src.commit = u.to;
        this.save(env);
      }
      const r = await this.replayPlan(env, { fresh: false, changed });
      if (!r.ok && !r.aborted) await this.replayFailed(env, r.reason, r.tail, false);
    } catch (err) {
      await this.replayFailed(env, err instanceof Error ? err.message : String(err), '', false);
    }
  }

  // ------------------------------------------------------------------------------------------ status

  private statusOf(env: EnvState): RunStatus {
    return {
      envId: env.envId,
      state: env.state,
      services: env.services.map((s) => ({
        name: s.def.name,
        state: s.state,
        ports: s.ports.map((p) => ({
          name: p.name,
          port: p.port,
          wanted: p.wanted,
          ...(p.url ? { url: p.url } : {}),
        })),
        urls: s.ports.filter((p) => p.url).map((p) => p.url as string),
        health: s.health,
        restarts: s.restarts,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
        ...(s.lastError ? { lastError: s.lastError.slice(0, 2000) } : {}),
        ...(s.pid ? { pid: s.pid } : {}),
        sandbox: s.sandbox ?? 'off',
      })),
      sources: env.sources.map((s) => ({ repoId: s.repoId, commit: s.commit })),
      ...(env.activity ? { activity: env.activity.slice(0, 300) } : {}),
      ...(env.error ? { error: env.error.slice(0, 4000) } : {}),
      ...(env.endReason && !isLiveEnv(env) ? { endReason: env.endReason } : {}),
      ...(env.rebaseConflictFiles ? { rebaseConflictFiles: env.rebaseConflictFiles.slice(0, 200) } : {}),
    };
  }

  /** Sends `run.status`; changes within a short moment are sent as one. `now`: immediately (final states). */
  private report(env: EnvState, now = false): void {
    if (now || !isLiveEnv(env)) {
      this.dirty.delete(env.envId);
      this.deps.send('run.status', this.statusOf(env) as unknown as Record<string, unknown>);
      if (!isLiveEnv(env)) {
        env.reportedFinal = true;
        this.save(env);
      }
      return;
    }
    this.dirty.add(env.envId);
    if (this.flushTimer || this.shuttingDown) return;
    this.flushTimer = setTimeout(() => this.flush(), 200);
    this.flushTimer.unref();
  }

  /** Sends the pending status changes now (before an `aom run` call answers, so the server is never behind the CLI). */
  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const id of [...this.dirty]) {
      const e = this.envs.get(id);
      this.dirty.delete(id);
      if (e) this.deps.send('run.status', this.statusOf(e) as unknown as Record<string, unknown>);
    }
  }

  private save(env: EnvState): void {
    try {
      this.store.save(env);
    } catch (err) {
      this.deps.log.warn(`could not save run state ${env.envId}: ${String(err)}`);
    }
  }

  /** Aggregate state from the services (only meaningful while the environment is up). */
  private recompute(env: EnvState): void {
    if (env.state === 'stopping' || !isLiveEnv(env)) return;
    if (env.state === 'preparing' || env.state === 'requested') return;
    if (!env.readyAt) {
      env.state = 'starting';
      return;
    }
    const want = this.wantedServices(env);
    const ok = want.length > 0 && want.every((s) => s.state === 'healthy');
    env.state = ok ? 'healthy' : 'degraded';
  }

  private wantedServices(env: EnvState): ServiceState[] {
    const names = new Set(env.wanted.map((n) => n.toLowerCase()));
    return names.size
      ? env.services.filter(
          (s) =>
            names.has(s.def.name.toLowerCase()) ||
            env.services.some((o) => names.has(o.def.name.toLowerCase()) && o.def.after.includes(s.def.name)),
        )
      : env.services;
  }

  // -------------------------------------------------------------------------------------------- rpc

  /** `aom run ...` from the DevOps engineer's shift (the supervisor already checked it works this environment). */
  async rpc(
    envId: string,
    method: string,
    params: Record<string, unknown>,
    caller: RunCaller,
  ): Promise<IpcRpcResponse> {
    try {
      return await this.rpcInner(envId, method, params, caller);
    } finally {
      this.flush();
    }
  }

  private async rpcInner(
    envId: string,
    method: string,
    params: Record<string, unknown>,
    caller: RunCaller,
  ): Promise<IpcRpcResponse> {
    const env = this.envs.get(envId);
    if (!env) return { ok: false, error: 'this environment does not exist (any more) on this workstation' };
    if (env.requestId && env.requestId !== caller.requestId)
      return { ok: false, error: 'this environment belongs to another DevOps request' };
    // After a failed replay the environment has no request yet: the DevOps engineer the server filed for it takes over
    // (the supervisor only lets the shift of that environment's `run` request call this).
    if (!env.requestId && ['run.step', 'run.service', 'run.ready', 'run.fail'].includes(method)) {
      env.requestId = caller.requestId;
      this.save(env);
    }
    await this.prepared.get(envId);
    try {
      if (method === 'run.info') return { ok: true, result: { message: this.info(env) } };
      if (method === 'run.status') return { ok: true, result: { message: this.statusText(env) } };
      if (method === 'run.logs') return this.logs(env, params);
      if (env.replaying)
        return {
          ok: false,
          error: 'the runner is replaying the saved plan; wait until it has finished or failed',
        };
      if (!isLiveEnv(env) || env.state === 'stopping')
        return {
          ok: false,
          error: `the environment is ${env.state === 'stopping' ? 'stopping' : `already ${env.state}`}; end the request with \`aom devops-done\``,
        };
      if (method === 'run.step') return await this.step(env, params);
      if (method === 'run.service') return await this.service(env, params, caller);
      if (method === 'run.ready') return await this.ready(env, params);
      if (method === 'run.fail') {
        const reason = String(params.reason ?? '').trim();
        if (!reason) return { ok: false, error: '--reason "<why>" is required' };
        env.state = 'stopping';
        void this.stop({ envId, reason: 'failed' });
        env.error = reason.slice(0, 4000);
        return {
          ok: true,
          result: {
            message:
              'The environment is being stopped as failed. Now end the request with `aom devops-done` (say why).',
          },
        };
      }
      return { ok: false, error: `${method} is not available` };
    } catch (err) {
      if (err instanceof z.ZodError)
        return {
          ok: false,
          error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private info(env: EnvState): string {
    const lines = [
      `Environment ${env.envId} of ${env.projectName} (${env.projectKey}): ${env.state}`,
      `Expires: ${env.ttlAt}`,
      `Port range for allocated ports: ${env.portRange.from}-${env.portRange.to} (a service's default port is used when it is free)`,
      `Docker: ${env.allowDocker ? 'allowed (docker/compose steps run outside the sandbox)' : 'not allowed'}`,
      'Steps and services run in the runner sandbox: host network, writes only to the worktrees below, the shared package caches and a private /tmp (HOME is /tmp/home); credential folders and the runner data are unreadable.',
      'Repositories (detached run worktrees, no branch; your own commands may read and build there):',
      ...env.sources.map(
        (s) =>
          `- ${s.name} (--repo ${s.name}): ${s.path}  branch ${s.branch} @ ${s.commit?.slice(0, 10) ?? '?'}${s.projectPath ? `  project folder ${s.projectPath}` : ''}${s.clonePath ? `  (the user's own checkout: ${s.clonePath})` : ''}${s.submoduleWarning ? `  WARNING: the submodules could not be initialised: ${s.submoduleWarning}` : ''}`,
      ),
    ];
    if (env.wanted.length) lines.push(`Services wanted: ${env.wanted.join(', ')}`);
    return lines.join('\n');
  }

  private statusText(env: EnvState): string {
    const lines = [
      `Environment ${env.state}${env.activity ? ` (${env.activity})` : ''}${env.error ? `: ${env.error}` : ''}`,
    ];
    if (env.steps.length) {
      lines.push('Steps:');
      for (const s of env.steps)
        lines.push(
          `- ${s.name}: ${s.status}${s.exitCode !== undefined && s.exitCode !== null ? ` (exit ${s.exitCode})` : ''}`,
        );
    }
    if (env.services.length) {
      lines.push('Services:');
      for (const s of env.services)
        lines.push(
          `- ${s.def.name}: ${s.state}${s.health !== 'unknown' ? `, health ${s.health}` : ''}${s.ports.length ? `, ports ${s.ports.map((p) => `${p.name}=${p.port}${p.port !== p.wanted ? ` (wanted ${p.wanted})` : ''}`).join(' ')}` : ''}${s.restarts ? `, restarted ${s.restarts}x` : ''}${s.lastError ? `, ${s.lastError}` : ''}`,
        );
    }
    return lines.join('\n');
  }

  private logs(env: EnvState, params: Record<string, unknown>): IpcRpcResponse {
    const name = String(params.service ?? '');
    const n = Math.min(Math.max(Number(params.lines ?? 80) || 80, 1), 500);
    if (!name) return { ok: false, error: 'usage: aom run logs <service> [--lines N]' };
    const svc = env.services.find((s) => s.def.name.toLowerCase() === name.toLowerCase());
    const stepLog = env.steps.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!svc && !stepLog) return { ok: false, error: `no service or step named "${name}"` };
    const file = svc ? this.logPath(env, svc.def.name) : (stepLog as StepState).logFile;
    const secrets = svc
      ? (this.runtime.get(`${env.envId}/${svc.def.name}`)?.secrets ?? new Set<string>())
      : new Set<string>();
    const lines = tailLines(file, n).map((l) => redactValues(l, secrets));
    return { ok: true, result: { message: lines.length ? lines.join('\n') : '(no output yet)' } };
  }

  // ------------------------------------------------------------------------------------------ steps

  private repoOf(env: EnvState, name: string | undefined): SourceState {
    if (!name) {
      if (env.sources.length === 1) return env.sources[0] as SourceState;
      throw new Error(`--repo <${env.sources.map((s) => s.name).join('|')}> is required`);
    }
    const hit = env.sources.find((s) => s.name.toLowerCase() === name.toLowerCase() || s.repoId === name);
    if (!hit)
      throw new Error(`unknown repository "${name}" (have: ${env.sources.map((s) => s.name).join(', ')})`);
    return hit;
  }

  private checkDocker(env: EnvState, cmd: string[], flagged: boolean): void {
    if ((isDockerCommand(cmd) || flagged) && !env.allowDocker)
      throw new Error(
        'this command uses Docker, which is not allowed for this project (Project settings > Run & test > "Branch code may use Docker"). End with `aom run fail --reason` if it cannot run without it',
      );
  }

  private cwdIn(src: SourceState, cwd: string): string {
    if (!isSafeRelativeDir(cwd)) throw new Error(`--cwd must be inside the repository: ${cwd}`);
    return resolve(src.path, cwd);
  }

  private baseEnv(sandboxed = false): Record<string, string> {
    const out: Record<string, string> = {};
    if (sandboxed) Object.assign(out, scrubEnv(process.env));
    else
      for (const [k, v] of Object.entries(process.env))
        if (v !== undefined && !k.startsWith('AOM_')) out[k] = v;
    const dirs = this.deps.pathDirs?.() ?? [];
    if (dirs.length)
      out.PATH = [...dirs, ...(out.PATH ?? '').split(delimiter)]
        .filter((x, i, a) => x && a.indexOf(x) === i)
        .join(delimiter);
    if (sandboxed)
      Object.assign(
        out,
        {
          HOME: SERVICE_HOME,
          TMPDIR: '/tmp',
          TMP: '/tmp',
          TEMP: '/tmp',
          XDG_CACHE_HOME: '/tmp/home/.cache',
          XDG_CONFIG_HOME: '/tmp/home/.config',
          XDG_DATA_HOME: '/tmp/home/.local/share',
          // .NET: a private CLI home and no build servers that outlive the service
          DOTNET_CLI_HOME: '/tmp/home/.dotnet',
          DOTNET_NOLOGO: '1',
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
          MSBUILDDISABLENODEREUSE: '1',
          DOTNET_CLI_USE_MSBUILD_SERVER: '0',
        },
        cacheEnv(sharedCacheRoot(this.deps.paths)),
      );
    return out;
  }

  /** `/tmp/aom-run-<env>`: bound over /tmp inside the sandbox; the services' HOME lives in it. */
  private ensureRunTmp(env: EnvState): void {
    env.runTmp ??= `/tmp/aom-run-${env.envId.slice(0, 8)}`;
    mkdirSync(join(env.runTmp, 'home'), { recursive: true, mode: 0o700 });
  }

  /** Where a command runs: the service sandbox, outside it because of Docker (opted in), or with no sandbox at all. */
  private async sandboxKind(argv: string[], dockerFlag: boolean): Promise<'sandboxed' | 'docker' | 'off'> {
    if (dockerFlag || isDockerCommand(argv)) return 'docker'; // checkDocker already insisted on the project's opt-in
    const cfg = this.deps.sandboxMode?.();
    if (!cfg || cfg.mode === 'off') return 'off';
    if (await this.launcher.sandboxAvailable()) return 'sandboxed';
    if (cfg.mode === 'best_effort' && cfg.allowUnsandboxed) return 'off';
    throw new Error(
      'the service sandbox (bubblewrap) is not available on this workstation: install bubblewrap (apt install bubblewrap), or allow unsandboxed runs in the runner config (sandbox "best_effort" with allowUnsandboxed)',
    );
  }

  /** The command line a step or service is really started with, and the environment it gets. */
  private async launch(
    env: EnvState,
    argv: string[],
    extraEnv: Record<string, string>,
    o: { docker: boolean; service?: string },
  ): Promise<{
    cmd: string;
    args: string[];
    env: Record<string, string>;
    sandbox: 'sandboxed' | 'docker' | 'off';
  }> {
    const sandbox = await this.sandboxKind(argv, o.docker);
    let cmd = argv[0] as string;
    let args = argv.slice(1);
    if (sandbox === 'sandboxed') {
      this.ensureRunTmp(env);
      const cacheRoot = sharedCacheRoot(this.deps.paths);
      await ensureSharedCaches(cacheRoot);
      const c = sandboxCommand(
        {
          runnerRoot: this.deps.paths.root,
          realHome: this.deps.realHome ?? homedir(),
          worktrees: env.sources.map((s) => s.path),
          cacheRoot,
          runTmp: env.runTmp as string,
          gitDirs: env.sources.flatMap((s) => gitDirOf(s.path)),
        },
        argv,
      );
      cmd = c.cmd;
      args = c.args;
    }
    const childEnv = { ...this.baseEnv(sandbox === 'sandboxed'), ...extraEnv };
    // Services leave the runner's cgroup (systemd scope) so a runner restart or update does not kill them.
    if (o.service && (await this.launcher.scopeAvailable())) {
      let inner = [cmd, ...args];
      if (sandbox === 'sandboxed') {
        // systemd-run needs the user bus variables; the sandboxed command must not see them (`env` execs, the pid stays).
        inner = ['env', ...SCOPE_ONLY_ENV.flatMap((k) => ['-u', k]), ...inner];
        for (const k of SCOPE_ONLY_ENV) {
          const v = process.env[k];
          if (v !== undefined) childEnv[k] = v;
        }
      }
      const c = scopeCommand(
        `aom-run-${env.envId.slice(0, 8)}-${slug(o.service)}-${Date.now().toString(36)}`,
        inner,
      );
      cmd = c.cmd;
      args = c.args;
    }
    return { cmd, args, env: childEnv, sandbox };
  }

  private checkEnv(env: Record<string, string>): void {
    for (const [k, v] of Object.entries(env)) {
      try {
        checkEnvVar(k, v);
      } catch (err) {
        throw new Error(
          `${err instanceof Error ? err.message : String(err)}. Secrets belong in an env file outside the repository (--env-file), not in --env`,
        );
      }
    }
  }

  private async step(env: EnvState, raw: Record<string, unknown>): Promise<IpcRpcResponse> {
    const p = StepParams.parse(raw);
    const key = `${env.envId}/${p.name.toLowerCase()}`;
    let step = env.steps.find((s) => s.name.toLowerCase() === p.name.toLowerCase());
    if (p.cmd) {
      if (step?.status === 'running')
        return {
          ok: false,
          error: `step "${p.name}" is still running; \`aom run step --name "${p.name}" --wait\` waits for it`,
        };
      const src = this.repoOf(env, p.repo);
      this.checkDocker(env, p.cmd, false);
      this.checkEnv(p.env);
      const cwd = this.cwdIn(src, p.cwd);
      const idx = step ? env.steps.indexOf(step) : env.steps.length;
      const logFile = join(
        this.store.dir(env.envId),
        'steps',
        `${String(idx + 1).padStart(2, '0')}-${slug(p.name)}.log`,
      );
      step = {
        name: p.name,
        repoId: src.repoId,
        cwd: p.cwd,
        cmd: p.cmd,
        timeoutSec: p.timeoutSec,
        when: p.when,
        status: 'running',
        startedAt: Date.now(),
        logFile,
      };
      if (idx < env.steps.length) env.steps[idx] = step;
      else env.steps.push(step);
      env.activity = `running ${p.name}`;
      this.save(env);
      this.report(env);
      this.stepRuns.set(
        key,
        this.runStep(env, step, cwd, p.env).finally(() => this.stepRuns.delete(key)),
      );
    } else if (!step) {
      return { ok: false, error: `no step named "${p.name}"; give the command after --` };
    }
    const done = this.stepRuns.get(key);
    if (done) await Promise.race([done, sleep(this.timing.waitMs)]);
    const s = step as StepState;
    const tail = tailLines(s.logFile, 30).join('\n');
    if (s.status === 'running')
      return {
        ok: true,
        result: {
          message: `Step "${s.name}" is still running (the runner keeps going). Check with \`aom run status\` or wait with \`aom run step --name "${s.name}" --wait\`.${tail ? `\nLast output:\n${tail}` : ''}`,
          exitCode: 3,
        },
      };
    return {
      ok: true,
      result: {
        message: `Step "${s.name}" ${s.status === 'ok' ? 'finished' : `failed (exit ${s.exitCode ?? '?'})`}.${tail ? `\nLast output:\n${tail}` : ''}`,
        exitCode: s.status === 'ok' ? 0 : 1,
      },
    };
  }

  private runStep(env: EnvState, step: StepState, cwd: string, extra: Record<string, string>): Promise<void> {
    return new Promise<void>((done) => {
      const fd = openSync(step.logFile, 'a');
      const finish = (code: number | null, why?: string) => {
        closeSync(fd);
        step.status = code === 0 ? 'ok' : 'failed';
        step.exitCode = code;
        step.finishedAt = Date.now();
        if (why) {
          try {
            const f = openSync(step.logFile, 'a');
            writeSync(f, `[aom] ${why}\n`);
            closeSync(f);
          } catch {
            // ignore
          }
        }
        env.activity = undefined;
        this.save(env);
        this.report(env);
        done();
      };
      void (async () => {
        try {
          const l = await this.launch(env, step.cmd, extra, { docker: false });
          step.sandbox = l.sandbox;
          writeSync(fd, `[aom] ${formatCommandLine(step.cmd)}${sandboxNote(l.sandbox)}\n`);
          const child = spawn(l.cmd, l.args, {
            cwd,
            env: l.env,
            detached: true,
            stdio: ['ignore', fd, fd],
          });
          (child as unknown as { aomStep?: boolean }).aomStep = true;
          stepProcs.set(`${env.envId}/${step.name.toLowerCase()}`, child);
          const timer = setTimeout(() => {
            if (child.pid) signalGroup(child.pid, 'SIGKILL');
            finish(null, `killed after ${step.timeoutSec} s (timeout)`);
          }, step.timeoutSec * 1000);
          child.once('error', (err) => {
            clearTimeout(timer);
            finish(127, `could not start: ${err.message}`);
          });
          child.once('exit', (code, signal) => {
            clearTimeout(timer);
            stepProcs.delete(`${env.envId}/${step.name.toLowerCase()}`);
            if (step.status === 'running')
              finish(code ?? (signal ? 137 : 1), signal ? `ended by ${signal}` : undefined);
          });
        } catch (err) {
          finish(127, `could not start: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });
  }

  private killStep(env: EnvState, s: StepState): void {
    const c = stepProcs.get(`${env.envId}/${s.name.toLowerCase()}`);
    if (c?.pid) signalGroup(c.pid, 'SIGKILL');
  }

  // ---------------------------------------------------------------------------------------- services

  private logPath(env: EnvState, name: string): string {
    return join(this.store.dir(env.envId), `${slug(name)}.log`);
  }

  private rt(env: EnvState, name: string): Runtime {
    const k = `${env.envId}/${name}`;
    let r = this.runtime.get(k);
    if (!r) {
      r = { secrets: new Set(), failing: 0, lastCheck: 0, logBuf: '', waiters: [] };
      this.runtime.set(k, r);
    }
    return r;
  }

  private heldPorts(): Set<number> {
    const held = new Set<number>();
    for (const e of this.envs.values())
      if (isLiveEnv(e))
        for (const s of e.services)
          if (s.state !== 'stopped' && s.state !== 'failed') for (const p of s.ports) held.add(p.port);
    return held;
  }

  private loadSecrets(env: EnvState, svc: ServiceState, rt: Runtime): void {
    if (!svc.def.envFile) return;
    try {
      for (const v of Object.values(readEnvFile(svc.def.envFile, this.forbiddenRoots(env))))
        rt.secrets.add(v);
    } catch {
      // the file is gone: nothing to redact
    }
  }

  private forbiddenRoots(env: EnvState): string[] {
    return [this.deps.paths.root, this.deps.paths.worktrees, ...env.sources.map((s) => s.path)];
  }

  private checkDeclared(declared: RunDeclaredService[], def: RunService, env: EnvState): void {
    const d = declared.find((x) => x.name.toLowerCase() === def.name.toLowerCase());
    if (!d) return;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const problems: string[] = [];
    if (d.repoId !== def.repoId) problems.push('the repository');
    if (d.cwd !== def.cwd && d.cwd !== '.') problems.push(`the working directory (${d.cwd})`);
    if (d.cmd && !same(d.cmd, def.cmd)) problems.push(`the command (${formatCommandLine(d.cmd)})`);
    if (d.envFile && d.envFile !== def.envFile) problems.push(`the env file (${d.envFile})`);
    for (const p of d.ports) {
      const mine = def.ports.find((x) => x.name === p.name);
      if (!mine || mine.default !== p.default || (p.envVar && mine.envVar !== p.envVar))
        problems.push(`port ${p.name}:${p.default}${p.envVar ? `:${p.envVar}` : ''}`);
    }
    if (d.health && !same(d.health, def.health)) problems.push('the health check');
    for (const a of d.after) if (!def.after.includes(a)) problems.push(`after ${a}`);
    void env;
    if (problems.length)
      throw new Error(
        `the project settings declare service "${d.name}" and you may not contradict them: ${problems.join(', ')}. Use what the settings say`,
      );
  }

  private async service(
    env: EnvState,
    raw: Record<string, unknown>,
    caller: RunCaller,
  ): Promise<IpcRpcResponse> {
    const p = ServiceParams.parse(raw);
    const src = this.repoOf(env, p.repo);
    const def: RunService = RunServiceSchema.parse({ ...p, repoId: src.repoId });
    this.checkDeclared(caller.declared, def, env);
    const r = await this.bringUp(env, def, this.timing.waitMs);
    if (r.error || !r.svc) return { ok: false, error: r.error ?? 'the service did not start' };
    return this.serviceAnswer(env, r.svc);
  }

  /**
   * Validates a service definition and starts it (after its dependencies are healthy), then waits for its health up to
   * `waitMs`. Used by `aom run service` and by the plan replay. A refusal comes back as `error`.
   */
  private async bringUp(
    env: EnvState,
    def: RunService,
    waitMs: number,
  ): Promise<{ svc?: ServiceState; error?: string }> {
    const src = this.repoOf(env, def.repoId);
    this.checkDocker(env, def.cmd, def.docker);
    this.checkEnv(def.env);
    this.cwdIn(src, def.cwd);
    if (def.envFile) readEnvFile(def.envFile, this.forbiddenRoots(env)); // fails early with the reason
    for (const a of def.after) {
      const dep = env.services.find((s) => s.def.name.toLowerCase() === a.toLowerCase());
      if (!dep)
        return {
          error: `service "${def.name}" starts after "${a}", which is not started yet: start "${a}" first`,
        };
    }
    const existing = env.services.find((s) => s.def.name.toLowerCase() === def.name.toLowerCase());
    if (existing) {
      // Registering a name again replaces it (the previous process is stopped first).
      await this.stopService(env, existing);
      env.services = env.services.filter((s) => s !== existing);
    }
    const deadline = Date.now() + waitMs;
    for (const a of def.after) {
      const dep = env.services.find((s) => s.def.name.toLowerCase() === a.toLowerCase()) as ServiceState;
      while (dep.state === 'starting' && Date.now() < deadline) await sleep(this.timing.healthPollMs);
      if (dep.state !== 'healthy')
        return {
          error: `"${a}" is not healthy (${dep.state}${dep.lastError ? `: ${dep.lastError}` : ''}); fix it first (\`aom run logs ${a}\`)`,
        };
    }
    const svc: ServiceState = {
      def,
      state: 'starting',
      ports: [],
      restarts: 0,
      health: def.health.kind === 'none' ? 'none' : 'unknown',
      everHealthy: false,
      sandbox: 'off',
    };
    // Ports: the default when free, else an allocated one (only when the app can be told which port to use).
    const alloc = this.portAllocator(env);
    const held = this.heldPorts();
    for (const port of def.ports) {
      const got = await alloc.pick(port.default, held, !!port.envVar);
      if (!got)
        return {
          error: port.envVar
            ? `no free port in ${env.portRange.from}-${env.portRange.to} for ${def.name}:${port.name}`
            : `port ${port.default} (${def.name}:${port.name}) is already in use on this workstation and this service cannot be told another port. Give the port an environment variable (--port ${port.name}:${port.default}:ENV_VAR) if the app reads one, or stop whatever holds port ${port.default}`,
        };
      held.add(got.port);
      svc.ports.push({
        name: port.name,
        port: got.port,
        wanted: port.default,
        ...(port.url ? { url: port.url.replaceAll('${port}', String(got.port)) } : {}),
      });
    }
    env.services.push(svc);
    env.activity = `starting ${def.name}`;
    this.save(env);
    this.report(env);
    await this.spawnService(env, svc, src);
    await this.waitHealthy(env, svc, deadline);
    return { svc };
  }

  private portAllocator(env: EnvState): PortAllocator {
    if (!this.allocator) this.allocator = new PortAllocator(env.portRange, this.deps.isPortFree);
    return this.allocator;
  }

  private serviceAnswer(env: EnvState, svc: ServiceState): IpcRpcResponse {
    const ports = svc.ports
      .map((p) => `${p.name}=${p.port}${p.port !== p.wanted ? ` (wanted ${p.wanted})` : ''}`)
      .join(' ');
    if (svc.state === 'healthy')
      return {
        ok: true,
        result: {
          message: `Service "${svc.def.name}" is healthy${ports ? ` (ports ${ports})` : ''}${
            svc.ports.some((p) => p.url)
              ? `: ${svc.ports
                  .filter((p) => p.url)
                  .map((p) => p.url)
                  .join(' ')}`
              : ''
          }.`,
          exitCode: 0,
        },
      };
    const tail = tailLines(this.logPath(env, svc.def.name), 25).join('\n');
    if (svc.state === 'starting')
      return {
        ok: true,
        result: {
          message: `Service "${svc.def.name}" is still starting (the runner keeps checking, up to ${svc.def.startTimeoutSec} s). Check with \`aom run status\`.${tail ? `\nLast output:\n${tail}` : ''}`,
          exitCode: 3,
        },
      };
    return {
      ok: true,
      result: {
        message: `Service "${svc.def.name}" ${svc.state}${svc.lastError ? `: ${svc.lastError}` : ''}.${tail ? `\nLast output:\n${tail}` : ''}`,
        exitCode: 1,
      },
    };
  }

  /** What a service adds to the machine's environment: the env file, the plan's `env`, then the ports. */
  private serviceEnv(env: EnvState, svc: ServiceState): Record<string, string> {
    const rt = this.rt(env, svc.def.name);
    const out: Record<string, string> = {};
    if (svc.def.envFile) {
      const vars = readEnvFile(svc.def.envFile, this.forbiddenRoots(env));
      Object.assign(out, vars);
      for (const v of Object.values(vars)) rt.secrets.add(v);
    }
    const others = new Map(env.services.map((s) => [s.def.name.toLowerCase(), s]));
    for (const [k, v] of Object.entries(svc.def.env)) out[k] = substitute(v, svc, others);
    for (const [i, p] of svc.def.ports.entries()) {
      const st = svc.ports[i];
      if (p.envVar && st) out[p.envVar] = String(st.port);
    }
    return out;
  }

  private async spawnService(env: EnvState, svc: ServiceState, src: SourceState): Promise<void> {
    const rt = this.rt(env, svc.def.name);
    const log = this.logPath(env, svc.def.name);
    const others = new Map(env.services.map((s) => [s.def.name.toLowerCase(), s]));
    const argv = svc.def.cmd.map((a) => substitute(a, svc, others));
    let fd: number;
    try {
      fd = openSync(log, 'a');
    } catch (err) {
      svc.state = 'failed';
      svc.lastError = `cannot write the log: ${String(err)}`;
      return;
    }
    try {
      const l = await this.launch(env, argv, this.serviceEnv(env, svc), {
        docker: svc.def.docker,
        service: svc.def.name,
      });
      svc.sandbox = l.sandbox;
      writeSync(fd, `[aom] starting ${svc.def.name}: ${formatCommandLine(argv)}${sandboxNote(l.sandbox)}\n`);
      const child = spawn(l.cmd, l.args, {
        cwd: resolve(src.path, svc.def.cwd),
        env: l.env,
        detached: true, // setsid: its own process group, so the whole tree can be stopped and it survives the runner
        stdio: ['ignore', fd, fd],
      });
      svc.state = 'starting';
      svc.lastError = undefined;
      svc.exitCode = undefined;
      svc.startedAt = Date.now();
      svc.pid = child.pid;
      rt.child = child;
      child.once('error', (err) => this.onExit(env, svc, null, `could not start: ${err.message}`));
      child.once('exit', (code, signal) =>
        this.onExit(env, svc, code, signal ? `ended by ${signal}` : undefined),
      );
      void procStartTime(child.pid as number).then((t) => {
        svc.startTime = t;
        this.save(env);
      });
      child.unref();
    } catch (err) {
      svc.state = 'failed';
      svc.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      closeSync(fd);
    }
    rt.failing = 0;
    this.save(env);
    this.watch(env, svc);
  }

  /** Starts the health probing of a service (http, tcp, log or none). */
  private watch(env: EnvState, svc: ServiceState): void {
    const rt = this.rt(env, svc.def.name);
    if (rt.healthTimer) clearInterval(rt.healthTimer);
    rt.lastCheck = 0;
    rt.logRead =
      svc.def.health.kind === 'log' ? new FileFollower(this.logPath(env, svc.def.name), false) : undefined;
    rt.healthTimer = setInterval(
      () => void this.probe(env, svc).catch(() => undefined),
      this.timing.healthPollMs,
    );
    rt.healthTimer.unref();
    void this.probe(env, svc).catch(() => undefined);
  }

  private async probe(env: EnvState, svc: ServiceState): Promise<void> {
    if (this.shuttingDown || svc.state === 'stopped' || svc.state === 'failed' || svc.state === 'exited')
      return;
    const rt = this.rt(env, svc.def.name);
    const h: RunHealth = svc.def.health;
    const others = new Map(env.services.map((s) => [s.def.name.toLowerCase(), s]));
    const wasHealthy = svc.state === 'healthy' || svc.state === 'unhealthy';
    if (wasHealthy && Date.now() - rt.lastCheck < this.timing.recheckMs) return;
    rt.lastCheck = Date.now();
    let ok = false;
    let detail: string | undefined;
    if (h.kind === 'http') {
      const r = await probeHttp(substitute(h.url, svc, others), h.expect, this.deps.fetchImpl);
      ok = r.ok;
      detail = r.detail;
    } else if (h.kind === 'tcp') {
      const port =
        typeof h.port === 'number'
          ? h.port
          : svc.ports.find((p) => p.name.toLowerCase() === String(h.port).toLowerCase())?.port;
      if (!port) detail = `the health check names a port that the service does not have: ${h.port}`;
      else {
        const r = await probeTcp(port);
        ok = r.ok;
        detail = r.detail;
      }
    } else if (h.kind === 'log') {
      if (wasHealthy) ok = true;
      else {
        const re = new RegExp(h.regex);
        for (const line of rt.logRead?.read() ?? []) if (re.test(line)) ok = true;
        if (!ok) detail = 'waiting for the log line';
      }
    } else {
      ok =
        !!svc.startedAt && Date.now() - svc.startedAt >= h.graceSec * 1000 && !!svc.pid && pidAlive(svc.pid);
    }
    if (['exited', 'failed', 'stopped'].includes(svc.state as string)) return;
    if (ok) {
      rt.failing = 0;
      svc.health = h.kind === 'none' ? 'none' : 'passing';
      if (svc.state !== 'healthy') {
        svc.state = 'healthy';
        svc.everHealthy = true;
        svc.lastError = undefined;
        this.changed(env);
      }
    } else if (wasHealthy) {
      rt.failing++;
      if (rt.failing >= 3 && svc.state === 'healthy') {
        svc.state = 'unhealthy';
        svc.health = 'failing';
        svc.lastError = detail;
        this.changed(env);
      }
    } else if (svc.state === 'starting') {
      svc.health = h.kind === 'none' ? 'none' : 'failing';
      if (svc.startedAt && Date.now() - svc.startedAt > svc.def.startTimeoutSec * 1000) {
        svc.state = 'failed';
        svc.lastError = `not healthy after ${svc.def.startTimeoutSec} s${detail ? ` (${detail})` : ''}`;
        this.changed(env);
        void this.stopService(env, svc, true);
      }
    }
    // a waiting `aom run service` call
    if (svc.state !== 'starting') for (const w of rt.waiters.splice(0)) w();
  }

  private changed(env: EnvState): void {
    this.recompute(env);
    if (env.state === 'healthy') env.activity = undefined;
    this.save(env);
    this.report(env);
  }

  private async waitHealthy(env: EnvState, svc: ServiceState, deadline: number): Promise<void> {
    while (svc.state === 'starting' && Date.now() < deadline && isLiveEnv(env))
      await sleep(Math.min(this.timing.healthPollMs, 250));
    env.activity = undefined;
    this.recompute(env);
    this.report(env);
  }

  private onExit(env: EnvState, svc: ServiceState, code: number | null, why?: string): void {
    const rt = this.rt(env, svc.def.name);
    if (rt.healthTimer) clearInterval(rt.healthTimer);
    rt.healthTimer = undefined;
    if (svc.state === 'stopped' || this.shuttingDown) return;
    svc.exitCode = code;
    const tail = tailLines(this.logPath(env, svc.def.name), 3).join(' | ');
    svc.lastError = `${why ?? `exited with code ${code}`}${tail ? `; last output: ${tail.slice(0, 300)}` : ''}`;
    svc.health = svc.def.health.kind === 'none' ? 'none' : 'failing';
    if (!svc.everHealthy && svc.state === 'starting') svc.state = 'failed';
    else svc.state = 'exited';
    this.deps.log.warn(`run ${env.envId}: service ${svc.def.name} ${svc.lastError}`);
    for (const w of rt.waiters.splice(0)) w();
    if (!isLiveEnv(env) || env.state === 'stopping') return;
    // A service that was healthy and has been asked for is restarted (3 times, with a growing pause).
    if (svc.everHealthy && env.readyAt) {
      if (svc.restarts < this.timing.backoffMs.length) {
        const delay = this.timing.backoffMs[svc.restarts] as number;
        svc.restarts++;
        svc.state = 'starting';
        env.activity = `restarting ${svc.def.name} (${svc.restarts}/${this.timing.backoffMs.length})`;
        const src = env.sources.find((s) => s.repoId === svc.def.repoId) as SourceState;
        rt.restartTimer = setTimeout(() => {
          if (!isLiveEnv(env) || env.state === 'stopping') return;
          void this.spawnService(env, svc, src).then(() => this.changed(env));
        }, delay);
        rt.restartTimer.unref();
        this.changed(env);
        return;
      }
      this.save(env);
      void this.finish(env, 'failed', 'failed', `service ${svc.def.name} keeps exiting: ${svc.lastError}`);
      return;
    }
    this.changed(env);
  }

  /** Stops one service: its `stopCmd`, SIGTERM to the group, SIGKILL after the grace period. */
  private async stopService(env: EnvState, svc: ServiceState, keepState = false): Promise<void> {
    const rt = this.rt(env, svc.def.name);
    if (rt.healthTimer) clearInterval(rt.healthTimer);
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.healthTimer = undefined;
    const prev = svc.state;
    if (!keepState) svc.state = 'stopped';
    const pid = svc.pid;
    if (pid && (await sameProcess(pid, svc.startTime ?? null).catch(() => true))) {
      if (svc.def.stopCmd && prev !== 'exited') {
        const src = env.sources.find((s) => s.repoId === svc.def.repoId);
        if (src) await this.runStopCmd(env, svc, src);
      }
      await stopGroup(pid, this.timing.stopGraceMs);
    } else if (pid) {
      signalGroup(pid, 'SIGKILL'); // stragglers of a leader that has gone
    }
    svc.pid = undefined;
    for (const w of rt.waiters.splice(0)) w();
    this.save(env);
  }

  private runStopCmd(env: EnvState, svc: ServiceState, src: SourceState): Promise<void> {
    return new Promise<void>((done) => {
      void (async () => {
        try {
          const l = await this.launch(env, svc.def.stopCmd as string[], this.serviceEnv(env, svc), {
            docker: svc.def.docker,
          });
          const c = spawn(l.cmd, l.args, {
            cwd: resolve(src.path, svc.def.cwd),
            env: l.env,
            stdio: 'ignore',
            detached: true,
          });
          const t = setTimeout(() => {
            if (c.pid) signalGroup(c.pid, 'SIGKILL');
            done();
          }, 15_000);
          c.once('exit', () => {
            clearTimeout(t);
            done();
          });
          c.once('error', () => {
            clearTimeout(t);
            done();
          });
        } catch {
          done();
        }
      })();
    });
  }

  // ------------------------------------------------------------------------------------------- ready

  private async ready(env: EnvState, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const running = env.steps.filter((s) => s.status === 'running');
    if (running.length) return { ok: false, error: `step "${running[0]?.name}" is still running` };
    if (env.services.length === 0)
      return {
        ok: false,
        error:
          'no service was started: use `aom run service`, or `aom run fail --reason` when the project cannot run',
      };
    for (const w of env.wanted)
      if (!env.services.some((s) => s.def.name.toLowerCase() === w.toLowerCase()))
        return { ok: false, error: `the service "${w}" was asked for but is not started` };
    const want = this.wantedServices(env);
    const bad = want.filter((s) => s.state !== 'healthy');
    if (bad.length)
      return {
        ok: false,
        error: `not ready: ${bad.map((s) => `${s.def.name} is ${s.state}${s.lastError ? ` (${s.lastError})` : ''}`).join('; ')}`,
      };
    const notes = String(params.notes ?? '').slice(0, 10_000);
    const plan: RunPlan = RunPlanSchema.parse({
      version: 1,
      repos: env.sources.map((s) => ({
        repoId: s.repoId,
        ...(s.projectPath ? { subdir: s.projectPath } : {}),
      })),
      setup: env.steps
        .filter((s) => s.status === 'ok')
        .map((s) => ({
          name: s.name,
          repoId: s.repoId,
          cwd: s.cwd,
          cmd: s.cmd,
          timeoutSec: s.timeoutSec,
          when: s.when,
        })),
      services: env.services.map((s) => s.def),
      notes,
    });
    const problems = validateRunPlan(plan);
    if (problems.length) return { ok: false, error: `the plan is not valid: ${problems.join('; ')}` };
    env.plan = plan;
    env.readyAt = Date.now();
    env.notes = notes;
    env.state = 'healthy';
    env.activity = undefined;
    this.save(env);
    this.report(env, true);
    this.deps.send('run.plan.saved', { envId: env.envId, plan, buildHash: this.currentBuildHash(env) });
    const urls = env.services.flatMap((s) =>
      s.ports.filter((p) => p.url).map((p) => `${s.def.name}: ${p.url}`),
    );
    return {
      ok: true,
      result: {
        message: `Ready. The plan was saved for this project on this workstation.${urls.length ? `\n${urls.join('\n')}` : ''}\nNow end the request with \`aom devops-done\`; the services keep running.`,
        exitCode: 0,
      },
    };
  }

  // ------------------------------------------------------------------------------------- the tester

  /** The ports of a test environment that is up: what the tester's forwarders may connect to (and nothing else). */
  testPorts(envId: string): Set<number> {
    const env = this.envs.get(envId);
    if (!env || !isLiveEnv(env) || env.state === 'stopping') return new Set();
    return new Set(env.services.flatMap((s) => s.ports.map((p) => p.port)));
  }

  /** Every port of every environment this manager tracks (live or not): never opened as a local test service. */
  ownedPorts(): Set<number> {
    const out = new Set<number>();
    for (const env of this.envs.values())
      for (const s of env.services) for (const p of s.ports) out.add(p.port);
    return out;
  }

  /** Every secret value of the environment's services (env files): removed from anything the tester attaches. */
  secretsOf(envId: string): Set<string> {
    const out = new Set<string>();
    const env = this.envs.get(envId);
    for (const svc of env?.services ?? [])
      for (const v of this.runtime.get(`${envId}/${svc.def.name}`)?.secrets ?? []) out.add(v);
    return out;
  }

  /** What a tester sees of its environment: state, the commit of each repository, and every service with its ports. */
  testEnvironment(envId: string): {
    envId: string;
    state: string;
    purpose: string;
    expiresAt: string;
    sources: Array<{ repoId: string; name: string; branch: string; commit: string | null }>;
    services: Array<{
      name: string;
      state: string;
      health: string;
      ports: Array<{ name: string; port: number; url?: string }>;
    }>;
  } | null {
    const env = this.envs.get(envId);
    if (!env) return null;
    return {
      envId,
      state: env.state,
      purpose: env.purpose,
      expiresAt: env.ttlAt,
      sources: env.sources.map((s) => ({
        repoId: s.repoId,
        name: s.name,
        branch: s.branch,
        commit: s.commit,
      })),
      services: env.services.map((s) => ({
        name: s.def.name,
        state: s.state,
        health: s.health,
        ports: s.ports.map((p) => ({ name: p.name, port: p.port, ...(p.url ? { url: p.url } : {}) })),
      })),
    };
  }

  /** `aom env logs` / `aom env restart` of the tester working this test environment (read-only otherwise). */
  async testerRpc(
    envId: string,
    method: 'env.logs' | 'env.restart',
    params: Record<string, unknown>,
  ): Promise<IpcRpcResponse> {
    const env = this.envs.get(envId);
    if (!env) return { ok: false, error: 'this environment does not exist (any more) on this workstation' };
    if (method === 'env.logs') return this.logs(env, params);
    if (!isLiveEnv(env)) return { ok: false, error: `the environment is ${env.state}` };
    const r = await this.restart({ envId, update: false, ttlAt: env.ttlAt, revive: false });
    return r.ok
      ? {
          ok: true,
          result: {
            message:
              'Restarting the environment at the same commit. Check `aom env info` until every service is healthy again.',
          },
        }
      : { ok: false, error: r.error ?? 'could not restart the environment' };
  }

  /** BUILD.md of each repository, for the DevOps brief (waits until the run worktrees exist). */
  async buildDocs(envId: string): Promise<Array<{ repoId: string; path: string; content: string }>> {
    const env = this.envs.get(envId);
    if (!env) return [];
    await Promise.race([this.prepared.get(envId), sleep(120_000)]);
    return this.guidesOf(env).docs;
  }

  /**
   * The guides outside the run worktrees (folders above the clones, the project's setting, README fallbacks) and where
   * each repository's clone and run worktree are, for the DevOps brief.
   */
  async buildGuides(envId: string): Promise<{
    guides: ExtraGuide[];
    pathMap: Array<{ repoId: string; clonePath: string; worktreePath: string }>;
  }> {
    const env = this.envs.get(envId);
    if (!env) return { guides: [], pathMap: [] };
    await Promise.race([this.prepared.get(envId), sleep(120_000)]);
    return {
      guides: this.guidesOf(env).extra,
      pathMap: env.sources.flatMap((s) =>
        s.clonePath ? [{ repoId: s.repoId, clonePath: s.clonePath, worktreePath: s.path }] : [],
      ),
    };
  }

  /** The commit and branch of each repository, for the brief. */
  sourcesOf(envId: string): Array<{ repoId: string; commit: string | null }> {
    return (this.envs.get(envId)?.sources ?? []).map((s) => ({ repoId: s.repoId, commit: s.commit }));
  }

  // ---------------------------------------------------------------------------------------- logs

  /** A browser follows (or stops following) the logs: `run.log` is sent only meanwhile. */
  follow(envId: string, on: boolean): void {
    if (!on) {
      this.unfollow(envId);
      return;
    }
    const env = this.envs.get(envId);
    if (!env || this.followers.has(envId)) return;
    const files = new Map<string, FileFollower>();
    const names = env.services.map((s) => s.def.name);
    for (const name of names) {
      const path = this.logPath(env, name);
      const secrets = this.runtime.get(`${envId}/${name}`)?.secrets ?? new Set<string>();
      const hist = tailLines(path, 500).map((l) => redactValues(l, secrets));
      if (hist.length) this.sendLog({ envId, service: name, lines: hist, history: true });
      files.set(name, new FileFollower(path, true));
    }
    const timer = setInterval(() => {
      const e = this.envs.get(envId);
      if (!e) return;
      for (const s of e.services) {
        if (!files.has(s.def.name)) {
          files.set(s.def.name, new FileFollower(this.logPath(e, s.def.name), false));
        }
      }
      for (const [name, f] of files) {
        const lines = f.read();
        if (!lines.length) continue;
        const secrets = this.runtime.get(`${envId}/${name}`)?.secrets ?? new Set<string>();
        this.sendLog({
          envId,
          service: name,
          lines: lines.slice(-500).map((l) => redactValues(l.slice(0, 4000), secrets)),
        });
      }
    }, this.timing.logFlushMs);
    timer.unref();
    this.followers.set(envId, { timer, files });
  }

  private unfollow(envId: string): void {
    const f = this.followers.get(envId);
    if (f) clearInterval(f.timer);
    this.followers.delete(envId);
  }

  private sendLog(l: RunLogLines): void {
    this.deps.send('run.log', l as unknown as Record<string, unknown>);
  }

  // ------------------------------------------------------------------------------------------- tick

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const env of [...this.envs.values()]) {
      if (!isLiveEnv(env) || env.state === 'stopping') continue;
      // safety net for a server that cannot be reached: the runner honours the expiry itself, a while later
      if (Date.parse(env.ttlAt) + this.timing.ttlGraceMs < now) {
        void this.stop({ envId: env.envId, reason: 'ttl' });
        continue;
      }
      let changed = false;
      for (const svc of env.services) {
        rotateIfBig(this.logPath(env, svc.def.name));
        // an adopted process has no child handle: its end is noticed here
        const rt = this.rt(env, svc.def.name);
        if (
          !rt.child &&
          svc.pid &&
          (svc.state === 'starting' || svc.state === 'healthy' || svc.state === 'unhealthy')
        ) {
          if (!(await sameProcess(svc.pid, svc.startTime ?? null))) {
            this.onExit(env, svc, null, 'the process ended');
            changed = true;
          }
        }
      }
      if (changed) this.save(env);
    }
  }
}

/** Running setup steps (process handles are not part of the saved state). */
const stepProcs = new Map<string, import('node:child_process').ChildProcess>();
