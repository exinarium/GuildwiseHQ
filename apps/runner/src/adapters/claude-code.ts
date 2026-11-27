import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { CARD_ATTACHMENTS_DIR, type ClaudeAccountInfo, MAIN_ACCOUNT } from '@aom/shared';
import { execa } from 'execa';
import type { z } from 'zod';
import { probeBwrap } from '../box/bwrap.ts';
import { type BoxLevel, boxConfigDir, resetBoxConfigDir, writeBoxSettings } from '../box/config-dir.ts';
import { type DockerProxy, startDockerProxy } from '../box/docker-proxy.ts';
import { sshThroughProxy } from '../box/egress-allow.ts';
import { openCheckedFolder, openNamedFolder } from '../box/folder-check.ts';
import {
  type BoxPlanInput,
  boundDirsOf,
  boxedClaudeEnv,
  boxSandbox,
  boxWorkDirs,
  MODEL_UPSTREAM,
  type ModelCredential,
  modelProxyPlan,
} from '../box/launch.ts';
import { launchMacBox, macBoxMissing } from '../box/macos-launch.ts';
import { MAC_SYSTEM_READ } from '../box/macos-profile.ts';
import type { ModelCapture } from '../box/model-filter.ts';
import { ModelLedger } from '../box/model-ledger.ts';
import { type GrantedSkill, materializeSkills, skillsDirOf } from '../capabilities/materialize.ts';
import type { ClaudeRuntimeConfigSchema } from '../config.ts';
import { alwaysPathRefusal, deleteRootsFor, type GuardConfig } from '../devops/guard.ts';
import type { ProviderStore } from '../direct/store.ts';
import { holdSandboxRepo } from '../git/config-lock.ts';
import { discoverPluginMcpServers, mcpConfigFor, type PluginMcpServer } from '../mcp/plugins.ts';
import type { RunnerPaths } from '../paths.ts';
import { policyDir as localPolicyDir } from '../policy/store.ts';
import { systemRoBinds } from '../sandbox/harness-sandbox.ts';
import { toolchainsRoot } from '../toolchain/user-install.ts';
import { lookupBin } from './bin-lookup.ts';
import { BRIDGE_PORT, launchInHarnessSandbox, probeHarnessSandbox } from './harness-session.ts';

/** The card worktrees (`worktrees/<project>/<card>`): the roots a container may bind as a whole. */
export function cardWorktreeRoots(worktrees: string): string[] {
  const out: string[] = [];
  try {
    for (const p of readdirSync(worktrees, { withFileTypes: true }))
      if (p.isDirectory())
        for (const c of readdirSync(join(worktrees, p.name), { withFileTypes: true }))
          if (c.isDirectory()) out.push(join(worktrees, p.name, c.name));
  } catch {
    // no worktrees yet
  }
  return out;
}

/** The fallback message (S10): this computer has no credential the model proxy can carry for boxed DevOps work. */
export const NEEDS_API_KEY =
  'needs an API key for DevOps on this computer (the safety box never holds your Claude login, and none was found here)';

import { reviewerPolicy } from '../review/reviewer-sandbox.ts';
import {
  agentTmpDir,
  agentTmpRoot,
  CACHE_ENV_KEYS,
  DOTNET_SHM_DIR,
  usablePnpmLockDirs,
  userNugetPackages,
} from '../sandbox/sandbox.ts';
import { SHIFT_ENV_POINTER, sessionEnvDirOf } from '../session/shift-credential.ts';
import { selfCommand } from '../shims.ts';
import { detectionRoots } from '../toolchain/registry.ts';
import { type AccountCredential, type ClaudeAccount, ClaudeAccountRegistry } from './claude-accounts.ts';
import {
  type ClaudeAuthMonitor,
  type CredentialPaths,
  harvestAgentCredentials,
  isAuthFailureText,
  loginExpiresAt,
  prepareAgentCredentials,
  probeClaudeLogin,
  REFRESH_WINDOW_MS,
  readCredentials,
  withLock,
} from './claude-auth.ts';
import {
  backendOfModel,
  backendProcessEnv,
  backendRoleProblem,
  removeVertexKey,
  stampBackendUsage,
  writeVertexKey,
} from './claude-backend.ts';
import {
  agentEnv,
  buildCeoSettings,
  buildChatSettings,
  buildDevopsBoxSettings,
  buildDevopsChatSettings,
  buildMentionWorkSettings,
  buildShiftSettings,
  type ClaudePolicyContext,
  type ClaudeSettings,
  DEPLOY_ASK_ALLOW,
  DEVOPS_INHERITED_ENV,
  gitDirsOf,
  isReadOnlyWorktreeRole,
  type SandboxState,
  sandboxMissing,
  sandboxState,
  shadowedWrites,
  splitOwnRepository,
  toolchainReadPaths,
  withBoxWorkDirs,
} from './claude-policy.ts';
import { ClaudeStreamParser } from './claude-stream-parser.ts';
import { agentsDocument, NATIVE_SUBAGENT_ENV, readNativeSubagentUsage } from './claude-subagents.ts';
import {
  type ClaudeUsageMonitor,
  detectUsageLimit,
  formatLimitTime,
  probeClaudeUsage,
  type UsageProbeResult,
} from './claude-usage-limit.ts';
import { spawnSession } from './process-session.ts';
import { createSandboxPlaceholders } from './sandbox-placeholders.ts';
import type {
  AccountGate,
  ChatStartInput,
  DevopsGuardInput,
  NativeSubagent,
  OwnerTurnInput,
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
/**
 * A card shift's default shell timeout: `aom question --wait` waits up to 10 minutes for a peer's answer inside one
 * Bash call, so the default must outlast it (11 minutes). The hard cap below stays 15 minutes.
 */
export const CARD_BASH_DEFAULT_TIMEOUT_MS = 660_000;
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
  input: Pick<ShiftStartInput, 'env' | 'sandbox'> & {
    agent?: Pick<ShiftStartInput['agent'], 'isDevops'>;
    devopsGuard?: Pick<NonNullable<ShiftStartInput['devopsGuard']>, 'readOnlyScan'>;
    /** quiet-approvals [B2]: inside the box: a private HOME, no ssh agent or Docker, and the scrub forced on. */
    devopsBox?: boolean;
    kind?: ShiftStartInput['kind'];
    promptCacheTtl?: ShiftStartInput['promptCacheTtl'];
    /** The agent loads its granted skills natively: Claude Code's own bundled skills are switched off. */
    nativeSkills?: boolean;
  },
  cfg: ClaudeConfig,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // A scan is a DevOps shift but works inside the OS sandbox with the agent's private HOME: no ssh agent, Docker
  // socket or user runtime dir is handed to it (SSH_AUTH_SOCK would let the shell sign in to a server).
  const devops =
    input.agent?.isDevops === true && input.devopsGuard?.readOnlyScan !== true && input.devopsBox !== true;
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
    BASH_DEFAULT_TIMEOUT_MS: String(
      input.kind === 'card' ? CARD_BASH_DEFAULT_TIMEOUT_MS : BASH_DEFAULT_TIMEOUT_MS,
    ),
    BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
    // Short shifts (a question, the CEO, DevOps, QA steps) make a few calls and end: the 1-hour cache write of a
    // subscription costs twice the input price and is never read again. Verified against claude 2.1.302 (the variable
    // is in its binary next to ENABLE_PROMPT_CACHING_1H / FORCE_PROMPT_CACHING_5M).
    ...(input.promptCacheTtl ? { CLAUDE_CODE_PROMPT_CACHE_TTL: input.promptCacheTtl } : {}),
    ...(input.nativeSkills ? { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' } : {}),
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
  } else if (cfg.scrubSubprocessEnv || input.devopsBox === true) extra.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
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

/**
 * The start of every `aom` hook command (skill and subagent guards). With the scrub on (the 1.10.0 default) Claude Code
 * strips AOM_SHIFT_TOKEN from what its hooks inherit, so a hook reads the session's 0600 env file instead: its path is
 * written into the command (`AOM_SHIFT_ENV_FILE=...`), whatever the hook inherits. And the hook runs in the agent's config
 * dir, not the worktree: the scrub leaves an empty `package.json` mount point there, and a Node started with a preload
 * (`tsx` when the runner runs from source) refuses an empty package.json in its working directory.
 */
export function hookPrefix(configDir: string, env: Record<string, string | undefined>): string {
  const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
  const file = env[SHIFT_ENV_POINTER];
  return `cd ${quote(configDir)} && ${file ? `${SHIFT_ENV_POINTER}=${quote(file)} ` : ''}`;
}

/**
 * With the scrub on, an agent's Bash cannot write package.json, the lockfiles or node_modules/.bin (Claude Code 2.1.330), so
 * a package install fails with "Read-only file system". This PreToolUse hook (plain shell, no node start per call) refuses
 * an install command up front and says how to ask DevOps instead (owner 2026-11-21).
 */
export const INSTALL_REDIRECT_MESSAGE =
  'Package installs do not run in your shell (it cannot write package.json, the lockfiles or node_modules/.bin). Ask DevOps to run it in your worktree: `aom devops install <npm|pnpm|yarn|bun>` for the locked dependencies, `aom devops install <tool> add <pkg>[@range]... [--dev]` or `aom devops install <tool> remove <pkg>...`. It answers when done; then carry on.';
export const INSTALL_COMMAND_RE =
  '(^|[;&|(]|&&|\\|\\||"command": *")[[:space:]]*(npm|pnpm|yarn|bun)[[:space:]]+(install|i|ci|add|remove|rm|uninstall|un)([[:space:]]|"|$)';

export function addInstallRedirect(settings: ClaudeSettings): void {
  const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
  const command = `grep -qE ${quote(INSTALL_COMMAND_RE)} && { printf '%s\\n' ${quote(INSTALL_REDIRECT_MESSAGE)} >&2; exit 2; }; exit 0`;
  settings.hooks = {
    ...(settings.hooks ?? {}),
    PreToolUse: [
      ...(settings.hooks?.PreToolUse ?? []),
      { matcher: 'Bash', hooks: [{ type: 'command' as const, command, timeout: 5 }] },
    ],
  };
}

/** Whether this call loads the agent's granted skills natively (and so cannot use `--disable-slash-commands`). */
export const nativeSkills = (input: {
  grantedSkills?: unknown[] | undefined;
  agent?: { isDevops?: boolean };
}): boolean => !!input.grantedSkills?.length && input.agent?.isDevops !== true;

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
  // No skills: the account's synced skills (anthropic-skills:*) and the bundled ones add ~10K tokens of descriptions
  // to every first call and no agent uses them (verified with claude 2.1.302: the init message lists 0 skills). An agent
  // with granted skills gets them natively instead (`nativeSkills`): the flag is dropped, the granted ones are written into
  // its private config dir, and a PreToolUse hook (`aom skill-guard`) refuses every other skill.
  if (!nativeSkills(input)) args.push('--disable-slash-commands');
  // A scan's clones are NOT `--add-dir`s: Claude Code opens every added directory whole to the sandbox, which would
  // undo the per-file masks (`.git/config`, `.env`) of the scan sandbox. The Read tool reads them anyway (no
  // working-directory block in the DevOps settings; the secret rules deny the settings files).
  if (input.devopsGuard?.readOnlyScan !== true)
    for (const d of [...input.addDirs, ...(input.readDirs ?? [])]) args.push('--add-dir', d);
  if (input.subagents?.length) args.push('--agents', join(input.sandbox.configDir, AGENTS_FILE));
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  return {
    bin: cfg.bin,
    args,
    env: sessionEnv(
      {
        env: input.env,
        sandbox: input.sandbox,
        agent: { isDevops: input.agent.isDevops },
        ...(input.devopsGuard?.readOnlyScan ? { devopsGuard: { readOnlyScan: true } } : {}),
        ...(input.devopsBox ? { devopsBox: true } : {}),
        ...(nativeSkills(input) ? { nativeSkills: true } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.promptCacheTtl ? { promptCacheTtl: input.promptCacheTtl } : {}),
      },
      cfg,
    ),
    ...(viaStdin ? { stdin: input.prompt } : {}),
  };
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
  const viaStdin = Buffer.byteLength(input.message) > MAX_ARGV_PROMPT_BYTES;
  const args = [
    '-p',
    ...(viaStdin ? [] : [input.message]),
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
  if (!nativeSkills(input)) args.push('--disable-slash-commands');
  for (const d of input.readDirs ?? []) args.push('--add-dir', d);
  if (input.subagents?.length) args.push('--agents', join(input.sandbox.configDir, AGENTS_FILE));
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  // G-Q1: the DevOps agent's chat works as the user like its shifts (real HOME, no sandbox); other chats stay sandboxed
  return {
    bin: cfg.bin,
    args,
    env: sessionEnv(
      {
        env: input.env,
        sandbox: input.sandbox,
        agent: { isDevops: input.agent.isDevops },
        ...(input.devopsBox ? { devopsBox: true } : {}),
        ...(nativeSkills(input) ? { nativeSkills: true } : {}),
      },
      cfg,
    ),
    ...(viaStdin ? { stdin: input.message } : {}),
  };
}

/** The native subagents' definitions, in the agent's private config dir (`--agents <file>`). */
export const AGENTS_FILE = 'agents.json';

export const OWNER_BRIEF_FILE = 'ceo-brief.md';
export const OWNER_MCP_FILE = 'aom-permission.json';
export const OWNER_FLOOR_FILE = 'floor.json';
export const PERMISSION_TOOL = 'mcp__aom_permission__ask';

/**
 * The CEO's full-power turn (docs/design/ceo-front-door.md section 3.3, permissions per section 14.1): the Owner's own Claude
 * Code. His real `~/.claude` loads (user, project and local settings, skills, plugins and his MCP servers), HOME is the real
 * one, there is no sandbox, no `--strict-mcp-config`, no `--disable-slash-commands` and no `CLAUDE_CONFIG_DIR` override.
 * The Owner's own chat runs in `auto` (the classifier plus the desk relay) unless he opted in with `full-power on --bypass`
 * (`ceo.ownerPermissions = 'bypass'`: `bypassPermissions`, nothing judged or prompted, like his terminal); a standing-order turn always runs `auto`, and a permission it lacks
 * goes to the permission relay (a desk question). The deny floor (`floor.json`) still wins in both modes: deny rules are
 * evaluated before the mode. `Bash(aom:*)` is always allowed. Pure; unit tested.
 */
export function buildClaudeOwnerTurnCommand(
  input: OwnerTurnInput,
  cfg: ClaudeConfig,
  parent: NodeJS.ProcessEnv = process.env,
): ClaudeCommand {
  const viaStdin = Buffer.byteLength(input.message) > MAX_ARGV_PROMPT_BYTES;
  const args = [
    '-p',
    ...(viaStdin ? [] : [input.message]),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    input.agent.model,
  ];
  if (input.agent.effort) args.push('--effort', input.agent.effort);
  args.push(
    '--setting-sources',
    'user,project,local',
    '--append-system-prompt-file',
    join(input.turnDir, OWNER_BRIEF_FILE),
    '--permission-mode',
    ownerPermissionFlag(input),
    '--permission-prompt-tool',
    PERMISSION_TOOL,
    '--mcp-config',
    join(input.turnDir, OWNER_MCP_FILE),
    '--settings',
    join(input.turnDir, OWNER_FLOOR_FILE),
    '--allowedTools',
    'Bash(aom:*)',
    ...DEPLOY_ASK_ALLOW,
  );
  for (const d of input.addDirs ?? []) args.push('--add-dir', d);
  if (input.resumeSessionId) args.push('--resume', input.resumeSessionId);
  const provider: Record<string, string> = {};
  if (cfg.authMode === 'oauth' && cfg.oauthToken) provider.CLAUDE_CODE_OAUTH_TOKEN = cfg.oauthToken;
  else if (cfg.authMode === 'api_key' && cfg.apiKey) provider.ANTHROPIC_API_KEY = cfg.apiKey;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined) env[k] = v;
  const home = homedir();
  Object.assign(env, { HOME: home, USERPROFILE: home }, input.env, provider);
  // Without the classifier or the relay in front of the shell, the runner's provider credential must not be readable by it
  // (`env`, `printenv`): Claude Code strips Anthropic and cloud-provider credentials from the subprocesses it starts.
  // The scrub also removes credential-named variables such as AOM_SHIFT_TOKEN from the Bash children, so `aom` refills
  // them from the file named by AOM_SHIFT_ENV_FILE (see session/shift-credential.ts).
  if (ownerBypasses(input)) env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  return { bin: cfg.bin, args, env, ...(viaStdin ? { stdin: input.message } : {}) };
}

/**
 * quiet-approvals S12: the environment of a boxed full-power turn: the session's own variables and the private config dir and
 * HOME; nothing inherited from the runner (its HOME, its credentials, its DOCKER_HOST, ...).
 */
export function ownerBoxEnv(
  turnEnv: Record<string, string>,
  dirs: { configDir: string; home: string },
): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']) if (turnEnv[k]) keep[k] = turnEnv[k] as string;
  for (const [k, v] of Object.entries(turnEnv)) if (k.startsWith('AOM_')) keep[k] = v;
  if (turnEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB) keep.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  return { ...keep, HOME: dirs.home, USERPROFILE: dirs.home, CLAUDE_CONFIG_DIR: dirs.configDir };
}

