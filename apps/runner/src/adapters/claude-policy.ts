import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { AgentPermissions } from '@aom/shared';

/**
 * What an agent session may touch, expressed in Claude Code's own settings (verified against
 * https://code.claude.com/docs/en/settings-reference, /permissions and /sandboxing for Claude Code 2.1.288):
 *
 * - `permissions.allow` / `permissions.deny`: rules for the built-in tools. Read and Edit rules use gitignore
 *   patterns; `//path` is an absolute path (a single `/` anchors at the settings file, so every path below is `//`).
 *   `Edit(...)` rules cover Edit, Write and NotebookEdit. Deny rules win over allow rules in every scope.
 * - `permissions.defaultMode: "dontAsk"`: whatever no allow rule approves is denied (a headless run cannot ask).
 *   `acceptEdits` would approve every edit inside the working directory whatever the role may do.
 * - `permissions.blockReadsOutsideWorkingDirectories`: the Read/Grep/Glob tools refuse paths outside the working
 *   directories (the worktree or scratch dir, plus `additionalDirectories` and `--add-dir`).
 * - `sandbox.*`: an OS-level (bubblewrap / Seatbelt) boundary around Bash. It does NOT cover the built-in file tools,
 *   which is why the permission rules above exist as well. Sandbox filesystem paths are plain absolute paths.
 */

export type SandboxMode = 'required' | 'best_effort' | 'off';

export interface ClaudePolicyContext {
  /** The runner data dir (`~/.aom-runner`): config (runner token, provider credentials), outbox, all agents. */
  runnerRoot: string;
  /** This agent's own sandbox root (`<runnerRoot>/agents/<id>`: HOME, CLAUDE_CONFIG_DIR, scratch). */
  agentDir: string;
  /** Worktree of the card, or the agent's scratch dir. */
  cwd: string;
  /** Vault folder(s) passed with `--add-dir`: readable context, never writable by an agent. */
  addDirs: string[];
  /** The main repository's git dir(s) a linked worktree commits into. */
  gitDirs: string[];
  /** The runner's `bin/` (the `aom` shim) and where the shim's script lives: readable although inside the data dir. */
  aomReadPaths: string[];
  /** Unix socket of the runner's IPC server (the `aom` CLI talks over it: the sandbox has no loopback route out). */
  ipcSocket?: string;
  /** The real home directory of the runner's OS user (agents run with a private HOME). */
  realHome: string;
  mode: SandboxMode;
  extraAllowedDomains?: string[];
}

/** Hosts a shell may reach: package registries and source hosts, enough to install dependencies. */
export const REGISTRY_DOMAINS = [
  'registry.npmjs.org',
  '*.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
  'index.rubygems.org',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

/** Credential stores in the real home that no agent has any business reading. */
const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.config/gh',
  '.config/gcloud',
  '.claude',
  '.claude.json',
];

/** The runner's own state: nothing in it is for an agent (its own sandbox and worktree are carved out below). */
export const RUNNER_PRIVATE = [
  'config.json',
  'outbox',
  'outbound',
  'active-shifts',
  'vaults.json',
  'status.json',
  'logs',
  'mock-state',
];

const ALWAYS_DENIED = [
  'Bash(git push:*)',
  'Bash(git rebase:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git reset --hard:*)',
];

/** `git push*` -> `Bash(git push:*)`, `rm -rf /*` -> `Bash(rm -rf /*)`. */
export function shellDeny(pattern: string): string {
  const p = pattern.trim();
  if (p.endsWith(' *')) return `Bash(${p.slice(0, -2)}:*)`;
  if (p.endsWith('*') && !p.endsWith('/*')) return `Bash(${p.slice(0, -1).trimEnd()}:*)`;
  return `Bash(${p})`;
}

/** `/abs/path` -> `//abs/path` (the absolute-path anchor of permission rules). */
export const ruleAbs = (p: string): string => `/${resolve(p)}`;

/** A role glob (relative to the worktree) as an absolute `Edit(...)` rule. */
export function editRule(cwd: string, glob: string): string {
  const g = glob.replace(/^\.?\//, '');
  return `Edit(${ruleAbs(join(cwd, g))})`;
}

export interface ClaudeSettings {
  permissions: {
    allow: string[];
    deny: string[];
    defaultMode: 'dontAsk';
    blockReadsOutsideWorkingDirectories: true;
    additionalDirectories: string[];
  };
  sandbox?: {
    enabled: true;
    failIfUnavailable: boolean;
    allowUnsandboxedCommands: false;
    autoAllowBashIfSandboxed: true;
    filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[]; allowRead: string[] };
    excludedCommands: string[];
    network: {
      allowedDomains: string[];
      strictAllowlist: true;
      allowUnixSockets: string[];
      allowLocalBinding: boolean;
    };
  };
  includeCoAuthoredBy: false;
}

