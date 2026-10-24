import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type ClaudeAccountInfo, MAIN_ACCOUNT } from '@aom/shared';
import {
  CodexRuntimeConfigSchema,
  GeminiRuntimeConfigSchema,
  type LoginAccountConfig,
  loadConfig,
  type RunnerConfig,
  saveConfig,
} from '../config.ts';
import { checkAccountDir, OWNER_MARKER } from './claude-account-provision.ts';
import { displayDir, expandHome } from './claude-accounts.ts';
import { ClaudeAuthMonitor } from './claude-auth.ts';
import { ClaudeUsageMonitor, formatLimitTime } from './claude-usage-limit.ts';

/**
 * Named login accounts of Codex and the Gemini CLI (S-A, docs/design/discovery-boardroom-registry.md): the Claude accounts'
 * machinery (docs/design/claude-accounts.md) for the other two login-based runtimes. `main` is the owner's own login; a named
 * account is a folder of its own that only the runner uses: `~/.codex-gw-<key>` (a `CODEX_HOME`) or `~/.gemini-gw-<key>` (a
 * `GEMINI_CLI_HOME`, the login inside its `.gemini`). The runner never adopts a folder it did not create (the marker file), and an
 * account's login is copied into each agent's private home per session and handed back after checks, exactly as the main login is.
 *
 * Nothing here reads, logs or returns a token.
 */

export type LoginRuntime = 'codex' | 'gemini';

