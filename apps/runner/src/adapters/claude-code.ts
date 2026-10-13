import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  agentEnv,
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
}

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
  const args = [
    '-p',
    input.prompt,
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
  return { bin: cfg.bin, args, env: sessionEnv(input, cfg) };
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
    } = {},
  ) {}

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
      extraAllowedDomains: this.cfg.extraAllowedDomains,
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
    const sandbox = { sandbox: sb.state, sandboxReason: sb.reason };
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
    this.linkCredentials(dir, used);

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
      this.cfg,
    );
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
      devops ? undefined : input.context?.mcpServers,
      intakeMcp && existsSync(intakeMcp) ? intakeMcp : undefined,
    );
    await writeFile(
      join(dir, 'settings.json'),
      `${JSON.stringify(
        devops
          ? buildDevopsChatSettings(input.agent.permissions, this.policy(input, input.cwd), input.sandbox)
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
    this.linkCredentials(dir, used);
    const cmd = buildClaudeChatCommand(chatInput, this.cfg);
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

  /**
   * Credentials of the agent's config dir.
   * - No token configured (the user's own login is reused): the credentials file is linked as before (symlink, copy on
   *   Windows). It already holds the plugin servers' OAuth tokens (`mcpOAuth`), and Claude Code writes refreshed
   *   tokens back through the link, so a rotated refresh token is not lost.
   * - A token (`oauth` / `api_key`) is configured: the file is not linked. When servers are in use, a private copy with
   *   only the `mcpOAuth` entries of those servers is written (the model login is the token, so nothing else is
   *   needed); without servers there is no file.
   */
  linkCredentials(configDir: string, servers: PluginMcpServer[] = []): void {
    const configured =
      (this.cfg.authMode === 'oauth' && this.cfg.oauthToken) ||
      (this.cfg.authMode === 'api_key' && this.cfg.apiKey);
    const src = join(this.realHome(), '.claude', '.credentials.json');
    const dest = join(configDir, '.credentials.json');
    if (configured) {
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
    if (!existsSync(src)) return;
    rmSync(dest, { force: true });
    try {
      if (process.platform === 'win32') copyFileSync(src, dest);
      else symlinkSync(src, dest);
    } catch {
      // already linked by a concurrent shift
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
