import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { type AppIdentity, type AppInstallation, missingAppPermissions } from '@aom/shared';
import { redact, registerSecret, unregisterSecret } from '../secrets/redact.ts';
import {
  type AppAccessScope,
  type AppAccessToken,
  type AppConnectInput,
  type AppProviderDeps,
  type AppProviderFactory,
  AppTokenError,
  type AutomatedAppProvider,
} from './types.ts';

/**
 * A GitHub App installation (REST API 2022-11-28). The app JWT is signed RS256 with the sealed private key; installation
 * tokens are minted with it. GitHub's response shapes stay private to this file: callers see the generic types only.
 */

const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;
/** GitHub refuses an app JWT that lives longer than 10 minutes: iat is backdated 60 s, exp is 540 s ahead. */
export const JWT_BACKDATE_S = 60;
export const JWT_AHEAD_S = 540;

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Reads a PKCS#1 or PKCS#8 PEM. Refuses anything but RSA of 2048 bits or more. The message never quotes the key. */
export function parseAppPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.trim());
  } catch {
    throw new AppTokenError('key_invalid', 'The private key could not be read as a PEM file.');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== 'rsa' || bits < 2048)
    throw new AppTokenError('key_invalid', 'The private key must be an RSA key of 2048 bits or more.');
  return key;
}

/** The app JWT: `{ iat: now - 60, exp: now + 540, iss }`. A numeric App ID goes in as a number, a client ID as a string. */
export function signAppJwt(appRef: string, key: KeyObject, nowSec: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iss: string | number = /^\d+$/.test(appRef) ? Number(appRef) : appRef;
  const claims = { iat: nowSec - JWT_BACKDATE_S, exp: nowSec + JWT_AHEAD_S, iss };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = createSign('RSA-SHA256').update(input).end().sign(key);
  return `${input}.${b64url(sig)}`;
}

export const githubApiBase = (host: string): string =>
  !host || host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;

const noreplyHost = (host: string): string =>
  !host || host === 'github.com' ? 'users.noreply.github.com' : `users.noreply.${host}`;

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

type Phase = 'app' | 'installation' | 'installations' | 'mint' | 'user';

const messageOf = (a: Answer): string =>
  redact(typeof a.body.message === 'string' ? a.body.message : '').slice(0, 160);

/** Maps one GitHub answer to a typed error (exported for the tests). */
export function classifyGitHubError(a: Answer, phase: Phase): AppTokenError {
  const msg = messageOf(a);
  const suffix = msg ? ` (GitHub: ${msg})` : '';
  const remaining = a.headers.get('x-ratelimit-remaining');
  const retryAfter = a.headers.get('retry-after');
  const reset = a.headers.get('x-ratelimit-reset');
  if (a.status === 429 || ((a.status === 403 || a.status === 429) && (remaining === '0' || retryAfter))) {
    const retryAfterMs = retryAfter
      ? Number(retryAfter) * 1000
      : reset
        ? Math.max(0, Number(reset) * 1000 - Date.now())
        : 60_000;
    return new AppTokenError('rate_limited', `GitHub rate-limited this app.${suffix}`, {
      status: a.status,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 60_000,
    });
  }
  if (a.status >= 500) return new AppTokenError('unreachable', `GitHub answered ${a.status}.`, { status: a.status });
  if (a.status === 401) {
    if (phase === 'user') return new AppTokenError('token_rejected', `GitHub refused the access token.${suffix}`, { status: 401 });
    return new AppTokenError('jwt_rejected', `GitHub refused the app key or App ID.${suffix}`, { status: 401 });
  }
  if (a.status === 404) {
    if (phase === 'app') return new AppTokenError('app_not_found', `No app was found for this App ID.${suffix}`, { status: 404 });
    if (phase === 'installation' || phase === 'mint')
      return new AppTokenError('installation_not_found', `The app is not installed there any more.${suffix}`, { status: 404 });
  }
  if (a.status === 403 && /suspend/i.test(msg))
    return new AppTokenError('installation_suspended', `The installation is suspended.${suffix}`, { status: 403 });
  if ((a.status === 403 || a.status === 422) && phase === 'mint') {
    if (/repositor/i.test(msg))
      return new AppTokenError('repository_not_accessible', `The installation cannot reach a repository asked for.${suffix}`, { status: a.status });
    return new AppTokenError('permission_missing', `The installation does not grant a permission asked for.${suffix}`, { status: a.status });
  }
  return new AppTokenError('unexpected', `GitHub answered ${a.status}.${suffix}`, { status: a.status });
}