function sandboxBlock(
  tools: Set<string>,
  ctx: ClaudePolicyContext,
  agentHome: string,
  scratch: string,
  tmp: string,
): ClaudeSettings['sandbox'] {
  if (ctx.mode === 'off') return undefined;
  const runnerPrivate = RUNNER_PRIVATE.map((p) => join(ctx.runnerRoot, p));
  const shell = tools.has('shell') || tools.has('bash');
  const denyRead = [
    // the whole data dir: config.json (runner token, Jira/provider credentials), the outbox, every other agent's
    // sandbox and every other card's worktree; the agent's own areas are re-opened below.
    ctx.runnerRoot,
    ...HOME_SECRETS.map((p) => join(ctx.realHome, p)),
  ];
  return {
    enabled: true,
    failIfUnavailable: ctx.mode === 'required',
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [agentHome, scratch, tmp, ...ctx.gitDirs],
      // never the repository's hooks or config (they run outside the sandbox when the user next uses git), the
      // vault, or the runner's private state
      denyWrite: [
        ...ctx.gitDirs.flatMap((g) => [join(g, 'hooks'), join(g, 'config')]),
        ...ctx.addDirs,
        ...runnerPrivate,
      ],
      denyRead,
      // Never a directory that holds a writable path (the agent's own dir holds home, scratch and tmp): bubblewrap
      // re-opens an allowed read as read-only over the writable binds beneath it, and every Bash call then fails
      // on its first write. Home, scratch and tmp are readable anyway; the Claude config dir stays hidden.
      allowRead: [ctx.cwd, ...ctx.addDirs, ...ctx.aomReadPaths],
    },
    // On Linux the sandbox blocks creating any Unix socket (seccomp cannot filter by path), so the `aom` CLI cannot
    // reach the runner's IPC socket from inside it: it runs outside the sandbox, like git does for hooks. It only
    // talks to the runner with the shift's token and writes nothing itself.
    excludedCommands: ['aom'],
    network: {
      // Bash only: WebFetch/WebSearch are governed by the permission rules ('web' tool), not by this list.
      allowedDomains: shell ? [...REGISTRY_DOMAINS, ...(ctx.extraAllowedDomains ?? [])] : [],
      strictAllowlist: true,
      allowUnixSockets: ctx.ipcSocket ? [ctx.ipcSocket] : [],
      allowLocalBinding: shell,
    },
  };
}

/** Rules every session gets: private runner state, credentials and the session's own settings are off limits. */
function commonDenies(ctx: ClaudePolicyContext, configDir: string): string[] {
  return [
    ...RUNNER_PRIVATE.map((p) => `Read(${ruleAbs(join(ctx.runnerRoot, p))}/**)`),
    ...RUNNER_PRIVATE.map((p) => `Read(${ruleAbs(join(ctx.runnerRoot, p))})`),
    ...HOME_SECRETS.flatMap((p) => [
      `Read(${ruleAbs(join(ctx.realHome, p))}/**)`,
      `Read(${ruleAbs(join(ctx.realHome, p))})`,
    ]),
    `Edit(${ruleAbs(configDir)}/**)`,
    ...ctx.addDirs.map((d) => `Edit(${ruleAbs(d)}/**)`),
  ];
}

