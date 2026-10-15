import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CARD_ATTACHMENTS_DIR } from '@aom/shared';
import { execa } from 'execa';
import type { z } from 'zod';
import type { ClaudeRuntimeConfigSchema } from '../config.ts';
import { discoverPluginMcpServers, mcpConfigFor, type PluginMcpServer } from '../mcp/plugins.ts';
import type { RunnerPaths } from '../paths.ts';
import { agentTmpDir, CACHE_ENV_KEYS, DOTNET_SHM_DIR, userNugetPackages } from '../sandbox/sandbox.ts';
import { selfCommand } from '../shims.ts';
import {
  type ClaudeAuthMonitor,
  type CredentialPaths,
  harvestAgentCredentials,
  isAuthFailureText,
  prepareAgentCredentials,
  probeClaudeLogin,
} from './claude-auth.ts';
import {
  agentEnv,
  buildCeoSettings,
  buildChatSettings,
  buildDevopsChatSettings,
  buildShiftSettings,
  type ClaudePolicyContext,
  DEVOPS_INHERITED_ENV,
  gitDirsOf,
  type SandboxState,
  sandboxState,
  toolchainReadPaths,
} from './claude-policy.ts';
import { ClaudeStreamParser } from './claude-stream-parser.ts';
import {
  type ClaudeUsageMonitor,
  detectUsageLimit,
  formatLimitTime,
  probeClaudeUsage,
  type UsageProbeResult,
} from './claude-usage-limit.ts';
import { spawnSession } from './process-session.ts';
import type {
  ChatStartInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  ShiftStartInput,
} from './types.ts';

type ClaudeConfig = z.infer<typeof ClaudeRuntimeConfigSchema>;

export interface ClaudeCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
  /** The prompt, when it is too big for argv (see `MAX_ARGV_PROMPT_BYTES`): sent on stdin instead. */
  stdin?: string;
}

export const BASH_DEFAULT_TIMEOUT_MS = 300_000;
export const BASH_MAX_TIMEOUT_MS = 900_000;

/**
 * Linux refuses a single argument over 128 KiB (MAX_ARG_STRLEN) and the whole command line over a fraction of the
 * stack limit: spawn fails with E2BIG. A card with a long history (handoffs, review comments, thread) renders a prompt
 * that big, so past this size `claude -p` reads the prompt from stdin instead.
 */
export const MAX_ARGV_PROMPT_BYTES = 64 * 1024;

/**
 * The complete environment of the agent process (it is spawned without inheriting the runner's own): an allow-list of
 * harmless variables, the session's variables, and the one provider credential this runtime is configured with.
 */
export function sessionEnv(
  input: Pick<ShiftStartInput, 'env' | 'sandbox'> & { agent?: Pick<ShiftStartInput['agent'], 'isDevops'> },
  cfg: ClaudeConfig,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const devops = input.agent?.isDevops === true;
  const provider: Record<string, string> = {};
  if (cfg.authMode === 'oauth' && cfg.oauthToken) provider.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken;
  else if (cfg.authMode === 'api_key' && cfg.apiKey) provider.ANTHROPIC_API_KEY = cfg.apiKey;
  const extra: Record<string, string> = {
    CLAUDE_CONFIG_DIR: input.sandbox.configDir,
    HOME: input.sandbox.home,
    USERPROFILE: input.sandbox.home,
    // Claude Code's own temp root and the TMPDIR of its sandboxed shell (default /tmp/claude): private and writable.
    CLAUDE_CODE_TMPDIR: input.sandbox.tmp,
    // Per-command limits Claude Code honours: a default of 5 min and a hard cap of 15 min, so an agent cannot pass
    // timeout=3600000 (or a background task) to park a hanging test run for an hour.
    BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
    BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
  };
  // Opt-in: Claude Code strips credentials from what Bash and MCP children see and isolates their PID namespace.
  // The DevOps engineer is unsandboxed and works as the user: their HOME (docker, ssh, kube configs) and the agent
  // variables docker/ssh/kubectl rely on; the Claude config dir stays the agent's own. Env scrubbing (which isolates
  // the PID namespace and strips credentials from Bash) would break that, so it is skipped.
  if (devops) {
    const home = homedir();
    extra.HOME = home;
    extra.USERPROFILE = home;
    for (const k of DEVOPS_INHERITED_ENV) {
      const v = parent[k];
      if (v !== undefined) extra[k] = v;
    }
  } else if (cfg.scrubSubprocessEnv) extra.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  // input.env carries the agent's private HOME (sandboxEnv); the DevOps HOME above must win over it. DevOps also keeps
  // the user's own package caches: the shared sandbox caches and .NET settings are for sandboxed agents.
  const sessionVars = { ...input.env };
  if (devops) for (const k of CACHE_ENV_KEYS) delete sessionVars[k];
  return agentEnv(
    devops
      ? { ...sessionVars, HOME: extra.HOME as string, USERPROFILE: extra.USERPROFILE as string }
      : sessionVars,
    provider,
    parent,
    extra,
  );
}

