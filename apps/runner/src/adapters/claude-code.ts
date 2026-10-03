import { copyFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentPermissions } from '@aom/shared';
import { execa } from 'execa';
import type { z } from 'zod';
import type { ClaudeRuntimeConfigSchema } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
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

const ALWAYS_DENIED = [
  'Bash(git push:*)',
  'Bash(git rebase:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git reset --hard:*)',
];

/** `git push*` -> `Bash(git push:*)`, `rm -rf /*` -> `Bash(rm -rf /*)`. */
function shellDeny(pattern: string): string {
  const p = pattern.trim();
  if (p.endsWith(' *')) return `Bash(${p.slice(0, -2)}:*)`;
  if (p.endsWith('*') && !p.endsWith('/*')) return `Bash(${p.slice(0, -1).trimEnd()}:*)`;
  return `Bash(${p})`;
}

export function buildClaudeSettings(p: AgentPermissions): {
  permissions: { allow: string[]; deny: string[]; defaultMode: 'acceptEdits' };
  includeCoAuthoredBy: false;
} {
  const allow: string[] = [];
  for (const tool of p.allowedTools) {
    if (tool === 'read') allow.push('Read', 'Glob', 'Grep');
    else if (tool === 'edit') {
      if (p.writableGlobs === null) allow.push('Edit', 'Write', 'NotebookEdit');
      else for (const g of p.writableGlobs) allow.push(`Edit(${g})`, `Write(${g})`);
    } else if (tool === 'shell') allow.push('Bash');
    else if (tool === 'web') allow.push('WebFetch', 'WebSearch');
    else if (tool.startsWith('mcp:')) allow.push(`mcp__${tool.slice(4)}`);
  }
  const deny = [...new Set([...ALWAYS_DENIED, ...p.deniedShellPatterns.map(shellDeny)])];
  return { permissions: { allow, deny, defaultMode: 'acceptEdits' }, includeCoAuthoredBy: false };
}

export interface ClaudeCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
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
    'acceptEdits',
    '--strict-mcp-config',
    '--mcp-config',
    join(input.sandbox.configDir, 'mcp.json'),
  );
  for (const d of input.addDirs) args.push('--add-dir', d);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);

  const env: Record<string, string> = {
    ...input.env,
    CLAUDE_CONFIG_DIR: input.sandbox.configDir,
    HOME: input.sandbox.home,
    USERPROFILE: input.sandbox.home,
  };
  if (cfg.authMode === 'oauth' && cfg.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken;
  else if (cfg.authMode === 'api_key' && cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  return { bin: cfg.bin, args, env };
}

/** Chat sessions read and talk; the only shell command they may run is `aom` (comment, ledger search). */
export function buildClaudeChatSettings(
  readOnly: boolean,
  extraAllow: string[] = [],
): {
  permissions: { allow: string[]; deny: string[]; defaultMode: 'default' };
  includeCoAuthoredBy: false;
} {
  return {
    permissions: {
      allow: ['Read', 'Glob', 'Grep', 'Bash(aom:*)', ...extraAllow],
      deny: [...ALWAYS_DENIED, ...(readOnly ? ['Edit', 'Write', 'NotebookEdit'] : [])],
      defaultMode: 'default',
    },
    includeCoAuthoredBy: false,
  };
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
  args.push('--strict-mcp-config', '--mcp-config', join(input.sandbox.configDir, 'mcp.json'));
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  const env: Record<string, string> = {
    ...input.env,
    CLAUDE_CONFIG_DIR: input.sandbox.configDir,
    HOME: input.sandbox.home,
    USERPROFILE: input.sandbox.home,
  };
  if (cfg.authMode === 'oauth' && cfg.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken;
  else if (cfg.authMode === 'api_key' && cfg.apiKey) env.ANTHROPIC_API_KEY = cfg.apiKey;
  return { bin: cfg.bin, args, env };
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
    _paths?: RunnerPaths,
  ) {}

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
      const ok = major > 2 || (major === 2 && minor >= 1);
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
      `${JSON.stringify(buildClaudeSettings(input.agent.permissions), null, 2)}\n`,
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
      `${JSON.stringify(buildClaudeChatSettings(input.readOnly, input.intake ? (this.cfg.intake?.allowedTools ?? []) : []), null, 2)}\n`,
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
