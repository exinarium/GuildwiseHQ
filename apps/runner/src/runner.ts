import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, platform } from 'node:os';
import { basename, join } from 'node:path';
import {
  BOARD_VERBS_CAPABILITY,
  CAPABILITY_REGISTRY_FEATURE,
  CEO_FULL_POWER_CAPABILITY,
  CHAT_ACCOUNTS_CAPABILITY,
  CHAT_ACTIVITY_FEATURE,
  CLAUDE_ACCOUNTS_CAPABILITY,
  CLAUDE_MAIN_SWAP_CAPABILITY,
  CommandPayloadSchemas,
  DELEGATE_GRANTS_FEATURE,
  DELIVERY_CAPABILITY,
  DEPLOY_CONNECT_CAPABILITY,
  DEPLOY_DIRECT_CAPABILITY,
  DEPLOY_MOVE_CAPABILITY,
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_SETUP_V2_CAPABILITY,
  DIRECT_MODEL_CAPABILITY,
  defaultHost,
  type EnvEnsurePayload,
  INTEGRATIONS_VERSION,
  type IntegrationKindId,
  type IpcRpcResponse,
  isKeyScope,
  LOCAL_VAULT_CAPABILITY,
  type McpAuthState,
  normalizeRemoteUrl,
  PACK_AUTHORING_CAPABILITY,
  PACK_CREDENTIALS_BOUND_CAPABILITY,
  PACK_SCRIPT_GATE_CAPABILITY,
  PACKS_CAPABILITY,
  PRIVATE_ENDPOINTS_CAPABILITY,
  PROVIDER_ACCOUNTS_CAPABILITY,
  PROVIDER_KEYS_BOUND_CAPABILITY,
  PROVIDER_KEYS_CAPABILITY,
  type ProviderAccountPromoteResult,
  READONLY_DESIGN_CAPABILITY,
  type RepoReport,
  RUN_USAGE_FEATURE,
  RUNNER_PIN_CAPABILITY,
  RUNNER_UPDATE_CHECK_CAPABILITY,
  type RunnerCommandName,
  type RunnerUpdateCheckResult,
  type RunnerUpdateState,
  type RuntimeInfo,
  SEAL_AAD_CAPABILITY,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
  SETUP_SCAN_CAPABILITY,
  type ServerToRunner,
  SHIFT_LIMIT_CAPABILITY,
  type ShiftLimitSetting,
  uuidv7,
  type WorktreeSweepResult,
} from '@aom/shared';
import { ensureClaudeAccount } from './adapters/claude-account-provision.ts';
import { ClaudeAccountRegistry } from './adapters/claude-accounts.ts';
import { probeClaudeLogin } from './adapters/claude-auth.ts';
import { sweepVertexKeys } from './adapters/claude-backend.ts';
import { ClaudeCodeAdapter, realClaudeBlocked } from './adapters/claude-code.ts';
import { recoverClaudeMainSwap, swapClaudeMain } from './adapters/claude-main-swap.ts';
import { formatLimitTime } from './adapters/claude-usage-limit.ts';
import { codexMainFolder, detectCodex } from './adapters/codex.ts';
import { detectGemini, geminiMainFolder } from './adapters/gemini.ts';
import {
  CODEX_DEF,
  GEMINI_DEF,
  LoginAccountRegistry,
  swapMainLoginAccount,
} from './adapters/login-accounts.ts';
import { buildAdapters } from './adapters/registry.ts';
import type { RuntimeAdapter } from './adapters/types.ts';
import { ServerHttp } from './attachments/index.ts';
import { PackCredentialStore } from './capabilities/pack-credentials.ts';
import { PackManager } from './capabilities/packs.ts';
import { CapabilityRegistry } from './capabilities/registry.ts';
import { ChatManager } from './chat/chat.ts';
import { loadConfig, type RunnerConfig, saveConfig } from './config.ts';
import { type BackoffOptions, RunnerClient, toWsUrl, UNPAIRED_MESSAGE } from './connection/client.ts';
import { Outbox } from './connection/outbox.ts';
import { DeployConnector } from './delivery/connect.ts';
import { DeployKeys } from './delivery/deploy-keys.ts';
import { DeployExecutor } from './delivery/exec.ts';
import { DeployMover } from './delivery/move.ts';
import { DeployPreparer } from './delivery/prepare.ts';
import { runDeployProbe } from './delivery/probe.ts';
import { DeliveryService } from './delivery/service.ts';
import { verifyRights } from './devops/rights.ts';
import { ProviderStore } from './direct/store.ts';
import { ExternalAdapters } from './external/index.ts';
import { resolveJira } from './external/jira-store.ts';
import { OutboundExecutor } from './external/outbound.ts';
import { AgentGit } from './forge/agent-git.ts';
import { recheckFile, touchRecheck } from './forge/connect.ts';
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
import { SyncService } from './git/sync-service.ts';
import { removeWorktree } from './git/worktrees.ts';
import { GraphService } from './graph/service.ts';
import { runRoleSmoke } from './health/role-smoke.ts';
import { sanitizeError } from './health/runner-error.ts';
import { ClaudeCredentialStore, claudeFile, resolveClaudeCredential } from './integrations/claude-store.ts';
import { type AdapterEnv, type IntegrationAdapter, IntegrationService } from './integrations/index.ts';
import { IntegrationPoller } from './integrations/poll.ts';
import type { LoginSpawner } from './integrations/pty.ts';
import { IpcServer } from './ipc/server.ts';
import { type Logger, nullLogger } from './log.ts';
import {
  discoverPluginMcpServers,
  mcpAuthStates,
  mcpSignInNote,
  type PluginMcpServer,
  reportOf,
} from './mcp/plugins.ts';
import { changeOrgFolder, orgFolderCandidates, orgFolderStates } from './org-folder.ts';
import { type RunnerPaths, runnerPaths } from './paths.ts';
import { forbiddenReadPath } from './read-repos.ts';
import { RepoAccessUpdater } from './repo/access.ts';
import { RepoCloner } from './repo/clone.ts';
import { RepoCreator } from './repo/create.ts';
import { RestartAfterReply } from './restart-after-reply.ts';
import { RunManager } from './runs/manager.ts';
import { sweepAgentTmps, wipeAgent } from './sandbox/sandbox.ts';
import { sweepAgentScratch } from './sandbox/scratch.ts';
import { DeploySecrets } from './secrets/deploy.ts';
import { RunnerKeys } from './secrets/keys.ts';
import { SudoVault } from './secrets/sudo.ts';
import { TargetSecrets } from './secrets/targets.ts';
import { clearServerLimit, loadServerLimit, saveServerLimit } from './shifts/server-limit.ts';
import { ShiftSupervisor, type SupervisorDeps } from './shifts/supervisor.ts';
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
  /** The interval of the working-branch check (default 10 min). */
  syncIntervalMs?: number;
  /** Test seam: idle watchdog limits and clock. */
  idle?: SupervisorDeps['idle'];
  /** How often an expired Claude login is probed (default 3 minutes). */
  authProbeMs?: number;
  /** Minimum time between two usage-limit probes (default 3 minutes). */
  usageProbeMs?: number;
  /** Test seam: the sign-in state per MCP server key (default: read from the Claude credentials file). */
  mcpAuth?: () => (server: PluginMcpServer) => McpAuthState;
  /** The once-a-minute tick (MCP sign-in state, login probe); tests shorten it. */
  minuteMs?: number;
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
  /** Test hook: how a deployed target is probed before a tester shift (default: an HTTP request to its URL). */
  probeTarget?: (url: string) => Promise<string | null>;
  /** Sweep stale worktrees this long after the first connection of the process (default 15 s); a negative value turns it off. */
  startupSweepMs?: number;
  /** Test hook: milliseconds between the periodic scratch and worktree sweeps (default: `scratch.sweepIntervalHours`). */
  scratchSweepMs?: number;
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
  /**
   * Report the integrations (`integrations.report`). Default on, off with the mock runtime and under tests so nothing
   * reaches a real provider from them. Commands (`integration.*`) work either way.
   */
  integrationsReport?: boolean;
  /** Test hooks: the integration adapters and the sign-in process spawner. */
  integrationAdapters?: Map<IntegrationKindId, IntegrationAdapter>;
  integrationSpawn?: LoginSpawner;
  /** This pairing may change machine-wide logins from the web (default: yes; the host decides with several pairings). */
  isPrimaryPairing?: () => boolean;
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
  /** Safe mode: the server pinned this workstation to a runner version (null: follow the latest release again). */
  onRunnerPin?: (version: string | null) => void;
  /** "Check for updates" from the web: the self-updater checks now (one updater per process, whichever pairing asked). */
  onUpdateCheck?: () => Promise<RunnerUpdateCheckResult>;
  /** Test seam: timings of the run supervision (see `runs/manager.ts`). */
  runTiming?: Partial<import('./runs/manager.ts').RunTiming>;
  /** Tests shorten the health polling of a deploy. */
  deployTiming?: NonNullable<import('./delivery/exec.ts').DeployExecDeps['timing']>;
  /**
   * Run the role smoke test after the first welcome of this process (a runner start, and so after every update) and send
   * `role.smoke`. Default on, off with the mock runtime and under tests.
   */
  roleSmoke?: boolean;
  /** Test hook: the roles the smoke test goes through and the `aom` command it runs. */
  roleSmokeRoles?: NonNullable<import('./health/role-smoke.ts').RoleSmokeDeps['roles']>;
  roleSmokeAom?: string[];
  /**
   * Ends this process so a service manager (or the detached helper) starts it again: `aom runner restart` calls it after the
   * reply of the turn that asked was acknowledged (see `restart-after-reply.ts`). Absent: the request is accepted and ignored.
   */
  requestRestart?: () => void;
  /** Test seam: timings of the restart after a reply. */
  restartTiming?: Pick<
    import('./restart-after-reply.ts').RestartDeps,
    'pollMs' | 'maxWaitMs' | 'later' | 'now'
  >;
  /** Test seam: replaces or adds supervisor dependencies (disk check, grace, context reporting, ...). */
  supervisorOverrides?: Partial<SupervisorDeps>;
}

