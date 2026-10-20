import { mkdirSync } from 'node:fs';
import type { IntegrationScope, IntegrationStatus } from '@aom/shared';
import { MAIN_ACCOUNT } from '@aom/shared';
import {
  ensureClaudeAccount,
  registerAccount,
  setAccountSource,
  unregisterAccount,
} from '../adapters/claude-account-provision.ts';
import { type ClaudeAccount, readProfile } from '../adapters/claude-accounts.ts';
import {
  ClaudeCredentialStore,
  claudeAccountFile,
  resolveClaudeCredential,
  SETUP_TOKEN_DAYS,
} from './claude-store.ts';
import type { LoginSpec, ParseResult, Transcript } from './session.ts';
import { findUrl } from './terminal.ts';
import {
  type AdapterEnv,
  baseStatus,
  type IntegrationAdapter,
  type IntegrationFailure,
  type Outcome,
} from './types.ts';

/** Hosts the Claude sign-in page may be on. The runner never hands the page a link anywhere else. */
export const CLAUDE_SIGN_IN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com'];
export const hostAllowed = (host: string, allowed: readonly string[]): boolean =>
  allowed.some((a) => host === a || host.endsWith(`.${a}`));

/** The token `claude setup-token` prints (a year-long OAuth token). */
export const SETUP_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/g;

/**
 * Matchers for `claude setup-token` (recorded under apps/runner/test/fixtures/integrations): the Ink screen prints
 * "Browser didn't open? Use the url below", an OSC 8 link, then "Paste code here if prompted >". A wrong code gives
 * "OAuth error: ... Press Enter to retry"; a good one prints the token.
 */
export function parseSetupToken(t: Transcript): ParseResult {
  const tokens = [...t.text.matchAll(SETUP_TOKEN_RE)].map((m) => m[0]);
  if (tokens.length > 0) return { done: true, secrets: [tokens[tokens.length - 1] as string] };
  if (/OAuth error/i.test(t.sinceInput))
    return { failed: 'Anthropic did not accept the code. Start the sign-in again and paste the new code.' };
  const url = findUrl(t.raw, (u) => hostAllowed(u.hostname, CLAUDE_SIGN_IN_HOSTS));
  if (!url) return {};
  const waiting = /Paste code here/i.test(t.text);
  return {
    awaiting: waiting ? 'code' : 'user',
    prompt: {
      url,
      urlHost: new URL(url).hostname,
      inputKind: 'code',
      inputLabel: 'The code the Anthropic page shows after you sign in',
    },
  };
}

/** What `claude auth login` is expected to print once a code was accepted (UNVERIFIED wording; see `parseClaudeAuthLogin`). */
const LOGIN_OK_RE = /(?:login|sign[- ]?in) successful|successfully (?:logged|signed) in|logged in as/i;

/**
 * Matchers for `claude auth login --claudeai`. UNVERIFIED against the real CLI (a real login must not be started during
 * development): the fixture `claude-auth-login.txt` is derived from the recorded `claude setup-token` screen, which uses
 * the same OAuth component ("Browser didn't open? Use the url below", an OSC 8 link, "Paste code here if prompted >",
 * "OAuth error" on a wrong code). A login that needs no paste (the browser reached the local callback) ends with exit 0;
 * `finish` then asks `claude auth status --json`, so the outcome never depends on the success wording.
 */
export function parseClaudeAuthLogin(t: Transcript): ParseResult {
  if (/OAuth error/i.test(t.sinceInput))
    return { failed: 'Anthropic did not accept the code. Start the sign-in again and paste the new code.' };
  if (t.inputs > 0 && LOGIN_OK_RE.test(t.sinceInput)) return { done: true };
  const url = findUrl(t.raw, (u) => hostAllowed(u.hostname, CLAUDE_SIGN_IN_HOSTS));
  if (!url) return {};
  const waiting = /Paste code here/i.test(t.text);
  return {
    awaiting: waiting ? 'code' : 'user',
    prompt: {
      url,
      urlHost: new URL(url).hostname,
      inputKind: 'code',
      inputLabel: 'The code the Anthropic page shows after you sign in',
    },
  };
}

/** A token in the runner's own environment must not stand in for an account's login. */
const NO_TOKEN_ENV = { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } as const;