/** The exact argv/env of docs/ARCHITECTURE.md section 12.2. Pure; unit tested. */
export function buildClaudeCommand(input: ShiftStartInput, cfg: ClaudeConfig): ClaudeCommand {
  const viaStdin = Buffer.byteLength(input.prompt) > MAX_ARGV_PROMPT_BYTES;
  const args = [
    '-p',
    ...(viaStdin ? [] : [input.prompt]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.agent.model,
  ];
  if (input.agent.effort) args.push('--effort', input.agent.effort);
  args.push(
    '--permission-mode',
    'dontAsk',
    // Only the agent's own settings file (in its CLAUDE_CONFIG_DIR): a cloned repository's .claude/settings*.json
    // must not loosen the permission rules or the sandbox.
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    join(input.sandbox.configDir, 'mcp.json'),
  );
  for (const d of [...input.addDirs, ...(input.readDirs ?? [])]) args.push('--add-dir', d);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  return { bin: cfg.bin, args, env: sessionEnv(input, cfg), ...(viaStdin ? { stdin: input.prompt } : {}) };
}

/**
 * The read-only copy of a card's attachments (`<agent tmp>/card-attachments`, filled by the runner), when it exists: the
 * built-in file tools may read it although it lies outside the worktree.
 */
export function cardAttachmentDirs(sandbox: { tmp: string }): string[] {
  const dir = join(sandbox.tmp, CARD_ATTACHMENTS_DIR);
  return existsSync(dir) ? [dir] : [];
}

/** `claude -p <message> --resume <id> --output-format stream-json --verbose --include-partial-messages` (section 14). */
export function buildClaudeChatCommand(input: ChatStartInput, cfg: ClaudeConfig): ClaudeCommand {
  const args = [
    '-p',
    input.message,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    input.agent.model,
  ];
  if (input.agent.effort) args.push('--effort', input.agent.effort);
  args.push(
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--mcp-config',
    join(input.sandbox.configDir, 'mcp.json'),
  );
  for (const d of input.readDirs ?? []) args.push('--add-dir', d);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  // G-Q1: the DevOps agent's chat works as the user like its shifts (real HOME, no sandbox); other chats stay sandboxed
  return {
    bin: cfg.bin,
    args,
    env: sessionEnv(
      { env: input.env, sandbox: input.sandbox, agent: { isDevops: input.agent.isDevops } },
      cfg,
    ),
  };
}

/**
 * Tests and CI must never start a real Claude session (it spends tokens and can touch the machine). In mock mode
 * (`AOM_RUNNER_MOCK=1`) or under a test runner this is true unless the opt-in smoke test (`AOM_CLAUDE_SMOKE=1`) runs.
 */
export function realClaudeBlocked(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AOM_CLAUDE_SMOKE === '1') return false;
  return env.AOM_RUNNER_MOCK === '1' || env.NODE_ENV === 'test' || env.VITEST !== undefined;
}

export class RealClaudeBlockedError extends Error {
  constructor() {
    super(
      'refusing to start a real Claude Code session: AOM_RUNNER_MOCK=1 or a test environment is active (agents must use the mock runtime)',
    );
    this.name = 'RealClaudeBlockedError';
  }
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code';

