import { createDecipheriv, scryptSync } from 'node:crypto';
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
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { type AgentPermissions, GEMINI_RUNTIME, runtimeRoleProblem } from '@aom/shared';
import { execa } from 'execa';
import { materializeSkills } from '../capabilities/materialize.ts';
import type { GeminiRuntimeConfig } from '../config.ts';
import type { ProviderStore } from '../direct/store.ts';
import type { RunnerPaths } from '../paths.ts';
import { DOTNET_SHM_DIR, userNugetPackages } from '../sandbox/sandbox.ts';
import { selfCommand } from '../shims.ts';
import { agentEnv, toolchainReadPaths } from './claude-policy.ts';
import { findBinary, gitCommonDirs } from './codex.ts';
import { deniedShellPrefixes } from './denied-shell.ts';
import { GeminiStreamParser, geminiUsageLimit, isGeminiAuthFailureText } from './gemini-stream-parser.ts';
import {
  type HarnessLaunch,
  installDirsOf,
  type LaunchedHarness,
  launchInHarnessSandbox,
  probeHarnessSandbox,
} from './harness-session.ts';
import { spawnSession } from './process-session.ts';
import type {
  ChatStartInput,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeSession,
  ShiftStartInput,
} from './types.ts';

/**
 * The Gemini CLI runtime (docs/RUNNER.md, "Gemini CLI runtime"). Verified against @google/gemini-cli 0.65.0 (npm, 2026-10-24) by
 * running the real binary against a fake Gemini API; the facts used are:
 * - `gemini -p '' --output-format stream-json --approval-mode yolo --skip-trust -m <model>` reads the prompt from stdin (the `-p`
 *   value is appended to it) and prints one JSON event per line (`gemini-stream-parser.ts`). `--resume <session id>` continues a
 *   session by its id. Headless mode refuses a folder that is not trusted, hence `--skip-trust`.
 * - `GEMINI_CLI_HOME` is the root of its user folder (`<root>/.gemini`: settings, GEMINI.md, credentials, sessions, skills,
 *   policies); `<root>/.agents/skills` and `<root>/.gemini/skills` are its user-scope skills (Agent Skills, SKILL.md).
 * - The policy engine (`--admin-policy <file.toml>`, tier "admin", above user and workspace settings) allows, denies or asks per
 *   tool and per shell command prefix; in headless mode "ask" is a refusal. This is how a role without a shell is limited to `aom`.
 * - Its own sandbox (docker, podman, seatbelt, runsc) is not used: seatbelt is macOS only, the containers do not carry the `aom`
 *   command or the runner's socket, and its Linux "tool sandbox" binds the whole filesystem read-only (the owner's home included).
 *   The runner puts the whole CLI in its own bubblewrap sandbox instead (`sandbox/harness-sandbox.ts`).
 * - Sign-in: the Google login is kept in the OS keychain, or in `<home>/.gemini/gemini-credentials.json` (AES-GCM under a key
 *   derived from host and user name) when the keychain is not used (`GEMINI_FORCE_FILE_STORAGE=true`, WSL), or in the older
 *   `oauth_creds.json`. An API key is `GEMINI_API_KEY`.
 */
export const GEMINI_VERIFIED_VERSION = '0.65.0';
export const GEMINI_MIN_VERSION: readonly [number, number, number] = [0, 65, 0];

type GeminiConfig = GeminiRuntimeConfig & { bin: string };
type SandboxInfo = Pick<ShiftStartInput['sandbox'], 'home' | 'configDir' | 'scratch' | 'tmp' | 'cacheRoot'>;

/** Under tests and the mock runtime a binary on PATH is NOT picked up (a real `gemini` could spend tokens): only an explicit `bin`. */
export function detectGemini(
  cfg: GeminiRuntimeConfig | undefined,
  opts: { platform?: NodeJS.Platform; pathVar?: string; home?: string; blocked?: boolean } = {},
): string | undefined {
  if (cfg?.enabled === false) return undefined;
  if ((opts.platform ?? process.platform) !== 'linux') return undefined;
  if (opts.blocked && !cfg?.bin) return undefined;
  return findBinary(cfg?.bin ?? 'gemini', opts.pathVar, opts.home);
}

