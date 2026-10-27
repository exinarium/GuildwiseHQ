import { mkdirSync } from 'node:fs';
import { defaultHost, type IntegrationScope, type IntegrationStatus } from '@aom/shared';
import { GitHubForge } from '../forge/github.ts';
import { registerSecret, unregisterSecret } from '../secrets/redact.ts';
import type { LoginSpec, ParseResult, Transcript } from './session.ts';
import { findUrl } from './terminal.ts';
import {
  type AdapterEnv,
  fromGitConnection,
  type IntegrationAdapter,
  type IntegrationFailure,
  type Outcome,
} from './types.ts';

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,198}$/;

/**
 * Matchers for `gh auth login --web` (recorded under apps/runner/test/fixtures/integrations): "First copy your one-time
 * code: XXXX-XXXX" and "Open this URL to continue in your web browser: https://github.com/login/device". No terminal needed.
 */
export function parseGhDevice(host: string) {
  return (t: Transcript): ParseResult => {
    const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(t.text)?.[1];
    const url = findUrl(t.raw, (u) => u.hostname === host);
    if (!code || !url) return {};
    return {
      awaiting: 'user',
      prompt: { url, urlHost: new URL(url).hostname, userCode: code.toUpperCase(), inputKind: 'none' },
    };
  };
}

/** GitHub through this machine's `gh` login (machine scope: shared by every pairing). */
export class GitHubIntegration implements IntegrationAdapter {
  readonly kind = 'github' as const;
  private readonly scopes = new Map<string, string[]>();

  constructor(private readonly env: AdapterEnv) {}

  scopeOf(): IntegrationScope {
    return 'machine';
  }

  private gh(): string {
    return this.env.forge.ghBin ?? 'gh';
  }

  async instances(): Promise<string[]> {
    return [...new Set([defaultHost('github'), ...(this.env.repoHosts().github ?? [])])];
  }

  async status(host: string): Promise<IntegrationStatus> {
    const c = await new GitHubForge(this.env.forge, host).status();
    const s = fromGitConnection('github', host, 'machine', c);
    const scopes = this.scopes.get(host);
    return {
      ...s,
      ...(s.state === 'connected' && !s.method ? { method: 'cli' } : {}),
      ...(s.state === 'connected' && scopes ? { scopes } : {}),
    };
  }

  /** `gh api -i user` and the scopes the token carries (the header is absent for fine-grained tokens and the web login). */
  async test(host: string): Promise<IntegrationStatus> {
    const r = await this.env.exec.run(this.gh(), ['api', '-i', '--hostname', host, 'user'], {
      timeoutMs: 30_000,
    });
    const header = /^x-oauth-scopes:\s*(.*)$/im.exec(r.stdout)?.[1];
    if (header !== undefined)
      this.scopes.set(
        host,
        header
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 50),
      );
    return this.status(host);
  }

  async connect(host: string, method: string, fields: Record<string, string>): Promise<Outcome> {
    if (method !== 'token')
      return { error: 'This method cannot be connected from here.', code: 'unsupported' };
    if (!HOST_RE.test(host)) return { error: 'That is not a host name.', code: 'failed' };
    const token = fields.token?.trim();
    if (!token) return { error: 'Nothing was entered.', code: 'failed' };
    registerSecret(token);
    try {
      const login = await this.env.exec.run(
        this.gh(),
        ['auth', 'login', '--with-token', '--hostname', host],
        {
          input: `${token}\n`,
          timeoutMs: 60_000,
        },
      );
      if (login.exitCode === 127)
        return {
          error: 'The GitHub CLI (gh) is not installed on this workstation: https://cli.github.com',
          code: 'unavailable',
        };
      if (login.exitCode !== 0)
        return {
          error: `GitHub did not accept this token. ${firstLine(login.stderr || login.stdout)}`.trim(),
          code: 'refused',
        };
      await this.env.exec.run(this.gh(), ['auth', 'setup-git', '--hostname', host], { timeoutMs: 30_000 });
      this.env.touchRecheck();
      return await this.test(host);
    } finally {
      unregisterSecret(token);
    }
  }

  async begin(host: string, method: string): Promise<LoginSpec | IntegrationFailure> {
    if (method !== 'device')
      return { error: 'This sign-in cannot be started from here.', code: 'unsupported' };
    if (!HOST_RE.test(host)) return { error: 'That is not a host name.', code: 'failed' };
    const has = await this.env.exec.run(this.gh(), ['--version'], { timeoutMs: 15_000 });
    if (has.exitCode !== 0)
      return {
        error:
          'The GitHub CLI (gh) is not installed on this workstation. Install it (https://cli.github.com), then try again.',
        code: 'unavailable',
      };
    mkdirSync(this.env.sessionCwd, { recursive: true });
    return {
      cmd: this.gh(),
      args: ['auth', 'login', '--web', '--hostname', host, '--git-protocol', 'https'],
      pty: false,
      cwd: this.env.sessionCwd,
      parse: parseGhDevice(host),
      terminalHint: `guildwise-runner git-connect github --host ${host}`,
      finish: async ({ exitCode }) => {
        if (exitCode !== 0)
          return {
            error: `The GitHub sign-in did not finish. Use the terminal: guildwise-runner git-connect github --host ${host}`,
          };
        await this.env.exec.run(this.gh(), ['auth', 'setup-git', '--hostname', host], { timeoutMs: 30_000 });
        this.env.touchRecheck();
        return this.test(host);
      },
    };
  }

  async remove(host: string): Promise<Outcome> {
    if (!HOST_RE.test(host)) return { error: 'That is not a host name.', code: 'failed' };
    const r = await this.env.exec.run(this.gh(), ['auth', 'logout', '--hostname', host], {
      timeoutMs: 30_000,
    });
    this.scopes.delete(host);
    this.env.touchRecheck();
    const s = await this.status(host);
    if (r.exitCode !== 0 && s.state === 'connected')
      return {
        error: `The GitHub CLI could not sign out (${firstLine(r.stderr || r.stdout)}). Run \`gh auth logout --hostname ${host}\` on the workstation.`,
        code: 'failed',
        status: s,
      };
    return s;
  }
}

export const firstLine = (t: string): string =>
  (t.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 160);
