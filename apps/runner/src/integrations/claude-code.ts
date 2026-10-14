import { mkdirSync } from 'node:fs';
import type { IntegrationScope, IntegrationStatus } from '@aom/shared';
import { resolveClaudeCredential, SETUP_TOKEN_DAYS } from './claude-store.ts';
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

export class ClaudeCodeIntegration implements IntegrationAdapter {
  readonly kind = 'claude-code' as const;

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(method?: string): IntegrationScope {
    return method === 'default_login' ? 'machine' : 'workstation';
  }

  async instances(): Promise<string[]> {
    return [''];
  }

  private credential() {
    return resolveClaudeCredential(this.env.claudeStore, this.env.config().runtimes['claude-code']);
  }

  async status(): Promise<IntegrationStatus> {
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

  async test(): Promise<IntegrationStatus> {
    const r = await this.env.claude.probeLogin();
    const s = await this.status();
    if (r === 'expired')
      return { ...s, state: 'expired', detail: 'Claude rejected the login. Sign in again.' };
    if (r === 'unknown')
      return {
        ...s,
        detail: 'Could not reach Claude to check the login (offline, or Claude Code is missing).',
      };
    return s.state === 'connected' ? s : { ...s, state: 'connected' };
  }

  async connect(_instance: string, method: string, fields: Record<string, string>): Promise<Outcome> {
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
    this.env.claudeStore.save(
      method === 'api_key'
        ? { authMode: 'api_key', apiKey: value, via: 'web', method }
        : { authMode: 'oauth', oauthToken: value, via: 'web', method },
    );
    await this.env.claude.afterChange();
    const s = await this.status();
    return probe === 'unknown'
      ? {
          ...s,
          detail: 'Saved, but Claude could not be reached to check it. Use Test when the machine is online.',
        }
      : s;
  }

  async begin(_instance: string, method: string): Promise<LoginSpec | IntegrationFailure> {
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
        this.env.claudeStore.save({
          authMode: 'oauth',
          oauthToken: token,
          via: 'web',
          method: 'setup_token',
        });
        await this.env.claude.afterChange();
        return this.status();
      },
    };
  }

  async remove(): Promise<Outcome> {
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
