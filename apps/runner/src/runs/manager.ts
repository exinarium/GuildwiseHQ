import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmdirSync, writeSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import {
  formatCommandLine,
  type IpcRpcResponse,
  isSafeRelativeDir,
  type RunDeclaredService,
  type RunEndReason,
  type RunExtendPayload,
  type RunHealth,
  type RunLogLines,
  type RunPlan,
  RunPlanSchema,
  type RunService,
  RunServiceSchema,
  type RunStartPayload,
  type RunStatus,
  type RunStopPayload,
  runOrder,
  validateRunPlan,
} from '@aom/shared';
import { z } from 'zod';
import { git } from '../git/git.ts';
import { withRepoLock } from '../git/repo-lock.ts';
import { removeWorktree } from '../git/worktrees.ts';
import type { Logger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { checkEnvVar } from '../toolchain/registry.ts';
import { buildHash, findBuildDoc } from './discovery.ts';
import { probeHttp, probeTcp } from './health.ts';
import { FileFollower, rotateIfBig, tailLines } from './logs.ts';
import { PortAllocator, type PortRange } from './ports.ts';
import { pidAlive, procStartTime, sameProcess, signalGroup, stopGroup } from './proc.ts';
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
 * Phase 1 runs services as the user, outside any sandbox (the service sandbox is phase 2).
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
  send(type: 'run.status' | 'run.log' | 'run.plan.saved', payload: Record<string, unknown>): void;
  log: Logger;
  maxEnvironments(): number;
  portRange(): PortRange;
  /** Directories for the front of PATH (the registered toolchains). */
  pathDirs?(): string[];
  fetchImpl?: typeof fetch;
  timing?: Partial<RunTiming>;
  /** Test hook: where services are looked up for ports (default: real sockets). */
  isPortFree?: (port: number) => Promise<boolean>;
}

export interface RunCaller {
  /** The DevOps request the calling shift works. */
  requestId: string;
  declared: RunDeclaredService[];
}

