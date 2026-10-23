import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Where a runner may clone a pack from (docs/ARCHITECTURE.md section 38.4). A pack URL comes from the server, so it is checked
 * on the workstation before git is started: public https only, and the host must not lead into the workstation's own network
 * (loopback, link-local and cloud metadata, private and shared address space). Names are resolved here and every address is
 * checked; git is then told to use exactly those addresses, so a name that answers differently a moment later gains nothing.
 */

const v4 = (ip: string): number[] => ip.split('.').map((n) => Number(n));

/** True for an address that is not a public unicast address. */
export function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (isIP(lower) === 4) {
    const [a, b] = v4(lower) as [number, number, number, number];
    return (
      a === 0 || // "this network", unspecified
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (isIP(lower) === 6) {
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(lower);
    if (mapped) {
      if (mapped[1]) return isPrivateAddress(mapped[1]);
      const hi = Number.parseInt(mapped[2] as string, 16);
      const lo = Number.parseInt(mapped[3] as string, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = Number.parseInt(lower.split(':')[0] || '0', 16);
    return (
      (first & 0xfe00) === 0xfc00 || // unique local
      (first & 0xffc0) === 0xfe80 || // link-local
      (first & 0xff00) === 0xff00 || // multicast
      (first === 0x2001 && lower.startsWith('2001:db8')) // documentation
    );
  }
  return true; // not an address at all: refuse
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export interface CheckedPackUrl {
  url: string;
  host: string;
  port: number;
  /** The addresses the host resolved to, all public; empty for a local test path. */
  addresses: string[];
}

/** Throws a readable error for a URL a runner must not clone; otherwise returns what was resolved. */
export async function checkPackUrl(
  raw: string,
  opts: { allowLocal?: boolean; resolve?: Resolver } = {},
): Promise<CheckedPackUrl> {
  if (opts.allowLocal && (raw.startsWith('/') || raw.startsWith('file://')))
    return { url: raw, host: '', port: 0, addresses: [] };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('the pack URL is not a valid https URL (ssh and other protocols are not supported)');
  }
  if (u.protocol !== 'https:')
    throw new Error('only public https git URLs are supported for packs (ssh and other protocols are not)');
  if (u.username || u.password) throw new Error('a pack URL must not carry a user name or password');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    throw new Error(`the pack host ${host || '(none)'} is not a public host`);
  const port = u.port ? Number(u.port) : 443;
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await (opts.resolve ?? defaultResolver)(host);
    } catch {
      throw new Error(`the pack host ${host} could not be resolved`);
    }
  }
  if (!addresses.length) throw new Error(`the pack host ${host} could not be resolved`);
  const bad = addresses.find(isPrivateAddress);
  if (bad)
    throw new Error(`the pack host ${host} points to a private or internal address and is not allowed`);
  return { url: u.toString(), host, port, addresses };
}