/** The agent's private Gemini root: `agents/<id>/gemini` (`GEMINI_CLI_HOME`); the CLI's files are in its `.gemini` folder. */
export const geminiHomeOf = (sandbox: Pick<SandboxInfo, 'configDir'>): string =>
  join(dirname(sandbox.configDir), 'gemini');
const dotGemini = (ghome: string): string => join(ghome, '.gemini');

/** The CLI's install folders (the bundle and its package), read-only inside the sandbox. */
export function geminiInstallDirs(bin: string): string[] {
  return installDirsOf(bin, ['@google/gemini-cli'], realpathSync);
}

// ------------------------------------------------------------------------------------------------ settings and policy

export interface GeminiSettingsInput {
  /** The API key goes through the runner's proxy: the CLI is told to use a key (a dummy) and a local base URL. */
  auth: 'oauth-personal' | 'gemini-api-key';
}

/** The agent's `settings.json` (user scope). Written at every session start, so nothing an earlier session wrote stays. */
export function geminiSettings(i: GeminiSettingsInput): Record<string, unknown> {
  return {
    security: { auth: { selectedType: i.auth } },
    general: {
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      checkpointing: { enabled: false },
    },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    // GEMINI.md is the CLI's own name; the repository's AGENTS.md is read as well (as Claude Code and Codex read theirs)
    context: { fileName: ['GEMINI.md', 'AGENTS.md'] },
    // a cloned repository's hooks would run commands outside the shell shim
    hooksConfig: { enabled: false },
    // no MCP server of the repository
    mcp: { allowed: [] },
    tools: { sandbox: false },
    skills: { enabled: true },
    ui: { hideBanner: true, hideTips: true },
  };
}

export interface GeminiPolicyInput {
  perms: Pick<AgentPermissions, 'allowedTools' | 'deniedShellPatterns'>;
  roleKey: string;
  /** A chat: it reads and talks, its shell is `aom` only. */
  chat: boolean;
}

const q = (s: string): string => JSON.stringify(s);

/**
 * The policy file passed with `--admin-policy` (TOML; docs/reference/policy-engine.md of the CLI). Admin rules beat user and
 * workspace rules, so a repository's `.gemini/settings.json` cannot loosen them. Higher `priority` wins within the tier.
 * - the role's denied shell prefixes (`git push`, ...): deny;
 * - a role without `shell`, and every chat: the shell runs `aom ...` only (the way Claude Code allows `Bash(aom:*)`);
 * - a role or chat without `edit`: no write tools (the read-only mount of the working folder is the structure behind it);
 * - a role without `web`: no search or fetch;
 * - always: no MCP tools, no memory writes (`save_memory` would write the global GEMINI.md), no questions to a person (`ask_user`
 *   would wait for nobody).
 */
