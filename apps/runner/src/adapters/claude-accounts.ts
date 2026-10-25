import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type ClaudeAccountInfo, MAIN_ACCOUNT } from '@aom/shared';
import type { ClaudeAccountConfig } from '../config.ts';
import { ClaudeCredentialStore, claudeAccountFile } from '../integrations/claude-store.ts';
import { ClaudeAuthMonitor, type CredentialPaths, readCredentials } from './claude-auth.ts';
import { ClaudeUsageMonitor, formatLimitTime } from './claude-usage-limit.ts';

/**
 * The Claude accounts of this workstation (docs/design/claude-accounts.md section 2.1). `main` is today's credential
 * (secrets token, config token or key, or the machine login in `~/.claude`). Additional accounts are Claude Code config
 * dirs (the primary kind, `~/.claude-<key>`) or tokens. Each account has its own login and usage-limit monitors, which are
 * persisted so a restart does not forget a limit, and its own canonical credentials file, lock and probe environment, so
 * a credential write-back can never reach another account.
 *
 * Nothing here logs, returns or sends a token value.
 */

export interface AccountCredential {
  authMode: 'oauth' | 'api_key' | 'default';
  oauthToken?: string;
  apiKey?: string;
}

/** `~/x` or `$HOME/x` to an absolute path (a relative path is taken from the home). */
export function expandHome(p: string, home: string): string {
  let q = p.trim();
  if (q === '~') return home;
  if (q.startsWith('~/') || q.startsWith('~\\')) q = join(home, q.slice(2));
  else if (q === '$HOME') q = home;
  else if (q.startsWith('$HOME/') || q.startsWith('${HOME}/')) q = join(home, q.slice(q.indexOf('/') + 1));
  return isAbsolute(q) ? resolve(q) : resolve(home, q);
}

/** A path inside the home as `~/x`, for display and the server (the real home path never leaves the machine). */
export function displayDir(abs: string, home: string): string {
  const a = resolve(abs);
  const h = resolve(home);
  if (a === h) return '~';
  return a.startsWith(`${h}/`) || a.startsWith(`${h}\\`) ? `~${a.slice(h.length).replaceAll('\\', '/')}` : a;
}

export const defaultAccountDir = (key: string, home: string): string => join(home, `.claude-gw-${key}`);

interface Profile {
  email?: string;
  plan?: string;
}
const profileCache = new Map<string, { sig: string; profile: Profile }>();

/** Display details of a config dir from `<dir>/.claude.json` `oauthAccount` (email and plan only; cached by mtime). */
export function readProfile(configDir: string): Profile {
  const file = join(configDir, '.claude.json');
  try {
    const st = statSync(file);
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = profileCache.get(file);
    if (hit?.sig === sig) return hit.profile;
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: Record<string, unknown> };
    const o = doc.oauthAccount ?? {};
    const profile: Profile = {
      ...(typeof o.emailAddress === 'string' ? { email: o.emailAddress.slice(0, 200) } : {}),
      ...(typeof o.organizationType === 'string' ? { plan: o.organizationType.slice(0, 60) } : {}),
    };
    profileCache.set(file, { sig, profile });
    return profile;
  } catch {
    return {};
  }
}

