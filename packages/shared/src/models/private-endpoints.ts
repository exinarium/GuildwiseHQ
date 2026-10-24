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

type Octets = [number, number, number, number];

/** The octets of an IPv4 literal, or undefined. */
function octets(host: string): Octets | undefined {
  const m = V4.exec(host);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return undefined;
  return o as Octets;
}

/** The eight 16-bit groups of an IPv6 literal (`::` expanded, a dotted tail converted, a zone id dropped), or undefined. */
function ipv6Groups(host: string): number[] | undefined {
  let h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (!h.includes(':')) return undefined;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) {
    const o = octets(dotted[2] as string);
    if (!o) return undefined;
    h = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return undefined;
  const part = (x: string): string[] | undefined => (x === '' ? [] : x.split(':'));
  const head = part(halves[0] as string);
  const tail = halves.length === 2 ? part(halves[1] as string) : [];
  if (!head || !tail) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const all = [...head, ...(halves.length === 2 ? Array<string>(fill).fill('0') : []), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => Number.parseInt(g, 16));
}

const v4Of = (hi: number, lo: number): Octets => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/**
 * The IPv4 address an IPv6 literal carries, when it is one of the forms that reach an IPv4 host: IPv4-mapped (::ffff:0:0/96,
 * dotted or hex), the deprecated IPv4-compatible ::/96, NAT64 (64:ff9b::/96 and 64:ff9b:1::/48), 6to4 (2002::/16) and Teredo
 * (2001::/32: the server and the obfuscated client). Every embedded address is returned, so a caller judges them all.
 */
function embeddedV4(g: number[]): Octets[] {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeros5 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeros5 && (g5 === 0xffff || g5 === 0)) return [v4Of(g6, g7)]; // mapped; compatible (incl. ::1 and ::, judged below)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return [v4Of(g6, g7)]; // SIIT ::ffff:0:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return [v4Of(g6, g7)];
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return [v4Of(g6, g7)];
  if (g0 === 0x2002) return [v4Of(g1, g2)];
  if (g0 === 0x2001 && g1 === 0) return [v4Of(g2, g3), v4Of(g6 ^ 0xffff, g7 ^ 0xffff)];
  return [];
}

export type AddrClass = 'forbidden' | 'private' | 'loopback' | 'public';

function classV4(o: Octets): AddrClass {
  const [a, b, c] = o;
  if ((a === 169 && b === 254) || a === 0 || a >= 224) return 'forbidden';
  if (a === 127) return 'loopback';
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 0)
  )
    return 'private';
  return 'public';
}

const RANK: Record<AddrClass, number> = { public: 0, private: 1, loopback: 2, forbidden: 3 };

function classV6(g: number[]): AddrClass {
  const g0 = g[0] ?? 0;
  const isZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (isZeroPrefix && g[5] === 0 && g[6] === 0 && g[7] === 0) return 'forbidden'; // ::
  if (isZeroPrefix && g[5] === 0 && g[6] === 0 && g[7] === 1) return 'loopback'; // ::1
  let worst: AddrClass = 'public';
  const bump = (c: AddrClass): void => {
    if (RANK[c] > RANK[worst]) worst = c;
  };
  if (g0 >= 0xff00)
    bump('forbidden'); // multicast
  else if ((g0 & 0xffc0) === 0xfe80)
    bump('forbidden'); // link-local
  else if ((g0 & 0xffc0) === 0xfec0)
    bump('private'); // deprecated site-local
  else if ((g0 & 0xfe00) === 0xfc00) bump('private'); // unique-local
  // 6to4, NAT64 and Teredo carry an IPv4 address through a tunnel: a worse class counts, but it is never "this machine"
  const teredo = g0 === 0x2001 && g[1] === 0;
  const tunnel = g0 === 0x2002 || g0 === 0x64 || teredo;
  for (const o of embeddedV4(g)) {
    const c = classV4(o);
    bump(tunnel && c === 'loopback' ? 'private' : c);
  }
  if (teredo) bump('private'); // a tunnel through someone else's relay: never a plain public host
  if (isZeroPrefix && g[5] === 0) bump('private'); // the IPv4-compatible ::/96 is deprecated: not a public host
  return worst;
}

