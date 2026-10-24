import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationKindId, IntegrationScope, IntegrationStatus } from '@aom/shared';
import { MAIN_ACCOUNT } from '@aom/shared';
import { OWNER_MARKER } from '../adapters/claude-account-provision.ts';
import {
  ensureLoginAccount,
  type LoginAccount,
  type LoginRuntime,
  type LoginRuntimeDef,
  loginDef,
  unregisterLoginAccount,
} from '../adapters/login-accounts.ts';
import type { LoginSpec, ParseResult, Transcript } from './session.ts';
import { findUrl } from './terminal.ts';
import {
  type AdapterEnv,
  baseStatus,
  type IntegrationAdapter,
  type IntegrationFailure,
  type Outcome,
} from './types.ts';

/**
 * Sign-in for the login-based runtimes besides Claude Code (S-A): Codex (`codex login --device-auth`) and the Gemini CLI (Google
 * login). One class for both, driven by the runtime's definition. Each account is a folder of its own (`login-accounts.ts`); the
 * sign-in runs the CLI's own login headlessly on the workstation with that folder as its home, in the existing pseudo-terminal login
 * session, and the page shows the link and the device code (Codex) or the paste box (Gemini). `finish` never trusts the screen
 * text: it looks at the login files.
 *
 * UNVERIFIED against the real CLIs (a real login must not be started during development): the Codex screen is the documented
 * device-code flow ("Open this link ... Enter this one-time code"), the Gemini one is the documented `NO_BROWSER` flow ("Enter the
 * authorization code"). The parsers below are written from those descriptions and pinned by fixtures that say so.
 */

/** Hosts the sign-in pages may be on. The runner never hands the page a link anywhere else. */
export const CODEX_SIGN_IN_HOSTS = ['openai.com', 'chatgpt.com'];
export const GEMINI_SIGN_IN_HOSTS = ['google.com', 'googleusercontent.com'];
const hostAllowed = (host: string, allowed: readonly string[]): boolean =>
  allowed.some((a) => host === a || host.endsWith(`.${a}`));

/** `ABCD-EFGH1`: the one-time code of the device flow (letters and digits in two groups). */
const DEVICE_CODE_RE = /\b([A-Z0-9]{4,6}-[A-Z0-9]{4,8})\b/;

/** Codex's device flow: a link and a code to type there; nothing to paste back. */
export function parseCodexDeviceAuth(folder: string, def: LoginRuntimeDef) {
  return (t: Transcript): ParseResult => {
    if (/(?:error|failed|denied|expired)/i.test(t.sinceInput) && t.inputs > 0)
      return { failed: 'OpenAI did not accept the sign-in. Start it again.' };
    if (def.hasLogin(folder) && /(?:successfully|logged in|signed in)/i.test(t.text)) return { done: true };
    const url = findUrl(t.raw, (u) => hostAllowed(u.hostname, CODEX_SIGN_IN_HOSTS));
    if (!url) return {};
    const code = DEVICE_CODE_RE.exec(t.text)?.[1];
    return {
      awaiting: 'user',
      prompt: {
        url,
        urlHost: new URL(url).hostname,
        ...(code ? { userCode: code } : {}),
        inputKind: 'none',
      },
    };
  };
}

/** Gemini's Google login: a link, then "Enter the authorization code" and a paste. */
export function parseGeminiLogin(folder: string, def: LoginRuntimeDef) {
  return (t: Transcript): ParseResult => {
    if (t.inputs > 0 && def.hasLogin(folder)) return { done: true };
    if (t.inputs > 0 && /(?:invalid|error|failed|denied)/i.test(t.sinceInput))
      return { failed: 'Google did not accept the code. Start the sign-in again and paste the new code.' };
    const url = findUrl(t.raw, (u) => hostAllowed(u.hostname, GEMINI_SIGN_IN_HOSTS));
    if (!url) return {};
    const waiting = /authorization code/i.test(t.text);
    return {
      awaiting: waiting ? 'code' : 'user',
      prompt: {
        url,
        urlHost: new URL(url).hostname,
        inputKind: 'code',
        inputLabel: 'The authorization code the Google page shows after you sign in',
      },
    };
  };
}

/** The login registries and the programs, as the runner knows them. */
export interface LoginRuntimeHandle {
  registry: import('../adapters/login-accounts.ts').LoginAccountRegistry;
  /** The resolved program, or undefined when it is not installed (the runtime is not registered). */
  bin: () => string | undefined;
  /** Called after an account's state changed (the runner re-reports its runtimes). */
  afterChange: () => Promise<void> | void;
}

export class LoginRuntimeIntegration implements IntegrationAdapter {
  readonly kind: IntegrationKindId;
  private readonly def: LoginRuntimeDef;

  constructor(
    runtime: LoginRuntime,
    private readonly env: AdapterEnv,
  ) {
    this.kind = runtime;
    this.def = loginDef(runtime);
  }

  private get handle(): LoginRuntimeHandle | undefined {
    return this.env.loginRuntimes?.[this.def.runtime];
  }

  scopeOf(method?: string): IntegrationScope {
    return method ? 'machine' : 'workstation';
  }

  async instances(): Promise<string[]> {
    const others = (this.handle?.registry.list() ?? []).filter((a) => !a.main).map((a) => a.key);
    return ['', ...others];
  }

  private account(instance: string): LoginAccount | undefined {
    return this.handle?.registry.get(instance === '' ? MAIN_ACCOUNT : instance);
  }