const mtimeOf = (file: string | undefined): number => {
  if (!file) return 0;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

export interface AccountCtx {
  /** The user's real home. */
  home: string;
  /** The runner data dir, when known (the main account's lock lives there). */
  root: string | undefined;
  /** `secrets/` of the runner; token accounts keep their credential in `claude-accounts/<key>.json`. */
  secretsDir: string | undefined;
  mainCredential: () => AccountCredential;
  now: () => Date;
  zone: string | undefined;
}

type AccountSource = 'default' | 'config_dir' | 'token';

export class ClaudeAccount {
  readonly main: boolean;
  readonly auth: ClaudeAuthMonitor;
  readonly usage: ClaudeUsageMonitor;
  /** The `config_dir` of an additional account, absolute. */
  readonly configDir: string | undefined;
  readonly source: AccountSource;
  private readonly store: ClaudeCredentialStore | undefined;
  /** mtime of the credentials file at the last check (the watch compares against it). */
  watchedMtime = 0;

  constructor(
    readonly key: string,
    cfg: ClaudeAccountConfig | undefined,
    private readonly ctx: AccountCtx,
    monitors?: { auth?: ClaudeAuthMonitor; usage?: ClaudeUsageMonitor },
  ) {
    this.main = key === MAIN_ACCOUNT;
    this.auth = monitors?.auth ?? new ClaudeAuthMonitor();
    this.usage = monitors?.usage ?? new ClaudeUsageMonitor();
    if (this.main || !cfg) {
      this.source = 'default';
      this.configDir = undefined;
      this.store = undefined;
    } else if (cfg.source === 'token') {
      this.source = 'token';
      this.configDir = undefined;
      this.store = ctx.secretsDir
        ? new ClaudeCredentialStore(claudeAccountFile(ctx.secretsDir, key))
        : undefined;
    } else {
      this.source = 'config_dir';
      this.configDir = expandHome(cfg.configDir ?? defaultAccountDir(key, ctx.home), ctx.home);
      this.store = undefined;
    }
    this.watchedMtime = mtimeOf(this.credentialFile());
  }

  /** The credentials file whose change means a login was made or lost (a token account: its secrets file). */
  credentialFile(): string | undefined {
    if (this.main) return undefined;
    if (this.configDir) return join(this.configDir, '.credentials.json');
    return this.ctx.secretsDir ? claudeAccountFile(this.ctx.secretsDir, this.key) : undefined;
  }

  /** The credential sessions of this account run with. A config-dir account has none: its login is the copied file. */
  credential(): AccountCredential {
    if (this.main) return this.ctx.mainCredential();
    if (this.source === 'token') {
      const c = this.store?.load();
      if (c)
        return {
          authMode: c.authMode,
          ...(c.oauthToken ? { oauthToken: c.oauthToken } : {}),
          ...(c.apiKey ? { apiKey: c.apiKey } : {}),
        };
    }
    return { authMode: 'default' };
  }

  /** The login is the machine's (or the config dir's) credentials file, copied per agent; no token variable is set. */
  usesSharedLogin(): boolean {
    return this.credential().authMode === 'default';
  }

  /** The canonical credentials file the agents' copies come from and write back to (shared-login accounts only). */
  canonicalFile(): string | undefined {
    if (this.main) return join(this.ctx.home, '.claude', '.credentials.json');
    return this.configDir ? join(this.configDir, '.credentials.json') : undefined;
  }

  /** Bound at session start: the paths this account's credentials move between. */
  credentialPaths(agentConfigDir: string): CredentialPaths | undefined {
    const canonical = this.canonicalFile();
    if (!canonical) return undefined;
    return {
      canonical,
      copy: join(agentConfigDir, '.credentials.json'),
      lock: this.main
        ? join(this.ctx.root ?? dirname(dirname(agentConfigDir)), 'claude-credentials.lock')
        : join(this.configDir as string, '.aom-credentials.lock'),
    };
  }

  /** The environment a login or usage probe runs with. */
  probeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!this.main) {
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_API_KEY;
      if (this.configDir) env.CLAUDE_CONFIG_DIR = this.configDir;
    }
    const c = this.credential();
    if (c.authMode === 'oauth' && c.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = c.oauthToken;
    else if (c.authMode === 'api_key' && c.apiKey) env.ANTHROPIC_API_KEY = c.apiKey;
    return env;
  }

  /** Does the account hold a login at all? (Main is trusted: today's behaviour.) */
  hasLogin(): boolean {
    if (this.main) return true;
    if (this.source === 'token') return this.store?.load() !== undefined;
    const f = this.canonicalFile();
    return !!f && !!readCredentials(f)?.claudeAiOauth;
  }

  /** Sets `none` when the account holds no login. Returns true when the state changed. */
  refreshPresence(): boolean {
    if (this.main) return false;
    return this.hasLogin() ? false : this.auth.markNone();
  }

  /** Login and usage both fine. */
  get usable(): boolean {
    return this.auth.state === 'ok' && this.usage.state === 'ok';
  }

  /** The command an owner runs in a terminal to sign in (display). */
  terminalLogin(): string {
    return this.configDir
      ? `CLAUDE_CONFIG_DIR=${displayDir(this.configDir, this.ctx.home)} claude auth login`
      : 'claude auth login';
  }

  info(): ClaudeAccountInfo {
    const limited = this.usage.state === 'limited';
    const until = this.usage.limitedUntil;
    const profile = this.configDir ? readProfile(this.configDir) : {};
    const cred = this.credential();
    const source: ClaudeAccountInfo['source'] = this.main
      ? cred.authMode === 'oauth'
        ? 'token'
        : cred.authMode === 'api_key'
          ? 'api_key'
          : 'default'
      : this.source === 'token'
        ? cred.authMode === 'api_key'
          ? 'api_key'
          : 'token'
        : 'config_dir';
    const login = this.auth.state;
    const detail =
      login === 'none'
        ? `Not signed in. Sign in from the Integrations page, or run: ${this.terminalLogin()}`
        : login === 'expired'
          ? `The login does not work any more. Sign in again: ${this.terminalLogin()}`
          : undefined;
    return {
      key: this.key,
      main: this.main,
      source,
      ...(this.configDir
        ? { configDir: displayDir(this.configDir, this.ctx.home) }
        : this.main && source === 'default'
          ? { configDir: '~/.claude' }
          : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.plan ? { plan: profile.plan } : {}),
      login,
      usage: limited ? 'limited' : 'ok',
      ...(limited && until
        ? {
            limitedUntil: until,
            limitedLabel: formatLimitTime(new Date(until), this.ctx.now(), this.ctx.zone).slice(0, 100),
          }
        : {}),
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
    };
  }
}

