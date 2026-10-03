import { writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import {
  CommandPayloadSchemas,
  type IpcRpcResponse,
  normalizeRemoteUrl,
  type RepoReport,
  type RunnerCommandName,
  type RuntimeInfo,
  type ServerToRunner,
  uuidv7,
} from '@aom/shared';
import { buildAdapters } from './adapters/registry.ts';
import type { RuntimeAdapter } from './adapters/types.ts';
import { ChatManager } from './chat/chat.ts';
import type { RunnerConfig } from './config.ts';
import { type BackoffOptions, RunnerClient, toWsUrl } from './connection/client.ts';
import { Outbox } from './connection/outbox.ts';
import { ExternalAdapters } from './external/index.ts';
import { executeCompletion } from './git/completion.ts';
import { ghPrCreator, type PrCreator } from './git/gh.ts';
import { scanRepos } from './git/repo-scan.ts';
import { removeWorktree } from './git/worktrees.ts';
import { IpcServer } from './ipc/server.ts';
import { type Logger, nullLogger } from './log.ts';
import { type RunnerPaths, runnerPaths } from './paths.ts';
import { wipeAgent } from './sandbox/sandbox.ts';
import { ShiftSupervisor } from './shifts/supervisor.ts';
import { writeShims } from './shims.ts';
import { VaultManager } from './vaults/manager.ts';
import { RUNNER_VERSION } from './version.ts';

export interface RunnerOptions {
  config: RunnerConfig;
  dataDir: string;
  log?: Logger;
  backoff?: BackoffOptions;
  random?: () => number;
  maxShiftMsOverride?: number;
  reportWaitMs?: number;
  exitGraceMs?: number;
  /** Re-scan repos and re-probe runtimes this often (ms). Defaults: 10 min. */
  rescanMs?: number;
  adapters?: Map<string, RuntimeAdapter>;
  /** Test hook: milliseconds per vault sync interval second (default 1000). */
  vaultSecondMs?: number;
  /** Opens pull requests for the `pr` completion action; default shells out to `gh` (tests inject a fake). */
  prCreator?: PrCreator;
  /** Ticket systems for `aom source read` (default: `gh` for GitHub, the agent's skill for Jira). Tests inject fakes. */
  external?: ExternalAdapters;
  /** Test hook: replaces the tester environment check (docker, deployed app). */
  envChecker?: import('./testing/environment.ts').EnvChecker;
}

/** The long-running runner process: connection, IPC server, supervisor and command handlers. */
export class Runner {
  readonly paths: RunnerPaths;
  readonly outbox: Outbox;
  readonly ipc = new IpcServer();
  readonly supervisor: ShiftSupervisor;
  readonly chat: ChatManager;
  readonly client: RunnerClient;
  readonly vaults: VaultManager;
  private readonly log: Logger;
  private readonly adapters: Map<string, RuntimeAdapter>;
  private repos: RepoReport[] = [];
  private maxConcurrent: number;
  private readonly rpcs = new Map<string, (r: IpcRpcResponse) => void>();
  private timers: NodeJS.Timeout[] = [];
  private fatalResolve?: (code: number) => void;
  /** Resolves with an exit code when the server makes further retries pointless (4401/4403/4409). */
  readonly fatal = new Promise<number>((resolve) => {
    this.fatalResolve = resolve;
  });

  constructor(private readonly opts: RunnerOptions) {
    this.log = opts.log ?? nullLogger;
    this.paths = runnerPaths(opts.dataDir);
    this.outbox = new Outbox(this.paths.outbox);
    this.maxConcurrent = opts.config.maxConcurrentShifts;
    this.adapters = opts.adapters ?? buildAdapters(opts.config, this.paths);
    this.client = new RunnerClient({
      url: toWsUrl(opts.config.serverUrl),
      token: opts.config.runnerToken,
      outbox: this.outbox,
      log: this.log,
      backoff: opts.backoff,
      random: opts.random,
      buildHello: () => this.buildHello(),
      buildHeartbeat: () => ({
        activeShifts: this.supervisor.activeShifts().map((s) => s.shiftId),
        load: { runningShifts: this.supervisor.size },
      }),
    });
    this.vaults = new VaultManager({
      paths: this.paths,
      log: this.log,
      transport: { send: (type, payload) => void this.client.send(type, payload) },
      secondMs: opts.vaultSecondMs,
    });
    this.supervisor = new ShiftSupervisor({
      paths: this.paths,
      config: opts.config,
      adapters: this.adapters,
      ipc: this.ipc,
      outbox: this.outbox,
      log: this.log,
      transport: { send: (type, payload) => this.client.send(type as never, payload) },
      findRepo: (norm) => this.findRepo(norm),
      writeVault: (cmd) => this.vaults.write(cmd),
      rpc: (shiftId, method, params) => this.rpc(shiftId, method, params),
      maxConcurrentShifts: () => this.maxConcurrent,
      maxShiftMsOverride: opts.maxShiftMsOverride,
      reportWaitMs: opts.reportWaitMs,
      exitGraceMs: opts.exitGraceMs,
      envChecker: opts.envChecker,
    });
    this.chat = new ChatManager({
      paths: this.paths,
      adapters: this.adapters,
      ipc: this.ipc,
      log: this.log,
      send: (type, payload) => void this.client.send(type, payload),
      rpc: (chatId, method, params) => this.rpc(chatId, method, params),
      external:
        opts.external ??
        ExternalAdapters.defaults(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
    });
    this.client.on('message', (m) => this.onMessage(m));
    this.client.on('welcome', (w) => {
      this.maxConcurrent = Math.min(w.limits.maxConcurrentShifts, opts.config.maxConcurrentShifts);
      this.writeStatus(true);
    });
    this.client.on('disconnected', () => {
      this.writeStatus(false);
      void this.chat.cancelAll('workstation offline: the connection to the server dropped');
    });
    this.client.on('fatal', (code, why) => {
      this.log.error(`connection closed for good (${code}): ${why}`);
      this.fatalResolve?.(code === 4409 ? 3 : 2);
    });
  }

  async start(): Promise<void> {
    await writeShims(this.paths.bin);
    await this.ipc.start();
    this.repos = await scanRepos(this.opts.config.repoRoots);
    this.supervisor.resumePersisted();
    this.vaults.start();
    this.client.start();
    const t = setInterval(() => void this.rescan(), this.opts.rescanMs ?? 600_000);
    t.unref();
    this.timers.push(t);
    this.writeStatus(false);
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.vaults.stop();
    await this.supervisor.stopAll('manager');
    await this.chat.cancelAll('runner stopped');
    await this.client.stop();
    await this.ipc.stop();
    this.writeStatus(false);
  }

  private writeStatus(connected: boolean): void {
    try {
      writeFileSync(
        this.paths.status,
        JSON.stringify({
          pid: process.pid,
          connected,
          updatedAt: new Date().toISOString(),
          activeShifts: this.supervisor.size,
          repos: this.repos.length,
          outboxPending: this.outbox.count(),
        }),
      );
    } catch {
      // status is advisory
    }
  }

  private async runtimeInfos(): Promise<RuntimeInfo[]> {
    const out: RuntimeInfo[] = [];
    for (const a of this.adapters.values()) {
      const c = await a.capabilities();
      out.push({ id: c.runtime, version: c.version, available: c.available, capabilities: c.capabilities });
    }
    return out;
  }

  private async buildHello(): Promise<Record<string, unknown>> {
    this.repos = await scanRepos(this.opts.config.repoRoots);
    return {
      runnerVersion: RUNNER_VERSION,
      protocol: 1,
      platform: platform(),
      hostname: hostname(),
      runtimes: await this.runtimeInfos(),
      repos: this.repos,
      vaults: await this.vaults.report(),
      activeShifts: this.supervisor.activeShifts(),
    };
  }

  private async rescan(): Promise<void> {
    this.repos = await scanRepos(this.opts.config.repoRoots);
    this.client.send('repos.report', { repos: this.repos });
  }

  private async findRepo(normalized: string): Promise<RepoReport | undefined> {
    const match = (r: RepoReport) => normalizeRemoteUrl(r.remoteUrl) === normalized;
    let found = this.repos.find(match);
    if (!found) {
      this.repos = await scanRepos(this.opts.config.repoRoots);
      found = this.repos.find(match);
    }
    return found;
  }

  private rpc(shiftId: string, method: string, params: Record<string, unknown>): Promise<IpcRpcResponse> {
    if (!this.client.isReady)
      return Promise.resolve({ ok: false, error: 'server unreachable, try again later' });
    const rpcId = uuidv7();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.rpcs.delete(rpcId);
        resolve({ ok: false, error: 'server did not answer in time' });
      }, 30_000);
      this.rpcs.set(rpcId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.client.send('rpc.request', { rpcId, shiftId, method, params });
    });
  }

  private onMessage(msg: ServerToRunner): void {
    switch (msg.type) {
      case 'shift.start':
        void this.supervisor.handleStart(msg);
        break;
      case 'shift.stop':
        void this.supervisor.handleStop(msg.shiftId, msg.reason);
        break;
      case 'shift.report.result':
        this.supervisor.onReportResult(msg);
        break;
      case 'rpc.response': {
        const cb = this.rpcs.get(msg.rpcId);
        this.rpcs.delete(msg.rpcId);
        cb?.({
          ok: msg.ok,
          ...(msg.result !== undefined ? { result: msg.result } : {}),
          ...(msg.error ? { error: msg.error } : {}),
        });
        break;
      }
      case 'command':
        void this.runCommand(msg.commandId, msg.command, msg.payload);
        break;
      case 'chat.start':
        void this.chat.handleStart(msg);
        break;
      case 'chat.cancel':
        void this.chat.handleCancel(msg.chatId);
        break;
      default:
        break;
    }
  }

  private async runCommand(
    commandId: string,
    command: RunnerCommandName,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const done = (ok: boolean, result?: unknown, error?: string) =>
      this.client.send('command.result', {
        commandId,
        ok,
        ...(result !== undefined ? { result } : {}),
        ...(error ? { error } : {}),
      });
    try {
      if (command === 'agent.wipe') {
        const p = CommandPayloadSchemas['agent.wipe'].parse(payload);
        done(true, await wipeAgent(this.paths, p.agentId));
      } else if (command === 'worktree.remove') {
        const p = CommandPayloadSchemas['worktree.remove'].parse(payload);
        done(
          true,
          await removeWorktree({ path: p.path, branchName: p.branchName, deleteBranch: p.deleteBranch }),
        );
      } else if (command === 'repos.rescan') {
        await this.rescan();
        done(true, { repos: this.repos.length });
      } else if (command === 'vault.configure') {
        this.vaults.configure(CommandPayloadSchemas['vault.configure'].parse(payload));
        done(true, { vaults: this.vaults.configured() });
      } else if (command === 'vault.write') {
        done(true, await this.vaults.write(CommandPayloadSchemas['vault.write'].parse(payload)));
      } else if (command === 'finalize.execute') {
        const p = CommandPayloadSchemas['finalize.execute'].parse(payload);
        const repo = await this.findRepo(p.remoteUrlNormalized);
        if (!repo) {
          done(true, { ok: false, action: p.action, error: `no local clone for ${p.remoteUrlNormalized}` });
        } else {
          done(
            true,
            await executeCompletion({
              payload: p,
              repoPath: repo.localPath,
              worktreePath: this.paths.worktreePath(p.projectKey, p.ref),
              integrationDir: this.paths.integration,
              pr: this.opts.prCreator ?? ghPrCreator,
            }),
          );
        }
      } else {
        done(false, undefined, `command ${command} is not supported by this runner version`);
      }
    } catch (err) {
      done(false, undefined, err instanceof Error ? err.message : String(err));
    }
  }
}