  async status(instance = ''): Promise<IntegrationStatus> {
    const now = this.env.now();
    const h = this.handle;
    const method = this.def.runtime === 'codex' ? 'codex_login' : 'gemini_login';
    if (!h)
      return baseStatus(this.kind, instance, 'workstation', now, 'unavailable', {
        detail: `This runner cannot manage ${this.def.label} sign-ins: update it.`,
      });
    if (!h.bin())
      return baseStatus(this.kind, instance, 'machine', now, 'unavailable', {
        detail: `${this.def.label} is not installed on this workstation. Install it, then restart the runner.`,
      });
    h.registry.poll();
    const a = this.account(instance);
    if (!a)
      return baseStatus(this.kind, instance, 'machine', now, 'not_connected', {
        detail: `The account ${instance} is not set up on this workstation yet. Sign in to set it up.`,
      });
    const email = this.def.emailOf(a.folder);
    const login = a.auth.state;
    if (login === 'none')
      return baseStatus(this.kind, instance, 'machine', now, 'not_connected', {
        method,
        detail: `Not signed in. Sign in from here, or run: ${a.terminalLogin()}`,
      });
    if (login === 'expired')
      return baseStatus(this.kind, instance, 'machine', now, 'expired', {
        method,
        ...(email ? { account: email } : {}),
        detail: 'The login of this account expired. Sign in again.',
      });
    return baseStatus(this.kind, instance, 'machine', now, 'connected', {
      method,
      ...(email ? { account: email } : {}),
    });
  }

  /** Re-reads the login files (no network call: a sign-in that works is what the files say). */
  async test(instance = ''): Promise<IntegrationStatus> {
    const h = this.handle;
    const a = this.account(instance);
    if (h && a) {
      if (!a.hasLogin()) a.auth.markNone();
      else if (a.auth.state === 'none') a.auth.markOk();
      await h.afterChange();
    }
    return this.status(instance);
  }

  async begin(instance: string, method: string): Promise<LoginSpec | IntegrationFailure> {
    const want = this.def.runtime === 'codex' ? 'codex_login' : 'gemini_login';
    if (method !== want)
      return { error: 'This sign-in cannot be started from here yet.', code: 'unsupported' };
    const h = this.handle;
    if (!h) return { error: `This runner cannot manage ${this.def.label} sign-ins.`, code: 'unsupported' };
    const bin = h.bin();
    if (!bin)
      return {
        error: `${this.def.label} is not installed on this workstation. Install it, then restart the runner.`,
        code: 'unavailable',
      };
    let account = this.account(instance);
    if (!account && instance !== '') {
      const r = ensureLoginAccount(this.def, instance, {
        home: this.env.home,
        root: this.env.paths.root,
        configPath: this.env.paths.config,
        mainFolder: h.registry.main.folder,
      });
      if (!r.ok) return { error: r.error ?? 'The account could not be set up.', code: 'failed' };
      h.registry.refresh();
      account = this.account(instance);
    }
    if (!account) return { error: 'The account could not be set up.', code: 'failed' };
    const key = account.key;
    const folder = account.folder;
    const root = account.root;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    mkdirSync(this.env.sessionCwd, { recursive: true });
    const hint = account.terminalLogin();
    const log = this.env.log;
    log?.info(`${this.kind} account ${key}: sign-in started`, { folder });
    const finish: LoginSpec['finish'] = async () => {
      h.registry.poll();
      if (!account.hasLogin()) {
        log?.warn(`${this.kind} account ${key}: sign-in did not finish`, { folder });
        return { error: `Sign-in did not finish. Run ${hint} on the workstation.` };
      }
      log?.info(`${this.kind} account ${key}: sign-in finished`, { folder });
      account.auth.markOk();
      await h.afterChange();
      return this.status(instance);
    };
    if (this.def.runtime === 'codex')
      return {
        cmd: bin,
        args: ['login', '--device-auth'],
        pty: true,
        env: { CODEX_HOME: root },
        cwd: this.env.sessionCwd,
        parse: parseCodexDeviceAuth(folder, this.def),
        terminalHint: hint,
        finish,
      };
    // Gemini: the CLI opens its login on start when the auth type is set; NO_BROWSER prints the link instead of opening one, and
    // the login goes to a file (not the keychain) in the account's own home
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(folder, 'settings.json'),
      `${JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return {
      cmd: bin,
      args: [],
      pty: true,
      env: { GEMINI_CLI_HOME: root, NO_BROWSER: 'true', GEMINI_FORCE_FILE_STORAGE: 'true' },
      cwd: this.env.sessionCwd,
      parse: parseGeminiLogin(folder, this.def),
      terminalHint: hint,
      finish,
    };
  }

  /**
   * Removes a named account: it is unregistered and the login the runner stored in its own folder is deleted (a folder the runner
   * did not create is only unregistered). The main login is the machine's own and is never removed from here.
   */
  async remove(instance = ''): Promise<Outcome> {
    if (instance === '')
      return {
        error: `The main ${this.def.label} login belongs to the machine: sign out in a terminal on the workstation.`,
        code: 'unsupported',
        status: await this.status(instance),
      };
    const h = this.handle;
    const a = this.account(instance);
    if (a && h) {
      unregisterLoginAccount(this.env.paths.config, this.def.runtime, instance);
      if (existsSync(join(a.root, OWNER_MARKER))) {
        try {
          rmSync(a.folder, { recursive: true, force: true });
          if (this.def.runtime === 'gemini' && existsSync(a.root) && readdirSync(a.root).length <= 1)
            rmSync(a.root, { recursive: true, force: true });
        } catch {
          // best effort: the account is gone either way
        }
      }
      h.registry.refresh();
      await h.afterChange();
    }
    return this.status(instance);
  }
}
