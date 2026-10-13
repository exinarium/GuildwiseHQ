import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import type { AgentPermissions } from '@aom/shared';
import { sandboxReadEntries, secretReadDenies } from './read-only-dirs.ts';

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
  /**
   * Read-only folders, outside the working directory: a project's reference repositories, the project's own clones
   * in a chat, the card's repository metadata in a chat, and per-role extras (a future Architect reads every
   * repository under the organization's source folder: pass that list here). Readable by the built-in tools and the
   * shell, never writable, and their secret files (`.env`, keys, ...) stay unreadable. See read-only-dirs.ts.
   */
  readDirs?: string[];
  /** The runner's `bin/` (the `aom` shim) and where the shim's script lives: readable although inside the data dir. */
  aomReadPaths: string[];
  /** Unix socket of the runner's IPC server (the `aom` CLI talks over it: the sandbox has no loopback route out). */
  ipcSocket?: string;
  /** The real home directory of the runner's OS user (agents run with a private HOME). */
  realHome: string;
  mode: SandboxMode;
  extraAllowedDomains?: string[];
  /** Other agents' private temp dirs (under /tmp, outside the data dir): never readable by this agent. */
  otherAgentTmps?: string[];
  /** Toolchain dirs (the Node install, configured toolchainPaths) sandboxed commands may read despite the read block. */
  toolchainReadPaths?: string[];
  /**
   * The runner's shared package caches (`<runner root>/cache`): writable for every agent of this runner, so a package
   * restored once is reused by all. The trade-off (agents of one runner share caches) is in docs/RUNNER.md.
   */
  sharedCacheDir?: string;
  /** The user's own `~/.nuget/packages`: readable (never writable) as a NuGet fallback folder. */
  nugetFallbackDir?: string;
  /** `/tmp/.dotnet` (Linux): .NET's named-mutex files; without write access every `dotnet build` fails. */
  dotnetShmDir?: string;
  /** OS user id (default: the runner's), for `/run/user/<uid>`. Injectable for tests. */
  uid?: number;
  /** Names in `/tmp` (default: read from the disk), to mask ssh-agent directories. Injectable for tests. */
  tmpEntries?: string[];
}

/** What a shift's sandbox is allowed, beyond what its tools imply. */
export interface SandboxProfile {
  /** Runs browsers: Unix sockets are open (see `BROWSER_MASKED`), and the mask below is added. */
  browser: boolean;
  /** Cannot edit and may not commit: the worktree is read-only to its shell. */
  readOnlyWorktree: boolean;
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
  'api.nuget.org',
  '*.nuget.org',
  'plugins.gradle.org',
  'services.gradle.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
];

/** Credential stores in the real home that no agent has any business reading. */
export const HOME_SECRETS = [
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

/**
 * Browsers (Playwright/Chromium) need `socket(AF_UNIX)`, which the Linux sandbox's seccomp filter blocks entirely
 * (`allowUnixSockets` is ignored on Linux; the only switch is `allowAllUnixSockets`, which on WSL2 also reopens
 * the interop socket that launches Windows binaries). Opening it lets a shell connect to any socket it can reach,
 * so the sockets worth connecting to are hidden instead: a path in `denyRead` is masked and cannot be connected to.
 */
export const BROWSER_MASKED = [
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/run/containerd',
  '/run/podman',
  '/run/WSL', // WSL2 interop: launches Windows binaries
  '/run/dbus', // system bus
  '/run/systemd',
];

/** `/run/user/<uid>` (session bus, keyrings, ssh/gpg agent sockets) and ssh-agent directories in `/tmp`. */
export function browserMask(ctx: Pick<ClaudePolicyContext, 'uid' | 'tmpEntries'>): string[] {
  const uid = ctx.uid ?? process.getuid?.();
  let tmpNames = ctx.tmpEntries;
  if (!tmpNames) {
    try {
      tmpNames = readdirSync('/tmp');
    } catch {
      tmpNames = [];
    }
  }
  return [
    ...BROWSER_MASKED,
    ...(uid !== undefined ? [`/run/user/${uid}`] : []),
    // ssh-agent: /tmp/ssh-XXXXXX/agent.<pid>; gpg-agent and keyring sockets may sit directly in /tmp too
    ...tmpNames.filter((n) => /^(ssh-|keyring-|gpg-|\.?dbus-)/.test(n)).map((n) => join('/tmp', n)),
  ];
}

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
  'secrets',
];