const isSkewMessage = (msg: string): boolean => /\b(exp|iat)\b|expir|issued at|too far/i.test(msg);

class GitHubAppProvider implements AutomatedAppProvider {
  readonly provider = 'github-app' as const;
  private readonly key: KeyObject;
  /** Server time minus local time, learned from a skew refusal. */
  private skewMs = 0;

  constructor(
    private readonly cfg: AppConnectInput & { identity?: AppIdentity },
    private readonly deps: AppProviderDeps,
  ) {
    this.key = parseAppPrivateKey(cfg.privateKey);
  }

  describe(): AppIdentity {
    if (!this.cfg.identity) throw new AppTokenError('unexpected', 'This app has not been verified yet.');
    return this.cfg.identity;
  }

  private jwt(): string {
    const nowSec = Math.floor((this.deps.now() + this.skewMs) / 1000);
    const t = signAppJwt(this.cfg.appRef, this.key, nowSec);
    registerSecret(t);
    return t;
  }

  private async call(
    path: string,
    auth: { jwt: true } | { token: string },
    init: { method?: string; body?: unknown } = {},
  ): Promise<Answer> {
    const authz = 'jwt' in auth ? this.jwt() : auth.token;
    try {
      let res: Response;
      try {
        res = await this.deps.fetch(`${githubApiBase(this.cfg.host)}${path}`, {
          method: init.method ?? 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': API_VERSION,
            'User-Agent': 'guildwise-runner',
            Authorization: `Bearer ${authz}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new AppTokenError('unreachable', 'GitHub could not be reached.');
      }
      let body: Record<string, unknown> = {};
      try {
        const j = (await res.json()) as unknown;
        if (j && typeof j === 'object') body = j as Record<string, unknown>;
      } catch {
        body = {};
      }
      return { status: res.status, body, headers: res.headers };
    } finally {
      if ('jwt' in auth) unregisterSecret(authz);
    }
  }

  /** A JWT call, with one re-sign after a clock skew refusal (using GitHub's Date header). */
  private async jwtCall(path: string, phase: Phase, init: { method?: string; body?: unknown } = {}): Promise<Answer> {
    let a = await this.call(path, { jwt: true }, init);
    if (a.status === 401 && isSkewMessage(messageOf(a))) {
      const date = Date.parse(a.headers.get('date') ?? '');
      if (Number.isFinite(date)) this.skewMs = date - this.deps.now();
      a = await this.call(path, { jwt: true }, init);
      if (a.status === 401 && isSkewMessage(messageOf(a))) {
        const minutes = Math.max(1, Math.round(Math.abs(this.skewMs) / 60_000));
        throw new AppTokenError(
          'clock_skew',
          `This workstation's clock is off by about ${minutes} minutes; fix the system time.`,
          { status: 401 },
        );
      }
    }
    if (a.status >= 300) throw classifyGitHubError(a, phase);
    return a;
  }

  private requireInstallation(): string {
    if (!this.cfg.installationId)
      throw new AppTokenError('choose_installation', 'No installation was chosen for this app.');
    return this.cfg.installationId;
  }

  async status(): Promise<{ suspended: boolean }> {
    const a = await this.jwtCall(`/app/installations/${this.requireInstallation()}`, 'installation');
    return { suspended: !!a.body.suspended_at };
  }

  async mint(scope: AppAccessScope): Promise<AppAccessToken> {
    const id = this.requireInstallation();
    const body: Record<string, unknown> = {};
    if (scope.repositories?.length) body.repositories = scope.repositories;
    if (scope.permissions && Object.keys(scope.permissions).length) body.permissions = scope.permissions;
    const a = await this.jwtCall(`/app/installations/${id}/access_tokens`, 'mint', {
      method: 'POST',
      body,
    });
    const token = typeof a.body.token === 'string' ? a.body.token : '';
    const expiresAt = Date.parse(typeof a.body.expires_at === 'string' ? a.body.expires_at : '');
    if (!token || !Number.isFinite(expiresAt))
      throw new AppTokenError('unexpected', 'GitHub did not return an access token.');
    registerSecret(token);
    return { token, expiresAt };
  }

  async verify(): Promise<AppIdentity> {
    const app = (await this.jwtCall('/app', 'app')).body;
    const appId = String(app.id ?? '');
    const appSlug = String(app.slug ?? '');
    if (!appId || !appSlug) throw new AppTokenError('unexpected', 'GitHub did not describe the app.');
    const inst = await this.jwtCall(`/app/installations/${this.requireInstallation()}`, 'installation');
    if (inst.body.suspended_at)
      throw new AppTokenError('installation_suspended', 'The installation of this app is suspended.');
    const account = (inst.body.account ?? {}) as Record<string, unknown>;
    const granted = (inst.body.permissions ?? {}) as Record<string, string>;
    const permissions: Record<string, 'read' | 'write'> = {};
    for (const [k, v] of Object.entries(granted))
      if (/^[a-z_]{1,40}$/.test(k) && (v === 'read' || v === 'write' || v === 'admin'))
        permissions[k] = v === 'read' ? 'read' : 'write';
    const test = await this.mint({ permissions: { metadata: 'read' } });
    try {
      const login = `${appSlug}[bot]`;
      const u = await this.call(`/users/${encodeURIComponent(login)}`, { token: test.token });
      if (u.status >= 300) throw classifyGitHubError(u, 'user');
      const botUserId = String(u.body.id ?? '');
      if (!botUserId) throw new AppTokenError('unexpected', 'GitHub did not return the bot user.');
      const selection = inst.body.repository_selection;
      return {
        provider: 'github-app',
        host: this.cfg.host || 'github.com',
        appId,
        appSlug,
        appName: String(app.name ?? appSlug).slice(0, 200),
        installationId: this.requireInstallation(),
        account: String(account.login ?? '').slice(0, 200),
        ...(typeof account.type === 'string' ? { accountType: account.type.slice(0, 40) } : {}),
        ...(selection === 'all' || selection === 'selected' ? { repositorySelection: selection } : {}),
        botLogin: login,
        botUserId,
        commitName: login,
        commitEmail: `${botUserId}+${login}@${noreplyHost(this.cfg.host)}`,
        permissions,
        missingPermissions: missingAppPermissions(granted),
      };
    } finally {
      unregisterSecret(test.token);
    }
  }

  /** GET /app/installations answers with an array; `call` keeps objects only, so this reads it separately. */
  async listInstallations(): Promise<AppInstallation[]> {
    const nowSec = Math.floor((this.deps.now() + this.skewMs) / 1000);
    const jwt = signAppJwt(this.cfg.appRef, this.key, nowSec);
    registerSecret(jwt);
    let res: Response;
    try {
      res = await this.deps.fetch(`${githubApiBase(this.cfg.host)}/app/installations?per_page=100`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'guildwise-runner',
          Authorization: `Bearer ${jwt}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppTokenError('unreachable', 'GitHub could not be reached.');
    } finally {
      unregisterSecret(jwt);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.status >= 300) {
      const body = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
      throw classifyGitHubError({ status: res.status, body, headers: res.headers }, 'installations');
    }
    if (!Array.isArray(json)) throw new AppTokenError('unexpected', 'GitHub did not list the installations.');
    return json.slice(0, 100).map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const acc = (i.account ?? {}) as Record<string, unknown>;
      return {
        id: String(i.id ?? ''),
        account: String(acc.login ?? '').slice(0, 200),
        ...(typeof acc.type === 'string' ? { accountType: acc.type.slice(0, 40) } : {}),
        suspended: !!i.suspended_at,
      };
    });
  }
}

export const githubAppFactory: AppProviderFactory = {
  provider: 'github-app',
  create: (cfg, deps) => new GitHubAppProvider(cfg, deps),
  installations: (input, deps) => new GitHubAppProvider(input, deps).listInstallations(),
};