  constructor(
    private readonly cfg: ClaudeConfig,
    private readonly paths?: RunnerPaths,
    /** Test hook: simulate the platform and PATH the sandbox check sees. */
    private readonly host: {
      platform?: NodeJS.Platform;
      pathVar?: string;
      /** Test hook: the plugin MCP servers of this machine (default: read from the Claude Code home). */
      mcpServers?: () => PluginMcpServer[];
      /** Test hook: the user's real home (where `.claude/.credentials.json` lives; default: this user's). */
      home?: string;
      /** The Claude login state of this runner (expiry detection, pause and resume); see claude-auth.ts. */
      auth?: ClaudeAuthMonitor;
      /** Test hook: the login probe (default: `claude auth status`, then one minimal `claude -p`). */
      probe?: () => Promise<'ok' | 'expired' | 'unknown'>;
      /** The subscription's usage-limit state of this runner (pause until the limit resets); see claude-usage-limit.ts. */
      usage?: ClaudeUsageMonitor;
      /** Test hook: the usage probe (default: one minimal `claude -p` on the cheapest model). */
      usageProbe?: () => Promise<UsageProbeResult>;
      /** Test hook: the clock and the zone used to read and show reset times. */
      now?: () => Date;
      zone?: string;
      /** The credential in force (secrets/claude.json over config.json); read at every session start. */
      credentials?: () => Pick<ClaudeConfig, 'authMode' | 'oauthToken' | 'apiKey'> | undefined;
    } = {},
  ) {}

  /**
   * The configuration in force right now: `cfg` with the credential a provider supplies (`secrets/claude.json`, written
   * by the Integrations page or `aom-runner auth`) laid over it. Read at every session start, so a new token needs no
   * restart of the runner.
   */
  private get live(): ClaudeConfig {
    const c = this.host.credentials?.();
    return c ? { ...this.cfg, ...c } : this.cfg;
  }

  private realHome(): string {
    return this.host.home ?? homedir();
  }

  private pluginServers(): PluginMcpServer[] {
    return (this.host.mcpServers ?? (() => discoverPluginMcpServers()))();
  }

  private assertCanRun(): void {
    const sb = this.sandboxStatus();
    if (sb.state === 'unavailable') throw new Error(`the Claude Code sandbox is unavailable: ${sb.reason}`);
  }

  /** Effective OS-sandbox state of this runtime (see `sandboxState`). */
  sandboxStatus(): SandboxState {
    return sandboxState(this.cfg, this.host.platform, this.host.pathVar);
  }

