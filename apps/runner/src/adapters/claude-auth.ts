import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { execa } from 'execa';

/**
 * The Claude Code login of this machine (`~/.claude/.credentials.json`, OAuth): detecting that it expired, probing
 * whether it works again, and keeping the refreshed tokens of concurrent agents from racing each other.
 *
 * Nothing here logs, returns or sends a token value: files are read to compare `expiresAt` and are copied whole.
 */

// -------------------------------------------------------------------------------------------- detection

const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /OAuth session expired/i,
  /could not be refreshed/i,
  /Please run \/login/i,
  /OAuth (?:refresh )?token (?:is )?(?:no longer valid|has expired|expired|revoked)/i,
  /refresh token (?:is )?(?:no longer valid|invalid|expired|revoked)/i,
  /Failed to authenticate/i,
  /authentication_error/i,
  /invalid[ _]x-api-key|invalid_api_key/i,
  /\b401\b.*(?:unauthorized|invalid|authenticat)/i,
  /Invalid authentication credentials/i,
  /Not logged in/i,
];

/** Does this text (a result, an error line, a stderr tail) say that the Claude login does not work? */
export function isAuthFailureText(text: string | undefined | null): boolean {
  if (!text) return false;
  return AUTH_FAILURE_PATTERNS.some((re) => re.test(text));
}

export type ClaudeAuthState = 'ok' | 'expired';

/** The Claude login state of this runner: `expired` pauses the runtime until a probe (or a later session) succeeds. */
export class ClaudeAuthMonitor {
  private current: ClaudeAuthState = 'ok';
  private listeners: Array<(s: ClaudeAuthState) => void> = [];
  /** When the login was found expired (ISO), for the log and the status page. */
  expiredSince: string | undefined;

  get state(): ClaudeAuthState {
    return this.current;
  }

  onChange(fn: (s: ClaudeAuthState) => void): void {
    this.listeners.push(fn);
  }

  private set(next: ClaudeAuthState): boolean {
    if (this.current === next) return false;
    this.current = next;
    this.expiredSince = next === 'expired' ? new Date().toISOString() : undefined;
    for (const l of this.listeners) {
      try {
        l(next);
      } catch {
        // a listener never breaks the monitor
      }
    }
    return true;
  }

  markExpired(): boolean {
    return this.set('expired');
  }

  markOk(): boolean {
    return this.set('ok');
  }
}

// -------------------------------------------------------------------------------------------- credentials

interface OauthEntry {
  expiresAt?: number;
  [k: string]: unknown;
}
export interface CredentialsDoc {
  claudeAiOauth?: OauthEntry;
  mcpOAuth?: Record<string, OauthEntry>;
  [k: string]: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function readCredentials(path: string): CredentialsDoc | null {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isObj(doc) ? (doc as CredentialsDoc) : null;
  } catch {
    return null;
  }
}

const expiryOf = (e: unknown): number => {
  const n = isObj(e) ? e.expiresAt : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

/** When the model login's access token expires (ms since the epoch); 0 when unknown. */
export const loginExpiresAt = (doc: CredentialsDoc | null): number => expiryOf(doc?.claudeAiOauth);

/** Writes the file whole, atomically (a temp file in the same folder, then a rename), readable by this user only. */
export function writeCredentialsAtomic(path: string, doc: CredentialsDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// -------------------------------------------------------------------------------------------- lock

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A runner-wide lock (a file created exclusively in the runner data dir). A lock older than `staleMs` belongs to a
 * crashed process and is taken over. Waits up to `timeoutMs`, then runs `fn` anyway (a stuck lock must not stop work).
 */
export async function withLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const staleMs = opts.staleMs ?? 180_000;
  mkdirSync(dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      closeSync(openSync(lockFile, 'wx', 0o600));
      held = true;
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > staleMs) rmSync(lockFile, { force: true });
      } catch {
        // released meanwhile
      }
      if (Date.now() > deadline) break;
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    if (held) rmSync(lockFile, { force: true });
  }
}

// -------------------------------------------------------------------------------------------- sharing

/** An access token this close to expiry is refreshed once, under the lock, before agents are started on it. */
export const REFRESH_WINDOW_MS = 10 * 60_000;

export interface CredentialPaths {
  /** The machine's own login (`~/.claude/.credentials.json`). */
  canonical: string;
  /** The agent's private copy (`<agent config dir>/.credentials.json`). */
  copy: string;
  /** The runner-wide lock file. */
  lock: string;
}

/**
 * Before an agent session: gives the agent a private COPY of the machine's credentials (a symlink let the refresh of one
 * agent replace the file under the others and rotate the refresh token out from under them). When the access token
 * expires within `REFRESH_WINDOW_MS`, `refresh` runs first, under the lock, so every agent starts with a fresh token and
 * only one process refreshes at a time.
 */
