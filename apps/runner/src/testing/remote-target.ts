/**
 * Remote targets for the tester (docs/design/run-and-integration-tests.md D7): a deployed environment the tester tests
 * without the runner starting anything. The sandbox allows exactly the target's hostnames (plus the package registries
 * every shell role has); the sandbox filters hostnames, not ports.
 */

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The hostname of a URL or `host[:port]` string, lower-cased; null when it is not a plain hostname or IP address. */
export function hostnameOf(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '*' || host.includes('*')) return null;
  return HOSTNAME.test(host) || /^[0-9a-f:]+$/.test(host) ? host : null;
}

/** Every hostname the tester's shell may reach for the target: its URL and the extra hosts it declares. */
export function targetHosts(target: { url: string; hosts?: readonly string[] }): string[] {
  const out = new Set<string>();
  for (const v of [target.url, ...(target.hosts ?? [])]) {
    const h = hostnameOf(v);
    if (h) out.add(h);
  }
  return [...out];
}

/**
 * Does the target answer? Any HTTP answer below 500 counts (a login page answers 401); a refused connection, a timeout
 * and a gateway error (502, 503, 504) do not. Returns the reason, or null when it answers.
 */
export async function probeTargetUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if ([502, 503, 504].includes(res.status)) return `${url} answered ${res.status}`;
    return null;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `${url}: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}`;
  }
}
