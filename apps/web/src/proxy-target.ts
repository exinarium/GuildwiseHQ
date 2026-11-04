/** Where the dev/preview proxy sends API calls when nothing is configured. */
export const DEFAULT_API_PROXY_TARGET = 'http://127.0.0.1:4600';

export type ProxyTarget = { target: string; headers?: { Origin: string } };

const toOrigin = (name: string, value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http(s) origin such as http://localhost:4600, got "${value}"`);
  }
  const bare =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname !== '' &&
    !url.username &&
    !url.password &&
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash;
  if (!bare)
    throw new Error(
      `${name} must be an http(s) origin (scheme, host, port; no path, query or credentials) such as http://localhost:4600, got "${value}"`,
    );
  return url.origin;
};

/**
 * API_PROXY_TARGET sets the proxy target only. The legacy AOM_API_TARGET (screenshot harness) also rewrites Origin to the
 * target. Neither is exposed to client code.
 */
export const resolveProxyTarget = (env: Record<string, string | undefined>): ProxyTarget => {
  const primary = env.API_PROXY_TARGET?.trim();
  if (primary) return { target: toOrigin('API_PROXY_TARGET', primary) };
  const legacy = env.AOM_API_TARGET?.trim();
  if (legacy) {
    const target = toOrigin('AOM_API_TARGET', legacy);
    return { target, headers: { Origin: target } };
  }
  return { target: DEFAULT_API_PROXY_TARGET };
};
