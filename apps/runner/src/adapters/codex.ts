import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { type AgentPermissions, CODEX_RUNTIME, codexRoleProblem } from '@aom/shared';
import { execa } from 'execa';
import { materializeSkills } from '../capabilities/materialize.ts';
import type { CodexRuntimeConfig } from '../config.ts';
import type { RunnerPaths } from '../paths.ts';
import { DOTNET_SHM_DIR, userNugetPackages } from '../sandbox/sandbox.ts';
import { selfCommand } from '../shims.ts';
import {
  agentEnv,
  BRANCH_MOVING_DENIED,
  GIT_PUSH_DENIED,
  inside,
  STASH_REMOVING_DENIED,
  shellDeny,
  toolchainReadPaths,
} from './claude-policy.ts';
import { CodexStreamParser, codexUsageLimit, isCodexAuthFailureText } from './codex-stream-parser.ts';
import { spawnSession } from './process-session.ts';
import { SECRET_FILE_GLOBS } from './read-only-dirs.ts';
import type {
  ChatStartInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  ShiftStartInput,
} from './types.ts';

/**
 * The Codex CLI runtime. Verified against codex-cli 0.163.0 (npm `@openai/codex`, github.com/openai/codex tag rust-v0.163.0,
 * 2026-10-15); the sources of each fact are in docs/RUNNER.md, "Codex CLI runtime". In short:
 *
 * - `codex exec --json` prints one JSON event per line (`codex-rs/exec/src/exec_events.rs`); `exec` never asks for approval
 *   (headless default `approval_policy = never`, also set here). `resume <id> -` continues a thread by id; the prompt is read
 *   from stdin when it is `-`, which keeps a big prompt out of argv.
 * - The sandbox is a PERMISSION PROFILE (`default_permissions` + `[permissions.<name>]`, learn.chatgpt.com/docs/permissions):
 *   a deny-by-default filesystem (`:minimal` plus the paths listed), `network.enabled = false`. A profile and `--sandbox` /
 *   `sandbox_mode` do not combine, so `--sandbox` is never passed. `codex sandbox <cmd>` runs a command under the same config
 *   and is how the runner checks the sandbox works (`probeSandbox`).
 * - `CODEX_HOME` (default `~/.codex`) holds `auth.json`, `AGENTS.md` (global instructions), `rules/*.rules` (execpolicy), the
 *   rollout files of threads (`sessions/`). Each agent gets its own, so the owner's `~/.codex` is never read.
 * - Skills: `$HOME/.agents/skills` is the USER scope (the agent's private HOME); `<repo>/.agents/skills` is REPO scope.
 * - Every `-c key=value` value is parsed as TOML, so the whole per-session policy travels in argv and `CODEX_HOME` holds only
 *   state that is the same for every session of the agent (several chats of one agent can run at the same time).
 */
export const CODEX_VERIFIED_VERSION = '0.163.0';
/** The oldest version the profile syntax and `--strict-config` below were checked on. */
export const CODEX_MIN_VERSION: readonly [number, number, number] = [0, 163, 0];

type CodexConfig = CodexRuntimeConfig & { bin: string };
type SandboxInfo = Pick<ShiftStartInput['sandbox'], 'home' | 'configDir' | 'scratch' | 'tmp' | 'cacheRoot'>;

// ------------------------------------------------------------------------------------------------ TOML for `-c`

/** A TOML value for `-c key=value` (inline tables, quoted keys). JSON string escapes are valid TOML basic-string escapes. */
export function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)} = ${tomlValue(x)}`)
      .join(', ')}}`;
  throw new Error(`cannot write ${typeof v} as TOML`);
}

// ------------------------------------------------------------------------------------------------ locations

/** The agent's private Codex home: `agents/<id>/codex`, next to the Claude config dir. State shared by its sessions only. */
export const codexHomeOf = (sandbox: Pick<SandboxInfo, 'configDir'>): string =>
  join(dirname(sandbox.configDir), 'codex');

/** Codex's USER-scope skills folder, inside the agent's private HOME (never the card worktree or repository). */
export const codexSkillsDirOf = (sandbox: Pick<SandboxInfo, 'home'>): string =>
  join(sandbox.home, '.agents', 'skills');

