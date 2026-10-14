import { mkdirSync } from 'node:fs';
import type { IntegrationScope, IntegrationStatus } from '@aom/shared';
import type { PluginMcpServer } from '../mcp/plugins.ts';
import type { LoginSpec, ParseResult, Transcript } from './session.ts';
import { findUrl, isPublicHost } from './terminal.ts';
import {
  type AdapterEnv,
  baseStatus,
  type IntegrationAdapter,
  type IntegrationFailure,
  type Outcome,
} from './types.ts';

/**
 * Matchers for `claude mcp login <key> --no-browser` (recorded under apps/runner/test/fixtures/integrations): it prints
 * "Visit this URL to authorize:" and the link (also as an OSC 8 hyperlink), then "Or paste the redirect URL here:". A
 * wrong address gets "That doesn't look like a redirect URL for this sign-in" and the prompt again. The CLI also listens
 * on localhost, so a browser on the workstation itself finishes the sign-in without a paste.
 */
export function parseMcpLogin(t: Transcript): ParseResult {
  const url = findUrl(t.raw, (u) => isPublicHost(u.hostname));
  if (!url) return {};
  const waiting = /paste the redirect URL here/i.test(t.text);
  const retry = /doesn'?t look like a redirect URL|does not match|invalid redirect/i.test(t.sinceInput);
  if (
    /authentication failed|failed to authenticate|authorization (?:was )?denied|access_denied/i.test(
      t.sinceInput,
    )
  )
    return { failed: 'The provider refused the sign-in. Start it again.' };
  return {
    awaiting: waiting ? 'code' : 'user',
    ...(retry
      ? {
          retry:
            'That address did not match this sign-in. Copy the whole address from the page you landed on (it starts with http://localhost) and paste it again.',
        }
      : {}),
    prompt: {
      url,
      urlHost: new URL(url).hostname,
      inputKind: 'redirect_url',
      inputLabel: 'The address you landed on (starts with http://localhost)',
    },
  };
}

/** The tile instance of a plugin server is its tool-prefix name (`plugin_atlassian_atlassian`). */
export class McpIntegration implements IntegrationAdapter {
  readonly kind = 'mcp' as const;

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(): IntegrationScope {
    return 'machine';
  }

  private server(instance: string): PluginMcpServer | undefined {
    return this.env.mcp.discover().find((s) => s.name === instance);
  }

  async instances(): Promise<string[]> {
    return this.env.mcp.discover().map((s) => s.name);
  }

  async status(instance: string): Promise<IntegrationStatus> {
    const now = this.env.now();
    const s = this.server(instance);
    if (!s)
      return baseStatus('mcp', instance, 'machine', now, 'unavailable', {
        detail: 'This server is not installed or its plugin is disabled on this workstation.',
      });
    let host: string | undefined;
    if (typeof s.config.url === 'string') {
      try {
        host = new URL(s.config.url).hostname;
      } catch {
        host = undefined;
      }
    }
    const auth = this.env.mcp.authOf()(s);
    const state =
      auth === 'signed_in' ? 'connected' : auth === 'needs_sign_in' ? 'needs_sign_in' : 'not_needed';
    return baseStatus('mcp', instance, 'machine', now, state, {
      ...(state === 'connected' ? { method: 'oauth' } : {}),
      ...(host ? { site: host } : {}),
      ...(state === 'needs_sign_in'
        ? { detail: `${s.server} needs a sign-in before agents can use its tools.` }
        : state === 'not_needed'
          ? { detail: 'This server needs no sign-in (local, or it carries its own credentials).' }
          : {}),
    });
  }

  test(instance: string): Promise<IntegrationStatus> {
    return this.status(instance);
  }

  async begin(instance: string, method: string): Promise<LoginSpec | IntegrationFailure> {
    if (method !== 'oauth_paste')
      return { error: 'This sign-in cannot be started from here.', code: 'unsupported' };
    const s = this.server(instance);
    if (!s) return { error: 'This server is not installed on this workstation.', code: 'unavailable' };
    if (s.transport === 'stdio')
      return { error: 'This is a local server: it needs no sign-in.', code: 'unsupported' };
    mkdirSync(this.env.sessionCwd, { recursive: true });
    const key = s.key;
    return {
      cmd: this.env.claude.bin(),
      args: ['mcp', 'login', key, '--no-browser'],
      pty: true,
      cwd: this.env.sessionCwd,
      parse: parseMcpLogin,
      terminalHint: `claude mcp login ${key} --no-browser   (or: claude, /mcp, Authenticate)`,
      finish: async ({ exitCode }) => {
        const st = await this.status(instance);
        if (st.state === 'connected') return st;
        return {
          error:
            exitCode === 0
              ? `The sign-in finished but Claude Code stored no sign-in for ${s.server}. On the workstation run \`claude\`, then \`/mcp\`, choose ${s.server}, Authenticate.`
              : `The sign-in did not finish. On the workstation run \`claude\`, then \`/mcp\`, choose ${s.server}, Authenticate.`,
        };
      },
    };
  }

  async remove(instance: string): Promise<Outcome> {
    const s = this.server(instance);
    if (!s) return { error: 'This server is not installed on this workstation.', code: 'unavailable' };
    const r = await this.env.exec.run(this.env.claude.bin(), ['mcp', 'logout', s.key], { timeoutMs: 30_000 });
    if (r.exitCode !== 0)
      return {
        error: `Claude Code could not sign out of ${s.server}. Run \`claude mcp logout ${s.key}\` on the workstation.`,
        code: 'failed',
      };
    return this.status(instance);
  }
}