export function buildShiftSettings(
  p: AgentPermissions,
  ctx: ClaudePolicyContext,
  paths: { home: string; configDir: string; scratch: string; tmp: string },
): ClaudeSettings {
  const tools = new Set(p.allowedTools);
  const allow: string[] = [];
  const deny: string[] = [...ALWAYS_DENIED, ...p.deniedShellPatterns.map(shellDeny)];
  for (const tool of p.allowedTools) {
    if (tool === 'read') allow.push('Read', 'Glob', 'Grep');
    else if (tool === 'edit') {
      // Edit is limited to the worktree; a role with writable globs gets only those paths inside it.
      if (p.writableGlobs === null) allow.push(editRule(ctx.cwd, '**'));
      else for (const g of p.writableGlobs) allow.push(editRule(ctx.cwd, g));
    } else if (tool === 'shell') allow.push('Bash');
    else if (tool === 'web') allow.push('WebFetch', 'WebSearch');
    else if (tool.startsWith('mcp:')) allow.push(`mcp__${tool.slice(4)}`);
  }
  if (!tools.has('edit')) deny.push('Edit', 'Write', 'NotebookEdit');
  if (!tools.has('web')) deny.push('WebFetch', 'WebSearch');
  if (!tools.has('shell')) deny.push('Bash');
  deny.push(...commonDenies(ctx, paths.configDir), `Edit(${ruleAbs(join(ctx.cwd, '.git'))}/**)`);
  const out: ClaudeSettings = {
    permissions: {
      allow,
      deny: [...new Set(deny)],
      defaultMode: 'dontAsk',
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [paths.scratch],
    },
    includeCoAuthoredBy: false,
  };
  const sb = sandboxBlock(tools, ctx, paths.home, paths.scratch, paths.tmp);
  if (sb) out.sandbox = sb;
  return out;
}

/** Chat sessions read and talk; the only shell command they may run is `aom` (comment, ledger search). */
export function buildChatSettings(
  readOnly: boolean,
  extraAllow: string[],
  ctx: ClaudePolicyContext,
  paths: { home: string; configDir: string; scratch: string; tmp: string },
): ClaudeSettings {
  const deny = [
    ...ALWAYS_DENIED,
    'WebSearch',
    ...(readOnly ? ['Edit', 'Write', 'NotebookEdit'] : []),
    ...commonDenies(ctx, paths.configDir),
  ];
  const out: ClaudeSettings = {
    permissions: {
      allow: ['Read', 'Glob', 'Grep', 'Bash(aom:*)', ...extraAllow],
      deny: [...new Set(deny)],
      defaultMode: 'dontAsk',
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [paths.scratch],
    },
    includeCoAuthoredBy: false,
  };
  // The chat may only run `aom`: no registries needed, only the IPC socket.
  const sb = sandboxBlock(new Set(['shell']), { ...ctx, extraAllowedDomains: [] }, paths.home, paths.scratch, paths.tmp);
  if (sb) {
    sb.network.allowedDomains = [];
    out.sandbox = sb;
  }
  return out;
}

/** The main repository's `.git` directory of a linked worktree (its `.git` file says `gitdir: <repo>/.git/worktrees/x`). */
export function gitDirsOf(cwd: string): string[] {
  const dotGit = join(cwd, '.git');
  if (!existsSync(dotGit)) return [];
  try {
    const text = readFileSync(dotGit, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m?.[1]) return [];
    const admin = resolve(cwd, m[1].trim());
    const common = join(admin, '..', '..'); // <repo>/.git/worktrees/<name> -> <repo>/.git
    return /[\\/]worktrees[\\/][^\\/]+$/.test(admin) ? [resolve(common)] : [admin];
  } catch {
    return []; // `.git` is a directory (a plain clone): the cwd itself is writable
  }
}

// ---------------------------------------------------------------------------------------------- environment

/** Variables an agent process may inherit from the runner; everything else (GH_TOKEN, SSH_AUTH_SOCK, cloud keys, ...) is dropped. */
const INHERITED_ENV = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'COLORTERM',
  'SRT_DEBUG', // sandbox diagnostics, opt-in
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Windows needs these to start any process
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
];

/**
 * The environment of an agent process: the allow-listed inherited variables, then what the runner sets for this
 * session (private HOME and CLAUDE_CONFIG_DIR, the IPC variables) and only the provider credential this runtime
 * needs. Nothing else of the runner's environment reaches an agent.
 */
export function agentEnv(
  sessionEnv: Record<string, string>,
  provider: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED_ENV) {
    const v = parent[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...sessionEnv, ...provider, ...extra };
}

// ------------------------------------------------------------------------------------------- availability

/** Is `name` an executable on PATH? */
export function onPath(name: string, pathVar: string = process.env.PATH ?? ''): boolean {
  return pathVar.split(delimiter).some((d) => d && existsSync(join(d, name)));
}

/** What the OS-level sandbox needs on this platform (bubblewrap + socat on Linux/WSL2; built in on macOS). */
export function sandboxMissing(
  platform: NodeJS.Platform = process.platform,
  pathVar?: string,
): string | null {
  if (platform === 'darwin') return null;
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((b) => !onPath(b, pathVar));
    return missing.length ? `${missing.join(' and ')} not installed` : null;
  }
  return 'the Claude Code sandbox is not available on this platform (use WSL2)';
}
