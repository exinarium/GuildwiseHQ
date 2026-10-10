/**
 * The GitHub Codespaces REST calls we need (docs/design/cloud-workstations-and-forges.md 1.1). The user's own token
 * (scope `codespace`) acts, so the user's account pays. `fetchImpl` is injected: tests never reach GitHub.
 */
export type CodespaceState =
  | 'Unknown'
  | 'Created'
  | 'Queued'
  | 'Provisioning'
  | 'Available'
  | 'Awaiting'
  | 'Unavailable'
  | 'Deleted'
  | 'Moved'
  | 'Shutdown'
  | 'Archived'
  | 'Starting'
  | 'ShuttingDown'
  | 'Failed'
  | 'Exporting'
  | 'Updating'
  | 'Rebuilding';

export interface CodespaceInfo {
  name: string;
  state: CodespaceState | string;
  machine: string | null;
}

export class GithubError extends Error {
  constructor(
    /** `billing`: credits or the spending limit ran out; `auth`: the token no longer works; `missing`: 404. */
    readonly kind: 'billing' | 'auth' | 'missing' | 'other',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const BILLING_WORDS = /billing|spending limit|payment|quota|credits?\b|minutes|usage limit|budget|plan/i;

export interface GithubApi {
  user(token: string): Promise<{ login: string }>;
  machines(token: string, repo: string): Promise<Array<{ name: string; displayName: string }>>;
  fileExists(token: string, repo: string, path: string, ref?: string): Promise<boolean>;
  create(
    token: string,
    o: { repo: string; machine: string; ref?: string; devcontainerPath: string; idleMinutes: number },
  ): Promise<CodespaceInfo>;
  get(token: string, name: string): Promise<CodespaceInfo>;
  start(token: string, name: string): Promise<CodespaceInfo>;
  stop(token: string, name: string): Promise<CodespaceInfo>;
  remove(token: string, name: string): Promise<void>;
}

export function createGithubApi(fetchImpl: typeof fetch = fetch, base = 'https://api.github.com'): GithubApi {
  async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'guildwise-hq',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      // keep the status text
    }
    if (res.status === 401) throw new GithubError('auth', 'GitHub no longer accepts the saved token', 401);
    if (res.status === 404) throw new GithubError('missing', message, 404);
    if (res.status === 402 || ((res.status === 403 || res.status === 422) && BILLING_WORDS.test(message)))
      throw new GithubError('billing', message, res.status);
    throw new GithubError('other', message, res.status);
  }
  const info = (c: { name: string; state: string; machine?: { name?: string } | null }): CodespaceInfo => ({
    name: c.name,
    state: c.state,
    machine: c.machine?.name ?? null,
  });
  return {
    user: async (token) => ({ login: (await call<{ login: string }>(token, 'GET', '/user')).login }),
    machines: async (token, repo) =>
      (
        await call<{ machines: Array<{ name: string; display_name: string }> }>(
          token,
          'GET',
          `/repos/${repo}/codespaces/machines`,
        )
      ).machines.map((m) => ({ name: m.name, displayName: m.display_name })),
    fileExists: async (token, repo, path, ref) => {
      try {
        await call(
          token,
          'GET',
          `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
        );
        return true;
      } catch (e) {
        if (e instanceof GithubError && e.kind === 'missing') return false;
        throw e;
      }
    },
    create: async (token, o) =>
      info(
        await call(token, 'POST', `/repos/${o.repo}/codespaces`, {
          machine: o.machine,
          ...(o.ref ? { ref: o.ref } : {}),
          devcontainer_path: o.devcontainerPath,
          idle_timeout_minutes: Math.min(240, Math.max(5, o.idleMinutes)),
          retention_period_minutes: 43200,
          display_name: 'Guildwise workstation',
        }),
      ),
    get: async (token, name) =>
      info(await call(token, 'GET', `/user/codespaces/${encodeURIComponent(name)}`)),
    start: async (token, name) =>
      info(await call(token, 'POST', `/user/codespaces/${encodeURIComponent(name)}/start`)),
    stop: async (token, name) =>
      info(await call(token, 'POST', `/user/codespaces/${encodeURIComponent(name)}/stop`)),
    remove: async (token, name) => {
      await call(token, 'DELETE', `/user/codespaces/${encodeURIComponent(name)}`);
    },
  };
}