const expandHome = (p: string, home: string): string => (p.startsWith('~') ? join(home, p.slice(1)) : p);

/** Is `name` an executable file on PATH, or the given path? Returns its absolute path. */
export function findBinary(
  name: string,
  pathVar: string = process.env.PATH ?? '',
  home: string = homedir(),
): string | undefined {
  const n = expandHome(name, home);
  const ok = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(n) || n.includes('/') || n.includes(sep)) return ok(resolve(n)) ? resolve(n) : undefined;
  for (const d of pathVar.split(delimiter)) {
    if (!d) continue;
    const p = join(d, n);
    if (ok(p)) return p;
  }
  return undefined;
}

/**
 * Registration check (adapters/registry.ts): the configured `codex` binary, or the one on PATH. Undefined (the runtime is not
 * registered) when the runtime is disabled, the platform has no Codex sandbox this adapter supports, or no binary is found.
 * Under tests and the mock runtime a binary on PATH is NOT picked up (a real `codex` would spend tokens): only an explicit `bin`.
 */
export function detectCodex(
  cfg: CodexRuntimeConfig | undefined,
  opts: { platform?: NodeJS.Platform; pathVar?: string; home?: string; blocked?: boolean } = {},
): string | undefined {
  if (cfg?.enabled === false) return undefined;
  if ((opts.platform ?? process.platform) !== 'linux' && (opts.platform ?? process.platform) !== 'darwin')
    return undefined;
  if (opts.blocked && !cfg?.bin) return undefined;
  return findBinary(cfg?.bin ?? 'codex', opts.pathVar, opts.home);
}

/** The folder with the codex install, readable inside the sandbox (the sandbox helper re-executes the codex binary). */
export function codexInstallDirs(bin: string): string[] {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch {
    /* keep the path as given */
  }
  const out = new Set<string>([dirname(real)]);
  // npm layout: <pkg>/bin/codex.js next to <pkg>/vendor/<triple>/bin/codex
  let d = dirname(real);
  for (let i = 0; i < 4; i++) {
    const pj = join(d, 'package.json');
    if (existsSync(pj)) {
      try {
        const name = (JSON.parse(readFileSync(pj, 'utf8')) as { name?: string }).name ?? '';
        if (name === '@openai/codex' || name.startsWith('@openai/codex')) {
          out.add(d);
          // pnpm keeps the platform binary (`@openai/codex-linux-x64`) in a sibling folder of its store: <store>/.pnpm
          const k = real.indexOf(`${sep}.pnpm${sep}`);
          if (k > 0) out.add(real.slice(0, k + `${sep}.pnpm`.length));
        }
      } catch {
        /* not a package */
      }
      break;
    }
    d = dirname(d);
  }
  return [...out];
}

// ------------------------------------------------------------------------------------------------ the sandbox profile

export interface CodexProfileInput {
  cwd: string;
  /** The working folder is read-only: no edit tool, or a chat. */
  readOnlyCwd: boolean;
  sandbox: Pick<SandboxInfo, 'home' | 'scratch' | 'tmp' | 'cacheRoot'>;
  /** The main repositories' `.git` dirs of a linked worktree (claude-policy `gitDirsOf`). */
  gitDirs: string[];
  /** The agent commits: the worktree's own admin dir, objects, refs and logs become writable (never config or hooks). */
  mayCommit: boolean;
  readDirs: string[];
  addDirs: string[];
  toolchainReadPaths: string[];
  aomReadPaths: string[];
  codexReadPaths: string[];
  nugetFallbackDir?: string;
  dotnetShmDir?: string;
}

