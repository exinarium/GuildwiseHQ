import { statSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { basename, join } from 'node:path';
import {
  CommandPayloadSchemas,
  defaultHost,
  type EnvEnsurePayload,
  type IpcRpcResponse,
  normalizeRemoteUrl,
  type RepoReport,
  type RunnerCommandName,
  type RunnerUpdateState,
  type RuntimeInfo,
  type ServerToRunner,
  uuidv7,
  type WorktreeSweepResult,
} from '@aom/shared';
import { buildAdapters } from './adapters/registry.ts';
import type { RuntimeAdapter } from './adapters/types.ts';
import { ServerHttp } from './attachments/index.ts';
import { ChatManager } from './chat/chat.ts';
import { loadConfig, type RunnerConfig, saveConfig } from './config.ts';
import { type BackoffOptions, RunnerClient, toWsUrl, UNPAIRED_MESSAGE } from './connection/client.ts';
import { Outbox } from './connection/outbox.ts';
import { verifyRights } from './devops/rights.ts';
import { ExternalAdapters } from './external/index.ts';
import { resolveJira } from './external/jira-store.ts';
import { OutboundExecutor } from './external/outbound.ts';
import { AgentGit } from './forge/agent-git.ts';
import { recheckFile } from './forge/connect.ts';
import {
  branchRulesFor,
  FileTokenStore,
  forgeForUrl,
  forgePrCreator,
  gitAuthFor,
  gitConnections,
} from './forge/index.ts';
import { runSshAction, SshSettingsStore } from './forge/ssh.ts';
import type { ForgeEnv } from './forge/types.ts';
import { type CompletionInput, executeCompletion } from './git/completion.ts';
import type { PrCreator } from './git/gh.ts';
import { checkBranchMerged } from './git/merged.ts';
import { openReleasePr } from './git/release-pr.ts';
import { type ScannedRepo, scanAllRepos, withRemote } from './git/repo-scan.ts';
import { sweepWorktrees } from './git/sweep.ts';
import { removeWorktree } from './git/worktrees.ts';
import { IntegrationPoller } from './integrations/poll.ts';
import { IpcServer } from './ipc/server.ts';
import { type Logger, nullLogger } from './log.ts';
import { discoverPluginMcpServers, type PluginMcpServer, reportOf } from './mcp/plugins.ts';
import { changeOrgFolder, orgFolderCandidates, orgFolderStates } from './org-folder.ts';
import { type RunnerPaths, runnerPaths } from './paths.ts';
import { forbiddenReadPath } from './read-repos.ts';
import { RepoAccessUpdater } from './repo/access.ts';
import { RepoCloner } from './repo/clone.ts';
import { RepoCreator } from './repo/create.ts';
import { wipeAgent } from './sandbox/sandbox.ts';
import { RunnerKeys } from './secrets/keys.ts';
import { SudoVault } from './secrets/sudo.ts';
import { ShiftSupervisor } from './shifts/supervisor.ts';
import { writeShims } from './shims.ts';
import { selectDotnet } from './toolchain/dotnet.ts';
import { ensureEnvironment } from './toolchain/ensure.ts';
import { type Executor, realExecutor } from './toolchain/exec.ts';
import { ToolchainRegistry } from './toolchain/registry.ts';
import type { Platform } from './toolchain/types.ts';
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
  /** Branch rules of the working branch (default: the repository's forge adapter; tests inject a fake). */
  branchRules?: CompletionInput['rules'];
  /** Ticket systems for `aom source read` (default: `gh` for GitHub, the agent's skill for Jira). Tests inject fakes. */
  external?: ExternalAdapters;
  /** Test hook: replaces the tester environment check (docker, deployed app). */
  envChecker?: import('./testing/environment.ts').EnvChecker;
  /** Sweep stale worktrees this long after the first connection of the process (default 15 s); a negative value turns it off. */
  startupSweepMs?: number;
  /** How long a sweep waits for the server's answer about live worktrees (default 15 s). */
  sweepAnswerMs?: number;
  /**
   * Several pairings in one process share one concurrency budget: this returns how many shifts THIS runner may still
   * hold given what the others run (machine total minus the others' running shifts). Unset: no shared budget.
   */
  sharedCap?: () => number;
  /** Test seam: the fetch the runner uses for its own HTTP calls to the server (attachment bytes). */
  serverFetch?: typeof fetch;
  /** Test hook: runs the commands of toolchain installs, rights checks and sudo (default: real processes). */
  executor?: Executor;
  /**
   * Report the git-host connections (`git.report`). Default on, off with the mock runtime and under tests so nothing
   * reaches a real forge from them.
   */
  gitReport?: boolean;
  /**
   * Report the MCP servers of the installed, enabled Claude Code plugins (`mcp.servers`). Default on, off with the mock
   * runtime and under tests so the report never reads the machine's real Claude Code home.
   */
  mcpReport?: boolean;
  /** Test hook: the plugin MCP servers of this machine (default: read from the Claude Code home). */
  mcpDiscover?: () => PluginMcpServer[];
  /** Test hook: platform for the toolchain table (default: this machine). */
  platform?: Platform;
  /** The process-wide self-update status, sent to the server after each welcome (see `update/updater.ts`). */
  updateStatus?: () => {
    state: RunnerUpdateState;
    latestVersion: string | null;
    lastCheckedAt: string | null;
    detail: string | null;
  } | null;
  /** Called once per welcome: a freshly updated version uses it to prove it can connect. */
  onConnected?: () => void;
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
  /** M8: posts approved drafts to Jira and the code host with this workstation's credentials. */
  readonly outbound: OutboundExecutor;
  private readonly poller: IntegrationPoller;
  readonly repoCreator: RepoCreator;
  readonly repoCloner: RepoCloner;
  private readonly repoAccess: RepoAccessUpdater;
  /** The key pair for secrets the manager sends (the sudo password) and the store that holds the password. */
  readonly keys: RunnerKeys;
  readonly sudo: SudoVault;
  /** Tools agents may use: detected, configured and registered by the DevOps engineer (`aom toolchain`). */
  readonly toolchains: ToolchainRegistry;
  private readonly exec: Executor;
  private readonly log: Logger;
  private readonly adapters: Map<string, RuntimeAdapter>;
  private readonly external: ExternalAdapters;
  private repos: RepoReport[] = [];
  /** Every clone under the repoRoots (with or without a remote) minus the folders that are never offered. */
  private catalog: ScannedRepo[] = [];
  /** The runtimes last reported (hello or runtimes.report), to send a new report only on change. */
  private lastRuntimes: string | undefined;
  /** The plugin MCP servers last reported, to send a new report only on change. */
  private lastMcp: string | undefined;
  private lastToolchains: string | undefined;
  private maxConcurrent: number;
  private readonly rpcs = new Map<string, (r: IpcRpcResponse) => void>();
  private readonly sweepQueries = new Map<string, (live: string[]) => void>();
  private startupSweepDone = false;
  private sweeping: Promise<WorktreeSweepResult> | null = null;
  private timers: NodeJS.Timeout[] = [];
  /** The machine seam of the git-host adapters (GitHub via gh, GitLab/Azure/Bitbucket over REST). */
  readonly forgeEnv: ForgeEnv;
  private readonly agentGit: AgentGit;
  private lastGit: string | undefined;
  private lastJira: string | undefined;
  /** The runner's own HTTP calls to the server (attachment bytes); the token is read fresh (it can rotate). */
  private readonly serverHttp: ServerHttp;
  private lastRecheck = 0;
  private fatalResolve?: (code: number) => void;
  /** The server said the workstation was unpaired: the runner stops cleanly. */
  unpaired = false;
  /** Resolves with an exit code when the server makes further retries pointless (4401/4403/4409). */
  readonly fatal = new Promise<number>((resolve) => {
    this.fatalResolve = resolve;
  });

  constructor(private readonly opts: RunnerOptions) {
    this.log = opts.log ?? nullLogger;
    this.paths = runnerPaths(opts.dataDir);
    this.outbox = new Outbox(this.paths.outbox);
    this.serverHttp = new ServerHttp({
      base: () => opts.config.serverUrl,
      token: () => this.freshConfig().runnerToken,
      ...(opts.serverFetch ? { fetch: opts.serverFetch } : {}),
    });
    this.exec = opts.executor ?? realExecutor;
    this.forgeEnv = {
      exec: this.exec,
      fetch: globalThis.fetch,
      tokens: new FileTokenStore(join(this.paths.secrets, 'git-tokens.json')),
      ssh: {
        settings: new SshSettingsStore(join(this.paths.secrets, 'git-ssh.json')),
        knownHosts: join(this.paths.secrets, 'known_hosts'),
      },
      ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
    };
    this.agentGit = new AgentGit({ env: this.forgeEnv, secretsDir: this.paths.secrets });
    this.keys = new RunnerKeys(join(this.paths.secrets, 'runner-key.pem'));
    this.sudo = new SudoVault({
      file: join(this.paths.secrets, 'sudo.enc'),
      keys: this.keys,
      exec: this.exec,
    });
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
    this.toolchains = new ToolchainRegistry(this.paths.toolchains, this.paths.root, () => ({
      toolchainPaths: opts.config.runtimes['claude-code'].toolchainPaths,
      ...(opts.config.dotnetRoot ? { dotnetRoot: opts.config.dotnetRoot } : {}),
    }));
    this.toolchains.onChange = () => this.reportToolchains(false);
    this.supervisor = new ShiftSupervisor({
      paths: this.paths,
      config: opts.config,
      adapters: this.adapters,
      ipc: this.ipc,
      outbox: this.outbox,
      log: this.log,
      transport: { send: (type, payload) => this.client.send(type as never, payload) },
      findRepo: (norm) => this.findRepo(norm),
      findLocal: (k) => this.findLocal(k),
      writeVault: (cmd) => this.vaults.write(cmd),
      http: this.serverHttp,
      rpc: (shiftId, method, params) => this.rpc(shiftId, method, params),
      maxConcurrentShifts: () =>
        Math.min(this.maxConcurrent, this.opts.sharedCap?.() ?? Number.POSITIVE_INFINITY),
      maxShiftMsOverride: opts.maxShiftMsOverride,
      reportWaitMs: opts.reportWaitMs,
      exitGraceMs: opts.exitGraceMs,
      envChecker: opts.envChecker,
      sudoRun: (cmd, args) => this.sudo.run(cmd, args),
      git: this.agentGit,
      toolchains: this.toolchains,
      orgSourceFolder: (orgId) => this.orgSourceFolder(orgId),
      gitAuth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge),
    });
    this.external =
      opts.external ??
      ExternalAdapters.defaults({
        ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
        jira: () => this.jiraConfig(),
      });
    this.chat = new ChatManager({
      paths: this.paths,
      adapters: this.adapters,
      ipc: this.ipc,
      log: this.log,
      send: (type, payload) => void this.client.send(type, payload),
      rpc: (chatId, method, params) => this.rpc(chatId, method, params),
      external: this.external,
      http: this.serverHttp,
      findRepo: (n) => this.findRepo(n),
      findLocal: (k) => this.findLocal(k),
      git: this.agentGit,
      toolchains: this.toolchains,
      orgSourceFolder: (orgId) => this.orgSourceFolder(orgId),
      repoRoots: () => this.opts.config.repoRoots,
    });
    this.outbound = new OutboundExecutor({ dir: this.paths.outbound, adapters: this.external });
    this.repoCreator = new RepoCreator({
      dir: this.paths.outbound,
      repoRoots: () => this.opts.config.repoRoots,
      forge: () => this.forgeEnv,
      ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
    });
    this.repoCloner = new RepoCloner({
      repoRoots: () => this.opts.config.repoRoots,
      exec: this.exec,
      findExisting: (n) => this.findRepo(n),
      creator: this.repoCreator,
      forge: () => this.forgeEnv,
      ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
      afterClone: () => this.rescan(),
    });
    this.repoAccess = new RepoAccessUpdater({
      exec: this.exec,
      forge: () => this.forgeEnv,
      findExisting: (n) => this.findRepo(n),
      ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
    });
    this.poller = new IntegrationPoller({
      ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
      jira: () => this.jiraConfig(),
      ...(opts.config.runtimes.mock?.enabled ? { mockFile: join(this.paths.root, 'mock-issues.json') } : {}),
    });
    this.client.on('message', (m) => this.onMessage(m));
    this.client.on('welcome', (w) => {
      void this.reportGit(true);
      void this.reportOrgFolders();
      this.reportMcpServers(true);
      this.reportToolchains(true);
      this.reportUpdate();
      opts.onConnected?.();
      this.maxConcurrent = Math.min(w.limits.maxConcurrentShifts, opts.config.maxConcurrentShifts);
      this.writeStatus(true);
      this.scheduleStartupSweep();
    });
    this.client.on('disconnected', () => {
      this.writeStatus(false);
      void this.chat.cancelAll('workstation offline: the connection to the server dropped');
    });
    this.client.on('fatal', (code, why) => {
      this.unpaired = why === UNPAIRED_MESSAGE;
      if (this.unpaired) this.log.warn(`stopping: ${why}`);
      else this.log.error(`connection closed for good (${code}): ${why}`);
      // Unpaired is a normal end (exit 0, so a service manager does not restart a runner that cannot work).
      this.fatalResolve?.(this.unpaired ? 0 : code === 4409 ? 3 : 2);
    });
  }

  /** Jira credentials in force: `secrets/jira.json` (written by `aom-runner jira-connect`), else config.json's `jira` block. */
  private jiraConfig() {
    return resolveJira(this.paths.secrets, this.freshConfig().jira);
  }

  /** The organization source folder of an organization (read fresh from config.json, so `org-folder set` needs no restart). */
  private orgSourceFolder(orgId: string): string | undefined {
    let folders = this.opts.config.orgSourceFolders;
    try {
      folders = loadConfig(this.paths.config).orgSourceFolders;
    } catch {
      // no config file on disk (tests): the in-memory one stands
    }
    return folders[orgId.toLowerCase()];
  }

  /** The config as it is on disk now (`aom-runner org-folder` edits it without a restart); the in-memory one without a file. */
  private freshConfig(): RunnerConfig {
    try {
      return loadConfig(this.paths.config);
    } catch {
      return this.opts.config;
    }
  }

  /**
   * Tells the server which organisation source folders are set here (valid or not, how many repositories) and which
   * folders it may offer in the picker. Local facts only; sent after `welcome`, after each re-scan and after `org.folder`.
   */
  async reportOrgFolders(): Promise<void> {
    try {
      const config = this.freshConfig();
      this.client.send('org.folders', {
        folders: await orgFolderStates(config, this.paths.root),
        candidates: orgFolderCandidates(config, this.paths.root),
      });
    } catch (err) {
      this.log.warn(`org folder report failed: ${String(err)}`);
    }
  }

  /**
   * `org.folder`: the app asks to set or clear the folder. The exact validation of `aom-runner org-folder set` decides;
   * a refusal is an answer (`ok:false` with the reason), the config.json is rewritten atomically (mode 0600) only on
   * success, then the new state is reported.
   */
  private async applyOrgFolder(p: {
    orgId: string;
    path: string | null;
  }): Promise<{ ok: boolean; error?: string }> {
    const changed = changeOrgFolder(this.freshConfig(), p.orgId, p.path, this.paths.root);
    if (!changed.ok) return { ok: false, error: changed.error };
    try {
      saveConfig(this.paths.config, changed.config);
    } catch (err) {
      return { ok: false, error: `could not write the runner config: ${String(err)}` };
    }
    this.opts.config.orgSourceFolders = changed.config.orgSourceFolders;
    await this.reportOrgFolders();
    return { ok: true };
  }

  /** True when no agent job and no chat is running: the moment it is safe to restart into a new version. */
  isIdle(): boolean {
    return this.supervisor.size === 0 && this.chat.size === 0;
  }

  /** Tells the server how this runner's self-update stands (best effort: dropped while offline, resent on welcome). */
  reportUpdate(): void {
    const u = this.opts.updateStatus?.();
    if (u) this.client.send('runner.update', u);
  }

  async start(): Promise<void> {
    await writeShims(this.paths.bin);
    await this.ipc.start();
    await this.ipc.startSocket().catch((err) => this.log.warn(`IPC socket unavailable: ${String(err)}`));
    await this.scan();
    this.supervisor.resumePersisted();
    this.vaults.start();
    this.client.start();
    const t = setInterval(() => void this.rescan(), this.opts.rescanMs ?? 600_000);
    t.unref();
    this.timers.push(t);
    // `aom-runner git-connect` touches a marker file: report the new git status without waiting for the rescan.
    const g = setInterval(() => {
      try {
        const m = statSync(recheckFile(this.paths.secrets)).mtimeMs;
        if (m > this.lastRecheck) {
          this.lastRecheck = m;
          void this.reportGit(false);
        }
      } catch {
        // no marker yet
      }
    }, 10_000);
    g.unref();
    this.timers.push(g);
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
      out.push({
        id: c.runtime,
        version: c.version,
        available: c.available,
        capabilities: c.capabilities,
        ...(c.sandbox ? { sandbox: c.sandbox, sandboxReason: c.sandboxReason } : {}),
      });
    }
    return out;
  }

  private async buildHello(): Promise<Record<string, unknown>> {
    await this.scan();
    return {
      runnerVersion: RUNNER_VERSION,
      protocol: 1,
      platform: platform(),
      hostname: hostname(),
      runtimes: await this.runtimeInfos().then((r) => {
        this.lastRuntimes = JSON.stringify(r);
        return r;
      }),
      repos: this.repos,
      repoCatalog: this.repoCatalog(),
      vaults: await this.vaults.report(),
      activeShifts: this.supervisor.activeShifts(),
      maxConcurrentShifts: this.opts.config.maxConcurrentShifts,
      sudoKey: this.keys.publicKey,
    };
  }

  private async rescan(): Promise<void> {
    await this.scan();
    this.client.send('repos.report', { repos: this.repos, repoCatalog: this.repoCatalog() });
    // A re-probe may change a runtime (bubblewrap installed, claude upgraded): tell the server when it did.
    const runtimes = await this.runtimeInfos();
    const key = JSON.stringify(runtimes);
    if (this.lastRuntimes !== undefined && key !== this.lastRuntimes)
      this.client.send('runtimes.report', { runtimes });
    this.lastRuntimes = key;
    await this.reportGit(false);
    await this.reportOrgFolders();
    this.reportMcpServers(false);
    this.reportToolchains(false);
  }

  /**
   * Tells the server which MCP servers the installed, enabled Claude Code plugins of this machine offer (name, plugin,
   * transport, host name; never an environment value, header, token or argument). On `welcome` and when it changed.
   */
  private reportMcpServers(force: boolean): void {
    if (!(this.opts.mcpReport ?? !(this.opts.config.runtimes.mock?.enabled || process.env.VITEST))) return;
    try {
      const report = reportOf((this.opts.mcpDiscover ?? (() => discoverPluginMcpServers()))());
      const key = JSON.stringify(report);
      if (!force && key === this.lastMcp) return;
      this.lastMcp = key;
      this.client.send('mcp.servers', { servers: report });
    } catch (err) {
      this.log.warn(`plugin MCP server discovery failed: ${String(err)}`);
    }
  }

  /**
   * Tells the server which toolchains the sandboxed agents have (detected, configured, registered by the DevOps engineer):
   * names, folders and variable names, never a value. On `welcome`, when it changed and after `aom toolchain add|remove`.
   */
  private reportToolchains(force: boolean): void {
    if (!(this.opts.mcpReport ?? !(this.opts.config.runtimes.mock?.enabled || process.env.VITEST))) return;
    try {
      const report = this.toolchains
        .list()
        .slice(0, 64)
        .map((e) => ({
          name: e.name.slice(0, 80),
          source: e.source,
          ...(e.version ? { version: e.version.slice(0, 200) } : {}),
          binDirs: e.binDirs.slice(0, 8),
          readDirs: e.readDirs.slice(0, 16),
          envKeys: Object.keys(e.env).slice(0, 16),
          ...(e.addedAt ? { addedAt: e.addedAt } : {}),
          ...(e.addedBy ? { addedBy: e.addedBy } : {}),
        }));
      const key = JSON.stringify(report);
      if (!force && key === this.lastToolchains) return;
      this.lastToolchains = key;
      this.client.send('toolchains.report', { toolchains: report });
    } catch (err) {
      this.log.warn(`toolchain report failed: ${String(err)}`);
    }
  }

  /** Tells the server whether Jira is connected on this workstation and whether Jira accepts the saved credentials. */
  private async reportJira(force: boolean): Promise<void> {
    try {
      const status = await (this.external.jira?.checkStatus() ??
        Promise.resolve({ state: 'not_connected' as const }));
      const key = JSON.stringify(status);
      if (!force && key === this.lastJira) return;
      this.lastJira = key;
      this.client.send('jira.report', { status });
    } catch (err) {
      this.log.warn(`jira status check failed: ${String(err)}`);
    }
  }

  /** Tells the server which git providers this workstation is connected to (facts only, never a token). */
  private async reportGit(force: boolean): Promise<void> {
    if (!(this.opts.gitReport ?? !(this.opts.config.runtimes.mock?.enabled || process.env.VITEST))) return;
    void this.reportJira(force);
    try {
      const hosts: Partial<Record<'github' | 'gitlab', string[]>> = {};
      for (const r of this.repos) {
        const p = forgeForUrl(this.forgeEnv, r.remoteUrl);
        if (p && (p.repo.kind === 'github' || p.repo.kind === 'gitlab')) {
          const list = hosts[p.repo.kind] ?? [];
          if (!list.includes(p.repo.host)) list.push(p.repo.host);
          hosts[p.repo.kind] = list;
        }
      }
      const connections = await gitConnections(this.forgeEnv, hosts);
      const key = JSON.stringify(connections.map(({ checkedAt: _c, ...c }) => c));
      if (!force && key === this.lastGit) return;
      this.lastGit = key;
      this.client.send('git.report', { connections });
    } catch (err) {
      this.log.warn(`git status check failed: ${String(err)}`);
    }
  }

  /** The repository picker: the user's repositories on a connected provider (the answer holds no credential). */
  private async listForgeRepos(p: {
    provider: import('@aom/shared').ConnectableForge;
    search?: string | undefined;
  }) {
    const { forgeOfKind } = await import('./forge/index.ts');
    const forge = forgeOfKind(this.forgeEnv, p.provider);
    if (!forge.listRepos) return { ok: false, repos: [], error: `${p.provider} cannot list repositories` };
    try {
      return { ok: true, repos: await forge.listRepos({ search: p.search }) };
    } catch (err) {
      return {
        ok: false,
        repos: [],
        error: (err instanceof Error ? err.message : String(err)).slice(0, 400),
      };
    }
  }

  /** Once per process, shortly after the first connection: the stale-worktree sweep (owner decision 4). */
  private scheduleStartupSweep(): void {
    const delay = this.opts.startupSweepMs ?? 15_000;
    if (this.startupSweepDone || delay < 0) return;
    this.startupSweepDone = true;
    const t = setTimeout(() => {
      this.sweepWorktrees()
        .then((r) => {
          if (r.removed.length || r.dirty.length || r.emptyDirsRemoved.length || r.skipped)
            this.log.info(`worktree sweep: ${JSON.stringify(r)}`);
        })
        .catch((err) => this.log.warn(`worktree sweep failed: ${String(err)}`));
    }, delay);
    t.unref();
    this.timers.push(t);
  }

  /** Asks the server which worktrees are live (null: no answer in time). */
  private askLiveWorktrees(paths: string[]): Promise<Set<string> | null> {
    if (!this.client.isReady) return Promise.resolve(null);
    const queryId = uuidv7();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sweepQueries.delete(queryId);
        resolve(null);
      }, this.opts.sweepAnswerMs ?? 15_000);
      timer.unref();
      this.sweepQueries.set(queryId, (live) => {
        clearTimeout(timer);
        resolve(new Set(live.map((p) => p)));
      });
      this.client.send('worktrees.query', { queryId, paths });
    });
  }

  /** Removes the worktrees of finalized, cancelled and unknown cards, empty project folders and runs `git worktree prune`. */
  sweepWorktrees(): Promise<WorktreeSweepResult> {
    // One sweep at a time: a second request joins the one in flight.
    this.sweeping ??= sweepWorktrees({
      worktreesDir: this.paths.worktrees,
      liveOf: async (paths) => {
        // The server answers in chunks of at most SWEEP_QUERY_MAX_PATHS; ask in one go while it fits.
        return this.askLiveWorktrees(paths);
      },
      busyPaths: this.supervisor.worktreePaths(),
      repoPaths: this.repos.map((r) => r.localPath),
      outboxPending: this.outbox.count(),
    }).finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private platform(): Platform {
    return this.opts.platform ?? (process.platform as Platform);
  }

  /** `env.ensure`: detect the stacks of the project's repositories, verify and install their tools. */
  private ensureEnv(p: EnvEnsurePayload) {
    return ensureEnvironment(p, {
      exec: this.exec,
      platform: this.platform(),
      root: this.sudo,
      findRepo: (n) => this.findRepo(n),
      logFile: join(this.paths.envLogs, `${p.projectId}.log`),
      dotnet: () =>
        selectDotnet({
          ...(this.opts.config.dotnetRoot ? { override: this.opts.config.dotnetRoot } : {}),
        }),
    });
  }

  /** Scans the repoRoots once: project matching sees every clone with a remote, the picker catalog only what may be opened. */
  private async scan(): Promise<void> {
    const all = await scanAllRepos(this.opts.config.repoRoots);
    this.repos = withRemote(all);
    this.catalog = all.filter((r) => !forbiddenReadPath(r.localPath, this.paths.root));
  }

  /** What the server may offer in the reference repositories picker: names, normalized remotes, relative keys; no paths. */
  private repoCatalog(): Array<{ name: string; localKey: string; remoteUrlNormalized: string | null }> {
    return this.catalog.slice(0, 2000).map((r) => ({
      name: basename(r.localPath),
      localKey: r.localKey,
      remoteUrlNormalized: r.remoteUrl ? normalizeRemoteUrl(r.remoteUrl) : null,
    }));
  }

  /** The clone with this catalog key (a path relative to a repoRoot), as last scanned. */
  private async findLocal(localKey: string): Promise<{ localPath: string } | undefined> {
    const match = (r: ScannedRepo) => r.localKey === localKey;
    let found = this.catalog.find(match);
    if (!found) {
      await this.scan();
      found = this.catalog.find(match);
    }
    return found;
  }

  private async findRepo(normalized: string): Promise<RepoReport | undefined> {
    const match = (r: RepoReport) => normalizeRemoteUrl(r.remoteUrl) === normalized;
    let found = this.repos.find(match);
    if (!found) {
      await this.scan();
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
      case 'worktrees.live': {
        const cb = this.sweepQueries.get(msg.queryId);
        this.sweepQueries.delete(msg.queryId);
        cb?.(msg.live);
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
          await removeWorktree({
            path: p.path,
            branchName: p.branchName,
            deleteBranch: p.deleteBranch,
            roots: [this.paths.worktrees],
          }),
        );
      } else if (command === 'worktrees.sweep') {
        // The hygiene job's sweep: the result is an answer (ok:true) even when nothing could be swept.
        CommandPayloadSchemas['worktrees.sweep'].parse(payload);
        done(true, await this.sweepWorktrees());
      } else if (command === 'repos.rescan') {
        await this.rescan();
        done(true, { repos: this.repos.length });
      } else if (command === 'vault.configure') {
        this.vaults.configure(CommandPayloadSchemas['vault.configure'].parse(payload));
        done(true, { vaults: this.vaults.configured() });
      } else if (command === 'vault.write') {
        done(true, await this.vaults.write(CommandPayloadSchemas['vault.write'].parse(payload)));
      } else if (command === 'vault.move') {
        done(true, await this.vaults.move(CommandPayloadSchemas['vault.move'].parse(payload)));
      } else if (command === 'vault.merge') {
        done(true, await this.vaults.merge(CommandPayloadSchemas['vault.merge'].parse(payload)));
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
              worktreePath: this.paths.worktreePath(p.projectKey, p.ref, p.projectId),
              worktreesDir: this.paths.worktrees,
              integrationDir: this.paths.integration,
              pr: this.opts.prCreator ?? forgePrCreator(this.forgeEnv),
              auth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge),
              rules:
                this.opts.branchRules ??
                ((cwd, branch, forge) => branchRulesFor(this.forgeEnv, cwd, branch, forge)),
            }),
          );
        }
      } else if (command === 'repo.open_pr') {
        // "No clone here", "nothing to open" and every git host refusal are answers (ok:true, result.ok:false).
        const p = CommandPayloadSchemas['repo.open_pr'].parse(payload);
        const repo = await this.findRepo(p.remoteUrlNormalized);
        done(
          true,
          repo
            ? await openReleasePr({
                payload: p,
                repoPath: repo.localPath,
                pr: this.opts.prCreator ?? forgePrCreator(this.forgeEnv),
                auth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge),
              })
            : { ok: false, error: `no local clone for ${p.remoteUrlNormalized}` },
        );
      } else if (command === 'outbound.post') {
        // Failures are answered as `ok:true, result.ok:false`: the server turns them into a desk alert, not a blind retry.
        done(true, await this.outbound.run(CommandPayloadSchemas['outbound.post'].parse(payload), commandId));
      } else if (command === 'branch.check_merged') {
        // "Not merged" and "no clone here" are answers (ok:true); the server asks again later.
        const p = CommandPayloadSchemas['branch.check_merged'].parse(payload);
        const repo = await this.findRepo(p.remoteUrlNormalized);
        done(
          true,
          repo
            ? await checkBranchMerged({ repoPath: repo.localPath, payload: p })
            : { merged: false, reason: `no local clone for ${p.remoteUrlNormalized}` },
        );
      } else if (command === 'integration.run') {
        // A failed poll is an answer (ok:true, result.ok:false): the server shows it in the schedule's history.
        done(true, await this.poller.run(CommandPayloadSchemas['integration.run'].parse(payload)));
      } else if (command === 'repo.create') {
        // Failures are answered as `ok:true, result.ok:false`: the server puts them on the desk.
        done(true, await this.repoCreator.run(CommandPayloadSchemas['repo.create'].parse(payload)));
      } else if (command === 'repo.clone') {
        // A clone that cannot be done is an answer (ok:true, result.ok:false): the Repositories tab shows why.
        done(true, await this.repoCloner.run(CommandPayloadSchemas['repo.clone'].parse(payload)));
      } else if (command === 'env.ensure') {
        done(true, await this.ensureEnv(CommandPayloadSchemas['env.ensure'].parse(payload)));
      } else if (command === 'rights.verify') {
        const p = CommandPayloadSchemas['rights.verify'].parse(payload);
        done(
          true,
          await verifyRights(p.access, {
            exec: this.exec,
            root: this.sudo,
            platform: this.platform(),
            sudoPasswordStored: this.sudo.has(),
          }),
        );
      } else if (command === 'sudo.set') {
        // The payload is ciphertext; the answer never contains the password.
        done(true, await this.sudo.set(CommandPayloadSchemas['sudo.set'].parse(payload)));
      } else if (command === 'git.status') {
        await this.reportGit(true);
        done(true, { reported: true });
      } else if (command === 'repo.access') {
        // The origin of the clone follows the repository's access method; a failure is an answer, not a command error.
        done(true, await this.repoAccess.run(CommandPayloadSchemas['repo.access'].parse(payload)));
      } else if (command === 'git.ssh') {
        const p = CommandPayloadSchemas['git.ssh'].parse(payload);
        const ssh = this.forgeEnv.ssh;
        if (!ssh) throw new Error('ssh is not available on this runner');
        let result: Awaited<ReturnType<typeof runSshAction>>;
        try {
          result = await runSshAction(this.exec, ssh, {
            provider: p.provider,
            host: p.host ?? defaultHost(p.provider),
            action: p.action,
            defaultMethod: p.defaultMethod,
            key: p.key,
            keyPath: p.keyPath,
            repoUrl: p.repoUrl,
          });
        } catch (err) {
          await this.reportGit(true);
          throw err;
        }
        await this.reportGit(true);
        done(true, result);
      } else if (command === 'forge.repos') {
        done(true, await this.listForgeRepos(CommandPayloadSchemas['forge.repos'].parse(payload)));
      } else if (command === 'org.folder') {
        done(true, await this.applyOrgFolder(CommandPayloadSchemas['org.folder'].parse(payload)));
      } else if (command === 'toolchain.remove') {
        const { name } = CommandPayloadSchemas['toolchain.remove'].parse(payload);
        const removed = this.toolchains.remove(name);
        this.reportToolchains(false);
        done(true, { removed });
      } else if (command === 'sudo.clear') {
        this.sudo.clear();
        done(true, { cleared: true });
      } else {
        done(false, undefined, `command ${command} is not supported by this runner version`);
      }
    } catch (err) {
      done(false, undefined, err instanceof Error ? err.message : String(err));
    }
  }
}