/**
 * Claude Code tools that reach outside the shift: other sessions on this machine, remote triggers, schedules and
 * notifications. In dontAsk mode a tool that needs no approval still runs, so these are denied by name.
 */
export const SESSION_TOOLS_DENIED = [
  'ListAgents',
  'SendMessage',
  'RemoteTrigger',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
];

const ALWAYS_DENIED = [...SESSION_TOOLS_DENIED, 'Bash(git push:*)', 'Bash(git reset --hard:*)'];

/**
 * G-Q12: rebase, checkout and switch were denied for every role. The builder may now run them to
 * reconcile their card branch: the worktree is the only repository they can write to (the sandbox and the Edit denies
 * keep every other path read-only), so this can only move their own branch. Other roles keep the deny.
 */
export const BRANCH_MOVING_DENIED = ['Bash(git rebase:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)'];

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
    /** Absent for the workstation's DevOps engineer, which reads anywhere. */
    blockReadsOutsideWorkingDirectories?: true;
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
      /** Browser roles only (Linux seccomp blocks every AF_UNIX socket otherwise). */
      allowAllUnixSockets?: true;
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
  profile: SandboxProfile = { browser: false, readOnlyWorktree: false },
): ClaudeSettings['sandbox'] {
  if (ctx.mode === 'off') return undefined;
  const runnerPrivate = RUNNER_PRIVATE.map((p) => join(ctx.runnerRoot, p));
  const shell = tools.has('shell') || tools.has('bash');
  // A role that cannot edit and may not commit gets a read-only worktree; its scratch, tmp and home stay writable.
  // (When its cwd is its own scratch dir there is no worktree to protect.)
  const worktreeLocked = profile.readOnlyWorktree && !inside(ctx.cwd, ctx.agentDir);
  const denyRead = [
    // the whole data dir: config.json (runner token, Jira/provider credentials), the outbox, every other agent's
    // sandbox and every other card's worktree; the agent's own areas are re-opened below.
    // Exception: a read-only worktree. Masking a directory that contains it makes bubblewrap try to create Claude
    // Code's protected dotfiles (`.gitconfig`, `.bashrc`, ...) inside the read-only cwd, and every command then
    // fails with "bwrap: Can't create file <worktree>/.gitconfig: Read-only file system". So the data dir is masked
    // entry by entry, leaving only the path down to the worktree open.
    ...(worktreeLocked && inside(ctx.cwd, ctx.runnerRoot)
      ? denyAround(ctx.runnerRoot, ctx.cwd)
      : [ctx.runnerRoot]),
    ...(ctx.otherAgentTmps ?? []),
    ...HOME_SECRETS.map((p) => join(ctx.realHome, p)),
    ...(profile.browser ? browserMask(ctx) : []),
  ];
  const readDirs = ctx.readDirs ?? [];
  // A read-only folder is opened to the shell entry by entry so its secret files stay out (allowRead beats denyRead).
  const readEntries = readDirs.flatMap((d) => sandboxReadEntries(d) ?? []);
  return {
    enabled: true,
    failIfUnavailable: ctx.mode === 'required',
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [
        agentHome,
        scratch,
        tmp,
        ...ctx.gitDirs,
        ...(ctx.sharedCacheDir ? [ctx.sharedCacheDir] : []),
        ...(ctx.dotnetShmDir ? [ctx.dotnetShmDir] : []),
      ],
      // never the repository's hooks or config (they run outside the sandbox when the user next uses git), the
      // vault, or the runner's private state
      denyWrite: [
        ...ctx.gitDirs.flatMap((g) => [join(g, 'hooks'), join(g, 'config')]),
        ...ctx.addDirs,
        ...readDirs,
        ...runnerPrivate,
        ...(worktreeLocked ? [ctx.cwd] : []),
      ],
      denyRead,
      // Never a directory that holds a writable path (the agent's own dir holds home, scratch and tmp): bubblewrap
      // re-opens an allowed read as read-only over the writable binds beneath it, and every Bash call then fails
      // on its first write. Home, scratch and tmp are readable anyway; the Claude config dir stays hidden.
      allowRead: [
        ctx.cwd,
        ...ctx.addDirs,
        ...readEntries,
        ...ctx.aomReadPaths,
        ...(ctx.toolchainReadPaths ?? []),
        ...(ctx.nugetFallbackDir ? [ctx.nugetFallbackDir] : []),
      ],
    },
    // On Linux the sandbox blocks creating any Unix socket (seccomp cannot filter by path), so the `aom` CLI cannot
    // reach the runner's IPC socket from inside it: it runs outside the sandbox, like git does for hooks. It only
    // talks to the runner with the shift's token and writes nothing itself.
    // Patterns use Bash(...) rule syntax: a bare word matches only the command with no arguments, so `aom *` is
    // needed for `aom handoff ...`; the shim's absolute path is covered too.
    excludedCommands: aomExcluded(ctx.aomReadPaths),
    network: {
      // Bash only: WebFetch/WebSearch are governed by the permission rules ('web' tool), not by this list.
      allowedDomains: shell ? [...REGISTRY_DOMAINS, ...(ctx.extraAllowedDomains ?? [])] : [],
      strictAllowlist: true,
      allowUnixSockets: ctx.ipcSocket ? [ctx.ipcSocket] : [],
      ...(profile.browser ? { allowAllUnixSockets: true as const } : {}),
      allowLocalBinding: shell,
    },
  };
}