export interface AccountRegistryDeps {
  home: string;
  root?: string;
  secretsDir?: string;
  /** `<dataDir>/claude-accounts-state.json`; absent: state is kept in memory only. */
  stateFile?: string;
  /** The additional accounts in force right now (read fresh from config.json). */
  accounts: () => ClaudeAccountConfig[];
  mainCredential: () => AccountCredential;
  /** The monitors main uses (a test or an adapter built without a registry brings its own). */
  mainAuth?: ClaudeAuthMonitor;
  mainUsage?: ClaudeUsageMonitor;
  now?: () => Date;
  zone?: string;
}

export interface PersistedAccountState {
  limitedUntil?: string;
  login?: 'expired';
}

export class ClaudeAccountRegistry {
  private readonly accountsByKey = new Map<string, ClaudeAccount>();
  private readonly ctx: AccountCtx;
  private persisted: Record<string, PersistedAccountState> = {};
  private lastWritten = '';
  private listeners: Array<(a: ClaudeAccount) => void> = [];

  constructor(private readonly deps: AccountRegistryDeps) {
    this.ctx = {
      home: deps.home,
      root: deps.root,
      secretsDir: deps.secretsDir,
      mainCredential: deps.mainCredential,
      now: deps.now ?? (() => new Date()),
      zone: deps.zone,
    };
    this.persisted = this.readState();
    this.add(
      new ClaudeAccount(MAIN_ACCOUNT, undefined, this.ctx, {
        ...(deps.mainAuth ? { auth: deps.mainAuth } : {}),
        ...(deps.mainUsage ? { usage: deps.mainUsage } : {}),
      }),
    );
    this.refresh();
  }

  // ------------------------------------------------------------------------------------------ state file