export async function prepareAgentCredentials(
  p: CredentialPaths,
  opts: { refresh?: () => Promise<void>; now?: () => number } = {},
): Promise<'copied' | 'missing'> {
  if (!existsSync(p.canonical)) return 'missing';
  const now = opts.now ?? Date.now;
  return withLock(p.lock, async () => {
    let doc = readCredentials(p.canonical);
    if (!doc) return 'missing';
    const exp = loginExpiresAt(doc);
    if (opts.refresh && exp > 0 && exp - now() < REFRESH_WINDOW_MS) {
      try {
        await opts.refresh();
      } catch {
        // the session below reports a login that still does not work
      }
      doc = readCredentials(p.canonical) ?? doc;
    }
    rmSync(p.copy, { force: true }); // also removes a symlink left by an older runner
    writeCredentialsAtomic(p.copy, doc);
    return 'copied';
  });
}

/**
 * After an agent session: when the agent's copy holds a newer login (its Claude Code refreshed the token) or newer
 * plugin sign-ins (`mcpOAuth`), writes them back to the machine's credentials, atomically and under the lock. Entries are
 * compared by `expiresAt` only; the canonical file keeps everything else it has. Returns what was written back.
 */
export async function harvestAgentCredentials(p: CredentialPaths): Promise<{ login: boolean; mcp: number }> {
  const none = { login: false, mcp: 0 };
  const copy = readCredentials(p.copy);
  if (!copy || !existsSync(p.canonical)) return none;
  return withLock(p.lock, async () => {
    const canon = readCredentials(p.canonical);
    if (!canon) return none;
    let login = false;
    let mcp = 0;
    if (copy.claudeAiOauth && loginExpiresAt(copy) > loginExpiresAt(canon)) {
      canon.claudeAiOauth = copy.claudeAiOauth;
      login = true;
    }
    for (const [k, v] of Object.entries(copy.mcpOAuth ?? {})) {
      const have = canon.mcpOAuth?.[k];
      if (!have || expiryOf(v) > expiryOf(have)) {
        canon.mcpOAuth = { ...(canon.mcpOAuth ?? {}), [k]: v };
        mcp += 1;
      }
    }
    if (login || mcp > 0) writeCredentialsAtomic(p.canonical, canon);
    return { login, mcp };
  });
}

// -------------------------------------------------------------------------------------------- MCP sign-in state

export type McpAuth = 'signed_in' | 'needs_sign_in';

/**
 * Whether a plugin MCP server has a stored sign-in: a `mcpOAuth` key equal to the server's key (`plugin:atlassian:atlassian`)
 * or starting with `<key>|` (Claude Code adds a hash of the connection). An entry whose access token expired counts as
 * signed in when it has a refresh token (Claude Code refreshes it on use). Never reads or returns a token value.
 */
export function mcpAuthOf(
  creds: CredentialsDoc | null,
  serverKey: string,
  now: number = Date.now(),
): McpAuth {
  const entries = Object.entries(creds?.mcpOAuth ?? {}).filter(
    ([k]) => k === serverKey || k.startsWith(`${serverKey}|`),
  );
  for (const [, e] of entries) {
    if (!isObj(e)) continue;
    const exp = expiryOf(e);
    const hasAccess = typeof e.accessToken === 'string' && e.accessToken.length > 0;
    const hasRefresh = typeof e.refreshToken === 'string' && e.refreshToken.length > 0;
    if (hasAccess && (exp === 0 || exp > now)) return 'signed_in';
    if (hasRefresh) return 'signed_in';
  }
  return 'needs_sign_in';
}

// -------------------------------------------------------------------------------------------- probe

export type ProbeResult = 'ok' | 'expired' | 'unknown';

export interface ProbeOpts {
  bin: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** A seam for tests: runs a command and returns what it printed. */
  run?: (
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const defaultRun: NonNullable<ProbeOpts['run']> = async (bin, args, env) => {
  const r = await execa(bin, args, {
    env,
    extendEnv: false,
    reject: false,
    stdin: 'ignore',
    timeout: 120_000,
  });
  return { exitCode: r.exitCode ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};

/**
 * A cheap check that the login works: `claude auth status` says at once when nobody is signed in; otherwise one
 * minimal `claude -p` call (one turn, the smallest model) exercises the token, which also refreshes it when it can.
 * 'unknown' (a network error, a missing binary) leaves the state as it is.
 */
export async function probeClaudeLogin(opts: ProbeOpts): Promise<ProbeResult> {
  const run = opts.run ?? defaultRun;
  const env = opts.env ?? process.env;
  try {
    const status = await run(opts.bin, ['auth', 'status', '--json'], env);
    if (status.exitCode === 0) {
      try {
        const j = JSON.parse(status.stdout) as { loggedIn?: unknown };
        if (j.loggedIn === false) return 'expired';
      } catch {
        // not JSON: fall through to the real call
      }
    } else if (isAuthFailureText(`${status.stdout}\n${status.stderr}`)) return 'expired';
    const r = await run(
      opts.bin,
      ['-p', 'Reply with: ok', '--max-turns', '1', '--output-format', 'json', '--model', 'haiku'],
      env,
    );
    const out = `${r.stdout}\n${r.stderr}`;
    if (isAuthFailureText(out)) return 'expired';
    if (r.exitCode !== 0) return 'unknown';
    try {
      const j = JSON.parse(r.stdout) as { is_error?: unknown; result?: unknown };
      if (j.is_error === true) return isAuthFailureText(String(j.result ?? '')) ? 'expired' : 'unknown';
    } catch {
      // plain text answer: exit 0 is enough
    }
    return 'ok';
  } catch {
    return 'unknown';
  }
}