/**
 * Everything under `root` that must stay unreadable except the path leading down to `keep`: at every level of the
 * chain the siblings of the next step are listed (the entries of `root` itself, then the other projects' worktree
 * folders, then the other cards' worktrees). The folder `keep` is not masked, nor is anything above it. A sibling
 * created after the shift started is not covered (rare: worktrees are made before their shift begins).
 */
export function denyAround(root: string, keep: string): string[] {
  const parts = relative(root, keep).split(sep).filter(Boolean);
  const out: string[] = [];
  let dir = root;
  try {
    for (const next of parts) {
      for (const e of readdirSync(dir)) if (e !== next) out.push(join(dir, e));
      dir = join(dir, next);
    }
  } catch {
    return [root]; // cannot list it: mask everything (the safe direction)
  }
  return out;
}

/** `aom`, `aom *` and the same for the shim's absolute path in the runner's bin dir. */
export function aomExcluded(aomReadPaths: string[]): string[] {
  const out = ['aom', 'aom *'];
  const bin = aomReadPaths[0];
  if (bin) out.push(join(bin, 'aom'), `${join(bin, 'aom')} *`);
  return out;
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
    ...readOnlyDenies(ctx),
  ];
}

/** Read-only folders: no Edit or Write there (a deny wins over every allow), and no secret file is readable. */
function readOnlyDenies(ctx: Pick<ClaudePolicyContext, 'readDirs'>): string[] {
  const dirs = ctx.readDirs ?? [];
  return [
    ...dirs.flatMap((d) => [`Edit(${ruleAbs(d)}/**)`, `Edit(${ruleAbs(d)})`]),
    ...secretReadDenies(dirs),
  ];
}

/** The built-in tester always runs browsers (agents hired before the flag existed carry none); custom roles opt in. */
export const runsBrowsers = (p: Pick<AgentPermissions, 'browser'>, roleKey?: string): boolean =>
  p.browser === true || roleKey === 'tester';

/**
 * The workstation's DevOps engineer (`AgentRuntimeSpec.isDevops`, built-in role `devops`) runs OUTSIDE the agent
 * sandbox by design: it deploys to the local Docker stack (docker.sock), reaches remote hosts (ssh, scp, docker
 * contexts), installs tools and uses sudo, none of which bubblewrap allows. It acts with the user's own privileges.
 * What stays denied: the runner's private files, the agent's own Claude config and the user's Claude login. Whether a
 * given action is within its granted access is guidance in its prompt plus `aom devops-approval`, not enforced here.
 * Everything else about the DevOps agent is decided by this one flag, so the other roles' settings do not change.
 */
function buildDevopsSettings(
  p: AgentPermissions,
  ctx: ClaudePolicyContext,
  paths: { home: string; configDir: string; scratch: string; tmp: string },
): ClaudeSettings {
  const claudeLogin = ['.claude', '.claude.json'].map((f) => ruleAbs(join(ctx.realHome, f)));
  const deny = [
    ...SESSION_TOOLS_DENIED,
    // git push is allowed (owner decision): it keeps the vaults in sync across workstations with the user's git
    // credentials. Creating a new repository still goes through `aom repo create`.
    ...p.deniedShellPatterns.map(shellDeny),
    ...RUNNER_PRIVATE.flatMap((f) => {
      const abs = ruleAbs(join(ctx.runnerRoot, f));
      return [`Read(${abs}/**)`, `Read(${abs})`, `Edit(${abs}/**)`, `Edit(${abs})`];
    }),
    ...claudeLogin.flatMap((a) => [`Read(${a}/**)`, `Read(${a})`]),
    `Edit(${ruleAbs(paths.configDir)}/**)`,
    ...ctx.addDirs.map((d) => `Edit(${ruleAbs(d)}/**)`),
  ];
  return {
    permissions: {
      allow: ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'WebFetch', 'WebSearch'],
      deny: [...new Set(deny)],
      defaultMode: 'dontAsk',
      additionalDirectories: [paths.scratch],
    },
    includeCoAuthoredBy: false,
  };
}