/** Only the Owner's own chat can run without prompts; a standing-order turn (nobody watching) keeps the classifier and the relay. */
export const ownerBypasses = (input: Pick<OwnerTurnInput, 'mode' | 'permissionMode'>): boolean =>
  input.mode === 'owner' && input.permissionMode === 'bypass';

const ownerPermissionFlag = (input: Pick<OwnerTurnInput, 'mode' | 'permissionMode'>): string =>
  ownerBypasses(input) ? 'bypassPermissions' : 'auto';

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

/**
 * The runtime configuration for one account: `base` with the account's own credential laid over it. A config-dir account
 * has none (`authMode: 'default'`), so no token variable reaches its sessions; the main account's token never leaks into it.
 */
export function accountClaudeConfig(base: ClaudeConfig, credential: AccountCredential): ClaudeConfig {
  const { oauthToken: _o, apiKey: _k, ...rest } = base;
  return {
    ...rest,
    authMode: credential.authMode,
    ...(credential.oauthToken ? { oauthToken: credential.oauthToken } : {}),
    ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
  };
}

/** `RuntimeInfoSchema.accounts` allows 20. */
const MAX_REPORTED_ACCOUNTS = 20;

/** The folder of the per-session DevOps guard files inside an agent's config dir. */
export const GUARD_DIR = 'devops-guard';
/** Guard files older than this are removed when a new one is written (a running session has a fresh file). */
const GUARD_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The guard file of one session: no two sessions of an agent share one (`kind` is 'shift' or 'chat'). */
export function guardFileFor(configDir: string, kind: 'shift' | 'chat', sessionRef: string): string {
  const safe = /^[A-Za-z0-9-]{1,80}$/.test(sessionRef)
    ? sessionRef
    : createHash('sha256').update(sessionRef).digest('hex').slice(0, 32);
  return join(configDir, GUARD_DIR, `${kind}-${safe}.json`);
}