export interface LoginRuntimeDef {
  runtime: LoginRuntime;
  label: string;
  /** The runner-owned folder name of a key (inside the home). */
  ownedDirName(key: string): string;
  /** The folder holding the login files, given an account's folder (codex: the folder itself; gemini: its `.gemini`). */
  loginFolder(root: string): string;
  /** The account folder given the folder holding the login files (the inverse of `loginFolder`). */
  rootOfLoginFolder(folder: string): string;
  /** Does this login folder hold a login? */
  hasLogin(folder: string): boolean;
  /** The login file whose change means somebody signed in or out. */
  loginFile(folder: string): string | undefined;
  /** The email shown beside the account, when the login says it. */
  emailOf(folder: string): string | undefined;
  /** The command that signs a folder in from a terminal (display). */
  terminalLogin(rootDisplay: string): string;
}

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The `email` claim of an id token, for display only (the signature is not checked: nothing trusts it). */
function emailOfJwt(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    const body = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof body.email === 'string' ? body.email.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

export const CODEX_DEF: LoginRuntimeDef = {
  runtime: 'codex',
  label: 'Codex',
  ownedDirName: (key) => `.codex-gw-${key}`,
  loginFolder: (root) => root,
  rootOfLoginFolder: (folder) => folder,
  hasLogin: (folder) => {
    const j = readJson(join(folder, 'auth.json'));
    if (!j) return false;
    const t = j.tokens as { access_token?: unknown } | undefined;
    return (
      (typeof t?.access_token === 'string' && t.access_token.length > 0) ||
      (typeof j.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY.length > 0)
    );
  },
  loginFile: (folder) => join(folder, 'auth.json'),
  emailOf: (folder) =>
    emailOfJwt((readJson(join(folder, 'auth.json'))?.tokens as { id_token?: unknown })?.id_token),
  terminalLogin: (root) => `CODEX_HOME=${root} codex login --device-auth`,
};

const GEMINI_FILES = ['oauth_creds.json', 'gemini-credentials.json'] as const;
export const GEMINI_DEF: LoginRuntimeDef = {
  runtime: 'gemini',
  label: 'Gemini CLI',
  ownedDirName: (key) => `.gemini-gw-${key}`,
  loginFolder: (root) => join(root, '.gemini'),
  rootOfLoginFolder: (folder) => dirname(folder),
  hasLogin: (folder) =>
    GEMINI_FILES.some((n) => {
      try {
        return statSync(join(folder, n)).size > 2;
      } catch {
        return false;
      }
    }),
  loginFile: (folder) => GEMINI_FILES.map((n) => join(folder, n)).find((f) => existsSync(f)),
  emailOf: (folder) => {
    const a = readJson(join(folder, 'google_accounts.json'))?.active;
    return typeof a === 'string' ? a.slice(0, 200) : undefined;
  },
  terminalLogin: (root) => `GEMINI_CLI_HOME=${root} GEMINI_FORCE_FILE_STORAGE=true gemini`,
};

export const loginDef = (runtime: LoginRuntime): LoginRuntimeDef =>
  runtime === 'codex' ? CODEX_DEF : GEMINI_DEF;

const mtimeOf = (file: string | undefined): number => {
  if (!file) return 0;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

// ------------------------------------------------------------------------------------------------ accounts

export class LoginAccount {
  readonly main: boolean;
  readonly auth = new ClaudeAuthMonitor();
  readonly usage = new ClaudeUsageMonitor();
  /** mtime of the login file at the last look (the registry's poll compares against it). */
  watchedMtime = 0;

  constructor(
    readonly def: LoginRuntimeDef,
    readonly key: string,
    /** The account's folder (codex: a CODEX_HOME; gemini: a GEMINI_CLI_HOME). */
    readonly root: string,
    /** Where the login files are. */
    readonly folder: string,
    private readonly ctx: { home: string; now: () => Date; zone: string | undefined },
  ) {
    this.main = key === MAIN_ACCOUNT;
    this.watchedMtime = mtimeOf(def.loginFile(folder));
  }

  hasLogin(): boolean {
    return this.def.hasLogin(this.folder);
  }

  /** Sets `none` when no login is there. Returns true when the state changed. */
  refreshPresence(): boolean {
    if (this.hasLogin()) return false;
    return this.auth.markNone();
  }

  get usable(): boolean {
    return this.auth.state === 'ok' && this.usage.state === 'ok';
  }

  terminalLogin(): string {
    return this.def.terminalLogin(displayDir(this.root, this.ctx.home));
  }

  info(): ClaudeAccountInfo {
    const limited = this.usage.state === 'limited';
    const until = this.usage.limitedUntil;
    const email = this.def.emailOf(this.folder);
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
      source: 'config_dir',
      configDir: displayDir(this.root, this.ctx.home),
      ...(email ? { email } : {}),
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

export interface LoginRegistryDeps {
  def: LoginRuntimeDef;
  /** The user's real home. */
  home: string;
  /** The additional accounts in force right now (read fresh from config.json). */
  accounts: () => LoginAccountConfig[];
  /** The main account's LOGIN FOLDER (the owner's own login). */
  mainFolder: () => string;
  /** `<dataDir>/<runtime>-accounts-state.json`; absent: state is kept in memory only. */
  stateFile?: string;
  now?: () => Date;
  zone?: string;
}

interface PersistedState {
  limitedUntil?: string;
  login?: 'expired';
}

export class LoginAccountRegistry {
  private readonly byKey = new Map<string, LoginAccount>();
  private persisted: Record<string, PersistedState> = {};
  private lastWritten = '';
  private listeners: Array<(a: LoginAccount) => void> = [];
  private readonly ctx: { home: string; now: () => Date; zone: string | undefined };

  constructor(private readonly deps: LoginRegistryDeps) {
    this.ctx = { home: deps.home, now: deps.now ?? (() => new Date()), zone: deps.zone };
    this.persisted = this.readState();
    this.refresh();
  }

  get def(): LoginRuntimeDef {
    return this.deps.def;
  }

  /** The folder of an account key as the config names it: `loginDir` is the account's root. */
  rootOf(cfg: LoginAccountConfig): string {
    return expandHome(cfg.loginDir ?? `~/${this.def.ownedDirName(cfg.key)}`, this.deps.home);
  }

  // ------------------------------------------------------------------------------------------ state file

  private readState(): Record<string, PersistedState> {
    const f = this.deps.stateFile;
    if (!f) return {};
    try {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
      const out: Record<string, PersistedState> = {};
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

  private persist(): void {
    const f = this.deps.stateFile;
    if (!f) return;
    const snap: Record<string, PersistedState> = {};
    for (const a of this.byKey.values()) {
      const limited = a.usage.state === 'limited' ? a.usage.limitedUntil : undefined;
      const expired = a.auth.state === 'expired';
      if (limited || expired)
        snap[a.key] = {
          ...(limited ? { limitedUntil: limited } : {}),
          ...(expired ? { login: 'expired' } : {}),
        };
    }
    const body = JSON.stringify(snap);
    if (body === this.lastWritten) return;
    this.lastWritten = body;
    try {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(`${f}.tmp`, `${body}\n`, { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
    } catch {
      // best effort: a restart then forgets the limit
    }
  }

  // ------------------------------------------------------------------------------------------ accounts

  private build(key: string, root: string, folder: string): LoginAccount {
    const a = new LoginAccount(this.def, key, root, folder, this.ctx);
    const p = this.persisted[key];
    delete this.persisted[key];
    if (p?.limitedUntil) a.usage.markLimited(new Date(p.limitedUntil));
    if (p?.login === 'expired') a.auth.markExpired();
    a.refreshPresence();
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
    return a;
  }

  /** Re-reads config.json's accounts: new ones appear, removed ones go, a moved folder rebuilds the account. */
  refresh(): void {
    let cfgs: LoginAccountConfig[] = [];
    try {
      cfgs = this.deps.accounts();
    } catch {
      return;
    }
    const mainFolder = resolve(this.deps.mainFolder());
    const main = this.byKey.get(MAIN_ACCOUNT);
    if (!main || main.folder !== mainFolder)
      this.byKey.set(
        MAIN_ACCOUNT,
        this.build(MAIN_ACCOUNT, this.def.rootOfLoginFolder(mainFolder), mainFolder),
      );
    const keys = new Set(cfgs.map((c) => c.key));
    for (const k of [...this.byKey.keys()]) if (k !== MAIN_ACCOUNT && !keys.has(k)) this.byKey.delete(k);
    for (const c of cfgs) {
      const root = this.rootOf(c);
      const have = this.byKey.get(c.key);
      if (!have || have.root !== root)
        this.byKey.set(c.key, this.build(c.key, root, this.def.loginFolder(root)));
    }
    this.persist();
  }

  /** Main first, then the others by key. */
  list(): LoginAccount[] {
    this.refresh();
    return [...this.byKey.values()].sort(
      (a, b) => Number(b.main) - Number(a.main) || a.key.localeCompare(b.key),
    );
  }

  get(key: string): LoginAccount | undefined {
    if (key !== MAIN_ACCOUNT && !this.byKey.has(key)) this.refresh();
    return this.byKey.get(key);
  }

  get main(): LoginAccount {
    this.refresh();
    return this.byKey.get(MAIN_ACCOUNT) as LoginAccount;
  }

  infos(): ClaudeAccountInfo[] {
    return this.list().map((a) => a.info());
  }

  anyUsable(): boolean {
    return this.list().some((a) => a.usable);
  }

  onChange(fn: (a: LoginAccount) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Checked in the runner's tick. A login file that changed since the last look: gone means `none`; present while the account was
   * `none` or `expired` means somebody signed in (a terminal, or the web flow), so the account is `ok` again at once. A usage limit
   * whose reset time has passed is cleared (no probe call: a probe costs tokens, and a limit that is still there is simply hit again).
   * Returns the accounts whose state changed.
   */
  poll(): LoginAccount[] {
    const changed: LoginAccount[] = [];
    const now = this.ctx.now().getTime();
    for (const a of this.list()) {
      const f = this.def.loginFile(a.folder);
      const m = mtimeOf(f);
      if (m !== a.watchedMtime) {
        a.watchedMtime = m;
        if (!a.hasLogin()) {
          if (a.auth.markNone()) changed.push(a);
        } else if (a.auth.state !== 'ok' && a.auth.markOk()) changed.push(a);
      }
      const until = a.usage.limitedUntilMs;
      if (a.usage.state === 'limited' && until !== undefined && now >= until && a.usage.markOk())
        changed.push(a);
    }
    return changed;
  }
}

// ------------------------------------------------------------------------------------------------ config edits

type RuntimeKey = 'codex' | 'gemini';

function withRuntime(
  cfg: RunnerConfig,
  runtime: RuntimeKey,
  edit: (cur: { loginDir?: string | undefined; accounts: LoginAccountConfig[] }) => {
    loginDir?: string | undefined;
    accounts: LoginAccountConfig[];
  },
): RunnerConfig {
  const cur =
    cfg.runtimes[runtime] ??
    (runtime === 'codex' ? CodexRuntimeConfigSchema.parse({}) : GeminiRuntimeConfigSchema.parse({}));
  const next = edit({ loginDir: cur.loginDir, accounts: cur.accounts });
  const { loginDir: _old, ...rest } = cur;
  return {
    ...cfg,
    runtimes: {
      ...cfg.runtimes,
      [runtime]: { ...rest, ...(next.loginDir ? { loginDir: next.loginDir } : {}), accounts: next.accounts },
    },
  };
}

/** Registers a named account in this pairing's config.json (an existing entry for the key is kept). Returns true when added. */
export function registerLoginAccount(
  configPath: string,
  runtime: RuntimeKey,
  entry: LoginAccountConfig,
): boolean {
  const cfg = loadConfig(configPath);
  if ((cfg.runtimes[runtime]?.accounts ?? []).some((a) => a.key === entry.key)) return false;
  saveConfig(
    configPath,
    withRuntime(cfg, runtime, (c) => ({ ...c, accounts: [...c.accounts, entry] })),
  );
  return true;
}

/** Unregisters the account (the folder and its login stay on disk). */
export function unregisterLoginAccount(configPath: string, runtime: RuntimeKey, key: string): boolean {
  const cfg = loadConfig(configPath);
  if (!(cfg.runtimes[runtime]?.accounts ?? []).some((a) => a.key === key)) return false;
  saveConfig(
    configPath,
    withRuntime(cfg, runtime, (c) => ({ ...c, accounts: c.accounts.filter((a) => a.key !== key) })),
  );
  return true;
}

/**
 * "Make main": the named account's folder becomes the main login and the former main's folder becomes the named account (a swap:
 * nothing is lost, and doing it again undoes it). Codex: `loginDir` is the CODEX_HOME. Gemini: `loginDir` is the `.gemini` folder of
 * the main login while an account names the GEMINI_CLI_HOME that holds it, so the two forms are converted. Returns an error text.
 */
export function swapMainLoginAccount(
  configPath: string,
  def: LoginRuntimeDef,
  key: string,
  home: string,
  currentMainFolder: string,
): { ok: true } | { ok: false; error: string } {
  const cfg = loadConfig(configPath);
  const cur = cfg.runtimes[def.runtime];
  const acct = cur?.accounts.find((a) => a.key === key);
  if (!cur || !acct) return { ok: false, error: `there is no account ${key} on this workstation` };
  const acctRoot = expandHome(acct.loginDir ?? `~/${def.ownedDirName(key)}`, home);
  const newMainFolder = def.loginFolder(acctRoot);
  const oldRoot = def.rootOfLoginFolder(resolve(currentMainFolder));
  if (def.loginFolder(oldRoot) !== resolve(currentMainFolder))
    return { ok: false, error: 'the main login folder is not in the usual place: move it by hand' };
  saveConfig(
    configPath,
    withRuntime(cfg, def.runtime, (c) => ({
      loginDir: displayDir(newMainFolder, home),
      accounts: c.accounts.map((a) => (a.key === key ? { key, loginDir: displayDir(oldRoot, home) } : a)),
    })),
  );
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ provisioning

export interface LoginProvisionResult {
  ok: boolean;
  /** The account's root folder (absolute), when ok. */
  root?: string;
  error?: string;
}

/**
 * Makes sure a named account has its folder and a config entry. Idempotent. A folder is created (0700) with the ownership marker;
 * one that exists without the marker is used only when the owner wrote it into config.json. The caller (the integration service)
 * has already enforced the machine-scope policy, because this writes into the user's home.
 */
export function ensureLoginAccount(
  def: LoginRuntimeDef,
  key: string,
  deps: { home: string; root: string; configPath: string; mainFolder: string },
): LoginProvisionResult {
  const cfg = loadConfig(deps.configPath);
  const entry = cfg.runtimes[def.runtime]?.accounts.find((a) => a.key === key);
  const explicit = entry?.loginDir;
  const root = expandHome(explicit ?? `~/${def.ownedDirName(key)}`, deps.home);
  const bad =
    checkAccountDir(root, deps.home, deps.root) ??
    (resolve(root) === resolve(def.rootOfLoginFolder(deps.mainFolder))
      ? 'that is the main account’s folder'
      : undefined);
  if (bad) return { ok: false, error: `Account folder refused: ${bad}.` };
  if (!explicit && existsSync(root) && !existsSync(join(root, OWNER_MARKER)))
    return {
      ok: false,
      error: `${displayDir(root, deps.home)} already exists and was not created by Guildwise, so it was left alone.`,
    };
  try {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      try {
        chmodSync(root, 0o700);
      } catch {
        // not supported everywhere
      }
      writeFileSync(join(root, OWNER_MARKER), `created by the Guildwise runner for account ${key}\n`, {
        mode: 0o600,
      });
    }
    mkdirSync(def.loginFolder(root), { recursive: true, mode: 0o700 });
    if (!entry) registerLoginAccount(deps.configPath, def.runtime, { key });
    return { ok: true, root };
  } catch (err) {
    return {
      ok: false,
      error: `Could not set the account up: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
