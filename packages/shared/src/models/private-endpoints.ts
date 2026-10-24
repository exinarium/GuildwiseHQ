import { z } from 'zod';

/**
 * The private-endpoint allow-list of a workstation (docs/ARCHITECTURE.md section 38.5, R2): specific `host:port` entries on a
 * private network (a LAN Ollama or LM Studio) that this workstation's agents' sandboxes and its direct-model runtime may reach.
 * Off by default (empty). An entry is exact: one host (a name or an IP) and one port, never a range or a wildcard. Loopback (this
 * machine) needs no entry, as before. Link-local and metadata addresses can never be listed.
 */
export const PRIVATE_ENDPOINTS_CAPABILITY = 'private-endpoints:1';
export const PRIVATE_ENDPOINTS_MAX = 20;

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The octets of an IPv4 literal, or undefined. */
function octets(host: string): [number, number, number, number] | undefined {
  const m = V4.exec(host);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return undefined;
  return o as [number, number, number, number];
}

/** Link-local (169.254/16, fe80::/10), the cloud metadata names and the unspecified address: never reachable through a listing. */
export function isForbiddenEndpointHost(host: string): boolean {
  const h = host.toLowerCase();
  const o = octets(h);
  if (o) return (o[0] === 169 && o[1] === 254) || o.every((n) => n === 0) || o[0] >= 224;
  return (
    h === '::' ||
    h.startsWith('fe8') ||
    h.startsWith('fe9') ||
    h.startsWith('fea') ||
    h.startsWith('feb') ||
    h.startsWith('ff') ||
    h === 'metadata.google.internal' ||
    h === 'metadata' ||
    h.endsWith('.metadata.google.internal')
  );
}

/** RFC 1918, carrier-grade NAT (100.64/10), unique-local IPv6 (fc00::/7) and loopback: an address that is not on the public internet. */
export function isPrivateEndpointHost(host: string): boolean {
  const h = host.toLowerCase();
  const o = octets(h);
  if (o)
    return (
      o[0] === 10 ||
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
      o[0] === 127
    );
  if (h.includes(':')) return /^f[cd]/.test(h) || h === '::1';
  return true; // a name: it is the owner's own LAN name; the connection check refuses a name that resolves to a public address
}

export const isLoopbackHost = (host: string): boolean =>
  /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i.test(host) || host.toLowerCase().endsWith('.localhost');

/**
 * Parses one entry (`192.168.1.12:11434`, `studio.lan:1234`, `[fd00::5]:8080`) into its exact form, or says why not. Pure.
 */
export function parsePrivateEndpoint(
  raw: string,
): { ok: true; entry: string; host: string; port: number } | { ok: false; error: string } {
  const s = raw.trim().toLowerCase();
  const m = /^\[([0-9a-f:]+)\]:(\d{1,5})$/.exec(s) ?? /^([a-z0-9][a-z0-9.-]*):(\d{1,5})$/.exec(s);
  if (!m?.[1] || !m[2]) {
    if (/[*/]/.test(s))
      return { ok: false, error: 'enter one exact host:port: no wildcards, ranges or paths' };
    return { ok: false, error: 'enter it as host:port, for example 192.168.1.12:11434' };
  }
  const host = m[1];
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { ok: false, error: 'the port is 1 to 65535' };
  if (host.endsWith('.') || host.includes('..')) return { ok: false, error: 'that is not a valid host name' };
  if (isForbiddenEndpointHost(host))
    return { ok: false, error: 'link-local, metadata and unspecified addresses can never be listed' };
  if (octets(host) === undefined && /^[\d.]+$/.test(host))
    return { ok: false, error: 'that is not a valid IP address' };
  if (!isPrivateEndpointHost(host))
    return {
      ok: false,
      error: 'only private-network addresses can be listed: a public address needs no entry',
    };
  return { ok: true, entry: host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`, host, port };
}

/** Normalizes a list: every entry parsed, duplicates removed. The first problem is returned. */
export function normalizePrivateEndpoints(
  list: readonly string[],
): { ok: true; entries: string[] } | { ok: false; error: string } {
  const out: string[] = [];
  for (const raw of list) {
    const p = parsePrivateEndpoint(raw);
    if (!p.ok) return { ok: false, error: `${raw.trim().slice(0, 80)}: ${p.error}` };
    if (!out.includes(p.entry)) out.push(p.entry);
  }
  if (out.length > PRIVATE_ENDPOINTS_MAX)
    return { ok: false, error: `at most ${PRIVATE_ENDPOINTS_MAX} entries` };
  return { ok: true, entries: out };
}

/** Whether `host:port` is exactly one of the entries. */
export function endpointListed(host: string, port: number, entries: readonly string[]): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const key = h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
  return entries.includes(key);
}

/**
 * May an OpenAI-compatible base URL point here? Public hosts and this machine: yes. A private-network IP literal: only when the
 * workstation owner listed that exact host:port. Link-local and metadata: never. (A name that resolves to a private address is
 * checked when the connection is made, in the egress proxy.) Pure.
 */
export function baseUrlEndpointProblem(rawUrl: string, entries: readonly string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return undefined; // the URL check reports it
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(u.hostname)) return undefined;
  if (isForbiddenEndpointHost(host)) return 'link-local and metadata addresses cannot be used as an endpoint';
  const literal = octets(host) !== undefined || host.includes(':');
  if (literal && isPrivateEndpointHost(host)) {
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!endpointListed(host, port, entries))
      return `${host}:${port} is on a private network. Add it to this workstation's private endpoints first.`;
  }
  return undefined;
}

/** `PUT /api/workstations/:id/private-endpoints` and the `provider.endpoints.set` command payload. */
export const PrivateEndpointsSetSchema = z.object({
  endpoints: z.array(z.string().min(1).max(120)).max(PRIVATE_ENDPOINTS_MAX),
});
export type PrivateEndpointsSet = z.infer<typeof PrivateEndpointsSetSchema>;