export class ClaudeCodeIntegration implements IntegrationAdapter {
  readonly kind = 'claude-code' as const;

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(method?: string): IntegrationScope {
    return method === 'default_login' || method === 'claude_login' ? 'machine' : 'workstation';
  }

  /** `''` is the main account; the others are the additional accounts of this workstation, by key. */
  async instances(): Promise<string[]> {
    const others = (this.env.claudeAccounts?.list() ?? []).filter((a) => !a.main).map((a) => a.key);
    return ['', ...others];
  }

  private credential() {
    return resolveClaudeCredential(this.env.claudeStore, this.env.config().runtimes['claude-code']);
  }

  private account(instance: string): ClaudeAccount | undefined {
    return instance === '' ? undefined : this.env.claudeAccounts?.get(instance);
  }

  private tokenStore(key: string): ClaudeCredentialStore {
    return new ClaudeCredentialStore(claudeAccountFile(this.env.paths.secrets, key));
  }

  async status(instance = ''): Promise<IntegrationStatus> {
    if (instance !== '') return this.accountStatus(instance);
    const now = this.env.now();
    const cred = this.credential();
    const expired = this.env.claude.authState() === 'expired';
    if (cred.authMode !== 'default') {
      const stored = this.env.claudeStore.load();
      const savedAt = stored?.savedAt;
      const method = cred.authMode === 'api_key' ? 'api_key' : (stored?.method ?? 'oauth_token');
      const expiresAt =
        cred.authMode === 'oauth' && savedAt
          ? new Date(Date.parse(savedAt) + SETUP_TOKEN_DAYS * 86_400_000).toISOString()
          : undefined;
      const pastExpiry = expiresAt !== undefined && Date.parse(expiresAt) < now.getTime();
      const state = expired || pastExpiry ? 'expired' : 'connected';
      return baseStatus('claude-code', '', 'workstation', now, state, {
        method,
        ...(savedAt ? { savedAt } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(state === 'expired'
          ? { detail: 'The Claude credential does not work any more. Sign in again.' }
          : {}),
      });
    }
    // The machine's own login: ask the CLI (fast, no model call).
    if (this.env.claude.blocked?.())
      return baseStatus('claude-code', '', 'machine', now, 'unavailable', {
        detail: 'Claude Code is not run in this environment.',
      });
    const r = await this.env.exec.run(this.env.claude.bin(), ['auth', 'status', '--json'], {
      timeoutMs: 15_000,
    });
    if (r.exitCode === 127)
      return baseStatus('claude-code', '', 'machine', now, 'unavailable', {
        detail: 'Claude Code is not installed on this workstation.',
      });
    let loggedIn = false;
    let account: string | undefined;
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string };
      loggedIn = j.loggedIn === true;
      account = typeof j.email === 'string' ? j.email : undefined;
    } catch {
      // not JSON: treated as not signed in
    }
    if (loggedIn && !expired)
      return baseStatus('claude-code', '', 'machine', now, 'connected', {
        method: 'default_login',
        ...(account ? { account } : {}),
      });
    return baseStatus('claude-code', '', 'machine', now, expired ? 'expired' : 'not_connected', {
      method: 'default_login',
      ...(account ? { account } : {}),
      detail: expired
        ? 'The Claude login expired. Sign in with a token from here, or run `claude` then `/login` on the workstation.'
        : 'Not signed in. Sign in with your subscription from here, or add an API key.',
    });
  }

  /** The login of an additional account: its own folder (or token) and its own state. */
  private async accountStatus(key: string): Promise<IntegrationStatus> {
    const now = this.env.now();
    const account = this.account(key);
    if (!account)
      return baseStatus('claude-code', key, 'machine', now, 'not_connected', {
        detail: `The account ${key} is not set up on this workstation yet. Sign in to set it up.`,
      });
    const login = account.auth.state;
    if (account.source === 'token') {
      const stored = this.tokenStore(key).load();
      if (!stored)
        return baseStatus('claude-code', key, 'workstation', now, 'not_connected', {
          detail: 'No token is saved for this account. Add one, or sign in with your subscription.',
        });
      const expiresAt =
        stored.authMode === 'oauth'
          ? new Date(Date.parse(stored.savedAt) + SETUP_TOKEN_DAYS * 86_400_000).toISOString()
          : undefined;
      const pastExpiry = expiresAt !== undefined && Date.parse(expiresAt) < now.getTime();
      const state = login !== 'ok' || pastExpiry ? 'expired' : 'connected';
      return baseStatus('claude-code', key, 'workstation', now, state, {
        method: stored.authMode === 'api_key' ? 'api_key' : (stored.method ?? 'oauth_token'),
        savedAt: stored.savedAt,
        ...(expiresAt ? { expiresAt } : {}),
        ...(state === 'expired'
          ? { detail: 'The Claude credential of this account does not work any more. Sign in again.' }
          : {}),
      });
    }
    const email = account.configDir ? readProfile(account.configDir).email : undefined;
    if (login === 'none')
      return baseStatus('claude-code', key, 'machine', now, 'not_connected', {
        method: 'claude_login',
        detail: 'Not signed in. Sign in with your Claude subscription from here.',
      });
    if (login === 'expired')
      return baseStatus('claude-code', key, 'machine', now, 'expired', {
        method: 'claude_login',
        ...(email ? { account: email } : {}),
        detail: 'The login of this account expired. Sign in again.',
      });
    return baseStatus('claude-code', key, 'machine', now, 'connected', {
      method: 'claude_login',
      ...(email ? { account: email } : {}),
    });
  }

  async test(instance = ''): Promise<IntegrationStatus> {
    const r = await this.env.claude.probeLogin(instance === '' ? undefined : instance);
    const s = await this.status(instance);
    if (r === 'expired')
      return { ...s, state: 'expired', detail: 'Claude rejected the login. Sign in again.' };
    if (r === 'unknown')
      return {
        ...s,
        detail: 'Could not reach Claude to check the login (offline, or Claude Code is missing).',
      };
    return s.state === 'connected' ? s : { ...s, state: 'connected' };
  }

  async connect(instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    const value = (method === 'api_key' ? fields.apiKey : fields.oauthToken)?.trim();
    if (!value) return { error: 'Nothing was entered.', code: 'failed' };
    if (method !== 'api_key' && method !== 'oauth_token')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    // Check the candidate under a throwaway environment first: nothing is saved when Claude says the credential is bad.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (method === 'api_key') env.ANTHROPIC_API_KEY = value;
    else env.CLAUDE_CODE_OAUTH_TOKEN = value;
    const probe = await this.env.claude.probe(env);
    if (probe === 'expired')
      return {
        error:
          method === 'api_key'
            ? 'Anthropic refused this API key. Check that it is complete and not revoked.'
            : 'Claude refused this token. Make a new one with `claude setup-token`.',
        code: 'refused',
      };
    const cred =
      method === 'api_key'
        ? ({ authMode: 'api_key', apiKey: value, via: 'web', method } as const)
        : ({ authMode: 'oauth', oauthToken: value, via: 'web', method } as const);
    if (instance === '') this.env.claudeStore.save(cred);
    else this.saveAccountToken(instance, cred);
    await this.env.claude.afterChange(instance === '' ? undefined : instance);
    const s = await this.status(instance);
    return probe === 'unknown'
      ? {
          ...s,
          detail: 'Saved, but Claude could not be reached to check it. Use Test when the machine is online.',
        }
      : s;
  }

  /** A token for an additional account (the secondary source): saved under the account's key; the account switches to it. */
  private saveAccountToken(key: string, cred: Parameters<ClaudeCredentialStore['save']>[0]): void {
    this.tokenStore(key).save(cred);
    const have = this.account(key);
    if (!have) registerAccount(this.env.paths.config, { key, source: 'token' });
    else if (have.source !== 'token') setAccountSource(this.env.paths.config, key, 'token');
    this.env.claudeAccounts?.refresh();
  }

  async begin(instance: string, method: string): Promise<LoginSpec | IntegrationFailure> {
    if (method === 'claude_login') return this.beginAccountLogin(instance);
    if (method !== 'setup_token')
      return { error: 'This sign-in cannot be started from here yet.', code: 'unsupported' };
    mkdirSync(this.env.sessionCwd, { recursive: true });
    return {
      cmd: this.env.claude.bin(),
      args: ['setup-token'],
      pty: true,
      cwd: this.env.sessionCwd,
      parse: parseSetupToken,
      terminalHint: 'claude setup-token',
      finish: async ({ secrets }) => {
        const token = secrets.find((s) => s.startsWith('sk-ant-oat01-'));
        if (!token)
          return {
            error:
              'The sign-in ended without a token. Use the terminal: run `claude setup-token`, then paste the token under "A token made elsewhere".',
          };
        const cred = { authMode: 'oauth', oauthToken: token, via: 'web', method: 'setup_token' } as const;
        if (instance === '') this.env.claudeStore.save(cred);
        else this.saveAccountToken(instance, cred);
        await this.env.claude.afterChange(instance === '' ? undefined : instance);
        return this.status(instance);
      },
    };
  }

  /**
   * `claude auth login --claudeai` for one account, with `CLAUDE_CONFIG_DIR` pointing at the account's own folder (owner
   * decision D6), run in the existing pseudo-terminal login session. An account this workstation does not know yet is set
   * up first (folder, config entry, alias), exactly as `claude.account.ensure` does.
   */
  private async beginAccountLogin(instance: string): Promise<LoginSpec | IntegrationFailure> {
    if (instance === '' || instance === MAIN_ACCOUNT)
      return { error: 'Sign in needs an account key.', code: 'unsupported' };
    const registry = this.env.claudeAccounts;
    if (!registry) return { error: 'This runner cannot manage additional accounts.', code: 'unsupported' };
    let account = registry.get(instance);
    if (!account) {
      const r = await ensureClaudeAccount(
        { key: instance },
        {
          home: this.env.home,
          root: this.env.paths.root,
          configPath: this.env.paths.config,
          // the service has already enforced the machine-scope policy for this method
          machineScopeAllowed: true,
          registry,
          probeLogin: (k) => this.env.claude.probeLogin(k),
        },
      );
      if (r.state === 'failed' || r.state === 'needs_owner')
        return { error: r.detail ?? 'The account could not be set up.', code: 'failed' };
      account = registry.get(instance);
    }
    if (!account) return { error: 'The account could not be set up.', code: 'failed' };
    if (account.source !== 'config_dir' || !account.configDir)
      return {
        error:
          'This account uses a token. Replace the token, or remove the account and sign in with your subscription.',
        code: 'unsupported',
      };
    const dir = account.configDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.env.sessionCwd, { recursive: true });
    const bin = this.env.claude.bin();
    const key = account.key;
    const hint = account.terminalLogin();
    return {
      cmd: bin,
      args: ['auth', 'login', '--claudeai'],
      pty: true,
      env: { CLAUDE_CONFIG_DIR: dir, ...NO_TOKEN_ENV },
      cwd: this.env.sessionCwd,
      parse: parseClaudeAuthLogin,
      terminalHint: hint,
      finish: async () => {
        const r = await this.env.exec.run(bin, ['auth', 'status', '--json'], {
          timeoutMs: 15_000,
          env: { CLAUDE_CONFIG_DIR: dir, ...NO_TOKEN_ENV },
        });
        let loggedIn = false;
        let email: string | undefined;
        try {
          const j = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string };
          loggedIn = j.loggedIn === true;
          email = typeof j.email === 'string' ? j.email : undefined;
        } catch {
          // not JSON: not signed in
        }
        if (!loggedIn) return { error: `Sign-in did not finish. Run ${hint} on the workstation.` };
        const acct = registry.get(key);
        acct?.auth.markOk();
        await this.env.claude.afterChange(key);
        const s = await this.status(key);
        return email ? { ...s, account: email } : s;
      },
    };
  }

  async remove(instance = ''): Promise<Outcome> {
    if (instance !== '') {
      const have = this.account(instance);
      if (!have) return this.status(instance);
      if (have.source === 'token') this.tokenStore(instance).remove();
      // a config-dir account is only unregistered: its folder and alias stay
      unregisterAccount(this.env.paths.config, instance);
      this.env.claudeAccounts?.refresh();
      await this.env.claude.afterChange(instance);
      return this.status(instance);
    }
    const removed = this.env.claudeStore.remove();
    await this.env.claude.afterChange();
    const s = await this.status();
    if (!removed && s.state === 'connected' && s.method !== 'default_login')
      return {
        error:
          'This credential is in the runner config.json, not in the secrets folder. Remove it there (or run `aom-runner auth` again).',
        code: 'unsupported',
        status: s,
      };
    return s;
  }
}