export function geminiPolicy(i: GeminiPolicyInput): string {
  const tools = i.perms.allowedTools;
  const out: string[] = [];
  const rule = (lines: string[]): void => {
    out.push(`[[rule]]\n${lines.join('\n')}\n`);
  };
  const prefixes = deniedShellPrefixes(i.perms, i.roleKey);
  if (prefixes.length)
    rule([
      'toolName = "run_shell_command"',
      `commandPrefix = [${prefixes.map(q).join(', ')}]`,
      'decision = "deny"',
      'priority = 900',
      `denyMessage = ${q('not allowed for this agent')}`,
    ]);
  const aomOnly = !tools.includes('shell') || i.chat;
  if (aomOnly) {
    rule(['toolName = "run_shell_command"', 'commandPrefix = "aom"', 'decision = "allow"', 'priority = 500']);
    rule([
      'toolName = "run_shell_command"',
      'decision = "deny"',
      'priority = 400',
      `denyMessage = ${q('this agent may run only the aom command in the shell')}`,
    ]);
  }
  const deny = (names: string[], message: string): void =>
    rule([
      `toolName = [${names.map(q).join(', ')}]`,
      'decision = "deny"',
      'priority = 800',
      `denyMessage = ${q(message)}`,
    ]);
  if (!tools.includes('edit') || i.chat) deny(['write_file', 'replace'], 'this agent cannot edit files');
  if (!tools.includes('web')) deny(['google_web_search', 'web_fetch'], 'this agent has no web access');
  deny(['save_memory', 'ask_user', 'enter_plan_mode', 'exit_plan_mode'], 'not available to an agent');
  rule(['toolName = "mcp_*"', 'decision = "deny"', 'priority = 800']);
  return out.join('\n');
}

// ------------------------------------------------------------------------------------------------ command

export interface GeminiCommandInput {
  prompt: string;
  model: string;
  resumeSessionId?: string;
  /** The folders added to the CLI's workspace (the vault, reference repositories). */
  includeDirs: string[];
  policyFile: string;
  /** The variables of the session (`AOM_*`, caches, PATH, HOME ...). Never a secret of the runner. */
  sessionEnv: Record<string, string>;
  ghome: string;
  /** `key`: the CLI is pointed at the runner's proxy route and given a dummy key. */
  auth: 'login' | 'key';
  bridgePort: number;
}