/**
 * Classifies an IP literal (v4, or v6 in any notation, with the IPv4 it embeds judged too), or undefined for a name. An address
 * that embeds a worse one takes the worse class: `::ffff:7f00:1` is loopback, `::ffff:a9fe:a9fe` is forbidden (metadata).
 */
export function classifyIp(host: string): AddrClass | undefined {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const o = octets(h);
  if (o) return classV4(o);
  const g = ipv6Groups(h);
  if (!g) return undefined;
  return classV6(g);
}

/** Is this an IP literal at all (v4 or v6)? */
export const isIpLiteral = (host: string): boolean => classifyIp(host) !== undefined;

/** Link-local (169.254/16, fe80::/10), the cloud metadata names and the unspecified address: never reachable through a listing. */
export function isForbiddenEndpointHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const c = classifyIp(h);
  if (c) return c === 'forbidden';
  return (
    h === 'metadata.google.internal' ||
    h === 'metadata' ||
    h.endsWith('.metadata.google.internal') ||
    h === 'instance-data' ||
    h === 'instance-data.ec2.internal'
  );
}

/** RFC 1918, carrier-grade NAT (100.64/10), unique-local and site-local IPv6, tunnel forms of those, and loopback: not on the public internet. */
export function isPrivateEndpointHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const c = classifyIp(h);
  if (c) return c === 'private' || c === 'loopback';
  return true; // a name: it is the owner's own LAN name; the connection check refuses a name that resolves to a public address
}

/** This machine: 127/8, ::1, an IPv4-mapped form of those (`::ffff:7f00:1`), `localhost` and every `*.localhost` name. */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const c = classifyIp(h);
  if (c) return c === 'loopback';
  return h === 'localhost' || h.endsWith('.localhost');
}

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

/** The comparison form of a host: an IPv6 literal in any notation becomes its eight groups, a name its lower case. */
function hostKey(host: string): string {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const g = h.includes(':') ? ipv6Groups(h) : undefined;
  return g ? `[${g.map((x) => x.toString(16)).join(':')}]` : h;
}

/** Whether `host:port` is exactly one of the entries (an IPv6 literal matches however it is written). */
export function endpointListed(host: string, port: number, entries: readonly string[]): boolean {
  const key = `${hostKey(host)}:${port}`;
  return entries.some((e) => {
    const m = /^(.*):(\d+)$/.exec(e.toLowerCase());
    return !!m && `${hostKey(m[1] as string)}:${m[2]}` === key;
  });
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

/**
 * May an ORGANIZATION'S credential be sent to this base URL from a member's workstation? An organization admin chooses the URL, so
 * it is untrusted on someone else's machine: it must be https to a public address, or an exact entry in the workstation owner's
 * private-endpoint allow-list (any scheme, since a LAN Ollama is plain http). Loopback is NOT exempt (an admin could aim the
 * workstation's own services), link-local and metadata addresses are never allowed, listed or not. A name is judged here by its
 * spelling only (`localhost`, `*.localhost`, metadata names); the address it resolves to is judged when the connection is made.
 * Pure. The workstation's OWN credentials keep `baseUrlEndpointProblem` (loopback allowed: the owner typed it).
 */
export function orgCredentialEndpointProblem(
  rawUrl: string,
  allowList: readonly string[],
): string | undefined {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'the endpoint is not a valid URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'the endpoint must be an http or https URL';
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (isForbiddenEndpointHost(host)) return 'link-local and metadata addresses cannot be used as an endpoint';
  if (endpointListed(host, port, allowList)) return undefined;
  const cls = classifyIp(host);
  if (cls === 'private' || cls === 'loopback' || (!cls && isLoopbackHost(host)))
    return `${host}:${port} is on this machine or a private network. An organization's endpoint may reach it only when this workstation's owner lists it in the private endpoints.`;
  if (u.protocol !== 'https:')
    return `${host}:${port} is plain http. An organization's endpoint must use https unless this workstation's owner lists it in the private endpoints.`;
  return undefined;
}
