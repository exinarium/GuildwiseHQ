import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
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
import { basename, dirname, join } from 'node:path';
import { type AgentPermissions, GEMINI_RUNTIME, runtimeRoleProblem } from '@aom/shared';
import { execa } from 'execa';
import { materializeSkills } from '../capabilities/materialize.ts';
import type { GeminiRuntimeConfig } from '../config.ts';
import type { ProviderStore } from '../direct/store.ts';
import type { RunnerPaths } from '../paths.ts';
import { DOTNET_SHM_DIR, userNugetPackages } from '../sandbox/sandbox.ts';
import { registerSecret } from '../secrets/redact.ts';
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
import type { LoginAccountRegistry } from './login-accounts.ts';
import { withFileLock } from './login-lock.ts';
import { spawnSession } from './process-session.ts';
import type {
  AccountGate,
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

type GeminiConfig = Omit<GeminiRuntimeConfig, 'accounts'> & {
  accounts?: GeminiRuntimeConfig['accounts'];
  bin: string;
};
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
export const geminiHomeOf = (sandbox: Pick<SandboxInfo, 'configDir'>): string => {
  // one Gemini home per account per agent (S-A), like the Claude config dir
  const m = /^claude-acct-(.+)$/.exec(basename(sandbox.configDir));
  return join(dirname(sandbox.configDir), m ? `gemini-acct-${m[1]}` : 'gemini');
};

/** The main account's `.gemini` folder: `loginDir`, else `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`. */
export function geminiMainFolder(
  cfg: { loginDir?: string | undefined } | undefined,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (cfg?.loginDir) return expandHome(cfg.loginDir, home);
  return env.GEMINI_CLI_HOME ? join(env.GEMINI_CLI_HOME, '.gemini') : join(home, '.gemini');
}
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

/** The tools that take a path or a command, for the rule that keeps the login files out of reach of file tool calls. */
const GEMINI_PATH_TOOLS = [
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'grep_search',
  'search_file_content',
  'write_file',
  'replace',
  'run_shell_command',
];
/** Matched against a tool call's arguments: the names of the login files, whatever the path in front of them. */
export const GEMINI_LOGIN_ARGS_PATTERN =
  '(oauth_creds|gemini-credentials|google_accounts|\\.gemini[/\\\\]+(?:credentials|oauth|auth))';

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
  // The Google login lives in the agent's private Gemini home, which the file tools can reach: no tool call may name it, whatever the
  // role. (The shell cannot see it either: the sandbox hides it from the shell.) Above every other rule.
  rule([
    `toolName = [${GEMINI_PATH_TOOLS.map(q).join(', ')}]`,
    `argsPattern = ${q(GEMINI_LOGIN_ARGS_PATTERN)}`,
    'decision = "deny"',
    'priority = 990',
    `denyMessage = ${q('the sign-in files are not available to an agent')}`,
  ]);
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
export function credentialsKey(): Buffer {
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

// ---- reading, checking and writing back a login (finding 5: a login the agent's session wrote is never trusted as it is)

/** A login in either form, reduced to what the runner checks and writes back. */
export interface ParsedGeminiLogin {
  form: 'plain' | 'encrypted';
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  idToken?: string;
  /** Keys the file has beyond the ones a Google login carries (a plain file only): a login with any is not handed back. */
  unknownKeys: string[];
}

const PLAIN_LOGIN_KEYS = new Set([
  'access_token',
  'refresh_token',
  'scope',
  'token_type',
  'expiry_date',
  'id_token',
]);

export function parseGeminiLogin(file: string): ParsedGeminiLogin | undefined {
  try {
    if (file.endsWith('oauth_creds.json')) {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
      const str = (k: string): string | undefined =>
        typeof j[k] === 'string' ? (j[k] as string) : undefined;
      return {
        form: 'plain',
        ...(str('access_token') ? { accessToken: str('access_token') as string } : {}),
        ...(str('refresh_token') ? { refreshToken: str('refresh_token') as string } : {}),
        ...(typeof j.expiry_date === 'number' ? { expiresAt: j.expiry_date } : {}),
        ...(str('scope') ? { scope: str('scope') as string } : {}),
        ...(str('token_type') ? { tokenType: str('token_type') as string } : {}),
        ...(str('id_token') ? { idToken: str('id_token') as string } : {}),
        unknownKeys: Object.keys(j).filter((k) => !PLAIN_LOGIN_KEYS.has(k)),
      };
    }
    const t = readEncryptedGeminiLogin(file);
    if (!t) return undefined;
    return {
      form: 'encrypted',
      ...(t.accessToken ? { accessToken: t.accessToken } : {}),
      ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
      ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      ...(t.tokenType ? { tokenType: t.tokenType } : {}),
      unknownKeys: [],
    };
  } catch {
    return undefined;
  }
}

/** The longest an access token is believed to live: Google issues one hour; anything beyond this is not a refresh. */
const MAX_TOKEN_LIFETIME_MS = 2 * 3_600_000;

const TOKEN_TEXT = /^[\x21-\x7e]{16,4096}$/;
const REFRESH_TEXT = /^[\x21-\x7e]{1,4096}$/;

const jwtSubject = (jwt: string | undefined): string | undefined => {
  try {
    const part = jwt?.split('.')[1];
    if (!part) return undefined;
    const sub = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether a login found in an agent's private home after a session may go back to the owner's file. The agent's tools could write
 * that file, so it is checked as input: it parses, it is the same Google account (the refresh token of a Google login does not
 * change when it is used, and the id token names the same subject), its scopes are not wider, its access token is one token and its
 * expiry is a plausible refresh (later than the owner's, no more than a token's lifetime ahead). Undefined: all fine.
 */
export function geminiLoginProblem(
  mine: ParsedGeminiLogin | undefined,
  src: ParsedGeminiLogin | undefined,
  nowMs: number,
): string | undefined {
  if (!mine) return 'it cannot be read';
  if (mine.unknownKeys.length) return `it has unexpected fields (${mine.unknownKeys.slice(0, 3).join(', ')})`;
  if (!mine.accessToken || !TOKEN_TEXT.test(mine.accessToken)) return 'its access token is not a token';
  if (mine.refreshToken && !REFRESH_TEXT.test(mine.refreshToken)) return 'its refresh token is not a token';
  if (typeof mine.expiresAt !== 'number' || !Number.isFinite(mine.expiresAt)) return 'it has no expiry';
  if (mine.expiresAt > nowMs + MAX_TOKEN_LIFETIME_MS) return 'its expiry is further ahead than a token lives';
  if (!src) return undefined;
  if ((src.refreshToken ?? null) !== (mine.refreshToken ?? null))
    return 'it is not the owner’s account (another refresh token)';
  const a = jwtSubject(src.idToken);
  const b = jwtSubject(mine.idToken);
  if (a && b && a !== b) return 'it is not the owner’s account (another subject)';
  if (src.scope && mine.scope) {
    const had = new Set(src.scope.split(/\s+/).filter(Boolean));
    for (const sc of mine.scope.split(/\s+/).filter(Boolean))
      if (!had.has(sc)) return 'its scopes are wider than the owner’s';
  }
  return undefined;
}

/** Registers the tokens of a login with the redaction registry, so no log line, tool result or error shows one. */
export function registerGeminiLoginSecrets(file: string): void {
  const l = parseGeminiLogin(file);
  for (const t of [l?.accessToken, l?.refreshToken, l?.idToken]) if (t && t.length >= 12) registerSecret(t);
}

/**
 * The owner's login file in its own form, with the token fields of `mine` (already checked) put in. A plain file is written fresh
 * from the checked fields; an encrypted one is decrypted, updated and sealed again under the same key and layout, so a login is
 * never downgraded from the encrypted store to a plain file. Undefined when the owner's file cannot be read or is encrypted and
 * `mine` is not (nothing is written then).
 */
export function loginTextFor(
  srcFile: string,
  mine: ParsedGeminiLogin,
  now: number,
  key: Buffer = credentialsKey(),
): string | undefined {
  if (srcFile.endsWith('oauth_creds.json')) {
    return `${JSON.stringify({
      access_token: mine.accessToken,
      ...(mine.refreshToken ? { refresh_token: mine.refreshToken } : {}),
      ...(mine.scope ? { scope: mine.scope } : {}),
      token_type: mine.tokenType ?? 'Bearer',
      ...(mine.expiresAt !== undefined ? { expiry_date: mine.expiresAt } : {}),
      ...(mine.idToken ? { id_token: mine.idToken } : {}),
    })}\n`;
  }
  try {
    const [iv, tag, enc] = readFileSync(srcFile, 'utf8').trim().split(':');
    if (!iv || !tag || !enc) return undefined;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'hex'));
    const all = JSON.parse(d.update(enc, 'hex', 'utf8') + d.final('utf8')) as Record<
      string,
      Record<string, string>
    >;
    const rec = JSON.parse(all[KEYCHAIN_SERVICE]?.[KEYCHAIN_ACCOUNT] ?? 'null') as {
      token?: Record<string, unknown>;
      updatedAt?: number;
    } | null;
    if (!rec?.token) return undefined;
    rec.token = {
      ...rec.token,
      accessToken: mine.accessToken,
      ...(mine.expiresAt !== undefined ? { expiresAt: mine.expiresAt } : {}),
      ...(mine.tokenType ? { tokenType: mine.tokenType } : {}),
      ...(mine.scope ? { scope: mine.scope } : {}),
    };
    rec.updatedAt = now;
    (all[KEYCHAIN_SERVICE] as Record<string, string>)[KEYCHAIN_ACCOUNT] = JSON.stringify(rec);
    return encryptGeminiStore(all, key);
  } catch {
    return undefined;
  }
}

/** `gemini-credentials.json` content: `iv:tag:ciphertext` (hex), AES-256-GCM of the store's JSON under the host-derived key. */
export function encryptGeminiStore(store: unknown, key: Buffer = credentialsKey()): string {
  const nonce = randomBytes(16);
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const out = c.update(JSON.stringify(store), 'utf8', 'hex') + c.final('hex');
  return `${nonce.toString('hex')}:${c.getAuthTag().toString('hex')}:${out}`;
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
  /** Told when a login is not handed back to the owner (so the owner can find out why). */
  warn?: (message: string) => void;
  /** Test hook: the result of the sandbox self-test. */
  sandboxProbe?: () => { ok: boolean; reason: string };
  /** Test hook: more hosts the CLI may reach, and the key's upstream (a fake Gemini API on localhost). */
  upstream?: { url: string; allowPrivate?: boolean };
  /** Test hook: extra argv before the policy flag. */
  extraArgs?: string[];
  /** Test hook: start the command without the sandbox (unit tests with a fake binary run where there is no bubblewrap). */
  launch?: (l: HarnessLaunch) => Promise<LaunchedHarness>;
  /** The named Google-login accounts of this workstation (S-A); absent: only the main login exists. */
  accounts?: LoginAccountRegistry;
}

export class GeminiAdapter implements RuntimeAdapter {
  readonly id = GEMINI_RUNTIME;
  /** The login failed in a session: unavailable until the login file changes or a session works. One per account. */
  private readonly authBad = new Map<string, { freshness: number }>();

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
  loginDir(account?: string): string {
    if (account && account !== 'main') {
      const a = this.host.accounts?.get(account);
      return a ? a.folder : join(this.realHome(), `.gemini-gw-unknown-${account}`, '.gemini');
    }
    return geminiMainFolder(this.cfg, this.realHome(), this.parentEnv());
  }

  /** The login file of an account in use: the encrypted store first, then the older plain file. Main by default. */
  loginFile(account?: string): string | undefined {
    for (const n of LOGIN_FILES) {
      const f = join(this.loginDir(account), n);
      if (existsSync(f)) return f;
    }
    return undefined;
  }

  private loginUsable(account?: string): boolean {
    const f = this.loginFile(account);
    if (!f) return false;
    const k = account ?? 'main';
    const bad = this.authBad.get(k);
    if (bad) {
      if (geminiLoginFreshness(f) === bad.freshness) return false;
      this.authBad.delete(k);
    }
    return true;
  }

  /** Brings the registry's login state of every account in line with the files and the last sessions. */
  private syncAccounts(): void {
    const reg = this.host.accounts;
    if (!reg || this.cfg.authMode === 'api_key') return;
    reg.poll();
    for (const a of reg.list()) {
      if (!a.hasLogin()) a.auth.markNone();
      else if (!this.loginUsable(a.key)) a.auth.markExpired();
      else if (a.auth.state !== 'ok') a.auth.markOk();
    }
  }

  /** May a shift run on this account now? The server picked it from the last report; this closes the race. */
  accountGate(account: string): AccountGate {
    const reg = this.host.accounts;
    if (account === 'main' && !reg)
      return this.loginUsable() ? { state: 'ok' } : { state: 'login', login: 'expired' };
    this.syncAccounts();
    const a = reg?.get(account);
    if (!a) {
      // a key account of the Google key (the workstation runs the CLI on a key): known to the store, not the login registry
      if (account === 'org' || this.store?.holdsAccount('google', account)) return { state: 'ok' };
      return { state: 'missing' };
    }
    // the main account also runs on the Google key when there is one (authMode auto/api_key)
    const keyRuns = a.main && this.cfg.authMode !== 'login' && !!this.store?.holds('google');
    if (this.cfg.authMode !== 'api_key' && a.auth.state !== 'ok' && !keyRuns)
      return { state: 'login', login: a.auth.state === 'none' ? 'none' : 'expired' };
    if (a.usage.state === 'limited')
      return {
        state: 'limited',
        ...(a.usage.limitedUntil ? { limitedUntil: a.usage.limitedUntil } : {}),
        label: a.info().limitedLabel ?? 'later',
      };
    return { state: 'ok' };
  }

  async checkLogin(account?: string): Promise<'ok' | 'expired' | 'unknown'> {
    return this.loginUsable(account) ? 'ok' : 'expired';
  }

  /** How this workstation signs the CLI in right now. */
  authSelection(
    orgId?: string,
    account?: string,
  ):
    | { via: 'login' }
    | { via: 'key'; apiKey: string; source: 'org' | 'workstation' }
    | { via: 'none'; reason: string } {
    const mode = this.cfg.authMode;
    // An account the project chose: a named LOGIN account of this workstation when one has that name, else a named key
    // account (or `org`) of the Google key. A name that is neither selects nothing (the server only sends known names).
    const named = account && account !== 'main';
    const isLoginAccount = !!named && !!this.host.accounts?.get(account as string);
    const key = this.store?.get('google', orgId, named && !isLoginAccount ? account : undefined);
    if (mode !== 'api_key' && (!named || isLoginAccount) && this.loginUsable(account))
      return { via: 'login' };
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
    this.syncAccounts();
    // availability only: a key of some organization counts, but a run uses it only for the organization it names
    const keyHeld = this.cfg.authMode !== 'login' && !!this.store?.holds('google');
    const reg = this.host.accounts;
    const anyLogin = !!reg && this.cfg.authMode !== 'api_key' && reg.anyUsable();
    const auth = sel.via === 'none' && !keyHeld && !anyLogin ? ('expired' as const) : ('ok' as const);
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
      ...(sel.via !== 'none' || keyHeld
        ? { authVia: sel.via === 'login' ? ('login' as const) : ('key' as const) }
        : {}),
      ...(reg && this.cfg.authMode !== 'api_key' ? { accounts: reg.infos() } : {}),
      ...(reg?.main.usage.state === 'limited' && reg.main.usage.limitedUntil
        ? { usage: 'limited' as const, limitedUntil: reg.main.usage.limitedUntil }
        : {}),
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

  private assertCanRun(
    orgId?: string,
    account?: string,
  ): ReturnType<GeminiAdapter['authSelection']> & { via: 'login' | 'key' } {
    const sb = this.sandboxProblem();
    if (!sb.ok) throw new Error(`the Gemini CLI sandbox is unavailable: ${sb.reason}`);
    const sel = this.authSelection(orgId, account);
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

  /** In-process chain plus a lock folder beside the owner's login, so two runners or the owner's own CLI cannot interleave with us. */
  private locked<T>(fn: () => T | Promise<T>, account?: string): Promise<T> {
    const f = this.loginFile(account) ?? join(this.loginDir(account), 'gemini-credentials.json');
    return withAuthLock(() => withFileLock(`${f}.aom-lock`, fn));
  }

  private prepareLogin(ghome: string, account?: string): Promise<void> {
    return this.locked(() => {
      const src = this.loginFile(account);
      if (!src) return;
      const dir = dotGemini(ghome);
      const name = src.endsWith('oauth_creds.json') ? 'oauth_creds.json' : 'gemini-credentials.json';
      const dest = join(dir, name);
      // keep a copy that an earlier session of this agent already refreshed
      // (but not one that fails the checks of a login coming back: a private copy an agent edited is replaced by the owner's)
      if (
        existsSync(dest) &&
        geminiLoginFreshness(dest) > geminiLoginFreshness(src) &&
        !geminiLoginProblem(
          parseGeminiLogin(dest),
          parseGeminiLogin(src),
          (this.host.now?.() ?? new Date()).getTime(),
        )
      ) {
        registerGeminiLoginSecrets(dest);
        return;
      }
      for (const n of LOGIN_FILES) rmSync(join(dir, n), { force: true });
      writePrivate(dest, readFileSync(src, 'utf8'));
      registerGeminiLoginSecrets(dest);
    }, account);
  }

  /**
   * After a session: a refreshed login (a later expiry) goes back to the owner's file, in the form it is kept in. What the session
   * left in the agent's home is checked first (`geminiLoginProblem`): a file an agent wrote cannot overwrite the owner's login.
   */
  private harvestLogin(ghome: string, account?: string): Promise<void> {
    return this.locked(() => {
      const src = this.loginFile(account);
      if (!src) return;
      const dir = dotGemini(ghome);
      const now = (this.host.now?.() ?? new Date()).getTime();
      for (const n of LOGIN_FILES) {
        const file = join(dir, n);
        if (!existsSync(file) || geminiLoginFreshness(file) <= geminiLoginFreshness(src)) continue;
        // tokens the CLI refreshed are secrets from now on, whatever becomes of the file
        registerGeminiLoginSecrets(file);
        const mine = parseGeminiLogin(file);
        const problem = geminiLoginProblem(mine, parseGeminiLogin(src), now);
        if (problem || !mine) {
          (this.host.warn ?? ((m: string) => console.warn(`[gemini] ${m}`)))(
            `the login left by a Gemini session was not handed back to the owner: ${problem ?? 'unreadable'}`,
          );
          return;
        }
        // the owner's file keeps its form; an encrypted store is never replaced by a plain file
        if (!src.endsWith('oauth_creds.json') && mine.form === 'plain') {
          (this.host.warn ?? ((m: string) => console.warn(`[gemini] ${m}`)))(
            'the login left by a Gemini session is a plain file but the owner keeps an encrypted one: not handed back',
          );
          return;
        }
        const srcLogin = parseGeminiLogin(src);
        // an id token comes along only when the owner's login has one (and it is the same subject: checked above)
        const keep: ParsedGeminiLogin = { ...mine };
        if (!srcLogin?.idToken) delete keep.idToken;
        const text = loginTextFor(src, keep, now);
        if (text) writePrivate(src, text);
        return;
      }
    }, account);
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
    const sel = this.assertCanRun(input.orgId, input.account);
    const { ghome, policyFile } = this.prepareHome(input.sandbox, sel, input.grantedSkills, {
      perms: opts.perms,
      roleKey: opts.roleKey,
      chat: opts.chat,
    });
    if (sel.via === 'login') await this.prepareLogin(ghome, input.account);
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
      ...(this.store?.endpoints().length ? { privateEndpoints: this.store.endpoints() } : {}),
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
      onExit: async ({ code, authFailed, usageLimit }) => {
        try {
          const k = input.account ?? 'main';
          if (authFailed && sel.via === 'login') {
            const f = this.loginFile(input.account);
            this.authBad.set(k, { freshness: f ? geminiLoginFreshness(f) : 0 });
            this.host.accounts?.get(k)?.auth.markExpired();
          } else if (code === 0 && parser.usage().outputTokens > 0) this.authBad.delete(k);
          if (usageLimit && sel.via === 'login')
            this.host.accounts?.get(k)?.usage.markLimited(usageLimit.until);
          if (sel.via === 'login') await this.harvestLogin(ghome, input.account);
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