const DOCKER_CMDS = new Set(['docker', 'docker-compose', 'podman', 'podman-compose']);
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

  constructor(private readonly deps: RunManagerDeps) {
    this.store = new RunStore(join(deps.paths.root, 'runs'));
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) };
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
      env.activity = 'waiting for the DevOps engineer';
      this.save(env);
      this.report(env);
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
      env.sources.push({
        repoId: s.repoId,
        name: s.name,
        remoteUrlNormalized: s.remoteUrlNormalized,
        branch: s.branch,
        ...(s.projectPath ? { projectPath: s.projectPath } : {}),
        path,
        commit,
      });
      this.save(env);
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
    await this.teardown(env);
    await this.finish(env, reason === 'failed' ? 'failed' : 'stopped', reason);
  }

  /** Stops every service and step, closes follow, removes the run worktrees. */
  private async teardown(env: EnvState): Promise<void> {
    this.unfollow(env.envId);
    for (const s of env.steps) if (s.status === 'running') this.killStep(env, s);
    const order =
      runOrder(env.services.map((s) => ({ name: s.def.name, after: s.def.after }))) ??
      env.services.map((s) => ({ name: s.def.name, after: [] }));
    for (const o of [...order].reverse()) {
      const svc = env.services.find((s) => s.def.name === o.name);
      if (svc) await this.stopService(env, svc);
    }
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
      })),
      sources: env.sources.map((s) => ({ repoId: s.repoId, commit: s.commit })),
      ...(env.activity ? { activity: env.activity.slice(0, 300) } : {}),
      ...(env.error ? { error: env.error.slice(0, 4000) } : {}),
      ...(env.endReason && !isLiveEnv(env) ? { endReason: env.endReason } : {}),
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
    await this.prepared.get(envId);
    try {
      if (method === 'run.info') return { ok: true, result: { message: this.info(env) } };
      if (method === 'run.status') return { ok: true, result: { message: this.statusText(env) } };
      if (method === 'run.logs') return this.logs(env, params);
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
      `Docker: ${env.allowDocker ? 'allowed' : 'not allowed'}`,
      'Repositories (detached run worktrees, no branch; your own commands may read and build there):',
      ...env.sources.map(
        (s) =>
          `- ${s.name} (--repo ${s.name}): ${s.path}  branch ${s.branch} @ ${s.commit?.slice(0, 10) ?? '?'}${s.projectPath ? `  project folder ${s.projectPath}` : ''}`,
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
    const dockerish =
      DOCKER_CMDS.has(basename(cmd[0] ?? '')) ||
      (cmd[1] === 'compose' && basename(cmd[0] ?? '') === 'docker');
    if ((dockerish || flagged) && !env.allowDocker)
      throw new Error(
        'this command uses Docker, which is not allowed for this project (Project settings > Run & test > "Branch code may use Docker"). End with `aom run fail --reason` if it cannot run without it',
      );
  }

  private cwdIn(src: SourceState, cwd: string): string {
    if (!isSafeRelativeDir(cwd)) throw new Error(`--cwd must be inside the repository: ${cwd}`);
    return resolve(src.path, cwd);
  }

  private baseEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !k.startsWith('AOM_')) out[k] = v;
    const dirs = this.deps.pathDirs?.() ?? [];
    if (dirs.length)
      out.PATH = [...dirs, ...(out.PATH ?? '').split(delimiter)]
        .filter((x, i, a) => x && a.indexOf(x) === i)
        .join(delimiter);
    return out;
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
      writeSync(fd, `[aom] ${formatCommandLine(step.cmd)}\n`);
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
      try {
        const child = spawn(step.cmd[0] as string, step.cmd.slice(1), {
          cwd,
          env: { ...this.baseEnv(), ...extra },
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
    this.checkDocker(env, def.cmd, def.docker);
    this.checkEnv(def.env);
    this.cwdIn(src, def.cwd);
    if (def.envFile) readEnvFile(def.envFile, this.forbiddenRoots(env)); // fails early with the reason
    for (const a of def.after) {
      const dep = env.services.find((s) => s.def.name.toLowerCase() === a.toLowerCase());
      if (!dep)
        return {
          ok: false,
          error: `service "${def.name}" starts after "${a}", which is not started yet: start "${a}" first`,
        };
    }
    const existing = env.services.find((s) => s.def.name.toLowerCase() === def.name.toLowerCase());
    if (existing) {
      // Registering a name again replaces it (the previous process is stopped first).
      await this.stopService(env, existing);
      env.services = env.services.filter((s) => s !== existing);
    }
    const deadline = Date.now() + this.timing.waitMs;
    for (const a of def.after) {
      const dep = env.services.find((s) => s.def.name.toLowerCase() === a.toLowerCase()) as ServiceState;
      while (dep.state === 'starting' && Date.now() < deadline) await sleep(this.timing.healthPollMs);
      if (dep.state !== 'healthy')
        return {
          ok: false,
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
    };
    // Ports: the default when free, else an allocated one (only when the app can be told which port to use).
    const alloc = this.portAllocator(env);
    const held = this.heldPorts();
    for (const port of def.ports) {
      const got = await alloc.pick(port.default, held, !!port.envVar);
      if (!got)
        return {
          ok: false,
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
    this.spawnService(env, svc, src);
    await this.waitHealthy(env, svc, deadline);
    return this.serviceAnswer(env, svc);
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

  /** The environment the child gets: the machine's, the env file, the plan's `env`, then the ports. */
  private serviceEnv(env: EnvState, svc: ServiceState): Record<string, string> {
    const rt = this.rt(env, svc.def.name);
    const out = this.baseEnv();
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

  private spawnService(env: EnvState, svc: ServiceState, src: SourceState): void {
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
      const childEnv = this.serviceEnv(env, svc);
      writeSync(fd, `[aom] starting ${svc.def.name}: ${formatCommandLine(argv)}\n`);
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd: resolve(src.path, svc.def.cwd),
        env: childEnv,
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
          this.spawnService(env, svc, src);
          this.changed(env);
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
      try {
        const c = spawn(svc.def.stopCmd?.[0] as string, (svc.def.stopCmd ?? []).slice(1), {
          cwd: resolve(src.path, svc.def.cwd),
          env: this.serviceEnv(env, svc),
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
    env.readyAt = Date.now();
    env.notes = notes;
    env.state = 'healthy';
    env.activity = undefined;
    const docs = env.sources.flatMap((s) => {
      const d = findBuildDoc(s.path, s.projectPath);
      return d ? [{ repoId: s.repoId, content: d.content }] : [];
    });
    this.save(env);
    this.report(env, true);
    this.deps.send('run.plan.saved', { envId: env.envId, plan, buildHash: buildHash(docs) });
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

  /** BUILD.md of each repository, for the DevOps brief (waits until the run worktrees exist). */
  async buildDocs(envId: string): Promise<Array<{ repoId: string; path: string; content: string }>> {
    const env = this.envs.get(envId);
    if (!env) return [];
    await Promise.race([this.prepared.get(envId), sleep(120_000)]);
    return env.sources.flatMap((s) => {
      const d = findBuildDoc(s.path, s.projectPath);
      return d ? [{ repoId: s.repoId, path: d.path, content: d.content }] : [];
    });
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