/** Removes guard files (and the legacy shared `devops-guard.json`) that are over a day old. Never throws. */
function pruneGuardFiles(configDir: string, now: number = Date.now()): void {
  const old = (f: string): boolean => {
    try {
      return now - statSync(f).mtimeMs > GUARD_FILE_MAX_AGE_MS;
    } catch {
      return false;
    }
  };
  try {
    const legacy = join(configDir, 'devops-guard.json');
    if (old(legacy)) rmSync(legacy, { force: true });
    const folder = join(configDir, GUARD_DIR);
    for (const name of readdirSync(folder)) {
      const f = join(folder, name);
      if (name.endsWith('.json') && old(f)) rmSync(f, { force: true });
    }
  } catch {
    // a prune that fails must not stop a start
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
      /** The Claude accounts of this workstation (main + additional); without it only `main` exists. */
      accounts?: ClaudeAccountRegistry;
      /** The provider credentials of this workstation: the Bedrock, Vertex and gateway backends read theirs here. */
      providers?: ProviderStore;
      /** Test hook (runner-bare-bin [A11]): the model upstream of the boxes' route (a fake API on 127.0.0.1). */
      modelUpstream?: string;
      /** Test hook: the boxes' egress proxy may reach loopback (the fake API). Never passed by registry.ts. */
      proxyTest?: { allowPrivate: true; resolve?: (host: string) => Promise<string> };
      /** Test hook (B6): what each boxed model request used, refused or stripped; it never changes the verdict. */
      modelCapture?: ModelCapture;
    } = {},
  ) {
    this.registry =
      host.accounts ??
      new ClaudeAccountRegistry({
        home: host.home ?? homedir(),
        ...(paths ? { root: paths.root } : {}),
        accounts: () => [],
        mainCredential: () => this.live,
        ...(host.auth ? { mainAuth: host.auth } : {}),
        ...(host.usage ? { mainUsage: host.usage } : {}),
        ...(host.now ? { now: host.now } : {}),
        ...(host.zone ? { zone: host.zone } : {}),
      });
  }

  /** The accounts (main first). Built here when the runner did not hand one in (unit tests, the CLI). */
  readonly registry: ClaudeAccountRegistry;

  /** The account a session runs on (`main` when none is named); throws for a key this workstation does not know. */
  private account(key: string | undefined): ClaudeAccount {
    const a = this.registry.get(key ?? MAIN_ACCOUNT);
    if (!a) throw new Error(`account_missing:${key}`);
    return a;
  }

  /** The runtime configuration an account's sessions run with (see `accountClaudeConfig`). */
  private liveFor(a: ClaudeAccount): ClaudeConfig {
    return a.main ? this.live : accountClaudeConfig(this.cfg, a.credential());
  }

  /**
   * Before a shift: may it run on this account? Says why not otherwise. The runner's supervisor turns the answer into
   * `runtime_unavailable` (account_missing), `usage_limited` or `auth_expired`, each with the account key.
   */
  accountGate(key: string): AccountGate {
    const a = this.registry.get(key);
    if (!a) return { state: 'missing' };
    if (a.auth.state !== 'ok') return { state: 'login', login: a.auth.state === 'none' ? 'none' : 'expired' };
    if (a.usage.state === 'limited') {
      const until = a.usage.limitedUntil;
      return {
        state: 'limited',
        ...(until
          ? { limitedUntil: until, label: formatLimitTime(new Date(until), this.nowDate(), this.host.zone) }
          : {}),
      };
    }
    return { state: 'ok' };
  }

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

  /** A "Scan with DevOps" needs the OS sandbox enforced; `off` and "unsandboxed by choice" do not count. */
  private assertScanSandbox(): void {
    const missing = sandboxMissing(this.host.platform, this.host.pathVar);
    if (missing)
      throw new Error(
        `A scan runs inside the OS sandbox and this computer cannot provide it: ${missing}. Install bubblewrap and socat (apt install bubblewrap socat), or run the runner in WSL2/Linux/macOS; then scan again.`,
      );
  }

  /**
   * quiet-approvals [B2] (fail closed): a DevOps request inside the box needs the OS sandbox this platform provides,
   * whatever the runner's sandbox mode says; otherwise it does not start (the runner holds it as `devops.task`).
   */
  boxMissing(): string | null {
    // macOS: the boxes are Seatbelt profiles applied by the runner (S5)
    if (this.host.platform === 'darwin')
      return macBoxMissing() ?? (this.modelCredential() ? null : NEEDS_API_KEY);
    const missing = sandboxMissing(this.host.platform, this.host.pathVar);
    if (missing) return missing;
    const bw = probeBwrap();
    if (!bw.ok) return bw.reason;
    const hs = probeHarnessSandbox(this.host.platform);
    if (!hs.ok) return hs.reason;
    return this.modelCredential() ? null : NEEDS_API_KEY;
  }

  private assertBox(): void {
    const missing = this.boxMissing();
    if (missing) throw new Error(`the safety box for DevOps cannot start on this computer: ${missing}`);
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
      scopedVaults?: Array<{ dir: string; keep: string }>;
      toolchainReadDirs?: string[];
      extraAllowedDomains?: string[];
      testServiceDomains?: string[];
      devopsGuard?: { access?: { allowInstall: boolean; allowedPaths: string[] } };
    },
    cwd: string,
    /** A chat never writes: the repository metadata of its worktree is read-only there, not a writable dir. */
    chat = false,
    guardHookCommand?: string,
    readOnlyScan = false,
  ): ClaudePolicyContext {
    const root = this.paths?.root ?? dirname(dirname(input.sandbox.home));
    const script = selfCommand('aom').at(-1);
    const nugetFallbackDir = userNugetPackages(this.realHome());
    const sessionEnvDir = sessionEnvDirOf(input.env.AOM_SHIFT_ENV_FILE, root);
    return {
      runnerRoot: root,
      ...(sessionEnvDir ? { sessionEnvDir } : {}),
      agentDir: dirname(input.sandbox.home),
      cwd,
      addDirs: input.addDirs ?? [],
      gitDirs: chat ? [] : gitDirsOf(cwd),
      readDirs: input.readDirs ?? [],
      ...(input.scopedVaults?.length ? { scopedVaults: input.scopedVaults } : {}),
      aomReadPaths: [this.paths?.bin ?? join(root, 'bin'), ...(script ? [dirname(script)] : [])],
      ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
      ...(input.env.AOM_IPC_URL ? { ipcUrl: input.env.AOM_IPC_URL } : {}),
      realHome: this.realHome(),
      accountDirs: this.registry.list().flatMap((a) => (a.configDir ? [a.configDir] : [])),
      mode: this.cfg.sandbox,
      extraAllowedDomains: [...this.cfg.extraAllowedDomains, ...(input.extraAllowedDomains ?? [])],
      ...(input.testServiceDomains?.length ? { testServiceDomains: input.testServiceDomains } : {}),
      toolchainReadPaths: toolchainReadPaths([
        ...(this.cfg.toolchainPaths ?? []),
        ...(input.toolchainReadDirs ?? []),
      ]),
      sharedCacheDir: input.sandbox.cacheRoot ?? join(root, 'cache'),
      ...(nugetFallbackDir ? { nugetFallbackDir } : {}),
      ...(process.platform === 'linux'
        ? { dotnetShmDir: DOTNET_SHM_DIR, pnpmLockDirs: usablePnpmLockDirs() }
        : {}),
      otherAgentTmps: this.paths ? otherAgentTmps(this.paths, dirname(input.sandbox.home)) : [],
      ...(guardHookCommand ? { guardHookCommand } : {}),
      ...(readOnlyScan ? { readOnlyScan: true } : {}),
      // T2: no agent reads or writes the local authority's folder
      policyDir: localPolicyDir(),
      // T10: the DevOps engineer's Edit and Write tools reach only its own folders and what the switches open
      ...(input.devopsGuard?.access
        ? {
            devopsWriteRoots: [
              tmpdir(),
              '/tmp',
              '/var/tmp',
              ...input.devopsGuard.access.allowedPaths.filter(
                (p) =>
                  isAbsolute(p) &&
                  alwaysPathRefusal(p, {
                    home: this.realHome(),
                    policyRoot: localPolicyDir(),
                    worktrees: join(root, 'worktrees'),
                    runnerRoot: root,
                  }) === null,
              ),
              ...(input.devopsGuard.access.allowInstall ? detectionRoots(this.realHome()) : []),
            ],
          }
        : {}),
    };
  }

  /**
   * The DevOps guard (devops/guard.ts): writes the hook's configuration into the agent's config dir and returns the hook
   * command and the file's path (the hook finds it through `AOM_DEVOPS_GUARD`). Nothing without runner paths (unit tests).
   */
  private devopsGuard(
    configDir: string,
    guard: DevopsGuardInput | undefined,
    kind: 'shift' | 'chat',
    sandbox?: { home: string; scratch: string; tmp: string },
  ): { command: string; file: string; cfg: GuardConfig } | undefined {
    if (!guard || !this.paths) return undefined;
    // T10: where the session writes without the paths switch; with installs on, also the toolchain folders
    const writeRoots = [
      ...(sandbox ? [sandbox.home, sandbox.scratch, sandbox.tmp] : []),
      tmpdir(),
      '/tmp',
      '/var/tmp',
      ...(guard.access?.allowInstall ? detectionRoots(this.realHome()) : []),
    ];
    const cfg: GuardConfig = {
      sessionRef: guard.sessionRef,
      kind,
      deleteRoots: deleteRootsFor(this.paths.root),
      home: this.realHome(),
      protectedBranches: guard.protectedBranches ?? [],
      approvedCommands: guard.approvedCommands ?? [],
      ...(guard.readOnlyScan ? { readOnlyScan: true } : {}),
      ...(guard.shiftKind ? { shiftKind: guard.shiftKind } : {}),
      frozenBranches: guard.frozenBranches ?? [],
      ...(guard.appRepos?.length ? { appRepos: guard.appRepos } : {}),
      ...(guard.identityEmail ? { identityEmail: guard.identityEmail } : {}),
      // uat-runner-fixes-3 finding 2: never a write or commit in a card worktree (runner configuration, not the prompt)
      cardWorktreesRoot: this.paths.worktrees,
      ...(guard.installScriptsOff ? { installScriptsOff: true } : {}),
      // T2: the shell never touches the local approval settings, and runs only the read-only runner CLI verbs
      policyRoot: localPolicyDir(),
      ...(guard.access ? { access: guard.access, writeRoots } : {}),
      secretRoots: ['secrets', 'keys', 'config.json'].map((d) => join(this.paths?.root ?? '', d)),
      auditFile: join(this.paths.logs, 'devops-audit.jsonl'),
    };
    const file = guardFileFor(configDir, kind, guard.sessionRef);
    pruneGuardFiles(configDir);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
    const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
    return { command: `${[...selfCommand('aom'), 'devops-guard'].map(quote).join(' ')}`, file, cfg };
  }

  /** A start that failed after the guard file was written leaves nothing behind. */
  private dropGuardFile(
    input: { agent: { isDevops?: boolean }; sandbox: { configDir: string } },
    kind: 'shift' | 'chat',
    ref: string | undefined,
  ): void {
    if (!input.agent.isDevops || !ref) return;
    try {
      rmSync(guardFileFor(input.sandbox.configDir, kind, ref), { force: true });
    } catch {
      // nothing to remove
    }
  }

  private warnedTruncated = false;

  /** The accounts as reported in hello / runtimes.report: at most `MAX_REPORTED_ACCOUNTS` (main first), so validation never fails. */
  private accountInfos(): ClaudeAccountInfo[] {
    const all = this.registry.infos();
    if (all.length <= MAX_REPORTED_ACCOUNTS) return all;
    if (!this.warnedTruncated) {
      this.warnedTruncated = true;
      process.stderr.write(
        `claude-code: ${all.length} accounts are configured; only the first ${MAX_REPORTED_ACCOUNTS} (main first, then by key) are reported to the server\n`,
      );
    }
    return all.slice(0, MAX_REPORTED_ACCOUNTS);
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = ['shell', 'edit', 'web', 'mcp', 'skills', 'sandbox_config', 'resume'];
    // Reported unavailable in mock/test mode so the server never picks it for an agent (it also refuses to start).
    if (realClaudeBlocked())
      return { runtime: this.id, version: 'blocked', available: false, capabilities: [] };
    const sb = this.sandboxStatus();
    // The top-level fields describe the main account (older servers read only these); `available` below asks whether
    // ANY account can take a shift, and the server picks per account from `accounts`.
    const main = this.registry.main;
    const expired = main.auth.state === 'expired';
    const limited = main.usage.state === 'limited';
    const reportsMonitors = this.host.auth !== undefined || this.host.accounts !== undefined;
    const reportsUsage = this.host.usage !== undefined || this.host.accounts !== undefined;
    const anyUsable = this.registry.anyUsable();
    const sandbox = {
      sandbox: sb.state,
      sandboxReason: sb.reason,
      ...(reportsMonitors ? { auth: expired ? ('expired' as const) : ('ok' as const) } : {}),
      ...(reportsUsage
        ? {
            usage: limited ? ('limited' as const) : ('ok' as const),
            ...(limited && main.usage.limitedUntil
              ? {
                  limitedUntil: main.usage.limitedUntil,
                  limitedLabel: formatLimitTime(
                    new Date(main.usage.limitedUntil),
                    this.nowDate(),
                    this.host.zone,
                  ),
                }
              : {}),
          }
        : {}),
      ...(this.host.accounts ? { accounts: this.accountInfos() } : {}),
    };
    // Credentials for Bedrock, Vertex or a gateway: agents on those models need no Claude login.
    const backends = this.host.providers?.reportBackends() ?? [];
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
      // No account can take a shift (every login expired or never completed, or every usage limit hit): the runtime is
      // paused until a probe works (backlog #73). One usable account keeps it available.
      if (!anyUsable && backends.length === 0) ok = false;
      return {
        runtime: this.id,
        version: m[0],
        available: ok,
        capabilities: ok ? caps : [],
        ...sandbox,
        ...(backends.length ? { backends } : {}),
      };
    } catch {
      return { runtime: this.id, version: 'unknown', available: false, capabilities: [], ...sandbox };
    }
  }

  /**
   * The agent's granted skills (`grantedSkills`, absent: leave the folder alone): wipes and rewrites `<config dir>/skills`
   * with exactly those, so nothing of an earlier shift stays and the account's own skills are never copied in, and adds the
   * allow-list hook that refuses every other `Skill` call (the account's synced skills and plugins load natively otherwise).
   * Returns the input with only the skills that were written.
   */
  private prepareSkills<
    T extends { grantedSkills?: GrantedSkill[]; agent: { isDevops?: boolean }; env: Record<string, string> },
  >(dir: string, input: T, settings: ClaudeSettings): T {
    if (input.grantedSkills === undefined || input.agent.isDevops) return input;
    const written = materializeSkills(skillsDirOf(dir), input.grantedSkills);
    const kept = input.grantedSkills.filter((g) => written.includes(g.name));
    if (kept.length === 0) return { ...input, grantedSkills: [] };
    const file = join(dir, 'skill-guard.json');
    writeFileSync(file, `${JSON.stringify({ allowed: written })}\n`, { mode: 0o600 });
    const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
    // Claude Code lets the call through when a hook fails in any way but exit 2 (the command is not found: 127, it crashed). The
    // `|| exit 2` makes every failure of the guard, a missing `aom` included, a refusal. A hook that is killed at its time
    // limit still counts as failed-open, so the guard has its own 7 s deadline below the 10 s limit and denies by itself; the
    // deny rules below are the second line for names we can list.)
    const command = `${hookPrefix(dir, input.env)}AOM_SKILL_GUARD=${quote(file)} ${[...selfCommand('aom'), 'skill-guard'].map(quote).join(' ')} || exit 2`;
    settings.hooks = {
      PreToolUse: [
        ...(settings.hooks?.PreToolUse ?? []),
        { matcher: 'Skill', hooks: [{ type: 'command' as const, command, timeout: 10 }] },
      ],
    };
    settings.permissions.deny = [
      ...new Set([
        ...settings.permissions.deny,
        'Skill(anthropic-skills:*)',
        // every skill the accounts on this workstation have of their own and the agent was not granted
        ...this.accountSkillNames()
          .filter((n) => !written.includes(n))
          .map((n) => `Skill(${n})`),
      ]),
    ];
    return { ...input, grantedSkills: kept };
  }

  /**
   * Native subagents (the `Agent` tool). Claude Code lets the model start its own subagent types (`general-purpose`, `Explore`,
   * ...) whatever the permission mode says (verified with claude 2.1.309), on the parent's model and outside every grant. So
   * the tool is removed for every agent that has no delegation target (a deny rule), and for one that has, only its granted
   * targets are defined (`--agents`), kept in the foreground (the parent waits for each), and a PreToolUse hook (`aom
   * subagent-guard`) refuses every other type and asks the server before each granted one. The DevOps engineer and the CEO keep
   * their own behaviour.
   */
  private prepareSubagents<
    T extends {
      subagents?: NativeSubagent[];
      agent: { isDevops?: boolean; roleKey: string };
      env: Record<string, string>;
    },
  >(dir: string, input: T, settings: ClaudeSettings): T {
    if (input.agent.isDevops || input.agent.roleKey === 'ceo') return input;
    const subs = input.subagents ?? [];
    if (subs.length === 0) {
      settings.permissions.deny = [...new Set([...settings.permissions.deny, 'Agent', 'Task'])];
      return input;
    }
    writeFileSync(join(dir, AGENTS_FILE), `${JSON.stringify(agentsDocument(subs))}\n`, { mode: 0o600 });
    const guardFile = join(dir, 'subagent-guard.json');
    // the running calls leave their start here (the time limit's clock); emptied at every session start
    const liveDir = join(dir, 'subagent-live');
    rmSync(liveDir, { recursive: true, force: true });
    mkdirSync(liveDir, { recursive: true, mode: 0o700 });
    const limits = Object.fromEntries(
      subs.filter((x) => x.timeoutSec).map((x) => [x.name, x.timeoutSec as number]),
    );
    writeFileSync(
      guardFile,
      `${JSON.stringify({
        allowed: Object.fromEntries(subs.map((x) => [x.name, x.handle])),
        ...(Object.keys(limits).length ? { limits, stateDir: liveDir } : {}),
      })}\n`,
      { mode: 0o600 },
    );
    const quote = (w: string) => `'${w.replace(/'/g, `'\\''`)}'`;
    // `|| exit 2`: any failure of the guard, a missing `aom` included, is a refusal (a hook that fails any other way lets the call through)
    const pre = hookPrefix(dir, input.env);
    const command = `${pre}AOM_SUBAGENT_GUARD=${quote(guardFile)} ${[...selfCommand('aom'), 'subagent-guard'].map(quote).join(' ')} || exit 2`;
    const aom = (verb: string) => [...selfCommand('aom'), verb].map(quote).join(' ');
    // R3c, the time limit of one call: every tool call is checked against the start markers, but only when a call is running (the
    // shell test costs nothing; the node process starts only then). The end of an `Agent` call removes its marker. Fail closed.
    // Fails closed: a folder that is gone, or a deadline hook that cannot even start, refuses the tool call (exit 2). The hook itself
    // answers with a decision, so its own failures are refusals too (aom subagent-deadline).
    const deadline = `[ -d ${quote(liveDir)} ] || exit 2; [ -n "$(ls -A ${quote(liveDir)} 2>/dev/null)" ] || exit 0; ${pre}AOM_SUBAGENT_GUARD=${quote(guardFile)} ${aom('subagent-deadline')} || exit 2`;
    const done = `${pre}AOM_SUBAGENT_GUARD=${quote(guardFile)} ${aom('subagent-done')} || exit 0`;
    settings.hooks = {
      PreToolUse: [
        ...(settings.hooks?.PreToolUse ?? []),
        { matcher: 'Agent|Task', hooks: [{ type: 'command' as const, command, timeout: 10 }] },
        ...(Object.keys(limits).length
          ? [{ matcher: '*', hooks: [{ type: 'command' as const, command: deadline, timeout: 10 }] }]
          : []),
      ],
      ...(Object.keys(limits).length
        ? {
            PostToolUse: [
              { matcher: 'Agent|Task', hooks: [{ type: 'command' as const, command: done, timeout: 10 }] },
            ],
          }
        : {}),
    };
    settings.permissions.allow = [
      ...new Set([...settings.permissions.allow, ...subs.map((x) => `Agent(${x.name})`)]),
    ];
    // the second line, for the types we can name; the hook is the allow-list for the rest
    settings.permissions.deny = [
      ...new Set([
        ...settings.permissions.deny,
        // not a bare `Task`: that is the old name of the same tool and would remove it for the granted types too
        ...['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide'].map(
          (n) => `Agent(${n})`,
        ),
      ]),
    ];
    return { ...input, env: { ...input.env, ...NATIVE_SUBAGENT_ENV, AOM_SUBAGENT_GUARD: guardFile } };
  }

  /** Names of the skills in the accounts' own skills folders (`<config dir>/skills/*`): what can be listed is denied outright. */
  private accountSkillNames(): string[] {
    const dirs = [
      join(homedir(), '.claude', 'skills'),
      ...this.registry.list().flatMap((a) => (a.configDir ? [join(a.configDir, 'skills')] : [])),
    ];
    const names = new Set<string>();
    for (const d of dirs) {
      try {
        for (const n of readdirSync(d)) if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) names.add(n);
      } catch {
        // no such folder
      }
    }
    return [...names].sort();
  }

  async writeInstructions(sandbox: { configDir: string }, markdown: string): Promise<void> {
    await mkdir(sandbox.configDir, { recursive: true });
    await writeFile(join(sandbox.configDir, 'CLAUDE.md'), markdown);
  }

  /**
   * A session whose model names a backend (`bedrock:<id>`): the credential of this workstation (its own, else the organization's),
   * the environment that points the claude process at it, and the cleanup. Throws when the role cannot take a backend credential or
   * the backend is not set up here. The credential reaches only this agent's claude process.
   */
  private backendSession(
    agent: { model: string; roleKey: string; isDevops?: boolean },
    sessionRef: string,
    orgId?: string,
    /** The project's account for this backend (S-A): a named account of this workstation, or `org`. Absent: main. */
    account?: string,
  ):
    | {
        model: string;
        backend: NonNullable<ReturnType<typeof backendOfModel>>['backend'];
        source: 'org' | 'workstation';
        env: Record<string, string>;
        cleanup: () => void;
      }
    | undefined {
    const b = backendOfModel(agent.model);
    if (!b) return undefined;
    const role = backendRoleProblem(agent);
    if (role) throw new Error(`runtime_role_refused: ${role}`);
    const cred = this.host.providers?.getBackend(b.backend, orgId, account);
    if (!cred)
      throw new Error(
        account && account !== 'main'
          ? `${b.backend} has no account ${account} on this workstation: add it under Integrations, AI runtime`
          : `${b.backend} is not set up on this workstation: add its credentials under Workstations > Model providers (or ask an Owner or Admin to share the organization's)`,
      );
    let vertexKeyFile: string | undefined;
    if (b.backend === 'vertex')
      vertexKeyFile = writeVertexKey(
        this.paths?.secrets ?? join(homedir(), '.aom-runner', 'secrets'),
        sessionRef,
        cred.fields.serviceAccountJson ?? '',
      );
    return {
      model: b.model,
      backend: b.backend,
      source: cred.source,
      env: backendProcessEnv(cred, b.model, vertexKeyFile ? { vertexKeyFile } : {}),
      cleanup: () => removeVertexKey(vertexKeyFile),
    };
  }

  /** The runtime configuration of a backend session: no Claude token of this workstation reaches it. */
  private noClaudeToken(cfg: ClaudeConfig): ClaudeConfig {
    const { oauthToken: _o, apiKey: _k, ...rest } = cfg;
    return { ...rest, authMode: 'default' };
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    if (realClaudeBlocked()) throw new RealClaudeBlockedError();
    // The DevOps engineer runs without the OS sandbox, so a missing bwrap/socat does not stop it. A scan is the exception:
    // it runs inside the sandbox or not at all (fail closed, whatever the runner's sandbox mode says).
    if (input.devopsBox) this.assertBox();
    else if (input.agent.isDevops && input.devopsGuard?.readOnlyScan === true) this.assertScanSandbox();
    else if (!input.agent.isDevops) this.assertCanRun();
    // a backend model (Bedrock, Vertex, a gateway) has no Claude login: its `account` names a credential of the backend, not a Claude account
    const account = this.account(backendOfModel(input.agent.model) ? undefined : input.account);
    const bk = this.backendSession(input.agent, input.shiftId, input.orgId, input.account);
    // The Vertex key file exists from here on: whatever fails before the process runs (and so before its exit hook can remove
    // the file) removes it.
    try {
      return await this.startShiftSession(input, account, bk);
    } catch (err) {
      bk?.cleanup();
      this.dropGuardFile(input, 'shift', input.devopsGuard?.sessionRef);
      throw err;
    }
  }

  /**
   * runner-bare-bin (blocker 1): the Claude Code binary of every boxed start. A bare `bin` ("claude", the default) is looked up
   * on the runner process's own PATH (never the agent PATH, which DevOps can extend), then its real path is checked (R2: not
   * under a folder a box or agent writes; R3: nobody but this user or root can change it or a folder above it). The real path
   * is what the box binds (its folder, read-only) and runs, exactly as an absolute `bin` would. Fails closed with the reason.
   */
  private boxedBin(): { path: string; real: string } {
    const r = lookupBin(this.cfg.bin, this.host.pathVar ?? process.env.PATH ?? '', {
      forbiddenRoots: [
        ...(this.paths ? [this.paths.root] : []),
        toolchainsRoot(),
        agentTmpRoot(),
        tmpdir(),
        '/tmp',
        '/var/tmp',
        '/dev/shm',
      ],
      uid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    });
    if (!r.ok) throw new Error(`could not start claude-code: ${r.reason}`);
    return { path: r.path, real: r.real };
  }

  /** runner-bare-bin (B2): the session's model ledger, and the route options that feed it. */
  private modelRoute(
    serverTools: 'none' | 'web_search',
    audit?: {
      sink: NonNullable<ShiftStartInput['boxAudit']>;
      sessionRef: string;
      shiftKind: 'devops' | 'release_prep';
    },
  ): { ledger: ModelLedger; upstream: string; opts: Parameters<typeof modelProxyPlan>[2] } {
    const ledger = new ModelLedger(
      audit ? { audit: audit.sink, sessionRef: audit.sessionRef, shiftKind: audit.shiftKind } : {},
    );
    return {
      ledger,
      upstream: this.host.modelUpstream ?? MODEL_UPSTREAM,
      opts: {
        serverTools,
        observe: ledger.observer(),
        ...(this.host.modelCapture ? { capture: this.host.modelCapture } : {}),
      },
    };
  }

  /**
   * quiet-approvals phase B: the credential the model proxy adds for a boxed session (never put into the box), or null
   * when this computer has none the proxy can carry.
   */
  modelCredential(accountKey?: string): ModelCredential | null {
    const account = this.account(accountKey);
    const cfg = this.liveFor(account);
    if (cfg.authMode === 'api_key' && cfg.apiKey) return { kind: 'api_key', apiKey: cfg.apiKey };
    if (cfg.authMode === 'oauth' && cfg.oauthToken) return { kind: 'oauth_token', token: cfg.oauthToken };
    const file = account.main
      ? join(this.realHome(), '.claude', '.credentials.json')
      : account.canonicalFile();
    return file && existsSync(file) ? { kind: 'login', credentialsFile: file } : null;
  }

  /**
   * quiet-approvals phase B (D7 (b)): a DevOps session in a box the runner builds (inner: the builder-like profile; outer:
   * the DevOps profile), Claude Code's own sandbox off, a fresh config dir per level and request (S9), the model through
   * the proxy (S10). Fails closed: no bubblewrap, no harness sandbox or no credential the proxy can carry throws.
   */
  private async startBoxedSession(input: ShiftStartInput, account: ClaudeAccount): Promise<RuntimeSession> {
    const level: BoxLevel = input.devopsBox ? 'inner' : 'outer';
    // runner-bare-bin: the binary first, before any config dir, guard, Docker proxy or launch
    const bin = this.boxedBin();
    if (this.host.platform === 'darwin') return this.startMacBoxedSession(input, account, level, bin);
    const bw = probeBwrap();
    if (!bw.ok) throw new Error(`the DevOps safety box cannot start on this computer: ${bw.reason}`);
    const hs = probeHarnessSandbox(this.host.platform);
    if (!hs.ok) throw new Error(`the DevOps safety box cannot start on this computer: ${hs.reason}`);
    const cred = this.modelCredential(input.account);
    if (!cred) throw new Error(NEEDS_API_KEY);
    const requestId = input.boxRequestId as string;
    const agentDir = dirname(input.sandbox.home);
    const configDir = boxConfigDir(agentDir, level, requestId);
    const tmp = join(input.sandbox.tmp, requestId);
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const root = this.paths?.root ?? dirname(dirname(agentDir));
    // the outer box keeps the DevOps guard (T2, T9, T10 as built: defence in depth). Its file sits beside the config dir,
    // read-only in the box, so the session cannot rewrite its own guard.
    const guardDir = `${configDir}.guard`;
    rmSync(guardDir, { recursive: true, force: true });
    const guard =
      level === 'outer' ? this.devopsGuard(guardDir, input.devopsGuard, 'shift', input.sandbox) : undefined;
    if (level === 'outer' && !guard)
      throw new Error('the DevOps guard could not be attached to the outer box');
    if (guard) input = { ...input, env: { ...input.env, AOM_DEVOPS_GUARD: guard.file } };
    const policyCtx = this.policy(input, input.cwd, false, guard?.command);
    // R4-B2: Docker only through the gatekeeper; its socket sits in a runner-owned folder, read-only in the box.
    // devops-box-access: Docker and the Desk folders start before the settings (the plan binds them); from here until the
    // spawn, a throw closes both.
    let docker: { proxy: DockerProxy; dir: string; socket: string } | undefined;
    const opened: Array<{ fd: number; real: string; close(): void }> = [];
    const closeFds = () => {
      for (const f of opened.splice(0)) f.close();
    };
    const closeDocker = async () => {
      if (!docker) return;
      const d = docker;
      docker = undefined;
      await d.proxy.close().catch(() => undefined);
      rmSync(d.dir, { recursive: true, force: true });
    };
    let launch: Awaited<ReturnType<typeof launchInHarnessSandbox>> | undefined;
    try {
      if (level === 'outer' && input.dockerGate) {
        const gdir = mkdtempSync(join(tmpdir(), 'aom-dk-'));
        chmodSync(gdir, 0o755);
        const socket = join(gdir, 'docker.sock');
        const bindRoots = [input.cwd];
        // REVIEW S5: a card worktree is only ever bound read-only into a container
        const roBindRoots = cardWorktreeRoots(join(root, 'worktrees'));
        try {
          const proxy = await startDockerProxy({
            socketPath: socket,
            upstream: input.dockerGate.upstream,
            policy: {
              instance: input.dockerGate.instance,
              bindRoots,
              roBindRoots,
              containerEgress: input.dockerGate.containerEgress,
            },
          });
          docker = { proxy, dir: gdir, socket };
        } catch (err) {
          rmSync(gdir, { recursive: true, force: true });
          throw err;
        }
      }
      // REVIEW S2 (R5-B1 rule 4): a Desk folder grant inside the ceiling is bound by the fd the runner checked
      const nl = {
        home: this.realHome(),
        policyRoot: localPolicyDir(),
        worktrees: join(root, 'worktrees'),
        runnerRoot: root,
      };
      if (level === 'outer')
        for (const p of input.devopsGuard?.access?.allowedPaths ?? []) {
          const r = openCheckedFolder(p, input.ceilingRoots ?? [], nl);
          if (r.ok) opened.push(r.folder);
          else process.stderr.write(`WARN DevOps box: ${r.reason}\n`);
        }
      const baseSettings =
        level === 'inner'
          ? buildDevopsBoxSettings(input.agent.permissions, policyCtx, { ...input.sandbox, configDir })
          : buildShiftSettings(
              input.agent.permissions,
              policyCtx,
              { ...input.sandbox, configDir },
              'devops',
              true,
            );
      // the box is the boundary: Claude Code's own sandbox is off inside it (never nested)
      delete (baseSettings as { sandbox?: unknown }).sandbox;
      resetBoxConfigDir(configDir, {
        settings: baseSettings,
        mcp: { mcpServers: {} },
        instructions: input.instructionsMarkdown,
        ...(input.resumeSessionId ? { keepSession: input.resumeSessionId } : {}),
      });
      mkdirSync(join(configDir, 'home'), { recursive: true, mode: 0o700 });
      // devops-box-access: the plan first (its folders exist now), then the settings list exactly what it binds
      const planInput: BoxPlanInput = {
        level,
        requestDir: input.cwd,
        ...(opened.length
          ? { fdBinds: opened.map((f, i) => ({ fdIndex: 3 + i, real: f.real, writable: true })) }
          : {}),
        configDir,
        tmp,
        aomReadPaths: policyCtx.aomReadPaths,
        plumbingReadPaths: [
          ...(guard ? [guardDir] : []),
          ...(docker ? [docker.dir] : []),
          ...(input.boxReadOnly ?? []),
        ],
        claudeBin: bin.real,
        toolchainReadDirs: policyCtx.toolchainReadPaths ?? [],
        cloneDirs: input.readDirs ?? [],
        ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
        ...(level === 'outer'
          ? {
              outer: {
                devopsTools: join(root, 'devops-tools'),
                cardWorktrees: join(root, 'worktrees'),
                realHome: this.realHome(),
              },
            }
          : {}),
      };
      const boxPlan = boxSandbox(planInput);
      const bound = new Set(boundDirsOf(boxPlan));
      const settings = withBoxWorkDirs(
        baseSettings,
        boxWorkDirs(planInput, (p) => bound.has(p), systemRoBinds()),
      );
      writeBoxSettings(configDir, settings);
      // B1: web search only where the session's settings allow it (the outer box); B2: the ledger outside the box
      const mr = this.modelRoute(level === 'outer' ? 'web_search' : 'none', this.auditOf(input));
      const plan = modelProxyPlan(cred, mr.upstream, mr.opts);
      const boxSb = { ...input.sandbox, configDir, home: join(configDir, 'home'), tmp };
      // devops-box-access: no --add-dir; the settings list the folders (the box's own, never a separate list)
      const cmd = buildClaudeCommand(
        { ...input, sandbox: boxSb, addDirs: [], readDirs: [] },
        this.noClaudeToken(this.liveFor(account)),
      );
      const env: Record<string, string> = {
        ...cmd.env,
        ...boxedClaudeEnv(plan, BRIDGE_PORT),
        ...(docker ? { DOCKER_HOST: `unix://${docker.socket}` } : {}),
      };
      delete env.ANTHROPIC_API_KEY;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      Object.assign(env, plan.env);
      // REVIEW S3: git over ssh goes through the egress proxy too (only to the project's own remotes and deploy targets)
      if (level === 'outer') env.GIT_SSH_COMMAND = sshThroughProxy(BRIDGE_PORT);
      launch = await launchInHarnessSandbox({
        routes: [plan.route],
        // S5: no direct line to any model service; the model only through the route
        cliHosts: [],
        ...(this.host.proxyTest ? { proxyTest: this.host.proxyTest } : {}),
        extraHosts: [
          ...this.cfg.extraAllowedDomains,
          ...(level === 'outer' ? (input.outerEgress?.hosts ?? []) : []),
        ],
        // Rework 2 (REVIEW B4): names only at public addresses (resolved at every connect); private only for literals
        ...(level === 'outer' && input.outerEgress?.endpoints.length
          ? { publicEndpoints: input.outerEgress.endpoints }
          : {}),
        ...(level === 'outer' && input.outerEgress?.privateEndpoints.length
          ? { privateEndpoints: input.outerEgress.privateEndpoints }
          : {}),
        sandbox: boxPlan,
        // the install is bound by its real folder: start it by its checked real path (a ~/.local/bin link is not in the box)
        cmd: { bin: bin.real, args: cmd.args, env },
      });
      mkdirSync(join(root, 'devops-tools'), { recursive: true, mode: 0o700 });
      const parser = new ClaudeStreamParser();
      const l = launch;
      const dk = docker;
      const session = spawnSession({
        bin: l.command.bin,
        args: l.command.args,
        cwd: input.cwd,
        env: l.command.env,
        inheritEnv: false,
        ...(opened.length ? { extraFds: opened.map((f) => f.fd) } : {}),
        ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
        parseLine: (line) => parser.parseLine(line),
        // B2, S6: usage, login and limits from the proxy's ledger, never from what the box prints
        usage: () => mr.ledger.usage(),
        authFailure: () => mr.ledger.authFailed,
        usageLimit: () => mr.ledger.usageLimit(),
        contextTokens: () => parser.contextTokens(),
        logFile: input.logFile,
        exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
        onExit: async () => {
          // S5: what the box asked for and was refused (host names only), for the owner's diagnosis
          const denied = l.proxy.denied();
          if (denied.length)
            process.stderr.write(
              `WARN DevOps box (${level}): egress refused for ${denied.slice(0, 20).join(', ')}\n`,
            );
          // the per-session bearer dies with the proxy (revoked at the session's end)
          await l.cleanup();
          if (dk) {
            await dk.proxy.close().catch(() => undefined);
            rmSync(dk.dir, { recursive: true, force: true });
          }
        },
      });
      // the session owns Docker and the launch from here (closed in onExit)
      docker = undefined;
      launch = undefined;
      // B5: the guard the runner wrote, kept in memory for the runner's own judgement of a blocked command
      return guard ? Object.assign(session, { guardConfig: guard.cfg }) : session;
    } catch (err) {
      await launch?.cleanup();
      await closeDocker();
      throw err;
    } finally {
      // the child holds its own copies of the fds after spawn
      closeFds();
    }
  }

  /** runner-bare-bin (S7): the ledger's audit sink of a boxed DevOps shift (absent without one). */
  private auditOf(input: ShiftStartInput):
    | {
        sink: NonNullable<ShiftStartInput['boxAudit']>;
        sessionRef: string;
        shiftKind: 'devops' | 'release_prep';
      }
    | undefined {
    if (!input.boxAudit) return undefined;
    return {
      sink: input.boxAudit,
      sessionRef: input.shiftId,
      shiftKind:
        input.devopsGuard?.shiftKind === 'release_prep' || input.kind === 'release_prep'
          ? 'release_prep'
          : 'devops',
    };
  }

  /** quiet-approvals S5: the same session on macOS, in the Seatbelt profile of its level (unit-tested; Mac QA required). */
  private async startMacBoxedSession(
    input: ShiftStartInput,
    account: ClaudeAccount,
    level: BoxLevel,
    bin: { path: string; real: string },
  ): Promise<RuntimeSession> {
    const missing = macBoxMissing();
    if (missing) throw new Error(`the DevOps safety box cannot start on this computer: ${missing}`);
    const cred = this.modelCredential(input.account);
    if (!cred) throw new Error(NEEDS_API_KEY);
    const requestId = input.boxRequestId as string;
    const agentDir = dirname(input.sandbox.home);
    const configDir = boxConfigDir(agentDir, level, requestId);
    const tmp = join(input.sandbox.tmp, requestId);
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const root = this.paths?.root ?? dirname(dirname(agentDir));
    // the outer box keeps the DevOps guard, its file read-only beside the config dir (as on Linux)
    const guardDir = `${configDir}.guard`;
    rmSync(guardDir, { recursive: true, force: true });
    const guard =
      level === 'outer' ? this.devopsGuard(guardDir, input.devopsGuard, 'shift', input.sandbox) : undefined;
    if (level === 'outer' && !guard)
      throw new Error('the DevOps guard could not be attached to the outer box');
    if (guard) input = { ...input, env: { ...input.env, AOM_DEVOPS_GUARD: guard.file } };
    const policyCtx = this.policy(input, input.cwd, false, guard?.command);
    const baseSettings =
      level === 'inner'
        ? buildDevopsBoxSettings(input.agent.permissions, policyCtx, { ...input.sandbox, configDir })
        : buildShiftSettings(
            input.agent.permissions,
            policyCtx,
            { ...input.sandbox, configDir },
            'devops',
            true,
          );
    delete (baseSettings as { sandbox?: unknown }).sandbox;
    resetBoxConfigDir(configDir, {
      settings: baseSettings,
      mcp: { mcpServers: {} },
      instructions: input.instructionsMarkdown,
      ...(input.resumeSessionId ? { keepSession: input.resumeSessionId } : {}),
    });
    const home = join(configDir, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // devops-box-access: the plan first; the settings list what the profile lets the session read (Seatbelt checks the
    // resolved path, so a folder that exists is a folder it shows)
    const planInput: BoxPlanInput = {
      level,
      requestDir: input.cwd,
      configDir,
      tmp,
      aomReadPaths: policyCtx.aomReadPaths,
      plumbingReadPaths: guard ? [guardDir] : [],
      claudeBin: bin.real,
      toolchainReadDirs: policyCtx.toolchainReadPaths ?? [],
      cloneDirs: input.readDirs ?? [],
      ...(level === 'outer'
        ? {
            outer: {
              devopsTools: join(root, 'devops-tools'),
              cardWorktrees: join(root, 'worktrees'),
              realHome: this.realHome(),
            },
          }
        : {}),
    };
    const sb = boxSandbox(planInput);
    writeBoxSettings(
      configDir,
      withBoxWorkDirs(baseSettings, boxWorkDirs(planInput, existsSync, MAC_SYSTEM_READ)),
    );
    const mr = this.modelRoute(level === 'outer' ? 'web_search' : 'none', this.auditOf(input));
    const plan = modelProxyPlan(cred, mr.upstream, mr.opts);
    const cmd = buildClaudeCommand(
      { ...input, sandbox: { ...input.sandbox, configDir, home, tmp }, addDirs: [], readDirs: [] },
      this.noClaudeToken(this.liveFor(account)),
    );
    // R4-B2 on macOS too: Docker Desktop (or another daemon) only through the gatekeeper
    let docker: { proxy: DockerProxy; dir: string; socket: string } | undefined;
    if (level === 'outer' && input.dockerGate) {
      const gdir = mkdtempSync(join(tmpdir(), 'aom-dk-'));
      const socket = join(gdir, 'docker.sock');
      const proxy = await startDockerProxy({
        socketPath: socket,
        upstream: input.dockerGate.upstream,
        policy: {
          instance: input.dockerGate.instance,
          bindRoots: [input.cwd],
          roBindRoots: cardWorktreeRoots(join(root, 'worktrees')),
          containerEgress: input.dockerGate.containerEgress,
        },
      });
      docker = { proxy, dir: gdir, socket };
    }
    const launch = await launchMacBox({
      profile: {
        ...(docker ? { dockerSocket: docker.socket } : {}),
        level,
        home: this.realHome(),
        readPaths: [...sb.readonly, ...sb.readDirs],
        writePaths: [sb.cwd, sb.home, sb.tmp, ...sb.writable],
        ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
      },
      routes: [plan.route],
      // S5: no direct line to a model service (the route's upstream is reachable through the route only)
      allowedHosts: [...this.cfg.extraAllowedDomains],
      cmd: { bin: bin.real, args: cmd.args, env: cmd.env },
    });
    const env: Record<string, string> = {
      ...launch.command.env,
      ...boxedClaudeEnv(plan, launch.port),
      ...(docker ? { DOCKER_HOST: `unix://${docker.socket}` } : {}),
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    Object.assign(env, plan.env);
    const parser = new ClaudeStreamParser();
    const session = spawnSession({
      bin: launch.command.bin,
      args: launch.command.args,
      cwd: input.cwd,
      env,
      inheritEnv: false,
      ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
      parseLine: (l) => parser.parseLine(l),
      usage: () => mr.ledger.usage(),
      authFailure: () => mr.ledger.authFailed,
      usageLimit: () => mr.ledger.usageLimit(),
      contextTokens: () => parser.contextTokens(),
      logFile: input.logFile,
      exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
      onExit: async () => {
        await launch.cleanup();
        if (docker) {
          await docker.proxy.close().catch(() => undefined);
          rmSync(docker.dir, { recursive: true, force: true });
        }
      },
    });
    return guard ? Object.assign(session, { guardConfig: guard.cfg }) : session;
  }

  private async startShiftSession(
    input: ShiftStartInput,
    account: ReturnType<ClaudeCodeAdapter['account']>,
    bk: ReturnType<ClaudeCodeAdapter['backendSession']>,
  ): Promise<RuntimeSession> {
    // quiet-approvals phase B: a DevOps request session runs in the box the runner builds (fail closed)
    if (input.boxRequestId && input.agent.isDevops && !bk) return this.startBoxedSession(input, account);
    const dir = input.sandbox.configDir;
    await mkdir(dir, { recursive: true });
    const guard =
      input.agent.isDevops && !input.devopsBox
        ? this.devopsGuard(dir, input.devopsGuard, 'shift', input.sandbox)
        : undefined;
    if (input.agent.isDevops && input.kind === 'release_prep' && !guard)
      throw new Error(
        'the DevOps guard could not be attached to this release prep shift (no guard settings or no runner paths)',
      );
    if (guard) input = { ...input, env: { ...input.env, AOM_DEVOPS_GUARD: guard.file } };
    // A role that edits or commits must not get its own main clone as a read-only folder: that bind would cover the
    // writable git dir (GWP-86). Read-only roles and DevOps keep their folders unchanged.
    let ownRepoDirs: string[] = [];
    if (!input.agent.isDevops && !isReadOnlyWorktreeRole(input.agent.permissions)) {
      const split = splitOwnRepository(input.readDirs ?? [], input.cwd, gitDirsOf(input.cwd));
      ownRepoDirs = split.ownRepoDirs;
      input = { ...input, readDirs: split.readDirs };
    }
    const settings = input.devopsBox
      ? buildDevopsBoxSettings(input.agent.permissions, this.policy(input, input.cwd, false), input.sandbox)
      : buildShiftSettings(
          input.agent.permissions,
          {
            ...this.policy(input, input.cwd, false, guard?.command, input.devopsGuard?.readOnlyScan === true),
            ...(ownRepoDirs.length ? { ownRepoDirs } : {}),
          },
          input.sandbox,
          input.agent.roleKey,
          input.agent.isDevops,
        );
    if (settings.sandbox)
      for (const d of shadowedWrites(settings.sandbox.filesystem, input.cwd))
        process.stderr.write(
          `WARN sandbox: ${d} hides a writable path (denyWrite is bound after allowWrite)\n`,
        );
    input = this.prepareSkills(dir, input, settings);
    input = this.prepareSubagents(dir, input, settings);
    if (this.cfg.scrubSubprocessEnv && !input.agent.isDevops) addInstallRedirect(settings);
    await writeFile(join(dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
    // A read-only worktree (reviewer): Claude Code's sandbox must find its protected dotfile names already there.
    const dropPlaceholders = settings.sandbox?.filesystem.denyWrite.includes(input.cwd)
      ? createSandboxPlaceholders(input.cwd, input.shiftId)
      : () => {};
    const used = this.writeMcpConfig(
      dir,
      input.agent.permissions.allowedTools,
      input.agent.isDevops ? undefined : input.mcpServers,
    );
    // A backend session has no Claude login: nothing of the account's credentials is copied into its config dir.
    if (bk) rmSync(join(dir, '.credentials.json'), { force: true });
    else await this.linkCredentials(dir, used, account.key);

    const cmd = buildClaudeCommand(
      // the card repository metadata is readable (never through a rule that makes it read-only for the commit)
      {
        ...input,
        ...(bk ? { agent: { ...input.agent, model: bk.model } } : {}),
        readDirs: [
          ...new Set([
            ...(input.readDirs ?? []),
            ...gitDirsOf(input.cwd),
            ...cardAttachmentDirs(input.sandbox),
          ]),
        ],
      },
      bk ? this.noClaudeToken(this.liveFor(account)) : this.liveFor(account),
    );
    if (bk) Object.assign(cmd.env, bk.env);
    const parser = new ClaudeStreamParser();
    const hooks = bk ? {} : this.sessionHooks(dir, parser, account);
    // The sandbox leaves an empty read-only .git/config.lock behind on the host: removed when the clone's last shift ends.
    const releaseRepo = holdSandboxRepo(gitDirsOf(input.cwd));
    return spawnSession({
      bin: cmd.bin,
      args: cmd.args,
      cwd: input.cwd,
      env: cmd.env,
      inheritEnv: false,
      ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
      parseLine: (l) => parser.parseLine(l),
      usage: () =>
        bk
          ? stampBackendUsage(parser.usage(), { backend: bk.backend, model: bk.model, source: bk.source })
          : parser.usage(),
      contextTokens: () => parser.contextTokens(),
      nativeSubagentUsage: () =>
        input.subagents?.length ? readNativeSubagentUsage(dir, parser.sessionId) : [],
      logFile: input.logFile,
      exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
      ...hooks,
      onExit: async (r) => {
        try {
          await ('onExit' in hooks ? hooks.onExit?.(r) : undefined);
        } finally {
          dropPlaceholders();
          releaseRepo();
          bk?.cleanup();
          if (guard) rmSync(guard.file, { force: true });
        }
      },
    });
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    if (realClaudeBlocked()) throw new RealClaudeBlockedError();
    // quiet-approvals [B2]: a DevOps chat turn inside the box is sandboxed like a builder (fail closed), not "devops"
    const box = input.devopsBox === true;
    const devops = input.agent.isDevops === true && !box;
    if (box) this.assertBox();
    else if (!devops) this.assertCanRun();
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
    // a backend model (Bedrock, Vertex, a gateway) has no Claude login: its `account` names a credential of the backend, not a Claude account
    const account = this.account(backendOfModel(input.agent.model) ? undefined : input.account);
    const bk = this.backendSession(input.agent, input.chatId, input.orgId, input.account);
    // see `start`: the Vertex key file is removed when anything fails before the process runs
    try {
      return await this.startChatSession(input, chatInput, devops, account, bk);
    } catch (err) {
      bk?.cleanup();
      this.dropGuardFile(input, 'chat', input.devopsGuard?.sessionRef);
      throw err;
    }
  }

  private async startChatSession(
    input: ChatStartInput,
    chatInput: ChatStartInput,
    devops: boolean,
    account: ReturnType<ClaudeCodeAdapter['account']>,
    bk: ReturnType<ClaudeCodeAdapter['backendSession']>,
  ): Promise<RuntimeSession> {
    const dir = input.sandbox.configDir;
    await mkdir(dir, { recursive: true });
    const guard = devops ? this.devopsGuard(dir, input.devopsGuard, 'chat', input.sandbox) : undefined;
    if (guard) input = { ...input, env: { ...input.env, AOM_DEVOPS_GUARD: guard.file } };
    // Granted plugin MCP servers this role may call (the DevOps engineer's chat keeps its own behaviour).
    const intakeMcp = input.intake ? this.cfg.intake?.mcpConfig : undefined;
    const review = input.reviewRun;
    // A review run grants no MCP server, but Claude Code still needs the (empty) file the command points at.
    const used = review
      ? this.writeMcpConfig(dir, [], undefined)
      : this.writeMcpConfig(
          dir,
          input.agent.permissions.allowedTools,
          devops || input.devopsBox === true || input.agent.roleKey === 'ceo'
            ? undefined
            : input.context?.mcpServers,
          intakeMcp && existsSync(intakeMcp) ? intakeMcp : undefined,
        );
    const chatSettings: ClaudeSettings = review
      ? reviewerPolicy(review, this.policy(chatInput, input.cwd, true)).settings
      : input.devopsBox
        ? buildDevopsBoxSettings(
            input.agent.permissions,
            this.policy(chatInput, input.cwd, false),
            input.sandbox,
          )
        : devops
          ? buildDevopsChatSettings(
              input.agent.permissions,
              this.policy(input, input.cwd, false, guard?.command),
              input.sandbox,
            )
          : input.agent.roleKey === 'ceo'
            ? buildCeoSettings(this.policy(chatInput, input.cwd, true), input.sandbox)
            : input.work
              ? buildMentionWorkSettings(
                  input.agent.permissions,
                  this.policy(chatInput, input.cwd, false),
                  input.sandbox,
                )
              : buildChatSettings(
                  input.readOnly,
                  [
                    ...(input.intake ? (this.cfg.intake?.allowedTools ?? []) : []),
                    ...used.map((u) => `mcp__${u.name}`),
                  ],
                  this.policy(chatInput, input.cwd, true),
                  input.sandbox,
                );
    const withSkills = review
      ? chatInput
      : this.prepareSubagents(dir, this.prepareSkills(dir, chatInput, chatSettings), chatSettings);
    await writeFile(join(dir, 'settings.json'), `${JSON.stringify(chatSettings, null, 2)}\n`);
    if (bk) rmSync(join(dir, '.credentials.json'), { force: true });
    else await this.linkCredentials(dir, used, account.key);
    const chatInputFinal = guard ? { ...withSkills, env: input.env } : withSkills;
    const cmd = buildClaudeChatCommand(
      bk ? { ...chatInputFinal, agent: { ...chatInputFinal.agent, model: bk.model } } : chatInputFinal,
      bk ? this.noClaudeToken(this.liveFor(account)) : this.liveFor(account),
    );
    if (bk) Object.assign(cmd.env, bk.env);
    const parser = new ClaudeStreamParser();
    const hooks = bk ? {} : this.sessionHooks(dir, parser, account);
    // A mention that works leaves the same git lock leftovers a shift does: removed when the clone's last session ends.
    const releaseRepo = input.work ? holdSandboxRepo(gitDirsOf(input.cwd)) : undefined;
    return spawnSession({
      bin: cmd.bin,
      args: cmd.args,
      cwd: input.cwd,
      env: cmd.env,
      inheritEnv: false,
      ...(cmd.stdin !== undefined ? { input: cmd.stdin } : {}),
      parseLine: (l) => parser.parseLine(l),
      usage: () =>
        bk
          ? stampBackendUsage(parser.usage(), { backend: bk.backend, model: bk.model, source: bk.source })
          : parser.usage(),
      nativeSubagentUsage: () =>
        input.subagents?.length ? readNativeSubagentUsage(dir, parser.sessionId) : [],
      logFile: input.logFile,
      exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
      ...hooks,
      ...(bk || releaseRepo || guard
        ? {
            onExit: async (r: Parameters<NonNullable<typeof hooks.onExit>>[0]) => {
              try {
                await ('onExit' in hooks ? hooks.onExit?.(r) : undefined);
              } finally {
                releaseRepo?.();
                bk?.cleanup();
                if (guard) rmSync(guard.file, { force: true });
              }
            },
          }
        : {}),
    });
  }

  /** The CEO's full-power turn (see `buildClaudeOwnerTurnCommand`). Needs no OS sandbox. */
  async startOwnerTurn(input: OwnerTurnInput): Promise<RuntimeSession> {
    if (realClaudeBlocked()) throw new RealClaudeBlockedError();
    // runner-bare-bin: the binary first, before any config dir or launch
    const bin = this.boxedBin();
    // quiet-approvals phase B (S12): a full-power turn runs in the outer box the runner builds (fail closed), with a private
    // config dir: the owner's own Claude setup (plugins, MCP servers, skills) is not mounted, only what Guildwise gives it
    const missing = this.boxMissing();
    if (missing)
      throw new Error(`the safety box for a full-power turn cannot start on this computer: ${missing}`);
    const cred = this.modelCredential();
    if (!cred) throw new Error(NEEDS_API_KEY);
    const configDir = join(input.turnDir, 'config');
    resetBoxConfigDir(configDir, { settings: {}, mcp: { mcpServers: {} } });
    const home = join(configDir, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Rework 1 (REVIEW B2): the turn works in its own empty folder; never the real home. A folder the server names (its
    // cwd, its added folders) is mounted read-only, by its real location, only when not on the never-list
    const work = join(input.turnDir, 'work');
    const tmp = join(input.turnDir, 'tmp');
    for (const d of [work, tmp]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const root = this.paths?.root ?? dirname(dirname(input.turnDir));
    const nl = {
      home: this.realHome(),
      policyRoot: localPolicyDir(),
      worktrees: join(root, 'worktrees'),
      runnerRoot: root,
    };
    const named = [...new Set([input.cwd, ...(input.addDirs ?? [])])].filter(
      (p) => p && resolve(p) !== resolve(work),
    );
    // B1: the CEO turn's settings allow WebSearch; B2, S6: usage, login and limits from the ledger (replaces ownerHooks)
    const mr = this.modelRoute('web_search');
    const plan = modelProxyPlan(cred, mr.upstream, mr.opts);
    const base = buildClaudeOwnerTurnCommand(input, this.noClaudeToken(this.live), {});
    const aomRead = [
      input.turnDir,
      this.paths?.bin ?? join(root, 'bin'),
      ...selfCommand('aom')
        .slice(-1)
        .map((p) => dirname(p)),
    ];
    const outer = {
      devopsTools: join(root, 'devops-tools'),
      cardWorktrees: join(root, 'worktrees'),
      realHome: this.realHome(),
    };
    mkdirSync(join(root, 'devops-tools'), { recursive: true, mode: 0o700 });
    const parser = new ClaudeStreamParser();
    const hooks = this.ownerHooks(mr.ledger);
    const baseEnv: Record<string, string> = ownerBoxEnv(base.env, { configDir, home });
    // macOS (REVIEW S8): the same turn in the outer Seatbelt profile; Seatbelt checks resolved paths (no fd binds)
    if (this.host.platform === 'darwin') {
      const readable: string[] = [];
      for (const p of named) {
        const r = openNamedFolder(p, nl, { fdPath: () => realpathSync(p) });
        if (r.ok) {
          readable.push(r.folder.real);
          r.folder.close();
        }
      }
      const sb = boxSandbox({
        level: 'outer',
        requestDir: work,
        configDir,
        tmp,
        aomReadPaths: aomRead,
        claudeBin: bin.real,
        toolchainReadDirs: [],
        cloneDirs: [],
        outer,
      });
      const launch = await launchMacBox({
        profile: {
          level: 'outer',
          home: this.realHome(),
          readPaths: [...sb.readonly, ...readable],
          writePaths: [work, home, tmp, ...sb.writable],
          ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
        },
        routes: [plan.route],
        allowedHosts: [...this.cfg.extraAllowedDomains],
        cmd: { bin: bin.real, args: base.args, env: baseEnv },
      });
      return spawnSession({
        bin: launch.command.bin,
        args: launch.command.args,
        cwd: work,
        env: { ...launch.command.env, ...boxedClaudeEnv(plan, launch.port) },
        inheritEnv: false,
        ...(base.stdin !== undefined ? { input: base.stdin } : {}),
        parseLine: (l) => parser.parseLine(l),
        usage: () => mr.ledger.usage(),
        logFile: input.logFile,
        exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
        ...hooks,
        onExit: async (r) => {
          try {
            await hooks.onExit?.(r);
          } finally {
            await launch.cleanup();
          }
        },
      });
    }
    const opened: Array<{ fd: number; real: string; close(): void }> = [];
    for (const p of named) {
      const r = openNamedFolder(p, nl);
      if (r.ok) opened.push(r.folder);
      else process.stderr.write(`WARN full-power turn: ${r.reason}\n`);
    }
    const env: Record<string, string> = { ...baseEnv, ...boxedClaudeEnv(plan, BRIDGE_PORT) };
    let launch: Awaited<ReturnType<typeof launchInHarnessSandbox>>;
    try {
      launch = await launchInHarnessSandbox({
        routes: [plan.route],
        cliHosts: [],
        ...(this.host.proxyTest ? { proxyTest: this.host.proxyTest } : {}),
        extraHosts: this.cfg.extraAllowedDomains,
        sandbox: boxSandbox({
          level: 'outer',
          requestDir: work,
          configDir,
          tmp,
          aomReadPaths: aomRead,
          claudeBin: bin.real,
          toolchainReadDirs: [],
          cloneDirs: [],
          ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
          outer,
          fdBinds: opened.map((f, i) => ({ fdIndex: 3 + i, real: f.real, writable: false })),
        }),
        cmd: { bin: bin.real, args: base.args, env },
      });
    } catch (err) {
      for (const f of opened) f.close();
      throw err;
    }
    try {
      return spawnSession({
        bin: launch.command.bin,
        args: launch.command.args,
        cwd: work,
        env: launch.command.env,
        inheritEnv: false,
        ...(opened.length ? { extraFds: opened.map((f) => f.fd) } : {}),
        ...(base.stdin !== undefined ? { input: base.stdin } : {}),
        parseLine: (l) => parser.parseLine(l),
        usage: () => mr.ledger.usage(),
        logFile: input.logFile,
        exitError: () => (parser.resultError ? `claude result: ${parser.resultError}` : undefined),
        ...hooks,
        onExit: async (r) => {
          try {
            await hooks.onExit?.(r);
          } finally {
            await launch.cleanup();
          }
        },
      });
    } finally {
      // the child holds its own copies of the fds after spawn
      for (const f of opened) f.close();
    }
  }

  /**
   * Auth and usage-limit bookkeeping of a boxed turn on the Owner's own login. runner-bare-bin (S6): from the model proxy's
   * ledger only (an upstream 401 or 429, Anthropic's own usage), never from the box's stdout or stderr, which a command in the
   * box can write.
   */
  private ownerHooks(
    ledger: ModelLedger,
  ): Pick<Parameters<typeof spawnSession>[0], 'authFailure' | 'usageLimit' | 'onExit'> {
    return {
      authFailure: () => ledger.authFailed,
      usageLimit: () => ledger.usageLimit(),
      // the CEO's owner turn runs on the Owner's own login: the main account
      onExit: async ({ code }) => {
        const main = this.registry.main;
        const ok = code === 0 && ledger.usage().outputTokens > 0;
        // review S1: an upstream 401 marks the login expired only when the turn failed
        if (ledger.authFailed && code !== 0) main.auth.markExpired();
        else if (ok) main.auth.markOk();
        const limit = ledger.usageLimit();
        if (limit) main.usage.markLimited(limit.until);
        else if (ok) main.usage.markOk();
      },
    };
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

  /** The environment a probe of an account (default main) runs with. */
  probeEnv(accountKey: string = MAIN_ACCOUNT): NodeJS.ProcessEnv {
    return this.account(accountKey).probeEnv();
  }

  /**
   * Checks that an account's login works (`claude auth status`, then one minimal `claude -p`, in that account's own
   * environment) and updates its auth state: `ok` flips an expired or never-completed login back, `expired` marks it
   * unusable. Called every few minutes while expired, when a credentials file changed, and before a session when the access
   * token is about to expire (that call also refreshes it). Nothing here prints a token.
   */
  async probeLogin(accountKey: string = MAIN_ACCOUNT): Promise<'ok' | 'expired' | 'unknown'> {
    if (realClaudeBlocked()) return 'unknown';
    const account = this.registry.get(accountKey);
    if (!account) return 'unknown';
    const r = await (
      (accountKey === MAIN_ACCOUNT ? this.host.probe : undefined) ??
      (() => probeClaudeLogin({ bin: this.cfg.bin, env: account.probeEnv() }))
    )();
    if (r === 'ok') account.auth.markOk();
    else if (r === 'expired') {
      // a config-dir account that holds no login at all was never signed in: `none`, not `expired`
      if (account.hasLogin()) account.auth.markExpired();
      else account.auth.markNone();
    }
    return r;
  }

  /**
   * Before a shift: is the account's login good? Nothing to check with a configured token or API key. With a shared login
   * the access token's expiry is read from the credentials file (no call); only when it is within `REFRESH_WINDOW_MS` (or
   * past) does one minimal probe run, under the account's lock and re-checked inside it (another shift may have refreshed it
   * meanwhile). The probe refreshes a token that can be refreshed and marks the account expired when it cannot.
   * Network trouble is `unknown`: the shift goes ahead and reports a login that does not work itself.
   */
  async checkLogin(accountKey: string = MAIN_ACCOUNT): Promise<'ok' | 'expired' | 'unknown'> {
    const account = this.registry.get(accountKey);
    if (realClaudeBlocked() || !account || !account.usesSharedLogin()) return 'ok';
    if (account.auth.state !== 'ok') return 'expired';
    const src = account.canonicalFile();
    if (!src || !existsSync(src)) return 'ok';
    const now = () => this.nowDate().getTime();
    const nearExpiry = () => {
      const exp = loginExpiresAt(readCredentials(src));
      return exp > 0 && exp - now() < REFRESH_WINDOW_MS;
    };
    if (!nearExpiry()) return 'ok';
    const lock = account.main
      ? join(this.paths?.root ?? dirname(this.realHome()), 'claude-credentials.lock')
      : (account.credentialPaths(dirname(src))?.lock as string);
    return withLock(lock, async () => {
      if (!nearExpiry()) return 'ok' as const;
      return this.probeLogin(accountKey);
    });
  }

  private nowDate(): Date {
    return this.host.now?.() ?? new Date();
  }

  /**
   * While an account's usage limit is in force and its reset time has passed: one minimal call (cheapest model, one turn,
   * in that account's environment). Clean: the account is usable again. Still limited: the new reset time is read and the
   * pause extended (an hour when the text has none). Nothing readable (network): the state stays and the caller retries.
   */
  async probeUsage(accountKey: string = MAIN_ACCOUNT): Promise<UsageProbeResult['state']> {
    const account = this.registry.get(accountKey);
    const mon = account?.usage;
    if (!account || !mon || mon.state !== 'limited' || realClaudeBlocked()) return 'unknown';
    const r = await (
      (accountKey === MAIN_ACCOUNT ? this.host.usageProbe : undefined) ??
      (() =>
        probeClaudeUsage({
          bin: this.cfg.bin,
          env: account.probeEnv(),
          now: () => this.nowDate(),
          ...(this.host.zone ? { tz: this.host.zone } : {}),
        }))
    )();
    if (r.state === 'ok') mon.markOk();
    else if (r.state === 'limited') mon.markLimited(r.hit.until);
    return r.state;
  }

  /**
   * What the process session needs to notice a dead login and to hand back refreshed tokens. The account and its credential
   * paths are bound HERE, at session start, and never re-resolved: the write-back can only reach this account's own file.
   */
  private sessionHooks(
    configDir: string,
    parser: ClaudeStreamParser,
    account: ClaudeAccount,
  ): Pick<Parameters<typeof spawnSession>[0], 'authFailure' | 'usageLimit' | 'onExit'> {
    const paths = account.usesSharedLogin() ? account.credentialPaths(configDir) : undefined;
    return {
      authFailure: (stderr) => parser.authFailure || isAuthFailureText(stderr),
      usageLimit: (stderr) =>
        detectUsageLimit(parser.usageLimitText, this.nowDate(), this.host.zone) ??
        detectUsageLimit(stderr, this.nowDate(), this.host.zone),
      onExit: async ({ code, authFailed, usageLimit }) => {
        if (authFailed) account.auth.markExpired();
        else if (code === 0 && parser.usage().outputTokens > 0) account.auth.markOk();
        if (usageLimit) account.usage.markLimited(usageLimit.until);
        // a real session that worked proves the limit is gone: resume without waiting for the probe
        else if (code === 0 && parser.usage().outputTokens > 0) account.usage.markOk();
        if (paths) await harvestAgentCredentials(paths);
      },
    };
  }

  /**
   * Credentials of the agent's config dir.
   * - No token configured (the account's own login is reused: the user's `~/.claude`, or the account's config dir): the agent
   *   gets a private COPY of that account's `.credentials.json` (it holds the plugin servers' OAuth tokens, `mcpOAuth`, too).
   *   A symlink let one agent's token refresh replace the file under the others and rotate the refresh token out from under
   *   them. The copy is made under the account's lock, after one refresh probe when the access token expires within 10
   *   minutes, and a newer login in the copy is written back after the session (`harvestAgentCredentials`).
   * - A token (`oauth` / `api_key`) is configured: the file is not shared. When servers are in use, a private copy with
   *   only the `mcpOAuth` entries of those servers is written (the model login is the token, so nothing else is
   *   needed); without servers there is no file.
   */
  async linkCredentials(
    configDir: string,
    servers: PluginMcpServer[] = [],
    accountKey: string = MAIN_ACCOUNT,
  ): Promise<void> {
    const account = this.account(accountKey);
    // plugin sign-ins of a token account come from the account's own dir (none for a pure token account)
    const src = account.main
      ? join(this.realHome(), '.claude', '.credentials.json')
      : account.canonicalFile();
    const dest = join(configDir, '.credentials.json');
    if (!account.usesSharedLogin()) {
      rmSync(dest, { force: true });
      if (servers.length === 0 || !src || !existsSync(src)) return;
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
    const paths = account.credentialPaths(configDir);
    if (!paths || !existsSync(paths.canonical)) {
      rmSync(dest, { force: true });
      return;
    }
    try {
      await prepareAgentCredentials(paths, {
        refresh: async () => {
          await this.probeLogin(account.key);
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
