export class ForgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The forge cannot be used from this workstation (no login, CLI missing): callers fall back to "open it by hand". */
export class ForgeUnavailableError extends Error {}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** One JSON call. Non-2xx throws `ForgeHttpError` with a short, token-free message. */
export async function jsonCall<T = unknown>(f: typeof fetch, url: string, req: JsonRequest = {}): Promise<T> {
  const res = await f(url, {
    method: req.method ?? (req.body === undefined ? 'GET' : 'POST'),
    headers: {
      accept: 'application/json',
      ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...req.headers,
    },
    ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // Azure DevOps answers a bad PAT with a 203/302 and an HTML sign-in page.
  if (res.status === 203 || (res.status >= 300 && res.status < 400))
    throw new ForgeHttpError(401, 'the token was not accepted (sign-in page returned)');
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { message?: string; error?: unknown; error_description?: string };
      const e = j.error;
      msg =
        j.message ??
        j.error_description ??
        (typeof e === 'string' ? e : ((e as { message?: string } | undefined)?.message ?? msg));
    } catch {
      // keep the raw excerpt
    }
    throw new ForgeHttpError(res.status, `HTTP ${res.status}: ${String(msg).slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Credential env for git: a helper that reads the secret from the process environment (never from argv). */
export function tokenHelperEnv(host: string, user: string, token: string): Record<string, string> {
  const k = `credential.https://${host}.helper`;
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: k,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: k,
    GIT_CONFIG_VALUE_1: '!f() { echo "username=$AOM_GIT_USER"; echo "password=$AOM_GIT_TOKEN"; }; f',
    AOM_GIT_USER: user,
    AOM_GIT_TOKEN: token,
  };
}

export const isHttps = (url: string): boolean => /^https?:\/\//i.test(url);

export const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    const m = /^[^@/\s]+@([^:/\s]+):/.exec(url);
    return m ? (m[1] as string).toLowerCase() : null;
  }
};

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
