import { fromHttp } from './errors.ts';
import { type FetchLike, StorageError } from './types.ts';

/** A token for an OAuth connector. `force` asks for a fresh one after a 401. */
export type TokenFn = (force: boolean) => Promise<string>;

/** One call with a bearer token, one retry after a 401 with a refreshed token, and typed errors. */
export async function authed(
  fetchFn: FetchLike,
  kind: 'onedrive' | 'google_drive',
  token: TokenFn,
  url: string,
  init: RequestInit & { headers?: Record<string, string> },
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(attempt > 0);
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` }, signal });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw new StorageError('timeout', 'The storage did not answer in time.');
      throw new StorageError('unavailable', 'The storage could not be reached.');
    }
    if (res.status === 401 && attempt === 0) {
      await res.arrayBuffer().catch(() => undefined);
      continue;
    }
    if (res.ok || res.status === 404 || res.status === 409) return res;
    throw await httpError(kind, res);
  }
  throw new StorageError('auth_expired', 'The sign-in expired: reconnect this storage.');
}

export async function httpError(kind: 'onedrive' | 'google_drive', res: Response): Promise<StorageError> {
  let code: string | undefined;
  try {
    const j = (await res.json()) as {
      error?: { code?: string; errors?: Array<{ reason?: string }> } | string;
    };
    if (typeof j.error === 'object') code = j.error?.errors?.[0]?.reason ?? j.error?.code;
  } catch {
    // no JSON body
  }
  return fromHttp(kind, res.status, code);
}