  /** What this session may touch (see claude-policy.ts); without runner paths (unit tests) the data dir is unknown. */
  private policy(
    input: Pick<ShiftStartInput, 'env' | 'sandbox'> & {
      addDirs?: string[];
      readDirs?: string[];
      toolchainReadDirs?: string[];
      extraAllowedDomains?: string[];
    },
    cwd: string,
    /** A chat never writes: the repository metadata of its worktree is read-only there, not a writable dir. */
    chat = false,
  ): ClaudePolicyContext {
    const root = this.paths?.root ?? dirname(dirname(input.sandbox.home));
    const script = selfCommand('aom').at(-1);
    const nugetFallbackDir = userNugetPackages(this.realHome());
    return {
      runnerRoot: root,
      agentDir: dirname(input.sandbox.home),
      cwd,
      addDirs: input.addDirs ?? [],
      gitDirs: chat ? [] : gitDirsOf(cwd),
      readDirs: input.readDirs ?? [],
      aomReadPaths: [this.paths?.bin ?? join(root, 'bin'), ...(script ? [dirname(script)] : [])],
      ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
      realHome: this.realHome(),
      mode: this.cfg.sandbox,
      extraAllowedDomains: [...this.cfg.extraAllowedDomains, ...(input.extraAllowedDomains ?? [])],
      toolchainReadPaths: toolchainReadPaths([
        ...(this.cfg.toolchainPaths ?? []),
        ...(input.toolchainReadDirs ?? []),
      ]),
      sharedCacheDir: input.sandbox.cacheRoot ?? join(root, 'cache'),
      ...(nugetFallbackDir ? { nugetFallbackDir } : {}),
      ...(process.platform === 'linux' ? { dotnetShmDir: DOTNET_SHM_DIR } : {}),
      otherAgentTmps: this.paths ? otherAgentTmps(this.paths, dirname(input.sandbox.home)) : [],
    };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = ['shell', 'edit', 'web', 'mcp', 'skills', 'sandbox_config', 'resume'];
    // Reported unavailable in mock/test mode so the server never picks it for an agent (it also refuses to start).
    if (realClaudeBlocked())
      return { runtime: this.id, version: 'blocked', available: false, capabilities: [] };
    const sb = this.sandboxStatus();
    const expired = this.host.auth?.state === 'expired';
    const limited = this.host.usage?.state === 'limited';
    const sandbox = {
      sandbox: sb.state,
      sandboxReason: sb.reason,
      ...(this.host.auth ? { auth: expired ? ('expired' as const) : ('ok' as const) } : {}),
      ...(this.host.usage
        ? {
            usage: limited ? ('limited' as const) : ('ok' as const),
            ...(limited && this.host.usage.limitedUntil
              ? {
                  limitedUntil: this.host.usage.limitedUntil,
                  limitedLabel: formatLimitTime(
                    new Date(this.host.usage.limitedUntil),
                    this.nowDate(),
                    this.host.zone,
                  ),
                }
              : {}),
          }
        : {}),
    };
    try {
      const r = await execa(this.cfg.bin, ['--version'], { reject: false, timeout: 10_000, stdin: 'ignore' });
      const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(r.stdout));
      if (r.exitCode !== 0 || !m)
        return { runtime: this.id, version: 'unknown', available: false, capabilities: [], ...sandbox };
      const major = Number(m[1]);
      const minor = Number(m[2]);
      let ok = major > 2 || (major === 2 && minor >= 1);
      // The permission/sandbox settings used below need 2.1.257 (blockReadsOutsideWorkingDirectories).
      if (
        this.cfg.sandbox !== 'off' &&
        !(major > 2 || (major === 2 && minor >= 1 && Number(m[3] ?? 0) >= 257))
      )
        ok = false;
      // `unavailable`: required and missing, or best_effort without the allowUnsandboxed acknowledgement.
      if (sb.state === 'unavailable') ok = false;
      // An expired login pauses the runtime: nothing is dispatched to it until the login works again.
      if (expired) ok = false;
      // So does a hit usage limit, until it resets and a probe works (backlog #73).
      if (limited) ok = false;
      return { runtime: this.id, version: m[0], available: ok, capabilities: ok ? caps : [], ...sandbox };
    } catch {
      return { runtime: this.id, version: 'unknown', available: false, capabilities: [], ...sandbox };
    }
  }

  async writeInstructions(sandbox: { configDir: string }, markdown: string): Promise<void> {
    await mkdir(sandbox.configDir, { recursive: true });
    await writeFile(join(sandbox.configDir, 'CLAUDE.md'), markdown);
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    if (realClaudeBlocked()) throw new RealClaudeBlockedError();
    // The DevOps engineer runs without the OS sandbox, so a missing bwrap/socat does not stop it.
    if (!input.agent.isDevops) this.assertCanRun();
    const dir = input.sandbox.configDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      `${JSON.stringify(buildShiftSettings(input.agent.permissions, this.policy(input, input.cwd), input.sandbox, input.agent.roleKey, input.agent.isDevops), null, 2)}\n`,
    );
    const used = this.writeMcpConfig(
      dir,
      input.agent.permissions.allowedTools,
      input.agent.isDevops ? undefined : input.mcpServers,
    );
    await this.linkCredentials(dir, used);

    const cmd = buildClaudeCommand(
      // the card repository metadata is readable (never through a rule that makes it read-only for the commit)
      {
        ...input,
        readDirs: [
          ...new Set([
            ...(input.readDirs ?? []),
            ...gitDirsOf(input.cwd),
            ...cardAttachmentDirs(input.sandbox),
          ]),
        ],
      },
      this.live,
    );
    const parser = new ClaudeStreamParser();
    return spawnSession({
      bin: cmd.bin,
      args: cmd.args,
      cwd: input.cwd,
      env: cmd.env,
      inheritEnv: false,
      ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
      parseLine: (l) => parser.parseLine(l),
      usage: () => parser.usage(),
      logFile: input.logFile,
      exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
      ...this.sessionHooks(dir, parser),
    });
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    if (realClaudeBlocked()) throw new RealClaudeBlockedError();
    const devops = input.agent.isDevops === true;
    if (!devops) this.assertCanRun();
    // Read-only folders of the chat, plus the repository metadata of a card worktree it reads (stops the refused
    // Read/Grep of `<repo>/.git/worktrees/<card>/HEAD`). The DevOps engineer reads anywhere and needs none of it.
    const chatInput = {
      ...input,
      readDirs: devops
        ? []
        : [
            ...new Set([
              ...(input.readDirs ?? []),
              ...gitDirsOf(input.cwd),
              ...cardAttachmentDirs(input.sandbox),
            ]),
          ],
    };
    const dir = input.sandbox.configDir;
    await mkdir(dir, { recursive: true });
    // Granted plugin MCP servers this role may call (the DevOps engineer's chat keeps its own behaviour).
    const intakeMcp = input.intake ? this.cfg.intake?.mcpConfig : undefined;
    const used = this.writeMcpConfig(
      dir,
      input.agent.permissions.allowedTools,
      devops || input.agent.roleKey === 'ceo' ? undefined : input.context?.mcpServers,
      intakeMcp && existsSync(intakeMcp) ? intakeMcp : undefined,
    );
    await writeFile(
      join(dir, 'settings.json'),
      `${JSON.stringify(
        devops
          ? buildDevopsChatSettings(input.agent.permissions, this.policy(input, input.cwd), input.sandbox)
          : input.agent.roleKey === 'ceo'
            ? buildCeoSettings(this.policy(chatInput, input.cwd, true), input.sandbox)
            : buildChatSettings(
                input.readOnly,
                [
                  ...(input.intake ? (this.cfg.intake?.allowedTools ?? []) : []),
                  ...used.map((u) => `mcp__${u.name}`),
                ],
                this.policy(chatInput, input.cwd, true),
                input.sandbox,
              ),
        null,
        2,
      )}\n`,
    );
    await this.linkCredentials(dir, used);
    const cmd = buildClaudeChatCommand(chatInput, this.live);
    const parser = new ClaudeStreamParser();
    return spawnSession({
      bin: cmd.bin,
      args: cmd.args,
      cwd: input.cwd,
      env: cmd.env,
      inheritEnv: false,
      parseLine: (l) => parser.parseLine(l),
      usage: () => parser.usage(),
      logFile: input.logFile,
      exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
      ...this.sessionHooks(dir, parser),
    });
  }

  /**
   * The agent's mcp.json: `{ mcpServers: {} }` unless the project granted plugin servers AND the role has the
   * `mcp:<name>` permission for them (both are required). The full server configuration comes from this workstation's
   * plugins (it never travelled through the server) and is written readable by the runner user only. The BA's intake
   * chat keeps its configured Jira MCP file; granted servers are added to it.
   */
  writeMcpConfig(
    dir: string,
    allowedTools: readonly string[],
    granted: readonly string[] | undefined,
    base?: string,
  ): PluginMcpServer[] {
    let doc: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
    if (base) {
      try {
        const parsed = JSON.parse(readFileSync(base, 'utf8')) as { mcpServers?: Record<string, unknown> };
        doc = { ...parsed, mcpServers: { ...(parsed.mcpServers ?? {}) } };
      } catch {
        // an unreadable intake file: the chat then has no MCP server, as before
      }
    }
    const want =
      granted && granted.length > 0 ? mcpConfigFor(this.pluginServers(), granted, allowedTools) : null;
    if (want) Object.assign(doc.mcpServers, want.mcpServers);
    const path = join(dir, 'mcp.json');
    writeFileSync(path, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // not supported on every platform
    }
    return want?.used ?? [];
  }

  private credentialPaths(configDir: string): CredentialPaths {
    return {
      canonical: join(this.realHome(), '.claude', '.credentials.json'),
      copy: join(configDir, '.credentials.json'),
      lock: join(this.paths?.root ?? dirname(dirname(configDir)), 'claude-credentials.lock'),
    };
  }

  /** The environment a login probe runs with: the runner's own, plus the configured provider credential. */
  private probeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const c = this.live;
    if (c.authMode === 'oauth' && c.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = c.oauthToken;
    else if (c.authMode === 'api_key' && c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
    return env;
  }

  /**
   * Checks that the Claude login works (`claude auth status`, then one minimal `claude -p`) and updates the auth state:
   * `ok` flips an expired runtime back, `expired` pauses it. Called every few minutes while expired, and before a
   * session when the access token is about to expire (that call also refreshes it). Nothing here prints a token.
   */
  async probeLogin(): Promise<'ok' | 'expired' | 'unknown'> {
    if (realClaudeBlocked()) return 'unknown';
    const r = await (
      this.host.probe ?? (() => probeClaudeLogin({ bin: this.cfg.bin, env: this.probeEnv() }))
    )();
    if (r === 'ok') this.host.auth?.markOk();
    else if (r === 'expired') this.host.auth?.markExpired();
    return r;
  }

  private nowDate(): Date {
    return this.host.now?.() ?? new Date();
  }

  /**
   * While the usage limit is in force and its reset time has passed: one minimal call (cheapest model, one turn). Clean:
   * the runtime is available again. Still limited: the new reset time is read and the pause extended (an hour when
   * the text has none). Nothing readable (network): the state stays and the caller retries later.
   */
  async probeUsage(): Promise<UsageProbeResult['state']> {
    const mon = this.host.usage;
    if (!mon || mon.state !== 'limited' || realClaudeBlocked()) return 'unknown';
    const r = await (
      this.host.usageProbe ??
      (() =>
        probeClaudeUsage({
          bin: this.cfg.bin,
          env: this.probeEnv(),
          now: () => this.nowDate(),
          ...(this.host.zone ? { tz: this.host.zone } : {}),
        }))
    )();
    if (r.state === 'ok') mon.markOk();
    else if (r.state === 'limited') mon.markLimited(r.hit.until);
    return r.state;
  }

  /** What the process session needs to notice a dead login and to hand back refreshed tokens. */
  private sessionHooks(
    configDir: string,
    parser: ClaudeStreamParser,
  ): Pick<Parameters<typeof spawnSession>[0], 'authFailure' | 'usageLimit' | 'onExit'> {
    return {
      authFailure: (stderr) => parser.authFailure || isAuthFailureText(stderr),
      usageLimit: (stderr) =>
        detectUsageLimit(parser.usageLimitText, this.nowDate(), this.host.zone) ??
        detectUsageLimit(stderr, this.nowDate(), this.host.zone),
      onExit: async ({ code, authFailed, usageLimit }) => {
        if (authFailed) this.host.auth?.markExpired();
        else if (code === 0 && parser.usage().outputTokens > 0) this.host.auth?.markOk();
        if (usageLimit) this.host.usage?.markLimited(usageLimit.until);
        // a real session that worked proves the limit is gone: resume without waiting for the probe
        else if (code === 0 && parser.usage().outputTokens > 0) this.host.usage?.markOk();
        if (this.usesSharedLogin()) await harvestAgentCredentials(this.credentialPaths(configDir));
      },
    };
  }

  /** The user's own `claude` login is shared with the agents (no token or key configured). */
  private usesSharedLogin(): boolean {
    const c = this.live;
    return !((c.authMode === 'oauth' && c.oauthToken) || (c.authMode === 'api_key' && c.apiKey));
  }

  /**
   * Credentials of the agent's config dir.
   * - No token configured (the user's own login is reused): the agent gets a private COPY of
   *   `~/.claude/.credentials.json` (it holds the plugin servers' OAuth tokens, `mcpOAuth`, too). A symlink let one
   *   agent's token refresh replace the file under the others and rotate the refresh token out from under them. The
   *   copy is made under a runner-wide lock, after one refresh probe when the access token expires within 10 minutes,
   *   and a newer login in the copy is written back after the session (`harvestAgentCredentials`).
   * - A token (`oauth` / `api_key`) is configured: the file is not shared. When servers are in use, a private copy with
   *   only the `mcpOAuth` entries of those servers is written (the model login is the token, so nothing else is
   *   needed); without servers there is no file.
   */
  async linkCredentials(configDir: string, servers: PluginMcpServer[] = []): Promise<void> {
    const src = join(this.realHome(), '.claude', '.credentials.json');
    const dest = join(configDir, '.credentials.json');
    if (!this.usesSharedLogin()) {
      rmSync(dest, { force: true });
      if (servers.length === 0 || !existsSync(src)) return;
      try {
        const all = JSON.parse(readFileSync(src, 'utf8')) as { mcpOAuth?: Record<string, unknown> };
        const keys = servers.map((s) => s.key);
        const mcpOAuth = Object.fromEntries(
          Object.entries(all.mcpOAuth ?? {}).filter(([k]) =>
            keys.some((key) => k === key || k.startsWith(`${key}|`)),
          ),
        );
        if (Object.keys(mcpOAuth).length > 0)
          writeFileSync(dest, `${JSON.stringify({ mcpOAuth })}\n`, { mode: 0o600 });
      } catch {
        // unreadable credentials: the servers start unauthenticated and fail, which the agent reports
      }
      return;
    }
    if (!existsSync(src)) {
      rmSync(dest, { force: true });
      return;
    }
    try {
      await prepareAgentCredentials(this.credentialPaths(configDir), {
        refresh: async () => {
          await this.probeLogin();
        },
      });
    } catch {
      // unreadable or unwritable credentials: the session reports a login that does not work
    }
  }
}

/** Private temp dirs of every other agent on this runner (they live under /tmp, outside the denied data dir). */
function otherAgentTmps(paths: RunnerPaths, ownAgentDir: string): string[] {
  const agentsDir = dirname(ownAgentDir);
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((id) => join(agentsDir, id) !== ownAgentDir)
    .map((id) => agentTmpDir(paths, id));
}