/** `<repo>/.git/worktrees/<name>` of a linked worktree (read from its `.git` file), if `cwd` is one. */
export function gitAdminDirOf(cwd: string): string | undefined {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(cwd, '.git'), 'utf8'));
    return m?.[1] ? resolve(cwd, m[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

type Access = 'read' | 'write' | 'deny';

/**
 * The `[permissions.aom.filesystem]` table. Everything not named is invisible to the shell (deny-by-default: the owner's home,
 * the runner's data dir with its token and secrets, the other agents' folders, this agent's own Codex home with `auth.json`).
 * Deny beats write beats read for the same path (docs). Pure; unit tested.
 */
export function codexFilesystem(i: CodexProfileInput): Record<string, unknown> {
  const fs: Record<string, Access> = {};
  const set = (path: string, access: Access): void => {
    const p = resolve(path);
    const rank = { read: 0, write: 1, deny: 2 };
    const cur = fs[p];
    if (!cur || rank[access] > rank[cur]) fs[p] = access;
  };
  fs[':minimal'] = 'read';
  for (const p of [i.sandbox.home, i.sandbox.tmp]) set(p, 'write');
  if (i.sandbox.cacheRoot) set(i.sandbox.cacheRoot, 'write');
  // The scratch folder: writable unless it IS the (read-only) working folder.
  if (!(i.readOnlyCwd && (inside(i.sandbox.scratch, i.cwd) || inside(i.cwd, i.sandbox.scratch))))
    set(i.sandbox.scratch, 'write');
  for (const p of [...i.toolchainReadPaths, ...i.aomReadPaths, ...i.codexReadPaths]) set(p, 'read');
  for (const p of [...i.addDirs, ...i.readDirs]) set(p, 'read');
  if (i.nugetFallbackDir) set(i.nugetFallbackDir, 'read');
  if (i.dotnetShmDir) set(i.dotnetShmDir, 'write');
  // No socket here: the aom CLI is excluded from the sandbox by an execpolicy `allow` rule (see `codexRules`), because a Unix
  // socket cannot be connected from inside Codex's network-restricted sandbox (connect() fails with EPERM, verified on 0.163.0).
  // Reference repositories keep their secret files unreadable (the same names as read-only-dirs.ts). Matches are fixed when
  // the sandboxed process starts (docs): a file created later is not covered.
  for (const d of i.readDirs) for (const g of SECRET_FILE_GLOBS) set(join(d, '**', g), 'deny');
  // Git: a linked worktree commits into <repo>/.git/worktrees/<name>, objects, refs and logs; config and hooks stay read-only.
  const admin = gitAdminDirOf(i.cwd);
  for (const common of i.gitDirs) {
    set(common, 'read');
    if (i.mayCommit && !i.readOnlyCwd && admin) {
      for (const p of [admin, join(common, 'objects'), join(common, 'refs'), join(common, 'logs')])
        set(p, 'write');
    }
  }
  return fs;
}

/** The whole `permissions.aom` table. The working folder is the workspace root (`--cd`). */
export function codexPermissions(i: CodexProfileInput): Record<string, unknown> {
  const fs = codexFilesystem(i);
  return {
    filesystem: { ...fs, ':workspace_roots': { '.': i.readOnlyCwd ? 'read' : 'write' } },
    network: { enabled: false },
  };
}

// ------------------------------------------------------------------------------------------------ execpolicy rules

/**
 * `Bash(git push:*)`-style rules as Codex `prefix_rule`s. Defence in depth only: the structure (no network, a read-only or
 * worktree-only filesystem) is what holds, because Codex matches a command's leading words after splitting a simple shell
 * script, and a pattern with a wildcard in the middle (`git -C * push`) has no equivalent.
 */
export function codexRules(p: Pick<AgentPermissions, 'deniedShellPatterns'>, roleKey?: string): string {
  const claude = [
    ...GIT_PUSH_DENIED,
    'Bash(git reset --hard:*)',
    ...STASH_REMOVING_DENIED,
    ...(roleKey === 'builder' ? [] : BRANCH_MOVING_DENIED),
    ...p.deniedShellPatterns.map(shellDeny),
  ];
  const seen = new Set<string>();
  // The aom CLI is the agent's only way to the runner (the sandbox has no network, and a Unix socket cannot be connected from
  // inside it). An `allow` rule runs a matching command OUTSIDE the sandbox without asking, as claude-code's excluded `aom`
  // does: only a standalone `aom ...` command matches, a compound command containing anything else stays sandboxed.
  const lines: string[] = ['prefix_rule(pattern=["aom"], decision="allow")'];
  for (const r of claude) {
    const m = /^Bash\(([A-Za-z0-9_./ -]+?)(?::\*)?\)$/.exec(r);
    if (!m?.[1] || m[1].includes('*') || m[1].includes('/*')) continue;
    const words = m[1].trim().split(/\s+/);
    const key = words.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `prefix_rule(pattern=${JSON.stringify(words)}, decision="forbidden", justification="not allowed for this agent")`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------ command

export interface CodexCommandInput {
  prompt: string;
  cwd: string;
  model: string;
  effort?: string;
  resumeSessionId?: string;
  /** The variables the agent's shell commands get (and the codex process, besides its own). Never a secret of the runner. */
  shellEnv: Record<string, string>;
  profile: CodexProfileInput;
  /** The role may use web search (Codex's hosted search tool; the shell has no network either way). */
  web: boolean;
  codexHome: string;
}

export interface CodexCommand {
  bin: string;
  args: string[];
  env: Record<string, string>;
  /** The prompt, always on stdin (`-`): it never shows in `ps` and cannot overflow argv. */
  stdin: string;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The environment of the codex process: the allow-listed inherited variables, the session's variables, `CODEX_HOME` and, in
 * `api_key` mode, `CODEX_API_KEY`. Nothing else of the runner's environment (its tokens, `GH_TOKEN`, ssh agent, ...) reaches it.
 */
export function codexProcessEnv(
  shellEnv: Record<string, string>,
  codexHome: string,
  cfg: Pick<CodexRuntimeConfig, 'authMode' | 'apiKey'>,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const provider: Record<string, string> = {};
  if (cfg.authMode === 'api_key' && cfg.apiKey) provider.CODEX_API_KEY = cfg.apiKey;
  return agentEnv(shellEnv, provider, parent, { CODEX_HOME: codexHome });
}

/** The exact argv/env of a `codex exec` session (docs/RUNNER.md). Pure; unit tested. */
export function buildCodexCommand(
  input: CodexCommandInput,
  cfg: CodexConfig,
  parent: NodeJS.ProcessEnv = process.env,
): CodexCommand {
  const overrides: Array<[string, unknown]> = [
    // exec never asks; naming it keeps a changed default from turning a refusal into a prompt nobody answers
    ['approval_policy', 'never'],
    ['default_permissions', 'aom'],
    ['permissions.aom', codexPermissions(input.profile)],
    // The shell gets exactly `shellEnv`: no variable of the codex process (its API key, CODEX_HOME) and none of the runner's.
    ['shell_environment_policy', { inherit: 'none', set: input.shellEnv }],
    // `login = true` would run the shell as a login shell, and /etc/profile may rewrite PATH (the aom shim would vanish)
    ['allow_login_shell', false],
    ['web_search', input.web ? 'live' : 'disabled'],
    ['cli_auth_credentials_store', 'file'],
    ['analytics', { enabled: false }],
    ['feedback', { enabled: false }],
    ['check_for_update_on_startup', false],
    ['history', { persistence: 'none' }],
    // A card's rendered instructions are long: the default 32 KiB would cut them silently.
    ['project_doc_max_bytes', 1_048_576],
    // Only the skills the agent is granted: not the ones bundled with Codex.
    ['skills', { bundled: { enabled: false } }],
  ];
  if (cfg.authMode === 'api_key') overrides.push(['forced_login_method', 'api']);
  if (input.effort && EFFORTS.includes(input.effort))
    overrides.push(['model_reasoning_effort', input.effort]);
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--strict-config',
    '--color',
    'never',
    '--cd',
    input.cwd,
    '--model',
    input.model,
  ];
  for (const [k, v] of overrides) args.push('-c', `${k}=${tomlValue(v)}`);
  if (input.resumeSessionId) args.push('resume', input.resumeSessionId);
  args.push('-');
  return {
    bin: cfg.bin,
    args,
    env: codexProcessEnv(input.shellEnv, input.codexHome, cfg, parent),
    stdin: input.prompt,
  };
}

// ------------------------------------------------------------------------------------------------ login handling

/** Serialises copying and handing back the owner's login among this runner's sessions. */
let authChain: Promise<unknown> = Promise.resolve();
function withAuthLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = authChain.then(fn, fn);
  authChain = next.catch(() => undefined);
  return next;
}

function lastRefresh(file: string): number {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { last_refresh?: unknown };
    const t = typeof j.last_refresh === 'string' ? Date.parse(j.last_refresh) : Number.NaN;
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* not supported everywhere */
  }
  renameSync(tmp, file);
}

export interface CodexHost {
  platform?: NodeJS.Platform;
  /** The owner's real home (where `~/.codex` is). */
  home?: string;
  /** The environment the allow-list reads from. */
  parent?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Test hook: extra argv for `codex exec` (e.g. `-c openai_base_url=...` to point it at a fake API), put before the prompt. */
  extraArgs?: string[];
  /** Test hook: the result of the sandbox self-test. */
  sandboxProbe?: () => Promise<{ ok: boolean; reason: string }>;
}

const PROBE_TTL_MS = 10 * 60_000;

export class CodexAdapter implements RuntimeAdapter {
  readonly id = CODEX_RUNTIME;
  private probe: { at: number; result: { ok: boolean; reason: string } } | undefined;
  /** The login failed in a session: unavailable until `auth.json` changes or a session works. */
  private authBad: { mtimeMs: number } | undefined;

  constructor(
    private readonly cfg: CodexConfig,
    private readonly paths?: RunnerPaths,
    private readonly host: CodexHost = {},
  ) {}

  private realHome(): string {
    return this.host.home ?? homedir();
  }

  private parentEnv(): NodeJS.ProcessEnv {
    return this.host.parent ?? process.env;
  }

  /** The owner's login file (`auth.json`): `loginDir`, else `$CODEX_HOME`, else `~/.codex`. */
  loginFile(): string {
    const dir = this.cfg.loginDir
      ? expandHome(this.cfg.loginDir, this.realHome())
      : (this.parentEnv().CODEX_HOME ?? join(this.realHome(), '.codex'));
    return join(dir, 'auth.json');
  }

  private loginState(): 'ok' | 'expired' {
    if (this.cfg.authMode === 'api_key') return this.cfg.apiKey ? 'ok' : 'expired';
    const f = this.loginFile();
    if (!existsSync(f)) return 'expired';
    if (this.authBad) {
      try {
        if (statSync(f).mtimeMs === this.authBad.mtimeMs) return 'expired';
      } catch {
        return 'expired';
      }
      this.authBad = undefined;
    }
    return 'ok';
  }

  private sandboxPlatformProblem(): string | undefined {
    const p = this.host.platform ?? process.platform;
    return p === 'linux' || p === 'darwin'
      ? undefined
      : 'the Codex sandbox is supported by this runner on Linux (WSL2) and macOS only';
  }

  /**
   * Does Codex's sandbox work here? `codex sandbox -- true` under the same kind of profile the sessions use, in a scratch
   * CODEX_HOME. Cached for ten minutes. A failure is the reason shown to the owner (no bubblewrap, no user namespaces, ...).
   */
  async probeSandbox(): Promise<{ ok: boolean; reason: string }> {
    const platformProblem = this.sandboxPlatformProblem();
    if (platformProblem) return { ok: false, reason: platformProblem };
    const now = (this.host.now?.() ?? new Date()).getTime();
    if (this.probe && now - this.probe.at < PROBE_TTL_MS) return this.probe.result;
    const result = await (this.host.sandboxProbe ?? (() => this.runProbe()))();
    this.probe = { at: now, result };
    return result;
  }

  /** Folders of the codex install the sandbox must let the helper re-execute (found from the binary, or learned from a failed probe). */
  private readonly learned = new Set<string>();
  private installPaths(): string[] {
    return [...new Set([...codexInstallDirs(this.cfg.bin), ...this.learned])];
  }

  private async runProbe(): Promise<{ ok: boolean; reason: string }> {
    // Installs that start `codex` through a shim (pnpm, some wrappers) hide the native binary's folder from
    // `codexInstallDirs`; the helper's own error names it ("execvp <path>"), so it is learned and the check run once more.
    let r = await this.probeOnce();
    const m = /execvp (\S+): No such file/.exec(r.reason);
    if (!r.ok && m?.[1] && isAbsolute(m[1])) {
      this.learned.add(dirname(dirname(m[1])));
      r = await this.probeOnce();
    }
    return r;
  }

  private async probeOnce(): Promise<{ ok: boolean; reason: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'aom-codex-probe-'));
    try {
      const home = join(dir, 'home');
      mkdirSync(home, { recursive: true });
      const profile: CodexProfileInput = {
        cwd: dir,
        readOnlyCwd: true,
        sandbox: { home, scratch: join(dir, 'scratch'), tmp: join(dir, 'tmp') },
        gitDirs: [],
        mayCommit: false,
        readDirs: [],
        addDirs: [],
        toolchainReadPaths: [],
        aomReadPaths: [],
        codexReadPaths: this.installPaths(),
      };
      const r = await execa(
        this.cfg.bin,
        [
          'sandbox',
          '-c',
          'default_permissions="aom"',
          '-c',
          `permissions.aom=${tomlValue(codexPermissions(profile))}`,
          '--',
          'true',
        ],
        {
          cwd: dir,
          env: { CODEX_HOME: dir, HOME: home, PATH: this.parentEnv().PATH ?? '' },
          extendEnv: false,
          reject: false,
          timeout: 30_000,
          stdin: 'ignore',
        },
      );
      if (r.exitCode === 0)
        return {
          ok: true,
          reason:
            (this.host.platform ?? process.platform) === 'darwin'
              ? 'Codex permission profile (macOS Seatbelt)'
              : 'Codex permission profile (bubblewrap + seccomp)',
        };
      const text = `${r.stderr ?? ''}\n${r.stdout ?? ''}`
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('WARNING'))
        .slice(0, 2)
        .join(' | ');
      return {
        ok: false,
        reason: `the Codex sandbox does not start: ${text || `exit ${r.exitCode}`}`.slice(0, 300),
      };
    } catch (err) {
      return { ok: false, reason: `the Codex sandbox self-test failed: ${String(err).slice(0, 200)}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = ['shell', 'edit', 'web', 'skills', 'resume'];
    const auth = this.loginState();
    let version = 'unknown';
    try {
      const r = await execa(this.cfg.bin, ['--version'], { reject: false, timeout: 10_000, stdin: 'ignore' });
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout));
      if (r.exitCode !== 0 || !m)
        return this.unavailable(version, auth, 'unavailable', 'codex --version failed');
      version = m[0];
      const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const [x, y, z] = CODEX_MIN_VERSION;
      const old = a < x || (a === x && (b < y || (b === y && c < z)));
      if (old)
        return this.unavailable(
          version,
          auth,
          'unavailable',
          `codex ${version} is older than ${CODEX_MIN_VERSION.join('.')}, the oldest version whose sandbox profiles were checked: update it (npm i -g @openai/codex)`,
        );
    } catch {
      return this.unavailable(version, auth, 'unavailable', 'the codex binary does not run');
    }
    const sb = await this.probeSandbox();
    const ok = sb.ok && auth === 'ok';
    return {
      runtime: this.id,
      version,
      available: ok,
      capabilities: ok ? caps : [],
      sandbox: sb.ok ? 'enforced' : 'unavailable',
      sandboxReason: sb.reason,
      auth,
    };
  }

  private unavailable(
    version: string,
    auth: 'ok' | 'expired',
    sandbox: 'unavailable',
    reason: string,
  ): RuntimeCapabilities {
    return {
      runtime: this.id,
      version,
      available: false,
      capabilities: [],
      sandbox,
      sandboxReason: reason,
      auth,
    };
  }

  /** `AGENTS.md` in the agent's private Codex home: Codex's global instructions. The text is the shared renderer's, verbatim. */
  async writeInstructions(sandbox: Pick<SandboxInfo, 'configDir'>, markdown: string): Promise<void> {
    const dir = codexHomeOf(sandbox);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'AGENTS.md'), markdown);
    // An override file in the same folder would win over AGENTS.md; this home never has one.
    rmSync(join(dir, 'AGENTS.override.md'), { force: true });
  }

  // -------------------------------------------------------------------------------------------- session

  private assertRole(roleKey: string, isDevops: boolean | undefined, permissions: AgentPermissions): void {
    const problem = codexRoleProblem({ roleKey, isDevops: isDevops === true, permissions });
    if (problem) throw new Error(`codex_role_refused: ${problem}`);
  }

  private async assertCanRun(): Promise<void> {
    const sb = await this.probeSandbox();
    if (!sb.ok) throw new Error(`the Codex sandbox is unavailable: ${sb.reason}`);
    if (this.loginState() === 'expired')
      throw new Error(
        this.cfg.authMode === 'api_key'
          ? 'Codex has no API key: set runtimes.codex.apiKey in the runner config'
          : 'Codex is not signed in on this workstation: run `codex login` as the runner user',
      );
  }

  /** Puts the owner's login (or nothing, in api_key mode) into the agent's private Codex home. */
  private prepareLogin(codexHome: string): Promise<void> {
    return withAuthLock(() => {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      const dest = join(codexHome, 'auth.json');
      if (this.cfg.authMode === 'api_key') {
        rmSync(dest, { force: true });
        return;
      }
      const src = this.loginFile();
      // keep a copy that a running session of this agent already refreshed
      if (existsSync(dest) && lastRefresh(dest) > lastRefresh(src)) return;
      writePrivate(dest, readFileSync(src, 'utf8'));
    });
  }

  /** After a session: a refreshed login (newer `last_refresh`) goes back to the owner's file, so the next session starts valid. */
  private harvestLogin(codexHome: string): Promise<void> {
    if (this.cfg.authMode === 'api_key') return Promise.resolve();
    return withAuthLock(() => {
      const mine = join(codexHome, 'auth.json');
      const src = this.loginFile();
      if (!existsSync(mine) || !existsSync(src)) return;
      if (lastRefresh(mine) > lastRefresh(src)) writePrivate(src, readFileSync(mine, 'utf8'));
    });
  }

  private shellEnv(input: { env: Record<string, string> }): Record<string, string> {
    // CLAUDE_CONFIG_DIR names a folder the Codex agent has no use for (and a path the shell should not learn).
    const { CLAUDE_CONFIG_DIR: _c, ...rest } = input.env;
    return {
      ...agentEnv(rest, {}, this.parentEnv()),
      // git's background maintenance would take locks in the repository's `.git` root, which the sandbox keeps read-only
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'gc.auto',
      GIT_CONFIG_VALUE_1: '0',
    };
  }

  private profile(
    input: {
      cwd: string;
      sandbox: SandboxInfo;
      env: Record<string, string>;
      addDirs?: string[];
      readDirs?: string[];
      toolchainReadDirs?: string[];
    },
    readOnlyCwd: boolean,
    mayCommit: boolean,
  ): CodexProfileInput {
    const root = this.paths?.root ?? dirname(dirname(input.sandbox.home));
    const script = selfCommand('aom').at(-1);
    const nuget = userNugetPackages(this.realHome());
    return {
      cwd: input.cwd,
      readOnlyCwd,
      sandbox: input.sandbox,
      gitDirs: gitCommonDirs(input.cwd),
      mayCommit,
      readDirs: input.readDirs ?? [],
      addDirs: input.addDirs ?? [],
      toolchainReadPaths: toolchainReadPaths(
        [...this.cfg.toolchainPaths, ...(input.toolchainReadDirs ?? [])],
        process.execPath,
        this.realHome(),
      ),
      aomReadPaths: [this.paths?.bin ?? join(root, 'bin'), ...(script ? [dirname(script)] : [])],
      codexReadPaths: this.installPaths(),
      ...(nuget ? { nugetFallbackDir: nuget } : {}),
      ...((this.host.platform ?? process.platform) === 'linux' ? { dotnetShmDir: DOTNET_SHM_DIR } : {}),
    };
  }

  /** Writes what is the same for every session of the agent: its skills and the execpolicy rules. */
  private prepareHome(
    sandbox: SandboxInfo,
    grantedSkills: ShiftStartInput['grantedSkills'],
    permissions: AgentPermissions,
    roleKey: string,
  ): string {
    const home = codexHomeOf(sandbox);
    mkdirSync(join(home, 'rules'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'rules', 'aom.rules'), codexRules(permissions, roleKey));
    // The USER-scope skills folder, in the agent's private HOME: exactly the granted skills, nothing from the owner or an
    // earlier shift, and nothing written into the card's worktree.
    materializeSkills(codexSkillsDirOf(sandbox), grantedSkills ?? []);
    return home;
  }

  private withExtra(cmd: CodexCommand): void {
    const x = this.host.extraArgs;
    if (x?.length)
      cmd.args.splice(
        cmd.args.indexOf('resume') >= 0 ? cmd.args.indexOf('resume') : cmd.args.length - 1,
        0,
        ...x,
      );
  }

  private spawn(
    cmd: CodexCommand,
    cwd: string,
    parser: CodexStreamParser,
    logFile: string | undefined,
    codexHome: string,
  ): RuntimeSession {
    return spawnSession({
      bin: cmd.bin,
      args: cmd.args,
      cwd,
      env: cmd.env,
      inheritEnv: false,
      input: cmd.stdin,
      parseLine: (l) => parser.parseLine(l),
      usage: () => parser.usage(),
      contextTokens: () => parser.contextTokens(),
      ...(logFile ? { logFile } : {}),
      exitError: () => (parser.resultError ? `codex: ${parser.resultError}` : undefined),
      authFailure: (stderr) => parser.authFailure || isCodexAuthFailureText(stderr),
      usageLimit: (stderr) =>
        codexUsageLimit(parser.usageLimitText ?? '', this.host.now?.()) ??
        codexUsageLimit(stderr, this.host.now?.()),
      onExit: async ({ code, authFailed }) => {
        try {
          if (authFailed) {
            let mtimeMs = 0;
            try {
              mtimeMs = statSync(this.loginFile()).mtimeMs;
            } catch {
              /* no file */
            }
            this.authBad = { mtimeMs };
          } else if (code === 0 && parser.usage().outputTokens > 0) this.authBad = undefined;
          await this.harvestLogin(codexHome);
        } catch {
          /* best effort */
        }
      },
    });
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    this.assertRole(input.agent.roleKey, input.agent.isDevops, input.agent.permissions);
    if (input.devopsGuard || input.kind === 'devops' || input.kind === 'ceo')
      throw new Error('codex_role_refused: DevOps and CEO shifts run on Claude Code');
    await this.assertCanRun();
    const perms = input.agent.permissions;
    const edit = perms.allowedTools.includes('edit');
    const codexHome = this.prepareHome(input.sandbox, input.grantedSkills, perms, input.agent.roleKey);
    await this.prepareLogin(codexHome);
    const profile = this.profile(input, !edit, edit && perms.mayCommit);
    const cmd = buildCodexCommand(
      {
        prompt: input.prompt,
        cwd: input.cwd,
        model: input.agent.model,
        ...(input.agent.effort ? { effort: input.agent.effort } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        shellEnv: this.shellEnv(input),
        profile,
        web: perms.allowedTools.includes('web'),
        codexHome,
      },
      this.cfg,
      this.parentEnv(),
    );
    this.withExtra(cmd);
    return this.spawn(
      cmd,
      input.cwd,
      new CodexStreamParser({ model: input.agent.model }),
      input.logFile,
      codexHome,
    );
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    if (input.agent.isDevops || input.agent.roleKey === 'ceo' || input.agent.roleKey === 'devops')
      throw new Error('codex_role_refused: the DevOps and CEO chats run on Claude Code');
    if (input.intake)
      throw new Error(
        'codex_role_refused: the intake chat needs the Jira tool (MCP), which Codex does not get',
      );
    await this.assertCanRun();
    const codexHome = this.prepareHome(
      input.sandbox,
      input.grantedSkills,
      input.agent.permissions,
      input.agent.roleKey,
    );
    await this.prepareLogin(codexHome);
    // A chat reads: its working folder is read-only (a card's worktree, or the scratch folder of a session turn).
    const readDirs = [...new Set([...(input.readDirs ?? [])])];
    const profile = this.profile({ ...input, readDirs }, true, false);
    const cmd = buildCodexCommand(
      {
        prompt: input.message,
        cwd: input.cwd,
        model: input.agent.model,
        ...(input.agent.effort ? { effort: input.agent.effort } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        shellEnv: this.shellEnv(input),
        profile,
        web: input.agent.permissions.allowedTools.includes('web'),
        codexHome,
      },
      this.cfg,
      this.parentEnv(),
    );
    this.withExtra(cmd);
    return this.spawn(
      cmd,
      input.cwd,
      new CodexStreamParser({ model: input.agent.model, chat: true }),
      input.logFile,
      codexHome,
    );
  }
}

/** The main repository's `.git` dir of a linked worktree (empty for a plain clone, whose `.git` is inside the workspace). */
function gitCommonDirs(cwd: string): string[] {
  const admin = gitAdminDirOf(cwd);
  if (!admin) return [];
  return /[\\/]worktrees[\\/][^\\/]+$/.test(admin) ? [resolve(admin, '..', '..')] : [admin];
}