/** A Gemini session id is a UUID. */
const GEMINI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact argv/env of a `gemini` session (docs/RUNNER.md). The prompt is on stdin: never in argv or `ps`. Pure; unit tested. */
export function buildGeminiCommand(
  i: GeminiCommandInput,
  cfg: Pick<GeminiConfig, 'bin'>,
  parent: NodeJS.ProcessEnv = process.env,
): { bin: string; args: string[]; env: Record<string, string>; stdin: string } {
  const args = [
    // the prompt arrives on stdin; the (empty) -p value only switches on headless mode
    '-p',
    '',
    '--output-format',
    'stream-json',
    '--approval-mode',
    'yolo',
    // headless mode refuses a folder that is not trusted; the sandbox, not the trust check, is the boundary
    '--skip-trust',
    `--model=${i.model}`,
    '--admin-policy',
    i.policyFile,
  ];
  if (i.includeDirs.length) args.push('--include-directories', i.includeDirs.join(','));
  if (i.resumeSessionId && GEMINI_SESSION_ID.test(i.resumeSessionId))
    args.push('--resume', i.resumeSessionId);
  const provider: Record<string, string> = {};
  if (i.auth === 'key') {
    // the real key stays in the runner: the proxy adds it to the request
    provider.GEMINI_API_KEY = 'aom-key-is-added-by-the-runner';
    provider.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${i.bridgePort}/gemini`;
  }
  const env = agentEnv(i.sessionEnv, provider, parent, {
    GEMINI_CLI_HOME: i.ghome,
    // never the OS keychain: the login is a file in the agent's private home
    GEMINI_FORCE_FILE_STORAGE: 'true',
    NO_COLOR: '1',
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
  });
  return { bin: cfg.bin, args, env, stdin: i.prompt };
}

// ------------------------------------------------------------------------------------------------ login files

const KEYCHAIN_SERVICE = 'gemini-cli-oauth';
const KEYCHAIN_ACCOUNT = 'main-account';

/** The key `gemini-credentials.json` is sealed under (the CLI derives it from the host and user name). */
function credentialsKey(): Buffer {
  return scryptSync('gemini-cli-oauth', `${hostname()}-${userInfo().username}-gemini-cli`, 32);
}

/** The token record inside `gemini-credentials.json`, or undefined (not readable here). */
export function readEncryptedGeminiLogin(
  file: string,
  key: Buffer = credentialsKey(),
):
  | {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      scope?: string;
      tokenType?: string;
      updatedAt?: number;
    }
  | undefined {
  try {
    const [iv, tag, enc] = readFileSync(file, 'utf8').trim().split(':');
    if (!iv || !tag || !enc) return undefined;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'hex'));
    const json = JSON.parse(d.update(enc, 'hex', 'utf8') + d.final('utf8')) as Record<
      string,
      Record<string, string>
    >;
    const rec = JSON.parse(json[KEYCHAIN_SERVICE]?.[KEYCHAIN_ACCOUNT] ?? 'null') as {
      token?: Record<string, unknown>;
      updatedAt?: number;
    } | null;
    if (!rec?.token) return undefined;
    const t = rec.token;
    return {
      ...(typeof t.accessToken === 'string' ? { accessToken: t.accessToken } : {}),
      ...(typeof t.refreshToken === 'string' ? { refreshToken: t.refreshToken } : {}),
      ...(typeof t.expiresAt === 'number' ? { expiresAt: t.expiresAt } : {}),
      ...(typeof t.scope === 'string' ? { scope: t.scope } : {}),
      ...(typeof t.tokenType === 'string' ? { tokenType: t.tokenType } : {}),
      ...(typeof rec.updatedAt === 'number' ? { updatedAt: rec.updatedAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/** How fresh a login file is: the token's expiry (a refresh moves it forward), else the file's mtime. 0: unreadable. */
export function geminiLoginFreshness(file: string): number {
  try {
    if (!existsSync(file)) return 0;
    if (file.endsWith('oauth_creds.json')) {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { expiry_date?: unknown };
      if (typeof j.expiry_date === 'number') return j.expiry_date;
    } else {
      const t = readEncryptedGeminiLogin(file);
      if (t?.expiresAt) return t.expiresAt;
      if (t?.updatedAt) return t.updatedAt;
    }
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function writePrivate(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // not supported everywhere
  }
  renameSync(tmp, file);
}

/** Serialises copying and handing back the owner's login among this runner's sessions. */
let authChain: Promise<unknown> = Promise.resolve();
function withAuthLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = authChain.then(fn, fn);
  authChain = next.catch(() => undefined);
  return next;
}

const LOGIN_FILES = ['gemini-credentials.json', 'oauth_creds.json'] as const;

const expandHome = (p: string, home: string): string => (p.startsWith('~') ? join(home, p.slice(1)) : p);

// ------------------------------------------------------------------------------------------------ the adapter

export interface GeminiHost {
  platform?: NodeJS.Platform;
  /** The owner's real home (where `~/.gemini` is). */
  home?: string;
  parent?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Test hook: the result of the sandbox self-test. */
  sandboxProbe?: () => { ok: boolean; reason: string };
  /** Test hook: more hosts the CLI may reach, and the key's upstream (a fake Gemini API on localhost). */
  upstream?: { url: string; allowPrivate?: boolean };
  /** Test hook: extra argv before the policy flag. */
  extraArgs?: string[];
  /** Test hook: start the command without the sandbox (unit tests with a fake binary run where there is no bubblewrap). */
  launch?: (l: HarnessLaunch) => Promise<LaunchedHarness>;
}

export class GeminiAdapter implements RuntimeAdapter {
  readonly id = GEMINI_RUNTIME;
  /** The login failed in a session: unavailable until the login file changes or a session works. */
  private authBad: { freshness: number } | undefined;

  constructor(
    private readonly cfg: GeminiConfig,
    private readonly paths?: RunnerPaths,
    private readonly store?: ProviderStore,
    private readonly host: GeminiHost = {},
  ) {}

  private realHome(): string {
    return this.host.home ?? homedir();
  }

  private parentEnv(): NodeJS.ProcessEnv {
    return this.host.parent ?? process.env;
  }

  /** The owner's own `.gemini` folder: `loginDir`, else `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`. */
  loginDir(): string {
    if (this.cfg.loginDir) return expandHome(this.cfg.loginDir, this.realHome());
    const root = this.parentEnv().GEMINI_CLI_HOME;
    return root ? join(root, '.gemini') : join(this.realHome(), '.gemini');
  }

  /** The owner's login file in use: the encrypted store first, then the older plain file. */
  loginFile(): string | undefined {
    for (const n of LOGIN_FILES) {
      const f = join(this.loginDir(), n);
      if (existsSync(f)) return f;
    }
    return undefined;
  }

  private loginUsable(): boolean {
    const f = this.loginFile();
    if (!f) return false;
    if (this.authBad) {
      if (geminiLoginFreshness(f) === this.authBad.freshness) return false;
      this.authBad = undefined;
    }
    return true;
  }

  /** How this workstation signs the CLI in right now. */
  authSelection():
    | { via: 'login' }
    | { via: 'key'; apiKey: string; source: 'org' | 'workstation' }
    | { via: 'none'; reason: string } {
    const mode = this.cfg.authMode;
    const key = this.store?.get('google');
    if (mode !== 'api_key' && this.loginUsable()) return { via: 'login' };
    if (mode !== 'login' && key?.apiKey)
      return { via: 'key', apiKey: key.apiKey, source: key.source ?? 'workstation' };
    return {
      via: 'none',
      reason:
        mode === 'api_key'
          ? 'Gemini has no API key on this workstation: add a Google Gemini key under Model providers'
          : 'Gemini is not signed in on this workstation: run `GEMINI_FORCE_FILE_STORAGE=true gemini` as the runner user and sign in with Google (or add a Google Gemini key under Model providers)',
    };
  }

  private sandboxProblem(): { ok: boolean; reason: string } {
    return (this.host.sandboxProbe ?? (() => probeHarnessSandbox(this.host.platform)))();
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    const caps = ['shell', 'edit', 'web', 'skills', 'resume'];
    const sel = this.authSelection();
    const auth = sel.via === 'none' ? ('expired' as const) : ('ok' as const);
    const models = this.cfg.models.map((id) => ({ id, label: id }));
    let version = 'unknown';
    const down = (reason: string): RuntimeCapabilities => ({
      runtime: this.id,
      version,
      available: false,
      capabilities: [],
      sandbox: 'unavailable',
      sandboxReason: reason,
      auth,
      ...(models.length ? { models } : {}),
    });
    try {
      const r = await execa(this.cfg.bin, ['--version'], { reject: false, timeout: 20_000, stdin: 'ignore' });
      const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(r.stdout));
      if (r.exitCode !== 0 || !m) return down('gemini --version failed');
      version = m[0];
      const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const [x, y, z] = GEMINI_MIN_VERSION;
      if (a < x || (a === x && (b < y || (b === y && c < z))))
        return down(
          `gemini ${version} is older than ${GEMINI_MIN_VERSION.join('.')}, the oldest version whose flags and policy engine were checked: update it (npm i -g @google/gemini-cli)`,
        );
    } catch {
      return down('the gemini binary does not run');
    }
    const sb = this.sandboxProblem();
    const ok = sb.ok && auth === 'ok';
    return {
      runtime: this.id,
      version,
      available: ok,
      capabilities: ok ? caps : [],
      sandbox: sb.ok ? 'enforced' : 'unavailable',
      sandboxReason: sb.reason,
      auth,
      ...(sel.via !== 'none' ? { authVia: sel.via === 'login' ? ('login' as const) : ('key' as const) } : {}),
      ...(models.length ? { models } : {}),
    };
  }

  /** `GEMINI.md` in the agent's private Gemini home: the CLI's global instructions. The text is the shared renderer's, verbatim. */
  async writeInstructions(sandbox: Pick<SandboxInfo, 'configDir'>, markdown: string): Promise<void> {
    const dir = dotGemini(geminiHomeOf(sandbox));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'GEMINI.md'), markdown);
  }

  // -------------------------------------------------------------------------------------------- session

  private assertRole(roleKey: string, isDevops: boolean | undefined, permissions: AgentPermissions): void {
    const problem = runtimeRoleProblem(GEMINI_RUNTIME, { roleKey, isDevops: isDevops === true, permissions });
    if (problem) throw new Error(`runtime_role_refused: ${problem}`);
  }

  private assertCanRun(): ReturnType<GeminiAdapter['authSelection']> & { via: 'login' | 'key' } {
    const sb = this.sandboxProblem();
    if (!sb.ok) throw new Error(`the Gemini CLI sandbox is unavailable: ${sb.reason}`);
    const sel = this.authSelection();
    if (sel.via === 'none') throw new Error(sel.reason);
    return sel;
  }

  /** Copies the owner's login into the agent's private home (login mode) and writes the settings, policy and skills. */
  private prepareHome(
    sandbox: SandboxInfo,
    sel: { via: 'login' } | { via: 'key' },
    grantedSkills: ShiftStartInput['grantedSkills'],
    policy: GeminiPolicyInput,
  ): { ghome: string; policyFile: string; loginFiles: string[] } {
    const ghome = geminiHomeOf(sandbox);
    const dir = dotGemini(ghome);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivate(
      join(dir, 'settings.json'),
      `${JSON.stringify(geminiSettings({ auth: sel.via === 'login' ? 'oauth-personal' : 'gemini-api-key' }), null, 2)}\n`,
    );
    const policyFile = join(dir, 'aom-policy.toml');
    writePrivate(policyFile, geminiPolicy(policy));
    // the CLI's user-scope skills: exactly the granted ones, nothing from the owner or an earlier shift
    materializeSkills(join(dir, 'skills'), grantedSkills ?? [], ghome);
    rmSync(join(ghome, '.agents'), { recursive: true, force: true });
    const loginFiles = LOGIN_FILES.map((n) => join(dir, n));
    if (sel.via === 'key') for (const f of loginFiles) rmSync(f, { force: true });
    return { ghome, policyFile, loginFiles };
  }

  private prepareLogin(ghome: string): Promise<void> {
    return withAuthLock(() => {
      const src = this.loginFile();
      if (!src) return;
      const dir = dotGemini(ghome);
      const name = src.endsWith('oauth_creds.json') ? 'oauth_creds.json' : 'gemini-credentials.json';
      const dest = join(dir, name);
      // keep a copy that an earlier session of this agent already refreshed
      if (existsSync(dest) && geminiLoginFreshness(dest) > geminiLoginFreshness(src)) return;
      for (const n of LOGIN_FILES) rmSync(join(dir, n), { force: true });
      writePrivate(dest, readFileSync(src, 'utf8'));
    });
  }

  /** After a session: a refreshed login (a later expiry) goes back to the owner's file, in the form it is kept in. */
  private harvestLogin(ghome: string): Promise<void> {
    return withAuthLock(() => {
      const src = this.loginFile();
      if (!src) return;
      const dir = dotGemini(ghome);
      for (const n of LOGIN_FILES) {
        const mine = join(dir, n);
        if (!existsSync(mine) || geminiLoginFreshness(mine) <= geminiLoginFreshness(src)) continue;
        if (n === 'oauth_creds.json' || !src.endsWith('oauth_creds.json')) {
          writePrivate(src, readFileSync(mine, 'utf8'));
        } else {
          // the CLI moved a plain login into its encrypted store: hand it back in the plain form the owner keeps
          const t = readEncryptedGeminiLogin(mine);
          if (t?.accessToken)
            writePrivate(
              src,
              `${JSON.stringify({
                access_token: t.accessToken,
                ...(t.refreshToken ? { refresh_token: t.refreshToken } : {}),
                ...(t.scope ? { scope: t.scope } : {}),
                token_type: t.tokenType ?? 'Bearer',
                ...(t.expiresAt ? { expiry_date: t.expiresAt } : {}),
              })}\n`,
            );
        }
        return;
      }
    });
  }

  private sessionEnv(input: { env: Record<string, string> }): Record<string, string> {
    // CLAUDE_CONFIG_DIR names a folder this agent has no use for
    const { CLAUDE_CONFIG_DIR: _c, ...rest } = input.env;
    return {
      ...rest,
      // git's background maintenance would take locks in the repository's `.git` root, which the sandbox keeps read-only
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'gc.auto',
      GIT_CONFIG_VALUE_1: '0',
    };
  }

  private launchSpec(
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
    ghome: string,
  ): HarnessLaunch['sandbox'] {
    const root = this.paths?.root ?? dirname(dirname(input.sandbox.home));
    const script = selfCommand('aom').at(-1);
    const nuget = userNugetPackages(this.realHome());
    const readonly = [
      ...toolchainReadPaths(
        [...this.cfg.toolchainPaths, ...(input.toolchainReadDirs ?? [])],
        process.execPath,
        this.realHome(),
      ),
      this.paths?.bin ?? join(root, 'bin'),
      ...(script ? [dirname(script)] : []),
      ...geminiInstallDirs(this.cfg.bin),
      ...(input.addDirs ?? []),
    ];
    const gitDirs = gitCommonDirs(input.cwd);
    return {
      cwd: input.cwd,
      readOnlyCwd,
      home: input.sandbox.home,
      scratch: input.sandbox.scratch,
      tmp: input.sandbox.tmp,
      ...(input.sandbox.cacheRoot ? { cacheRoot: input.sandbox.cacheRoot } : {}),
      writable: [ghome],
      readonly,
      readDirs: input.readDirs ?? [],
      gitDirs,
      mayCommit,
      ...(input.env.AOM_IPC_SOCKET ? { ipcSocket: input.env.AOM_IPC_SOCKET } : {}),
      ...(nuget ? { nugetFallbackDir: nuget } : {}),
      ...(process.platform === 'linux' ? { dotnetShmDir: DOTNET_SHM_DIR } : {}),
    };
  }

  private async run(
    input: ShiftStartInput | ChatStartInput,
    opts: {
      prompt: string;
      chat: boolean;
      readOnlyCwd: boolean;
      mayCommit: boolean;
      perms: AgentPermissions;
      roleKey: string;
    },
  ): Promise<RuntimeSession> {
    const sel = this.assertCanRun();
    const { ghome, policyFile } = this.prepareHome(input.sandbox, sel, input.grantedSkills, {
      perms: opts.perms,
      roleKey: opts.roleKey,
      chat: opts.chat,
    });
    if (sel.via === 'login') await this.prepareLogin(ghome);
    const includeDirs = [
      ...new Set([...(('addDirs' in input ? input.addDirs : []) ?? []), ...(input.readDirs ?? [])]),
    ];
    const cmd = buildGeminiCommand(
      {
        prompt: opts.prompt,
        model: input.agent.model,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        includeDirs,
        policyFile,
        sessionEnv: this.sessionEnv(input),
        ghome,
        auth: sel.via,
        bridgePort: 3128,
      },
      this.cfg,
      this.parentEnv(),
    );
    if (this.host.extraArgs?.length)
      cmd.args.splice(cmd.args.indexOf('--admin-policy'), 0, ...this.host.extraArgs);
    const loginPaths = LOGIN_FILES.map((n) => join(dotGemini(ghome), n));
    const launch: HarnessLaunch = {
      cliHosts: [
        ...(sel.via === 'key'
          ? ['generativelanguage.googleapis.com']
          : ['cloudcode-pa.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com']),
        ...(this.host.upstream ? [new URL(this.host.upstream.url).hostname] : []),
      ],
      ...(this.host.upstream
        ? { proxyTest: { allowPrivate: true as const, resolve: async () => '127.0.0.1' } }
        : {}),
      extraHosts: this.cfg.extraAllowedDomains,
      ...(sel.via === 'key'
        ? {
            routes: [
              {
                prefix: '/gemini',
                upstream: this.host.upstream?.url ?? 'https://generativelanguage.googleapis.com',
                headers: { 'x-goog-api-key': sel.apiKey },
              },
            ],
          }
        : {}),
      sandbox: this.launchSpec(input, opts.readOnlyCwd, opts.mayCommit, ghome),
      hiddenFromShell: sel.via === 'login' ? loginPaths.filter((p) => existsSync(dirname(p))) : [],
      unsetForShell: ['GEMINI_API_KEY', 'GEMINI_CLI_HOME'],
      cmd: { bin: cmd.bin, args: cmd.args, env: cmd.env },
    };
    const harness: LaunchedHarness = await (this.host.launch ?? launchInHarnessSandbox)(launch);
    const parser = new GeminiStreamParser({
      model: input.agent.model,
      chat: opts.chat,
      ...(sel.via === 'key' ? { key: { source: sel.source, provider: 'google' } } : {}),
    });
    return spawnSession({
      bin: harness.command.bin,
      args: harness.command.args,
      cwd: input.cwd,
      env: harness.command.env,
      inheritEnv: false,
      input: cmd.stdin,
      parseLine: (l) => parser.parseLine(l),
      usage: () => parser.usage(),
      contextTokens: () => parser.contextTokens(),
      ...(input.logFile ? { logFile: input.logFile } : {}),
      exitError: () => (parser.resultError ? `gemini: ${parser.resultError}` : undefined),
      authFailure: (stderr) => parser.authFailure || (sel.via === 'login' && isGeminiAuthFailureText(stderr)),
      usageLimit: (stderr) =>
        geminiUsageLimit(parser.usageLimitText ?? '', this.host.now?.()) ??
        geminiUsageLimit(stderr, this.host.now?.()),
      onExit: async ({ code, authFailed }) => {
        try {
          if (authFailed && sel.via === 'login') {
            const f = this.loginFile();
            this.authBad = { freshness: f ? geminiLoginFreshness(f) : 0 };
          } else if (code === 0 && parser.usage().outputTokens > 0) this.authBad = undefined;
          if (sel.via === 'login') await this.harvestLogin(ghome);
        } catch {
          // best effort
        } finally {
          await harness.cleanup();
        }
      },
    });
  }

  async start(input: ShiftStartInput): Promise<RuntimeSession> {
    this.assertRole(input.agent.roleKey, input.agent.isDevops, input.agent.permissions);
    if (input.devopsGuard || input.kind === 'devops' || input.kind === 'ceo')
      throw new Error('runtime_role_refused: DevOps and CEO shifts run on Claude Code');
    const perms = input.agent.permissions;
    const edit = perms.allowedTools.includes('edit');
    return this.run(input, {
      prompt: input.prompt,
      chat: false,
      readOnlyCwd: !edit,
      mayCommit: edit && perms.mayCommit,
      perms,
      roleKey: input.agent.roleKey,
    });
  }

  async startChat(input: ChatStartInput): Promise<RuntimeSession> {
    if (input.agent.isDevops || input.agent.roleKey === 'ceo' || input.agent.roleKey === 'devops')
      throw new Error('runtime_role_refused: the DevOps and CEO chats run on Claude Code');
    if (input.intake)
      throw new Error(
        'runtime_role_refused: the intake chat needs the Jira tool (MCP), which the Gemini CLI does not get',
      );
    // A chat reads: its working folder is read-only (a card's worktree, or the scratch folder of a session turn).
    return this.run(input, {
      prompt: input.message,
      chat: true,
      readOnlyCwd: true,
      mayCommit: false,
      perms: input.agent.permissions,
      roleKey: input.agent.roleKey,
    });
  }
}