/** The long-running runner process: connection, IPC server, supervisor and command handlers. */
export class Runner {
  readonly paths: RunnerPaths;
  readonly outbox: Outbox;
  readonly ipc = new IpcServer();
  readonly supervisor: ShiftSupervisor;
  readonly chat: ChatManager;
  readonly restartAfterReply: RestartAfterReply;
  readonly client: RunnerClient;
  readonly vaults: VaultManager;
  /** M8: posts approved drafts to Jira and the code host with this workstation's credentials. */
  readonly outbound: OutboundExecutor;
  private readonly poller: IntegrationPoller;
  readonly repoCreator: RepoCreator;
  readonly repoCloner: RepoCloner;
  /** The project graph: indexes repositories into the project vault and answers `aom graph` (docs/design/project-graphs.md). */
  readonly graph: GraphService;
  private readonly repoAccess: RepoAccessUpdater;
  /** The key pair for secrets the manager sends (the sudo password) and the store that holds the password. */
  readonly keys: RunnerKeys;
  private readonly packCredentials: PackCredentialStore;
  readonly sudo: SudoVault;
  /** Test accounts for deploy targets (docs/design/run-and-integration-tests.md D11): ciphertext only on disk. */
  readonly targetSecrets: TargetSecrets;
  readonly deploySecrets: DeploySecrets;
  /** Provider keys of the direct-model runtime (sealed in the browser, ciphertext on disk, redacted everywhere). */
  readonly providers: ProviderStore;
  readonly delivery: DeliveryService;
  readonly deployExec: DeployExecutor;
  /** Dedicated deploy keys, guided connect and server preparation (design v2): keys live in `<data dir>/keys/deploy`. */
  readonly deployKeys: DeployKeys;
  readonly deployConnector: DeployConnector;
  readonly deployPreparer: DeployPreparer;
  readonly deployMover: DeployMover;
  /** The integrations of this workstation: status, connect from the web, interactive sign-ins (docs/design/integrations-page.md). */
  readonly integrations: IntegrationService;
  readonly claudeStore: ClaudeCredentialStore;
  /** Tools agents may use: detected, configured and registered by the DevOps engineer (`aom toolchain`). */
  readonly toolchains: ToolchainRegistry;
  /** Run a branch (#58): detached run worktrees, setup steps and supervised services. */
  readonly runs: RunManager;
  private readonly exec: Executor;
  /** Keeps each repository's local working branch in step with origin (fetch, fast-forward when safe, report). */
  readonly sync: SyncService;
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
  /**
   * The Claude accounts of this workstation: main (today's credential) and the additional ones. Each has its own login and
   * usage-limit state (persisted in `claude-accounts-state.json`) and its own recovery probes.
   */
  readonly claudeAccounts: ClaudeAccountRegistry;
  /** The named login accounts of Codex and of the Gemini CLI (S-A), with the same login and usage state per account. */
  readonly codexAccounts: LoginAccountRegistry;
  readonly geminiAccounts: LoginAccountRegistry;
  /** The main account's login: expired pauses it until a probe succeeds. */
  get claudeAuth() {
    return this.claudeAccounts.main.auth;
  }
  /** The main account's usage limit (backlog #73). */
  get claudeUsage() {
    return this.claudeAccounts.main.usage;
  }
  private readonly lastAuthProbe = new Map<string, number>();
  private readonly lastUsageProbe = new Map<string, number>();
  private maxConcurrent: number;
  /** The shift limit the owner chose on the Workstations page, saved so it holds after a restart (backlog #76). */
  private readonly serverLimitFile: string;
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
    this.targetSecrets = new TargetSecrets({
      file: join(this.paths.secrets, 'targets.json'),
      keys: this.keys,
    });
    this.deploySecrets = new DeploySecrets({ secretsDir: this.paths.secrets, keys: this.keys });
    this.providers = new ProviderStore({ file: join(this.paths.secrets, 'providers.json'), keys: this.keys });
    // A Vertex service-account key file left by a session that ended abnormally (no claude process outlives the runner).
    sweepVertexKeys(this.paths.secrets);
    this.serverLimitFile = join(this.paths.root, 'server-limits.json');
    // Until the server says otherwise: the owner's saved choice, else this runner's own configured value.
    this.maxConcurrent =
      loadServerLimit(this.serverLimitFile)?.maxConcurrentShifts ?? opts.config.maxConcurrentShifts;
    this.sync = new SyncService({
      file: join(this.paths.root, 'sync-targets.json'),
      findRepo: (n) => this.findRepo(n),
      busyWorktrees: () => this.supervisor.worktreePaths(),
      auth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge),
      send: (r) =>
        void this.client.send('repo.sync_status', {
          status: {
            repoId: r.repoId,
            workingBranch: r.workingBranch,
            state: r.state,
            ahead: r.ahead,
            behind: r.behind,
            dirty: r.dirty,
            onBranch: r.onBranch,
            checkedOutBranch: r.checkedOutBranch,
            ...(r.detail ? { detail: r.detail.slice(0, 400) } : {}),
            checkedAt: r.checkedAt,
          },
        }),
      log: this.log,
    });
    this.claudeStore = new ClaudeCredentialStore(claudeFile(this.paths.secrets));
    const mainCredential = () => {
      // secrets/claude.json over config.json, read at every session start: a new token needs no restart
      const c = resolveClaudeCredential(this.claudeStore, this.freshConfig().runtimes['claude-code']);
      return {
        authMode: c.authMode,
        ...(c.oauthToken ? { oauthToken: c.oauthToken } : {}),
        ...(c.apiKey ? { apiKey: c.apiKey } : {}),
      };
    };
    // a "Make main" swap that stopped half-way is finished before the accounts are read
    recoverClaudeMainSwap(this.paths.root);
    this.claudeAccounts = new ClaudeAccountRegistry({
      home: homedir(),
      root: this.paths.root,
      secretsDir: this.paths.secrets,
      stateFile: join(this.paths.root, 'claude-accounts-state.json'),
      accounts: () => this.freshConfig().runtimes['claude-code'].accounts,
      mainCredential,
    });
    // The named login accounts of Codex and the Gemini CLI (S-A): the owner's own login is main, the others are folders of their own.
    this.codexAccounts = new LoginAccountRegistry({
      def: CODEX_DEF,
      home: homedir(),
      stateFile: join(this.paths.root, 'codex-accounts-state.json'),
      accounts: () => this.freshConfig().runtimes.codex?.accounts ?? [],
      mainFolder: () => codexMainFolder(this.freshConfig().runtimes.codex, homedir()),
    });
    this.geminiAccounts = new LoginAccountRegistry({
      def: GEMINI_DEF,
      home: homedir(),
      stateFile: join(this.paths.root, 'gemini-accounts-state.json'),
      accounts: () => this.freshConfig().runtimes.gemini?.accounts ?? [],
      mainFolder: () => geminiMainFolder(this.freshConfig().runtimes.gemini, homedir()),
    });
    this.adapters =
      opts.adapters ??
      buildAdapters(
        opts.config,
        this.paths,
        this.claudeAuth,
        mainCredential,
        this.claudeUsage,
        this.claudeAccounts,
        {
          store: this.providers,
          onModelsChanged: () => void this.reportRuntimes(),
          options: { chatRetentionDays: opts.config.directChatRetentionDays },
        },
        { codex: this.codexAccounts, gemini: this.geminiAccounts },
      );
    this.integrations = new IntegrationService({
      workstationId: opts.config.workstationId,
      keys: this.keys,
      env: this.adapterEnv(),
      ...(opts.integrationAdapters ? { adapters: opts.integrationAdapters } : {}),
      ...(opts.integrationSpawn ? { spawn: opts.integrationSpawn } : {}),
      ...(opts.isPrimaryPairing ? { isPrimary: opts.isPrimaryPairing } : {}),
      log: this.log,
      send: (type, payload) => void this.client.send(type as 'integrations.report', payload as never),
    });
    // Any account's login or usage state changing is logged (tagged with the account) and reported to the server.
    this.claudeAccounts.onChange((a) => {
      const tag = a.main ? 'the Claude' : `account=${a.key}: the Claude`;
      const where = a.main ? 'work on this workstation' : `work on account ${a.key}`;
      const login = a.auth.state;
      if (login !== 'ok')
        this.log.warn(
          login === 'none'
            ? `${tag} login was never completed: ${where} is paused until you sign in (${a.terminalLogin()})`
            : a.main
              ? `${tag} login does not work: ${where} is paused until you run \`claude\` and \`/login\` here`
              : `${tag} login does not work: ${where} is paused until you sign in (${a.terminalLogin()})`,
        );
      if (a.usage.state === 'limited' && a.usage.limitedUntil)
        this.log.warn(
          `${tag} usage limit was reached: ${where} is paused until ${formatLimitTime(new Date(a.usage.limitedUntil))}`,
        );
      if (login === 'ok' && a.usage.state === 'ok')
        this.log.info(`${tag} account works again: ${where} resumes`);
      void this.reportRuntimes();
    });
    for (const reg of [this.codexAccounts, this.geminiAccounts]) {
      reg.onChange((a) => {
        const what = `${reg.def.label} account ${a.main ? 'main' : a.key}`;
        if (a.auth.state !== 'ok')
          this.log.warn(
            a.auth.state === 'none'
              ? `${what}: no login: its work is paused until you sign in (${a.terminalLogin()})`
              : `${what}: the login does not work: its work is paused until you sign in (${a.terminalLogin()})`,
          );
        if (a.usage.state === 'limited' && a.usage.limitedUntil)
          this.log.warn(
            `${what}: usage limit reached: paused until ${formatLimitTime(new Date(a.usage.limitedUntil))}`,
          );
        if (a.auth.state === 'ok' && a.usage.state === 'ok') this.log.info(`${what}: works again`);
        void this.reportRuntimes();
      });
    }
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
    this.packCredentials = new PackCredentialStore(
      this.paths.packs,
      // a pack credential must be bound to its pack and host (h2); the older forms are refused
      (c, aad) => this.keys.decryptAny(c, aad, { requireBound: true }),
      () => this.keys.publicKey.keyId,
    );
    this.packs = new PackManager({
      dir: this.paths.packs,
      log: this.log,
      report: (r) => void this.client.send('packs.report', r),
      allowLocal: process.env.AOM_PACKS_ALLOW_LOCAL === '1',
      credentials: this.packCredentials,
      open: (c) => this.keys.decryptAny(c),
      keyId: () => this.keys.publicKey.keyId,
    });
    this.capabilities = new CapabilityRegistry({ log: this.log, packs: this.packs });
    this.vaults = new VaultManager({
      paths: this.paths,
      log: this.log,
      transport: { send: (type, payload) => void this.client.send(type, payload) },
      secondMs: opts.vaultSecondMs,
      // generated graph files that two workstations both wrote: the sync took one side, the indexer rebuilds them
      onGraphResolved: (vaultId, folders) =>
        void this.graph.regenerate(vaultId, folders).catch(() => undefined),
      // the organization vault's skills, personas and playbooks: index them and tell the server what is there
      onSynced: (vaultId) => this.indexCapabilities(vaultId),
    });
    this.toolchains = new ToolchainRegistry(this.paths.toolchains, this.paths.root, () => ({
      toolchainPaths: opts.config.runtimes['claude-code'].toolchainPaths,
      ...(opts.config.dotnetRoot ? { dotnetRoot: opts.config.dotnetRoot } : {}),
    }));
    this.toolchains.onChange = () => this.reportToolchains(false);
    this.runs = new RunManager({
      paths: this.paths,
      findRepo: (n) => this.findRepo(n),
      send: (type, payload) => void this.client.send(type as never, payload as never),
      log: this.log,
      maxEnvironments: () => this.freshConfig().maxRunEnvironments,
      portRange: () => this.freshConfig().runPortRange,
      pathDirs: () => this.toolchains.resolve().pathDirs,
      repoRoots: () => this.freshConfig().repoRoots,
      gitAuth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge),
      sandboxMode: () => {
        const c = this.freshConfig().runtimes['claude-code'];
        return { mode: c.sandbox, allowUnsandboxed: c.allowUnsandboxed };
      },
      ...(opts.runTiming ? { timing: opts.runTiming } : {}),
    });
    this.supervisor = new ShiftSupervisor({
      capabilities: this.capabilities,
      onProjectCapabilities: (projectId, r) => {
        if (this.serverFeatures.has(PACKS_CAPABILITY))
          this.client.send('capabilities.project.report', {
            projectId,
            items: r.items.slice(0, 300),
            issues: r.issues.slice(0, 50),
          });
      },
      paths: this.paths,
      config: opts.config,
      adapters: this.adapters,
      beforeAuthReject: () => this.reportRuntimes(),
      ipc: this.ipc,
      outbox: this.outbox,
      log: this.log,
      transport: { send: (type, payload) => this.client.send(type as never, payload) },
      liveUsage: () => this.serverFeatures.has(RUN_USAGE_FEATURE),
      delegateUsage: () => this.serverFeatures.has(DELEGATE_GRANTS_FEATURE),
      onRunnerRestart: (shiftId, reason) => this.restartAfterReply.request(shiftId, reason),
      onShiftEnded: (shiftId, frameId) => this.restartAfterReply.turnFinished(shiftId, frameId),
      findRepo: (norm) => this.findRepo(norm),
      findLocal: (k) => this.findLocal(k),
      graph: () => this.graph,
      recipeSave: (shiftId, params) => this.delivery.save(shiftId, params),
      deployProbe: (shiftId, params, targets) => this.delivery.probeFor(params, shiftId, targets),
      writeVault: (cmd) => this.vaults.write(cmd),
      http: this.serverHttp,
      rpc: (shiftId, method, params) =>
        // Answered here, not by the server: which worktrees have a running shift (repository hygiene defers those repos).
        method === 'hygiene.busy_worktrees'
          ? Promise.resolve({ ok: true, result: { worktrees: this.supervisor.worktreePaths() } })
          : method === 'hygiene.change_state'
            ? this.changeState(params)
            : this.rpc(shiftId, method, params),
      maxConcurrentShifts: () =>
        Math.min(this.maxConcurrent, this.opts.sharedCap?.() ?? Number.POSITIVE_INFINITY),
      maxShiftMsOverride: opts.maxShiftMsOverride,
      ...(opts.idle ? { idle: opts.idle } : {}),
      reportWaitMs: opts.reportWaitMs,
      exitGraceMs: opts.exitGraceMs,
      envChecker: opts.envChecker,
      ...(opts.probeTarget ? { probeTarget: opts.probeTarget } : {}),
      sudoRun: (cmd, args) => this.sudo.run(cmd, args),
      git: this.agentGit,
      toolchains: this.toolchains,
      runs: this.runs,
      targetSecrets: this.targetSecrets,
      orgSourceFolder: (orgId) => this.orgSourceFolder(orgId),
      gitAuth: (url, forge) => gitAuthFor(this.forgeEnv, url, forge),
      syncAfterFetch: (t) => this.sync.sync(t, { fetch: false, locked: true }).then(() => undefined),
      mcpSignInNote: (granted) => this.mcpSignInNote(granted),
      external: () => this.external,
      reportError: (err, context) =>
        this.reportRunnerError(sanitizeError(err, { version: RUNNER_VERSION, context })),
      ...(opts.supervisorOverrides ?? {}),
    });
    this.external =
      opts.external ??
      ExternalAdapters.defaults({
        ...(process.env.AOM_GH_BIN ? { ghBin: process.env.AOM_GH_BIN } : {}),
        jira: () => this.jiraConfig(),
      });
    this.restartAfterReply = new RestartAfterReply({
      replyAcked: (frame) => !frame || !this.outbox.has(frame),
      isIdle: () => this.isIdle(),
      restart: () => opts.requestRestart?.(),
      log: this.log,
      ...(opts.restartTiming ?? {}),
    });
    this.chat = new ChatManager({
      capabilities: this.capabilities,
      restart: this.restartAfterReply,
      ceoFullPower: () => this.freshConfig().ceo.fullPower,
      guardClones: () =>
        this.repos.map((r) => ({ path: r.localPath, name: basename(r.remoteUrl || r.localPath) })),
      paths: this.paths,
      adapters: this.adapters,
      ipc: this.ipc,
      log: this.log,
      send: (type, payload) => this.client.send(type, this.withAttempt(type, payload)),
      chatActivity: () => this.serverFeatures.has(CHAT_ACTIVITY_FEATURE),
      liveUsage: () => this.serverFeatures.has(RUN_USAGE_FEATURE),
      delegateUsage: () => this.serverFeatures.has(DELEGATE_GRANTS_FEATURE),
      rpc: (chatId, method, params) => this.rpc(chatId, method, params, this.chat.attemptOf(chatId)),
      graph: () => this.graph,
      external: this.external,
      mcpSignInNote: (granted) => this.mcpSignInNote(granted),
      http: this.serverHttp,
      findRepo: (n) => this.findRepo(n),
      findLocal: (k) => this.findLocal(k),
      git: this.agentGit,
      toolchains: this.toolchains,
      sudoRun: (cmd, args) => this.sudo.run(cmd, args),
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
    this.graph = new GraphService({
      paths: this.paths,
      vaults: this.vaults,
      findRepo: (n) => this.findRepo(n),
      version: RUNNER_VERSION,
      log: this.log,
    });
    this.deployKeys = new DeployKeys({ dir: join(this.paths.root, 'keys', 'deploy') });
    this.deployConnector = new DeployConnector({
      keys: this.deployKeys,
      decrypt: (c, aad) => this.keys.decryptAny(c, aad),
      keyId: () => this.keys.publicKey.keyId,
      log: this.log,
    });
    this.deployPreparer = new DeployPreparer({
      keys: this.deployKeys,
      repoPath: async (remote) => (await this.findRepo(remote))?.localPath ?? null,
    });
    this.deployMover = new DeployMover({ keys: this.deployKeys, log: this.log });
    this.delivery = new DeliveryService({
      vaults: this.vaults,
      rpc: (shiftId, method, params) => this.rpc(shiftId, method, params),
      keys: this.deployKeys,
      log: this.log,
    });
    this.deployExec = new DeployExecutor({
      keys: this.deployKeys,
      paths: this.paths,
      vaults: this.vaults,
      secrets: this.deploySecrets,
      findRepo: (n) => this.findRepo(n),
      send: (type, payload) => void this.client.send(type as never, payload as never),
      log: this.log,
      ...(opts.deployTiming ? { timing: opts.deployTiming } : {}),
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
      this.serverFeatures = new Set(w.features ?? []);
      this.reportCapabilities();
      void this.reportGit(true);
      void this.reportIntegrations(true);
      void this.reportOrgFolders();
      this.reportMcpServers(true);
      this.reportToolchains(true);
      this.reportUpdate();
      this.runs.reportAll();
      opts.onConnected?.();
      opts.onRunnerPin?.(w.runnerPin?.version ?? null);
      this.applyShiftLimit(w.limits.shiftLimit, w.limits.maxConcurrentShifts);
      this.writeStatus(true);
      this.scheduleStartupSweep();
      void this.roleSmokeOnce();
    });
    this.client.on('disconnected', () => {
      this.writeStatus(false);
      // A CEO owner or order turn keeps running: its reply goes through the durable outbox and arrives on reconnect.
      void this.chat.cancelAll('workstation offline: the connection to the server dropped', {
        keepFullPower: true,
      });
    });
    this.client.on('fatal', (code, why) => {
      this.unpaired = why === UNPAIRED_MESSAGE;
      if (this.unpaired) this.log.warn(`stopping: ${why}`);
      else this.log.error(`connection closed for good (${code}): ${why}`);
      // Unpaired is a normal end (exit 0, so a service manager does not restart a runner that cannot work).
      this.fatalResolve?.(this.unpaired ? 0 : code === 4409 ? 3 : 2);
    });
  }

  /** What the integration adapters need from this machine. */
  private adapterEnv(): AdapterEnv {
    const claude = () => {
      const a = this.adapters.get('claude-code');
      return a instanceof ClaudeCodeAdapter ? a : undefined;
    };
    return {
      paths: this.paths,
      forge: this.forgeEnv,
      exec: this.exec,
      fetch: globalThis.fetch,
      log: this.log,
      config: () => this.freshConfig(),
      now: () => new Date(),
      home: homedir(),
      claudeStore: this.claudeStore,
      claude: {
        bin: () => this.freshConfig().runtimes['claude-code'].bin,
        blocked: () => realClaudeBlocked(),
        probe: async (env) =>
          realClaudeBlocked()
            ? 'unknown'
            : probeClaudeLogin({ bin: this.freshConfig().runtimes['claude-code'].bin, env }),
        probeLogin: async (key) => (await claude()?.probeLogin(key)) ?? 'unknown',
        authState: (key) => this.claudeAccounts.get(key ?? 'main')?.auth.state ?? 'ok',
        afterChange: async (key) => {
          await claude()?.probeLogin(key);
          await this.reportRuntimes();
        },
      },
      claudeAccounts: this.claudeAccounts,
      loginRuntimes: {
        codex: {
          registry: this.codexAccounts,
          bin: () =>
            this.adapters.has('codex')
              ? detectCodex(this.freshConfig().runtimes.codex, { blocked: realClaudeBlocked() })
              : undefined,
          afterChange: () => this.reportRuntimes(),
        },
        gemini: {
          registry: this.geminiAccounts,
          bin: () =>
            this.adapters.has('gemini')
              ? detectGemini(this.freshConfig().runtimes.gemini, { blocked: realClaudeBlocked() })
              : undefined,
          afterChange: () => this.reportRuntimes(),
        },
      },
      mcp: {
        discover: () => (this.opts.mcpDiscover ?? (() => discoverPluginMcpServers()))(),
        authOf: () => (this.opts.mcpAuth ?? mcpAuthStates)(),
      },
      repoHosts: () => this.repoHosts(),
      sessionCwd: join(this.paths.root, 'tmp', 'integrations'),
      touchRecheck: () => touchRecheck(this.paths.secrets),
    };
  }

  /** Hosts of the GitHub and GitLab repositories on this workstation (instances of those integrations). */
  private repoHosts(): Partial<Record<'github' | 'gitlab', string[]>> {
    const hosts: Partial<Record<'github' | 'gitlab', string[]>> = {};
    for (const r of this.repos) {
      const p = forgeForUrl(this.forgeEnv, r.remoteUrl);
      if (p && (p.repo.kind === 'github' || p.repo.kind === 'gitlab')) {
        const list = hosts[p.repo.kind] ?? [];
        if (!list.includes(p.repo.host)) list.push(p.repo.host);
        hosts[p.repo.kind] = list;
      }
    }
    return hosts;
  }

  private integrationsOn(): boolean {
    return this.opts.integrationsReport ?? !(this.opts.config.runtimes.mock?.enabled || process.env.VITEST);
  }

  /** `integrations.report` when something changed (or forced). Quiet under tests and the mock runtime. */
  private async reportIntegrations(force: boolean): Promise<void> {
    if (!this.integrationsOn()) return;
    try {
      await this.integrations.report(force);
    } catch (err) {
      this.log.warn(`integrations report failed: ${String(err)}`);
    }
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
  /**
   * The shift limit in force (backlog #76). A choice of the owner (`shiftLimit` a number or `unlimited`) replaces the
   * configured value, takes effect at once and is saved for restarts. No choice (null), or an older server that sends
   * none (undefined), leaves `config.json`'s `maxConcurrentShifts` as the ceiling, under what the server allows.
   */
  private applyShiftLimit(shiftLimit: ShiftLimitSetting | undefined, serverMax: number): void {
    if (shiftLimit === undefined || shiftLimit === null) {
      if (shiftLimit === null) clearServerLimit(this.serverLimitFile);
      this.maxConcurrent = Math.min(serverMax, this.freshConfig().maxConcurrentShifts);
    } else {
      try {
        saveServerLimit(this.serverLimitFile, { shiftLimit, maxConcurrentShifts: serverMax });
      } catch (err) {
        this.log.warn(`could not save the shift limit: ${String(err)}`);
      }
      this.maxConcurrent = serverMax;
    }
  }

  /** The most shifts this runner may run now (the machine-wide budget of several pairings is read from it). */
  shiftLimit(): number {
    return this.maxConcurrent;
  }

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
    return this.supervisor.size === 0 && this.chat.size === 0 && this.deployExec.inFlight() === 0;
  }

  /** Tells the server how this runner's self-update stands (best effort: dropped while offline, resent on welcome). */
  reportUpdate(): void {
    const u = this.opts.updateStatus?.();
    if (u) this.client.send('runner.update', u);
  }

  /** An error of the runner itself, sanitised, to the server (`runner.error`). Acked: kept in the outbox until delivered. */
  reportRunnerError(payload: import('./health/runner-error.ts').RunnerErrorPayload): void {
    this.client.send('runner.error', { ...payload });
  }

  private smokeStarted = false;
  /** What the server announced in its last `welcome` (`features`). */
  private serverFeatures = new Set<string>();
  private readonly capabilities: CapabilityRegistry;
  private readonly packs: PackManager;

  /** Re-reads the organization vault's capabilities after a sync of that vault and reports them when they changed. */
  private indexCapabilities(vaultId: string): void {
    const v = this.vaults.vault(vaultId);
    if (!v || v.kind !== 'org' || v.projectId || v.storage === 'local') return;
    // no clone yet: nothing to index (an empty report would wipe what the server knows)
    if (!existsSync(join(this.vaults.dir(vaultId), '.git'))) return;
    const r = this.capabilities.index(vaultId, this.vaults.dir(vaultId));
    if (r.changed) this.reportCapabilities();
  }

  /** `capabilities.report`: metadata of the organization vault's capabilities, only to a server that announced the feature. */
  private reportCapabilities(): void {
    if (!this.serverFeatures.has(CAPABILITY_REGISTRY_FEATURE)) return;
    const last = this.capabilities.last();
    if (!last) return;
    this.client.send('capabilities.report', {
      vaultId: last.vaultId,
      items: last.items,
      issues: last.issues.slice(0, 100),
    });
  }

  /**
   * The role smoke test, once per process (so on every runner start, which includes the start after an update): each
   * role goes down its own handoff path with no call to Claude and the result goes to the server, which keeps a failed
   * role from being offered work here.
   */
  private async roleSmokeOnce(): Promise<void> {
    if (this.smokeStarted) return;
    if (!(this.opts.roleSmoke ?? !(this.opts.config.runtimes.mock?.enabled || process.env.VITEST))) return;
    this.smokeStarted = true;
    try {
      const results = await runRoleSmoke({
        paths: this.paths,
        ipc: this.ipc,
        ...(this.opts.roleSmokeRoles ? { roles: this.opts.roleSmokeRoles } : {}),
        ...(this.opts.roleSmokeAom ? { aom: this.opts.roleSmokeAom } : {}),
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0)
        this.log.warn(
          `role smoke test failed for ${failed.map((f) => `${f.roleKey} (${f.detail ?? 'failed'})`).join('; ')}`,
        );
      else this.log.info(`role smoke test passed for ${results.length} role(s)`);
      this.client.send('role.smoke', { runnerVersion: RUNNER_VERSION, results });
    } catch (err) {
      this.smokeStarted = false; // try again at the next welcome
      this.log.warn(`role smoke test could not run: ${String(err)}`);
    }
  }

  async start(): Promise<void> {
    await writeShims(this.paths.bin);
    await this.ipc.start();
    await this.ipc.startSocket().catch((err) => this.log.warn(`IPC socket unavailable: ${String(err)}`));
    await this.scan();
    // Backlog #81: temp content left by earlier shifts (and a crashed runner) goes before anything runs.
    await sweepAgentTmps(this.paths, this.supervisor.persistedAgentIds())
      .then((r) => {
        if (r.removed)
          this.log.info(`temp sweep: removed ${r.removed} entries of ${r.agents} agent temp dir(s)`);
      })
      .catch((err) => this.log.warn(`temp sweep failed: ${String(err)}`));
    this.startScratchSweeps();
    this.supervisor.resumePersisted();
    await this.runs
      .adopt()
      .catch((err) => this.log.warn(`could not re-adopt run environments: ${String(err)}`));
    this.runs.start();
    this.vaults.start();
    // what the organization vault clone already holds is known before the first sync of this process finishes
    for (const id of this.vaults.configured()) this.indexCapabilities(id);
    this.client.start();
    this.sync.start(this.opts.syncIntervalMs);
    const t = setInterval(() => void this.rescan(), this.opts.rescanMs ?? 600_000);
    t.unref();
    this.timers.push(t);
    // Every minute: the sign-in state of the plugin MCP servers, and (while the Claude login is expired) the login probe.
    const m = setInterval(() => {
      this.reportMcpServers(false);
      void this.probeAccountLogins();
      void this.probeAuth();
      void this.probeUsage();
      // a login made in a terminal or a limit that has reset: the registries notice and report it
      this.codexAccounts.poll();
      this.geminiAccounts.poll();
    }, this.opts.minuteMs ?? 60_000);
    m.unref();
    this.timers.push(m);
    // `aom-runner git-connect` touches a marker file: report the new git status without waiting for the rescan.
    const g = setInterval(() => {
      try {
        const m = statSync(recheckFile(this.paths.secrets)).mtimeMs;
        if (m > this.lastRecheck) {
          this.lastRecheck = m;
          void this.reportGit(false);
          void this.reportIntegrations(false);
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
    this.integrations.stop();
    this.sync.stop();
    this.vaults.stop();
    // Run environments keep running (they are re-adopted by the next process); only the bookkeeping ends.
    this.runs.shutdown();
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
        ...(c.auth ? { auth: c.auth } : {}),
        ...(c.usage ? { usage: c.usage } : {}),
        ...(c.limitedUntil ? { limitedUntil: c.limitedUntil } : {}),
        ...(c.limitedLabel ? { limitedLabel: c.limitedLabel } : {}),
        ...(c.accounts ? { accounts: c.accounts } : {}),
        ...(c.providers ? { providers: c.providers } : {}),
        ...(c.keys ? { keys: c.keys } : {}),
        ...(c.privateEndpoints ? { privateEndpoints: c.privateEndpoints } : {}),
        ...(c.backends ? { backends: c.backends } : {}),
        ...(c.models ? { models: c.models } : {}),
        ...(c.authVia ? { authVia: c.authVia } : {}),
      });
    }
    return out;
  }

  /** Sends `runtimes.report` when what the runtimes report (availability, sandbox, login) changed since the last one. */
  private async reportRuntimes(): Promise<void> {
    const runtimes = await this.runtimeInfos();
    const key = JSON.stringify(runtimes);
    const changed = this.lastRuntimes !== undefined && key !== this.lastRuntimes;
    this.lastRuntimes = key;
    if (changed) {
      this.client.send('runtimes.report', { runtimes });
      void this.reportIntegrations(false);
    }
  }

  /**
   * A credentials file of an account changed (someone signed in from a terminal: `claude-work`, then `/login`) while the
   * account was `none` or `expired`: probe it at once, so work resumes within a minute instead of after the next 3-minute probe.
   */
  private async probeAccountLogins(): Promise<void> {
    const a = this.adapters.get('claude-code');
    if (!(a instanceof ClaudeCodeAdapter)) return;
    for (const account of this.claudeAccounts.poll()) {
      this.lastAuthProbe.set(account.key, Date.now());
      await a.probeLogin(account.key);
    }
  }

  /**
   * While an account's Claude login is expired: every 3 minutes a cheap probe (`claude auth status`, then one minimal call)
   * in that account's own environment; when it works the account is reported usable again and the server resumes
   * dispatching to it and clears its notice. Accounts are probed independently.
   */
  private async probeAuth(): Promise<void> {
    const a = this.adapters.get('claude-code');
    if (!(a instanceof ClaudeCodeAdapter)) return;
    for (const account of this.claudeAccounts.list()) {
      if (account.auth.state !== 'expired') continue;
      const last = this.lastAuthProbe.get(account.key) ?? 0;
      if (Date.now() - last < (this.opts.authProbeMs ?? 180_000)) continue;
      this.lastAuthProbe.set(account.key, Date.now());
      await a.probeLogin(account.key);
    }
  }

  /**
   * While an account's usage limit is in force: once its reset time has passed, a cheap probe (one minimal call) in that
   * account's environment; when it works the account is usable again and the server resumes dispatching to it; when the
   * limit is still there the new reset time extends the pause. A probe that could not tell is retried after 3 minutes.
   */
  private async probeUsage(): Promise<void> {
    const a = this.adapters.get('claude-code');
    if (!(a instanceof ClaudeCodeAdapter)) return;
    for (const account of this.claudeAccounts.list()) {
      const until = account.usage.limitedUntilMs;
      if (account.usage.state !== 'limited' || until === undefined || Date.now() < until) continue;
      const last = this.lastUsageProbe.get(account.key) ?? 0;
      // the first probe after a (new) reset time is never throttled; only a retry after "could not tell" waits
      if (last >= until && Date.now() - last < (this.opts.usageProbeMs ?? 180_000)) continue;
      this.lastUsageProbe.set(account.key, Date.now());
      await a.probeUsage(account.key);
    }
  }

  /**
   * "Make main" (`provider.account.promote`): a named account and the main account swap places. A login scope swaps the login
   * folders in this pairing's config; a key scope opens both sealed keys and seals them again under their new names with this
   * runner's own key. Claude Code swaps the model login of `~/.claude` and a named folder account (token accounts and a token
   * or key as main cannot be swapped).
   */
  private promoteLogFile(): string {
    return join(this.paths.root, 'promote-applied.json');
  }

  /** The answers to the "Make main" commands already applied here, by command nonce (the last 50). */
  private promoteLog(): Record<string, ProviderAccountPromoteResult> {
    try {
      const j = JSON.parse(readFileSync(this.promoteLogFile(), 'utf8')) as unknown;
      return j && typeof j === 'object' ? (j as Record<string, ProviderAccountPromoteResult>) : {};
    } catch {
      return {};
    }
  }

  /**
   * One "Make main" per command nonce: a command delivered twice (a lost answer, a reconnect) gets its first answer back and does
   * not swap the accounts again. The answer is remembered before it is reported.
   */
  private async promoteOnce(
    scope: string,
    key: string,
    nonce: string | undefined,
  ): Promise<ProviderAccountPromoteResult> {
    const id = nonce ? `${scope}/${key}/${nonce}` : undefined;
    const log = this.promoteLog();
    if (id && Object.hasOwn(log, id)) return log[id] as ProviderAccountPromoteResult;
    const r = await this.promoteAccount(scope, key);
    if (id) {
      const entries = Object.entries({ ...log, [id]: r }).slice(-50);
      try {
        mkdirSync(this.paths.root, { recursive: true });
        const tmp = `${this.promoteLogFile()}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
        renameSync(tmp, this.promoteLogFile());
      } catch (err) {
        this.log.warn(`could not remember the Make main answer: ${err instanceof Error ? err.message : err}`);
      }
    }
    return r;
  }

  private async promoteAccount(scope: string, key: string): Promise<ProviderAccountPromoteResult> {
    if (scope === 'codex' || scope === 'gemini') {
      const reg = scope === 'codex' ? this.codexAccounts : this.geminiAccounts;
      if (!reg.get(key) || key === 'main')
        return { ok: false, error: `there is no account ${key} on this workstation` };
      const r = swapMainLoginAccount(this.paths.config, reg.def, key, homedir(), reg.main.folder);
      reg.refresh();
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    if (isKeyScope(scope)) return this.providers.promote(scope, key);
    if (scope === 'claude-code')
      return swapClaudeMain(key, {
        home: homedir(),
        root: this.paths.root,
        registry: this.claudeAccounts,
        machineScopeAllowed:
          this.freshConfig().integrations.machineScopeFromWeb === 'primary' &&
          (this.opts.isPrimaryPairing?.() ?? true),
        busy: () => this.supervisor.size > 0 || this.chat.size > 0,
        mainAuthMode: () => this.claudeAccounts.main.credential().authMode,
      });
    return { ok: false, error: `no accounts for ${scope}` };
  }

  /** The instructions note for granted plugin MCP servers that are not signed in on this workstation. */
  private mcpSignInNote(granted: readonly string[] | undefined): string {
    if (!granted?.length) return '';
    try {
      const servers = (this.opts.mcpDiscover ?? (() => discoverPluginMcpServers()))();
      return mcpSignInNote(servers, granted, (this.opts.mcpAuth ?? mcpAuthStates)(), hostname());
    } catch {
      return '';
    }
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
      activeChats: this.chat.activeIds(),
      maxConcurrentShifts: this.opts.config.maxConcurrentShifts,
      sudoKey: this.keys.publicKey,
      // Run a branch needs process groups and /proc or ps: not on native Windows. Test environments for cards (`runs:3`) are
      // for real testers: the mock runtime (CI, demos) runs no tests, so its cards keep the plain test step.
      capabilities: [
        ...(platform() === 'win32'
          ? []
          : this.opts.config.runtimes.mock?.enabled
            ? ['runs:1', 'runs:2']
            : ['runs:1', 'runs:2', 'runs:3']),
        'ceo:1',
        SHIFT_LIMIT_CAPABILITY,
        READONLY_DESIGN_CAPABILITY,
        RUNNER_PIN_CAPABILITY,
        RUNNER_UPDATE_CHECK_CAPABILITY,
        DELIVERY_CAPABILITY,
        // Guided deploy setup: `deploy.probe` and `recipe.write` (docs/design/deploy-run-ux-design.md section 6)
        DEPLOY_SETUP_CAPABILITY,
        // Finds stacks from container labels and home folders, reports where it looked, new update methods, key forget on remove
        DEPLOY_SETUP_V2_CAPABILITY,
        // Apps that run directly on the machine (systemd, pm2, a command): probe and release scripts
        DEPLOY_DIRECT_CAPABILITY,
        // Guided connect, dedicated deploy keys and server preparation (design v2)
        ...(platform() === 'win32'
          ? []
          : [DEPLOY_CONNECT_CAPABILITY, DEPLOY_MOVE_CAPABILITY, SEAL_AAD_CAPABILITY]),
        // "Scan with DevOps": `aom setup propose` and a read-only scan brief (docs/design/deploy-run-ux-design.md section 5).
        SETUP_SCAN_CAPABILITY,
        LOCAL_VAULT_CAPABILITY,
        CLAUDE_ACCOUNTS_CAPABILITY,
        // Named accounts of Codex, the Gemini CLI and the provider keys; "Make main" (`provider.account.promote`).
        PROVIDER_ACCOUNTS_CAPABILITY,
        // Asks the server before it hands a pack script to an agent that is gated on pack scripts (`pack.script.gate`).
        PACK_SCRIPT_GATE_CAPABILITY,
        // "Make main" for Claude Code: a named folder account and the main login swap places.
        CLAUDE_MAIN_SWAP_CAPABILITY,
        // A chat about a project's card runs on the account the project chose (`chat.start.account`).
        CHAT_ACCOUNTS_CAPABILITY,
        // Runs the turns of discovery and boardroom sessions (`chat.start.session`) and indexes the capability registry.
        SESSION_TURNS_CAPABILITY,
        // A session turn may call the `aom session ...` verbs (the facilitator's questions, notes, proposals and drafts).
        SESSION_VERBS_CAPABILITY,
        // A boardroom turn may call the `aom board ...` verbs (whiteboard notes, the Chair's speaker choice, the minutes).
        BOARD_VERBS_CAPABILITY,
        // The direct-model runtime (Vercel AI SDK, provider keys kept here): session turns and chats on OpenAI, Gemini, Anthropic's API or an OpenAI-compatible endpoint.
        DIRECT_MODEL_CAPABILITY,
        // An organization key beside the workstation's own, Claude Code backends (Bedrock, Vertex, gateways) and re-sealing the organization key.
        PROVIDER_KEYS_CAPABILITY,
        // Provider and backend credentials bound to their purpose (`h2` with associated data), organization key generations,
        // and re-sealing only on an approval made in the admin's browser.
        PROVIDER_KEYS_BOUND_CAPABILITY,
        // The workstation owner's private-endpoint allow-list (`provider.endpoints.set`).
        PRIVATE_ENDPOINTS_CAPABILITY,
        // Capability packs: git import pinned to a commit, hash-checked before use (`packs.sync`, `pack.check`, `packs.report`).
        PACKS_CAPABILITY,
        // Authored and private packs, deploy keys and tokens for private git packs, member opt-in, reads for the editor and for hiring.
        PACK_AUTHORING_CAPABILITY,
        // A pack's deploy key or token is opened only bound to the pack and the host of its git URL, and used for no other host.
        PACK_CREDENTIALS_BOUND_CAPABILITY,
        // The local opt-in (`aom-runner ceo full-power on`), read fresh: the server shows "Full power is off" without it.
        ...(this.freshConfig().ceo.fullPower ? [CEO_FULL_POWER_CAPABILITY] : []),
      ],
      maxRunEnvironments: this.freshConfig().maxRunEnvironments,
      integrationsVersion: INTEGRATIONS_VERSION,
    };
  }

  private async rescan(): Promise<void> {
    await this.scan();
    this.client.send('repos.report', { repos: this.repos, repoCatalog: this.repoCatalog() });
    // A re-probe may change a runtime (bubblewrap installed, claude upgraded): tell the server when it did.
    await this.reportRuntimes();
    await this.reportGit(false);
    await this.reportIntegrations(false);
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
      const report = reportOf(
        (this.opts.mcpDiscover ?? (() => discoverPluginMcpServers()))(),
        (this.opts.mcpAuth ?? mcpAuthStates)(),
      );
      const key = JSON.stringify(report);
      if (!force && key === this.lastMcp) return;
      this.lastMcp = key;
      this.client.send('mcp.servers', { servers: report });
      void this.reportIntegrations(false);
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

  /**
   * Disk retention: prunes the agents' scratch folders now (not those of agents about to resume) and then every
   * `scratch.sweepIntervalHours` together with the stale-worktree sweep. An agent with a shift or chat running is skipped.
   */
  private startScratchSweeps(): void {
    const sweepScratch = (skip: string[] = []) =>
      sweepAgentScratch(this.paths, this.freshConfig().scratch, {
        skipAgentIds: skip,
        log: (m) => this.log.info(m),
      })
        .then((r) => {
          if (r.pruned)
            this.log.info(`scratch sweep: removed ${r.pruned} entries (${Math.round(r.bytes / 1048576)} MB)`);
        })
        .catch((err) => this.log.warn(`scratch sweep failed: ${String(err)}`));
    void sweepScratch(this.supervisor.persistedAgentIds());
    const hours = this.freshConfig().scratch.sweepIntervalHours;
    const t = setInterval(
      () => {
        void sweepScratch(this.supervisor.persistedAgentIds());
        void this.sweepWorktrees()
          .then((r) => {
            if (r.removed.length || r.dirty.length || r.emptyDirsRemoved.length)
              this.log.info(`worktree sweep: ${JSON.stringify(r)}`);
          })
          .catch((err) => this.log.warn(`worktree sweep failed: ${String(err)}`));
      },
      Math.max(1000, this.opts.scratchSweepMs ?? hours * 3_600_000),
    );
    t.unref();
    this.timers.push(t);
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
      busyPaths: [
        ...this.supervisor.worktreePaths(),
        ...this.runs.worktreeDirs(),
        ...this.chat.worktreePaths(),
      ],
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

  /**
   * `hygiene.change_state` (repository hygiene): is the pull request still open, merged or declined? Asked of the
   * card's git host with this workstation's login; `null` when the host cannot tell (plain git, no login, no network).
   */
  private async changeState(params: Record<string, unknown>): Promise<IpcRpcResponse> {
    const remoteUrl = typeof params.remoteUrl === 'string' ? params.remoteUrl : '';
    const prUrl = typeof params.prUrl === 'string' ? params.prUrl : '';
    // The id every adapter takes is the trailing number of the pull request link (pull/660, merge_requests/12, ...).
    const id = /(\d+)\/?(?:[?#].*)?$/.exec(prUrl)?.[1];
    const hit = remoteUrl && id ? forgeForUrl(this.forgeEnv, remoteUrl) : null;
    if (!hit || !id || !hit.forge.changeState) return { ok: true, result: { state: null } };
    try {
      return { ok: true, result: { state: await hit.forge.changeState(hit.repo, id) } };
    } catch {
      return { ok: true, result: { state: null } };
    }
  }

  /** R3c: the frames of a session turn carry the id of the dispatch they answer, so the server can tell a late one from the current. */
  private withAttempt<T extends object>(type: string, payload: T): T {
    if (type !== 'chat.delta' && type !== 'chat.activity' && type !== 'chat.done' && type !== 'chat.error')
      return payload;
    const id = (payload as { chatId?: string }).chatId;
    const attemptId = id ? this.chat.attemptOf(id) : undefined;
    return attemptId ? { ...payload, attemptId } : payload;
  }

  private rpc(
    shiftId: string,
    method: string,
    params: Record<string, unknown>,
    attemptId?: string,
  ): Promise<IpcRpcResponse> {
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
      this.client.send('rpc.request', {
        rpcId,
        shiftId,
        method,
        params,
        ...(attemptId ? { attemptId } : {}),
      });
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
      case 'shift.kill_tools':
        void this.supervisor.killTools(msg.shiftId);
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
      case 'run.follow':
        this.runs.follow(msg.envId, msg.follow);
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
      } else if (command === 'runner.pin') {
        // Safe mode: the platform team pinned (or unpinned) this workstation's runner version.
        const p = CommandPayloadSchemas['runner.pin'].parse(payload);
        this.opts.onRunnerPin?.(p.version);
        done(true, { version: p.version });
      } else if (command === 'runner.update.check') {
        // "Check for updates": the answer is ok:true whatever the outcome (up to date, found, paused, disabled, failed).
        CommandPayloadSchemas['runner.update.check'].parse(payload);
        done(
          true,
          (await this.opts.onUpdateCheck?.()) ?? {
            outcome: 'disabled',
            version: null,
            detail: 'this runner has no updater',
          },
        );
      } else if (command === 'provider.account.promote') {
        // "Make main": the named account and the main account swap places (login folders, or the two sealed keys)
        const p = CommandPayloadSchemas['provider.account.promote'].parse(payload);
        const r = await this.promoteOnce(p.scope, p.key, p.nonce);
        this.log.info(`provider account ${p.scope}/${p.key}: make main ${r.ok ? 'done' : 'refused'}`);
        void this.reportRuntimes();
        done(true, r);
      } else if (command === 'claude.account.ensure') {
        // Provision an additional Claude account (folder, config entry, alias); an unexpected error is ok:false only.
        const p = CommandPayloadSchemas['claude.account.ensure'].parse(payload);
        const claude = this.adapters.get('claude-code');
        this.log.info(`claude account ${p.key}: provisioning requested`);
        const answer = await ensureClaudeAccount(p, {
          home: homedir(),
          root: this.paths.root,
          configPath: this.paths.config,
          machineScopeAllowed:
            this.freshConfig().integrations.machineScopeFromWeb === 'primary' &&
            (this.opts.isPrimaryPairing?.() ?? true),
          registry: this.claudeAccounts,
          probeLogin: async (key) =>
            claude instanceof ClaudeCodeAdapter ? await claude.probeLogin(key) : 'unknown',
          afterRegister: () => this.reportRuntimes(),
        });
        this.log.info(`claude account ${p.key}: provisioning ${answer.state}`, {
          configDir: answer.configDir,
          aliasAdded: answer.aliasAdded,
          aliasExisting: answer.aliasExisting !== undefined,
          aliasConflict: answer.aliasConflict === true,
          ...(answer.detail ? { detail: answer.detail.slice(0, 200) } : {}),
        });
        done(true, answer);
      } else if (command === 'shifts.limit') {
        // The owner changed the limit on the Workstations page: it applies to the next shift offered, no restart.
        const p = CommandPayloadSchemas['shifts.limit'].parse(payload);
        this.applyShiftLimit(p.shiftLimit, p.maxConcurrentShifts);
        done(true, { maxConcurrentShifts: this.maxConcurrent });
      } else if (command === 'worktrees.sweep') {
        // The hygiene job's sweep: the result is an answer (ok:true) even when nothing could be swept.
        CommandPayloadSchemas['worktrees.sweep'].parse(payload);
        done(true, await this.sweepWorktrees());
      } else if (command === 'repo.sync') {
        // "Sync now": the answer is the branch's state (ok:true) even when it could not be moved.
        const p = CommandPayloadSchemas['repo.sync'].parse(payload);
        const r = await this.sync.sync({
          repoId: p.repoId,
          remoteUrlNormalized: p.remoteUrlNormalized,
          workingBranch: p.workingBranch,
        });
        done(true, {
          repoId: r.repoId,
          workingBranch: r.workingBranch,
          state: r.state,
          ahead: r.ahead,
          behind: r.behind,
          dirty: r.dirty,
          onBranch: r.onBranch,
          checkedOutBranch: r.checkedOutBranch,
          ...(r.detail ? { detail: r.detail.slice(0, 400) } : {}),
          checkedAt: r.checkedAt,
        });
      } else if (command === 'run.start') {
        // A refusal (cap, no clone, unknown branch) is an answer: the server ends the environment as failed.
        done(true, await this.runs.startEnv(CommandPayloadSchemas['run.start'].parse(payload)));
      } else if (command === 'run.stop') {
        await this.runs.stop(CommandPayloadSchemas['run.stop'].parse(payload));
        done(true, { stopped: true });
      } else if (command === 'run.restart') {
        // A refusal (no plan, rewritten branch, worktrees gone) is an answer, shown to the person who pressed the button.
        done(true, await this.runs.restart(CommandPayloadSchemas['run.restart'].parse(payload)));
      } else if (command === 'run.extend') {
        this.runs.extend(CommandPayloadSchemas['run.extend'].parse(payload));
        done(true, { extended: true });
      } else if (command === 'repos.rescan') {
        await this.rescan();
        done(true, { repos: this.repos.length });
      } else if (command === 'graph.org') {
        done(true, await this.graph.buildOrg(CommandPayloadSchemas['graph.org'].parse(payload)));
      } else if (command === 'graph.index' || command === 'graph.update') {
        // A repository that cannot be indexed is an answer (ok:true, result.ok:false with a fixed reason code).
        const p = CommandPayloadSchemas[command].parse(payload);
        done(true, await (command === 'graph.update' ? this.graph.update(p) : this.graph.index(p)));
      } else if (command === 'recipe.inspect') {
        // What `delivery/` of the project vault holds, with its hash; a failure is an answer (ok:true, result.ok:false).
        done(true, await this.delivery.inspect(CommandPayloadSchemas['recipe.inspect'].parse(payload)));
      } else if (command === 'recipe.write') {
        // Writes the generated delivery/ files into the project vault; a refusal is an answer (ok:true, result.ok:false).
        done(true, await this.delivery.write(CommandPayloadSchemas['recipe.write'].parse(payload)));
      } else if (command === 'deploy.probe') {
        // Read-only questions to Docker / a server; a failure is an answer, never an exception.
        done(
          true,
          await runDeployProbe(CommandPayloadSchemas['deploy.probe'].parse(payload), {
            keys: this.deployKeys,
          }),
        );
      } else if (command === 'deploy.hostkey') {
        // What fingerprint does the server show? Nothing is trusted or written by this.
        done(
          true,
          await this.deployConnector.hostKeyScan(CommandPayloadSchemas['deploy.hostkey'].parse(payload)),
        );
      } else if (command === 'deploy.key') {
        // This computer's dedicated key for a server: public key and fingerprint out, the private key stays here.
        done(true, await this.deployConnector.createKey(CommandPayloadSchemas['deploy.key'].parse(payload)));
      } else if (command === 'deploy.connect') {
        // A password or key file is sealed to this runner, used once in memory, never stored. A failure is an answer.
        done(
          true,
          await this.deployConnector.connect(CommandPayloadSchemas['deploy.connect'].parse(payload)),
        );
      } else if (command === 'deploy.revoke') {
        done(true, await this.deployConnector.revoke(CommandPayloadSchemas['deploy.revoke'].parse(payload)));
      } else if (command === 'deploy.prepare') {
        done(true, await this.deployPreparer.run(CommandPayloadSchemas['deploy.prepare'].parse(payload)));
      } else if (command === 'deploy.move') {
        // One step of moving an app to a new server; a refusal or a failure is an answer, never an exception.
        done(true, await this.deployMover.run(CommandPayloadSchemas['deploy.move'].parse(payload)));
      } else if (command === 'deploy.exec') {
        // Runs an approved deploy outside any model. A refusal or a failed deploy is an ANSWER: the server never retries it.
        done(true, await this.deployExec.run(CommandPayloadSchemas['deploy.exec'].parse(payload)));
      } else if (command === 'deploy.secret.set') {
        // Ciphertext in, a fact out: the value is never in an answer, a log line or an event.
        done(true, this.deploySecrets.setFor(CommandPayloadSchemas['deploy.secret.set'].parse(payload)));
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
          const completion = await executeCompletion({
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
          });
          done(true, completion);
          // The working branch on origin may have moved (a merge, or a pull request merged since): bring the local one along.
          if (completion.ok && (p.action === 'pr' || p.action === 'merge'))
            void this.sync.sync({
              repoId: p.repoId,
              remoteUrlNormalized: p.remoteUrlNormalized,
              workingBranch: p.baseBranch,
            });
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
      } else if (
        command === 'integration.connect' ||
        command === 'integration.begin' ||
        command === 'integration.input' ||
        command === 'integration.cancel' ||
        command === 'integration.test' ||
        command === 'integration.remove'
      ) {
        // Refusals (web turned off, wrong envelope, machine-wide login) are answers: ok:true with a sentence, never a retry.
        done(true, await this.integrations.handle(command, payload));
      } else if (command === 'sudo.clear') {
        this.sudo.clear();
        done(true, { cleared: true });
      } else if (command === 'env.secret.set') {
        // Ciphertext in, a fact out: the value is never in an answer, a log line or an event.
        done(true, this.targetSecrets.set(CommandPayloadSchemas['env.secret.set'].parse(payload)));
      } else if (command === 'packs.sync') {
        // Clone/fetch, pin, index and enforce the packs the server wants here; the answers are `packs.report` messages.
        const sync = CommandPayloadSchemas['packs.sync'].parse(payload);
        // The owner's blocked project-repository capabilities (additive: an older server sends none).
        this.capabilities.setBlocked(sync.blocked);
        // R3c (Q52): an unreviewed or changed project-repository capability is unusable (additive: an older server sends none).
        this.capabilities.setReviewed(sync.reviewed);
        await this.packs.sync(sync.packs);
        done(true, { packs: this.packs.summary().length });
      } else if (command === 'pack.check') {
        const p = CommandPayloadSchemas['pack.check'].parse(payload);
        await this.packs.check(p.packId, p.ref);
        done(true, {});
      } else if (command === 'pack.credential.set') {
        // Ciphertext in, a fact out: the deploy key or token is never in an answer, a log line or an event.
        const p = CommandPayloadSchemas['pack.credential.set'].parse(payload);
        done(true, await this.packCredentials.set(p));
      } else if (command === 'pack.credential.clear') {
        this.packCredentials.clear(CommandPayloadSchemas['pack.credential.clear'].parse(payload).packId);
        done(true, { cleared: true });
      } else if (command === 'pack.author.save') {
        done(
          true,
          await this.packs.saveAuthoredFiles(CommandPayloadSchemas['pack.author.save'].parse(payload)),
        );
      } else if (command === 'pack.read') {
        done(true, await this.packs.readFiles(CommandPayloadSchemas['pack.read'].parse(payload)));
      } else if (command === 'pack.persona.read') {
        const p = CommandPayloadSchemas['pack.persona.read'].parse(payload);
        done(true, this.packs.readPersona(p.packId, p.key));
      } else if (command === 'pack.bundle.request') {
        done(
          true,
          await this.packs.bundleRequest(CommandPayloadSchemas['pack.bundle.request'].parse(payload)),
        );
      } else if (command === 'pack.bundle.put') {
        done(true, await this.packs.bundlePut(CommandPayloadSchemas['pack.bundle.put'].parse(payload)));
      } else if (command === 'provider.key.set') {
        // Ciphertext in, a fact out (like env.secret.set): the key is never in an answer, a log line or an event.
        const r = this.providers.set(CommandPayloadSchemas['provider.key.set'].parse(payload));
        void this.reportRuntimes();
        done(true, r);
      } else if (command === 'provider.key.clear') {
        this.providers.clearPayload(CommandPayloadSchemas['provider.key.clear'].parse(payload));
        void this.reportRuntimes();
        done(true, { cleared: true });
      } else if (command === 'provider.endpoints.set') {
        // Exact host:port entries of private endpoints this workstation may reach (not secret); reported back with the runtimes.
        const r = this.providers.setEndpoints(
          CommandPayloadSchemas['provider.endpoints.set'].parse(payload).endpoints,
        );
        void this.reportRuntimes();
        done(true, r);
      } else if (command === 'provider.key.reseal') {
        // An Owner or Admin approved sharing the organization key with another workstation: seal it to that runner's key. The
        // answer carries the ciphertext for the server to relay; the plain key never leaves this function.
        const p = CommandPayloadSchemas['provider.key.reseal'].parse(payload);
        const r = await this.providers.reseal({
          provider: p.provider,
          orgId: p.orgId,
          targetKeyId: p.targetKeyId,
          targetPublicKey: p.targetPublicKey,
          ...(p.approval ? { approval: p.approval } : {}),
          ...(p.generation ? { generation: p.generation } : {}),
        });
        done(r.ok, r, r.ok ? undefined : r.error);
      } else if (command === 'env.secret.clear') {
        const p = CommandPayloadSchemas['env.secret.clear'].parse(payload);
        this.targetSecrets.clear(p.targetId, p.name);
        done(true, { cleared: true });
      } else {
        done(false, undefined, `command ${command} is not supported by this runner version`);
      }
    } catch (err) {
      done(false, undefined, err instanceof Error ? err.message : String(err));
    }
  }
}