export function buildShiftSettings(
  p: AgentPermissions,
  ctx: ClaudePolicyContext,
  paths: { home: string; configDir: string; scratch: string; tmp: string },
  roleKey?: string,
  isDevops = false,
): ClaudeSettings {
  if (isDevops) return buildDevopsSettings(p, ctx, paths);
  const tools = new Set(p.allowedTools);
  const allow: string[] = [];
  const deny: string[] = [
    ...ALWAYS_DENIED,
    ...(roleKey === 'builder' ? [] : BRANCH_MOVING_DENIED),
    ...p.deniedShellPatterns.map(shellDeny),
  ];
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
      additionalDirectories: [paths.scratch, ...ctx.gitDirs, ...(ctx.readDirs ?? [])],
    },
    includeCoAuthoredBy: false,
  };
  const sb = sandboxBlock(tools, ctx, paths.home, paths.scratch, paths.tmp, {
    browser: runsBrowsers(p, roleKey),
    readOnlyWorktree: !tools.has('edit') && !p.mayCommit,
  });
  if (sb) out.sandbox = sb;
  return out;
}

/**
 * G-Q1: the DevOps agent's chat runs exactly like its shifts: unsandboxed, as the user, with the same tool
 * permissions, so commands, docker builds and deploys work from the conversation. Other agents' chats stay sandboxed.
 */
export function buildDevopsChatSettings(
  p: AgentPermissions,
  ctx: ClaudePolicyContext,
  paths: { home: string; configDir: string; scratch: string; tmp: string },
): ClaudeSettings {
  return buildDevopsSettings(p, ctx, paths);
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
    ...BRANCH_MOVING_DENIED,
    'WebSearch',
    // A card's worktree is read-only; a bare `Edit` deny would also beat the scratch allow, so it is path-scoped.
    ...(readOnly ? [`Edit(${ruleAbs(ctx.cwd)}/**)`] : []),
    ...commonDenies(ctx, paths.configDir),
  ];
  const out: ClaudeSettings = {
    permissions: {
      // Edit (which covers Write and NotebookEdit) only in the agent's own scratch dir; the denies below still win.
      allow: ['Read', 'Glob', 'Grep', 'Bash(aom:*)', `Edit(${ruleAbs(paths.scratch)}/**)`, ...extraAllow],
      deny: [...new Set(deny)],
      defaultMode: 'dontAsk',
      blockReadsOutsideWorkingDirectories: true,
      additionalDirectories: [paths.scratch, ...(ctx.readDirs ?? [])],
    },
    includeCoAuthoredBy: false,
  };
  // The chat may only run `aom`: no registries needed, only the IPC socket.
  const sb = sandboxBlock(
    new Set(['shell']),
    { ...ctx, extraAllowedDomains: [] },
    paths.home,
    paths.scratch,
    paths.tmp,
  );
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
/** Extra variables the DevOps engineer inherits so docker, ssh and kubectl work as they do for the user. */
export const DEVOPS_INHERITED_ENV = [
  'SSH_AUTH_SOCK',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'KUBECONFIG',
  'XDG_RUNTIME_DIR',
];

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

/** What the runner reports per runtime: is an OS boundary around the agent's shell in force, and why not. */
export type SandboxStateName = 'enforced' | 'unsandboxed' | 'unavailable';
export interface SandboxState {
  state: SandboxStateName;
  reason: string;
}

/** A user-facing reason for a platform that cannot run the sandbox (what to do about it included). */
function missingAdvice(platform: NodeJS.Platform, missing: string): string {
  if (platform === 'win32')
    return 'Native Windows: install the runner in WSL2 (docs/RUNNER.md, "Windows: run the runner inside WSL2")';
  if (platform === 'linux') return `${missing}: install them (apt install bubblewrap socat)`;
  return `${missing}: run the runner in WSL2 or on macOS/Linux`;
}