  private readState(): Record<string, PersistedAccountState> {
    const f = this.deps.stateFile;
    if (!f) return {};
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      const out: Record<string, PersistedAccountState> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v !== 'object' || v === null) continue;
        const e = v as Record<string, unknown>;
        out[k] = {
          ...(typeof e.limitedUntil === 'string' && !Number.isNaN(Date.parse(e.limitedUntil))
            ? { limitedUntil: e.limitedUntil }
            : {}),
          ...(e.login === 'expired' ? { login: 'expired' as const } : {}),
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  private snapshot(): Record<string, PersistedAccountState> {
    const out: Record<string, PersistedAccountState> = {};
    for (const a of this.accountsByKey.values()) {
      const limited = a.usage.state === 'limited' ? a.usage.limitedUntil : undefined;
      const expired = a.auth.state === 'expired';
      if (limited || expired)
        out[a.key] = {
          ...(limited ? { limitedUntil: limited } : {}),
          ...(expired ? { login: 'expired' } : {}),
        };
    }
    return out;
  }

  /** Written on every change (atomic, 0600). */
  private persist(): void {
    const f = this.deps.stateFile;
    if (!f) return;
    const body = JSON.stringify(this.snapshot());
    if (body === this.lastWritten) return;
    this.lastWritten = body;
    try {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(`${f}.tmp`, `${body}\n`, { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch {
      // best effort: a restart then forgets the limit, as before
    }
  }

  // ------------------------------------------------------------------------------------------ accounts

  private add(a: ClaudeAccount): void {
    // restore what the last run knew, before any listener is attached
    // (each startup entry is consumed once: a later rebuild of the account object starts from what the monitors know)
    const p = this.persisted[a.key];
    delete this.persisted[a.key];
    if (p?.limitedUntil) a.usage.markLimited(new Date(p.limitedUntil));
    if (p?.login === 'expired') a.auth.markExpired();
    a.refreshPresence();
    this.accountsByKey.set(a.key, a);
    const changed = () => {
      this.persist();
      for (const l of this.listeners) {
        try {
          l(a);
        } catch {
          // a listener never breaks a monitor
        }
      }
    };
    a.auth.onChange(changed);
    a.usage.onChange(changed);
  }

  /** Re-reads config.json's accounts: new ones appear, removed ones go (never `main`). */
  refresh(): void {
    let cfgs: ClaudeAccountConfig[] = [];
    try {
      cfgs = this.deps.accounts();
    } catch {
      return;
    }
    const keys = new Set(cfgs.map((c) => c.key));
    for (const k of [...this.accountsByKey.keys()])
      if (k !== MAIN_ACCOUNT && !keys.has(k)) this.accountsByKey.delete(k);
    for (const c of cfgs) {
      const have = this.accountsByKey.get(c.key);
      const same =
        have &&
        have.source === (c.source === 'token' ? 'token' : 'config_dir') &&
        (c.source === 'token' ||
          have.configDir ===
            expandHome(c.configDir ?? defaultAccountDir(c.key, this.deps.home), this.deps.home));
      if (!same) this.add(new ClaudeAccount(c.key, c, this.ctx));
    }
    this.persist();
  }

  /**
   * After "Make main" the two accounts changed logins: the login state and the usage limit belong to the login, so they move
   * with it (a limit of the former main now applies to the account that holds that login).
   */
  swapStates(keyA: string, keyB: string): void {
    const a = this.accountsByKey.get(keyA);
    const b = this.accountsByKey.get(keyB);
    if (!a || !b) return;
    const snap = (x: ClaudeAccount) => ({
      auth: x.auth.state,
      limitedUntil: x.usage.limitedUntilMs,
    });
    const apply = (x: ClaudeAccount, s: ReturnType<typeof snap>) => {
      if (s.auth === 'expired') x.auth.markExpired();
      else if (s.auth === 'none') x.auth.markNone();
      else x.auth.markOk();
      if (s.limitedUntil !== undefined && s.limitedUntil > Date.now())
        x.usage.markLimited(new Date(s.limitedUntil));
      else x.usage.markOk();
    };
    const sa = snap(a);
    const sb = snap(b);
    apply(a, sb);
    apply(b, sa);
    a.watchedMtime = mtimeOf(a.credentialFile());
    b.watchedMtime = mtimeOf(b.credentialFile());
    this.persist();
  }

  /** Main first, then the others by key. */
  list(): ClaudeAccount[] {
    this.refresh();
    return [...this.accountsByKey.values()].sort(
      (a, b) => Number(b.main) - Number(a.main) || a.key.localeCompare(b.key),
    );
  }

  get(key: string): ClaudeAccount | undefined {
    if (key !== MAIN_ACCOUNT && !this.accountsByKey.has(key)) this.refresh();
    return this.accountsByKey.get(key);
  }

  get main(): ClaudeAccount {
    return this.accountsByKey.get(MAIN_ACCOUNT) as ClaudeAccount;
  }

  /** Any account whose login and usage are fine: the runtime is available. */
  anyUsable(): boolean {
    return this.list().some((a) => a.usable);
  }

  infos(): ClaudeAccountInfo[] {
    return this.list().map((a) => a.info());
  }

  onChange(fn: (a: ClaudeAccount) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Checked in the runner's tick: an account whose credentials file changed since the last look. A login that was lost
   * (file gone) marks it `none`; a file that changed while the account was `none` or `expired` (someone signed in from a
   * terminal) is returned, so the caller probes it at once.
   */
  poll(): ClaudeAccount[] {
    const probe: ClaudeAccount[] = [];
    for (const a of this.list()) {
      const f = a.credentialFile();
      if (!f) continue;
      const m = mtimeOf(f);
      if (m === a.watchedMtime) continue;
      a.watchedMtime = m;
      if (!existsSync(f) || !a.hasLogin()) a.refreshPresence();
      else if (a.auth.state !== 'ok') probe.push(a);
    }
    return probe;
  }
}
