import { isIP } from 'node:net';

/**
 * Which peers may set `X-Forwarded-For` (`AOM_TRUST_PROXY`). The resolved client address (`req.ip`) feeds every
 * per-address limit, so trusting too much lets a client choose its own address.
 */
export type TrustProxy =
  | { kind: 'off' }
  | { kind: 'all' }
  | { kind: 'hops'; hops: number }
  | { kind: 'addresses'; addresses: string[]; isDefault?: boolean };

const LOOPBACK = ['127.0.0.0/8', '::1/128'];

/** Unset: trust a reverse proxy on the same host only. */
export const TRUST_PROXY_DEFAULT: TrustProxy = { kind: 'addresses', addresses: LOOPBACK, isDefault: true };

export const TRUST_PROXY_MAX_HOPS = 32;

const NAMED: Record<string, string[]> = {
  loopback: LOOPBACK,
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

const FORMS =
  'Use false (or 0, none) to never trust X-Forwarded-For, a hop count from 1 to 32, a comma-separated list of ' +
  'IP addresses or CIDR ranges (IPv4 or IPv6; the names loopback, linklocal and uniquelocal are accepted), ' +
  'or true to trust every hop (not recommended). Unset trusts loopback only.';

/** Parses `AOM_TRUST_PROXY`. Throws an Error naming the variable and the accepted forms; never falls back to trusting all. */
export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const v = (raw ?? '').trim();
  if (!v) return TRUST_PROXY_DEFAULT;
  const bad = (why: string): never => {
    throw new Error(`AOM_TRUST_PROXY: "${v}" ${why}. ${FORMS}`);
  };
  const lower = v.toLowerCase();
  if (lower === 'false' || lower === '0' || lower === 'none') return { kind: 'off' };
  if (lower === 'true') return { kind: 'all' };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n < 1 || n > TRUST_PROXY_MAX_HOPS) bad('is out of range for a hop count');
    return { kind: 'hops', hops: n };
  }
  const out: string[] = [];
  const add = (a: string) => {
    if (!out.includes(a)) out.push(a);
  };
  for (const part of v.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const named = NAMED[p.toLowerCase()];
    if (named) {
      named.forEach(add);
      continue;
    }
    const pieces = p.split('/');
    const [addr, prefix] = pieces;
    const family = addr && !addr.includes('%') ? isIP(addr) : 0;
    if (!family || pieces.length > 2) bad(`has an entry that is not an IP address or CIDR range: "${p}"`);
    if (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
      bad(`has an invalid CIDR prefix: "${p}"`);
    add(prefix === undefined ? addr! : `${addr}/${Number(prefix)}`);
  }
  if (!out.length) bad('has no address in it');
  return { kind: 'addresses', addresses: out };
}

export type FastifyTrustProxy = boolean | string[] | ((addr: string, hop: number) => boolean);

/**
 * What to pass as Fastify's `trustProxy`. A hop count is passed as a function: Fastify 5.12+ treats a plain number as
 * "trust nobody" (hop-count-only trust cannot check the peer).
 */
export function fastifyTrustProxy(t: TrustProxy): FastifyTrustProxy {
  switch (t.kind) {
    case 'off':
      return false;
    case 'all':
      return true;
    case 'hops': {
      const n = t.hops;
      return (_addr: string, hop: number) => hop < n;
    }
    case 'addresses':
      return [...t.addresses];
  }
}

/** One line for the startup log: what is trusted. */
export function describeTrustProxy(t: TrustProxy): string {
  switch (t.kind) {
    case 'off':
      return 'none (X-Forwarded-For is ignored)';
    case 'all':
      return 'every hop';
    case 'hops':
      return t.hops === 1 ? '1 hop' : `${t.hops} hops`;
    case 'addresses':
      return t.isDefault ? 'loopback only (default)' : t.addresses.join(', ');
  }
}

/** The startup warning for `AOM_TRUST_PROXY=true`, or undefined when the setting does not need one. */
export function trustProxyWarning(t: TrustProxy): string | undefined {
  if (t.kind !== 'all') return undefined;
  return (
    'AOM_TRUST_PROXY=true: every X-Forwarded-For hop is trusted, so a client that reaches the server without the ' +
    'proxy can choose its own address and get past the per-address limits. Set the proxy address or a hop count ' +
    'instead (docs/SELF-HOSTING.md, Running behind a reverse proxy).'
  );
}
