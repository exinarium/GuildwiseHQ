import { copyFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { z } from 'zod';
import type { ClaudeRuntimeConfigSchema } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
import { selfCommand } from '../shims.ts';
import {
  agentEnv,
  buildChatSettings,
  buildShiftSettings,
  type ClaudePolicyContext,
  gitDirsOf,
  sandboxMissing,
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
  input: Pick<ShiftStartInput, 'env' | 'sandbox'>,
  cfg: ClaudeConfig,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
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
  if (cfg.scrubSubprocessEnv) extra.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  return agentEnv(input.env, provider, parent, extra);
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
  for (const d of input.addDirs) args.push('--add-dir', d);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  return { bin: cfg.bin, args, env: sessionEnv(input, cfg) };
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
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  return { bin: cfg.bin, args, env: sessionEnv(input, cfg) };
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
  ) {}

  /** What this session may touch (see claude-policy.ts); without runner paths (unit tests) the data dir is unknown. */
  private policy(
    input: Pick<ShiftStartInput, 'env' | 'sandbox'> & { addDirs?: string[] },
    cwd: string,
  ): ClaudePolicyContext {
    const root = this.paths?.root ?? dirname(dirname(input.sandbox.home));
    const script = selfCommand('aom').at(-1);
    return {
      runnerRoot: root,
      agentDir: dirname(input.sandbox.home),
      cwd,
      addDirs: input.addDirs ?? [],
      gitDirs: gitDirsOf(cwd),
      aomReadPaths: [this.paths?.bin ?? join(root, 'bin'), ...(script ? [dirname(script)] : [])],
      ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
      realHome: homedir(),
      mode: this.cfg.sandbox,
      extraAllowedDomains: this.cfg.extraAllowedDomains,
    };
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = ['shell', 'edit', 'web', 'mcp', 'skills', 'sandbox_config', 'resume'];
    // Reported unavailable in mock/test mode so the server never picks it for an agent (it also refuses to start).
    if (realClaudeBlocked())
      return { runtime: this.id, version: 'blocked', available: false, capabilities: [] };
    try {
      const r = await execa(this.cfg.bin, ['--version'], { reject: false, timeout: 10_000, stdin: 'ignore' });
      const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(r.stdout));
      if (r.exitCode !== 0 || !m)
        return { runtime: this.id, version: 'unknown', available: false, capabilities: [] };
      const major = Number(m[1]);
      const minor = Number(m[2]);
      let ok = major > 2 || (major === 2 && minor >= 1);
      // The permission/sandbox settings used below need 2.1.257 (blockReadsOutsideWorkingDirectories).
      if (
        this.cfg.sandbox !== 'off' &&
        !(major > 2 || (major === 2 && minor >= 1 && Number(m[3] ?? 0) >= 257))
      )
        ok = false;
      if (this.cfg.sandbox === 'required' && sandboxMissing()) ok = false;
      return { runtime: this.id, version: m[0], available: ok, capabilities: ok ? caps : [] };
    } catch {
      return { runtime: this.id, version: 'unknown', available: false, capabilities: [] };
    }
  }

  async writeInstructions(sandbox: { configDir: string }, markdown: string): Promise<void> {
    await mkdir(sandbox.configDir, { recursive: true });
    await writeFile(join(sandbox.configDir, 'CLAUDE.md'), markdown);
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    if (realClaudeBlocked()) throw new RealClaudeBlockedError();
    const dir = input.sandbox.configDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      `${JSON.stringify(buildShiftSettings(input.agent.permissions, this.policy(input, input.cwd), input.sandbox), null, 2)}\n`,
    );
    await writeFile(join(dir, 'mcp.json'), `${JSON.stringify({ mcpServers: {} })}\n`);
    this.linkCredentials(dir);

    const cmd = buildClaudeCommand(input, this.cfg);
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
    const dir = input.sandbox.configDir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'settings.json'),
      `${JSON.stringify(
        buildChatSettings(
          input.readOnly,
          input.intake ? (this.cfg.intake?.allowedTools ?? []) : [],
          this.policy(input, input.cwd),
          input.sandbox,
        ),
        null,
        2,
      )}\n`,
    );
    // The BA's intake reads Jira with the user's own MCP server (configured on this workstation); other chats have none.
    const intakeMcp = input.intake ? this.cfg.intake?.mcpConfig : undefined;
    await writeFile(
      join(dir, 'mcp.json'),
      intakeMcp && existsSync(intakeMcp)
        ? readFileSync(intakeMcp, 'utf8')
        : `${JSON.stringify({ mcpServers: {} })}\n`,
    );
    this.linkCredentials(dir);
    const cmd = buildClaudeChatCommand(input, this.cfg);
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

  /** No token configured: reuse the user's default login, symlinked (copied on Windows) into the agent's config dir. */
  private linkCredentials(configDir: string): void {
    const configured =
      (this.cfg.authMode === 'oauth' && this.cfg.oauthToken) ||
      (this.cfg.authMode === 'api_key' && this.cfg.apiKey);
    if (configured) return;
    const src = join(homedir(), '.claude', '.credentials.json');
    const dest = join(configDir, '.credentials.json');
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
