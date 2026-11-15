import {
  APP_ERROR_TEXT,
  type AppAccessCheckPayload,
  type AppAccessCheckResult,
  AppAccessCheckResultSchema,
  type AppErrorCode,
  CommandPayloadSchemas,
} from '@aom/shared';
import { type AppTokenProbe, appReason } from '../git/identity.ts';
import type { AppKeyStore } from './store.ts';
import { AppTokenError, type AppAccessScope } from './types.ts';

/** The part of the token broker the check needs. */
export interface AccessCheckBroker {
  readonly store: Pick<AppKeyStore, 'get'>;
  getAccessToken(instance: string, scope?: AppAccessScope): Promise<unknown>;
  withToken<T>(
    instance: string,
    scope: AppAccessScope | undefined,
    fn: (token: string) => Promise<T & { status?: number }>,
  ): Promise<T>;
}

/** `github.com/owner/name` -> host and lower-cased `owner/name`. */
export function splitRemote(remoteUrlNormalized: string): { host: string; fullName: string } | null {
  const parts = remoteUrlNormalized
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 3) return null;
  const host = (parts[0] ?? '').toLowerCase();
  return { host, fullName: parts.slice(-2).join('/').toLowerCase() };
}

const apiBase = (host: string): string =>
  host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;

const MAX_PAGES = 50;

/**
 * `app.access_check`: which of a project's repositories the app's installation can reach. Lists the installation's
 * repositories with a read-only token and matches host and `owner/name`. The answer carries states and value-free
 * reasons only (the result schema is strict); the token never leaves this function.
 */
export async function checkAppAccess(
  broker: AccessCheckBroker,
  rawPayload: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<AppAccessCheckResult> {
  const p: AppAccessCheckPayload = CommandPayloadSchemas['app.access_check'].parse(rawPayload);
  const allError = (code: AppErrorCode, detail: string): AppAccessCheckResult =>
    AppAccessCheckResultSchema.parse({
      repos: p.repos.map((r) => ({ repoId: r.repoId, state: 'error', code, detail })),
    });
  const stored = p.instance ? broker.store.get(p.instance) : undefined;
  if (!stored) return allError('installation_not_found', 'This app is not connected on this workstation.');
  if (!stored.refs.some((r) => r.integrationId === p.integrationId))
    return allError('app_mismatch', APP_ERROR_TEXT.app_mismatch);

  const names = new Set<string>();
  try {
    await broker.withToken(p.instance, { permissions: { metadata: 'read' } }, async (token) => {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetchFn(`${apiBase(p.host)}/installation/repositories?per_page=100&page=${page}`, {
          headers: { authorization: `token ${token}`, accept: 'application/vnd.github+json' },
        });
        if (res.status === 401) return { status: 401 };
        if (!res.ok)
          throw new AppTokenError(res.status === 403 ? 'permission_missing' : 'unexpected', 'listing failed');
        const body = (await res.json()) as { repositories?: Array<{ full_name?: string }> };
        const list = body.repositories ?? [];
        for (const r of list) if (r.full_name) names.add(r.full_name.toLowerCase());
        if (list.length < 100) break;
      }
      return {};
    });
  } catch (err) {
    const reason = appReason(err);
    const code = err instanceof AppTokenError ? err.code : 'unexpected';
    return allError(code, reason);
  }

  const host = p.host.toLowerCase();
  return AppAccessCheckResultSchema.parse({
    repos: p.repos.map((r) => {
      const remote = splitRemote(r.remoteUrlNormalized);
      const covered = !!remote && remote.host === host && names.has(remote.fullName);
      return { repoId: r.repoId, state: covered ? 'covered' : 'not_covered' };
    }),
  });
}

/**
 * The shift-time check behind the 'app' identity: the stored copy must belong to the selected registration (a stale or
 * foreign copy is refused, never used) and a token scoped to the repository must mint. The token stays in the broker's
 * memory cache; it is never returned.
 */
export function appTokenProbe(broker: AccessCheckBroker): AppTokenProbe {
  return {
    ensure: async ({ instance, integrationId }, repoName) => {
      const stored = broker.store.get(instance);
      if (!stored)
        throw new AppTokenError('installation_not_found', 'This app is not connected on this workstation.');
      if (!stored.refs.some((r) => r.integrationId === integrationId))
        throw new AppTokenError('app_mismatch', APP_ERROR_TEXT.app_mismatch);
      // GitHub scopes an installation token by repository name (without the owner).
      const name = repoName.split('/').pop() ?? repoName;
      await broker.getAccessToken(instance, { repositories: [name] });
    },
  };
}