/**
 * The effective sandbox state of the claude-code runtime.
 * - `required` (default): `enforced`, or `unavailable` when the platform cannot sandbox.
 * - `best_effort`: `enforced` when it can; otherwise `unsandboxed` only with the explicit `allowUnsandboxed`
 *   acknowledgement, else `unavailable` (no agent is scheduled).
 * - `off`: `unsandboxed` (an explicit opt-in in itself).
 * `platform` and `pathVar` are injectable for tests.
 */
export function sandboxState(
  cfg: { sandbox: SandboxMode; allowUnsandboxed?: boolean },
  platform: NodeJS.Platform = process.platform,
  pathVar?: string,
): SandboxState {
  if (cfg.sandbox === 'off')
    return { state: 'unsandboxed', reason: 'sandbox is set to "off" in the runner config' };
  const missing = sandboxMissing(platform, pathVar);
  if (!missing)
    return { state: 'enforced', reason: platform === 'darwin' ? 'macOS Seatbelt' : 'bubblewrap + socat' };
  const advice = missingAdvice(platform, missing);
  if (cfg.sandbox === 'best_effort' && cfg.allowUnsandboxed)
    return { state: 'unsandboxed', reason: `${advice}; running unsandboxed because allowUnsandboxed is set` };
  return {
    state: 'unavailable',
    reason:
      cfg.sandbox === 'best_effort'
        ? `${advice}. Or set runtimes["claude-code"].allowUnsandboxed to true to run without an OS sandbox (not recommended)`
        : advice,
  };
}

/** The `sandbox` lines of `aom-runner doctor`; on native Windows the exact WSL2 steps. Exported for tests. */
export function sandboxDoctorLines(
  sb: SandboxState,
  os: NodeJS.Platform,
): Array<{ ok: boolean | 'warn'; name: string; detail: string }> {
  const out: Array<{ ok: boolean | 'warn'; name: string; detail: string }> = [
    {
      ok: sb.state === 'enforced' ? true : sb.state === 'unsandboxed' ? 'warn' : false,
      name: 'sandbox',
      detail: `${sb.state} (${sb.reason})`,
    },
  ];
  if (os === 'win32' && sb.state !== 'enforced')
    for (const [i, step] of [
      'Recommended: run the runner inside WSL2, where the Claude Code sandbox works.',
      'In an admin PowerShell: wsl --install -d Ubuntu   (then reboot and create the Linux user)',
      'In Ubuntu: sudo apt update && sudo apt install -y git gh bubblewrap socat curl',
      'Install Node 22 (nvm install 22) and Claude Code (npm i -g @anthropic-ai/claude-code), then clone repos under ~/ (not /mnt/c)',
      'Install and pair the runner inside Ubuntu (aom-runner pair ...), then run it as a systemd user service',
      'Full steps: docs/RUNNER.md, "Windows: run the runner inside WSL2"',
      'Opt-in without sandbox (not recommended): runtimes["claude-code"] { "sandbox": "best_effort", "allowUnsandboxed": true } in config.json',
    ].entries())
      out.push({ ok: 'warn', name: i === 0 ? 'windows' : '       ', detail: step });
  return out;
}

// ------------------------------------------------------------------------------------------- toolchains

export const inside = (child: string, parent: string): boolean => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && r !== '..');
};

/**
 * Directories sandboxed shell commands may read although the read block hides /home: the Node install the runner
 * runs on (so `node`, `npm` and the `aom` shim work) plus the configured toolchain paths. `~` expands to the real
 * home. The home directory itself, anything containing it, and any credential store are refused.
 */
export function toolchainReadPaths(
  configured: string[],
  execPath: string = process.execPath,
  realHome: string = homedir(),
): string[] {
  const out = new Set<string>();
  let node = execPath;
  try {
    node = realpathSync(execPath);
  } catch {
    /* keep the path as given */
  }
  // <prefix>/bin/node -> <prefix>
  out.add(dirname(dirname(node)));
  for (const raw of configured) {
    const p = resolve(raw.startsWith('~') ? join(realHome, raw.slice(1)) : raw);
    out.add(p);
  }
  const secrets = HOME_SECRETS.map((s) => join(realHome, s));
  return [...out].filter(
    (p) =>
      p !== '/' &&
      !inside(realHome, p) && // never the home dir itself or a parent of it
      !secrets.some((s) => inside(p, s) || inside(s, p)),
  );
}
