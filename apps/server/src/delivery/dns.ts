import { promises as dns } from 'node:dns';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';

/**
 * Address lookups for the "point your domain here" check of a move. Done on the SERVER (the public view of the name, not a
 * computer's own resolver, which may have a private zone). Tests replace the resolver (`setDnsResolver`); an end-to-end run on a
 * private stack can name fixed answers in a JSON file (`AOM_DNS_OVERRIDE_FILE`, `{"shop.test": ["203.0.113.9"]}`), which only ever
 * changes what this one informational check sees: the Owner may confirm a move without it.
 */
export type DnsResolver = (name: string) => Promise<string[]>;

const real: DnsResolver = async (name) => {
  try {
    return await dns.resolve4(name);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN') return [];
    throw err;
  }
};

let resolver: DnsResolver | null = null;
export const setDnsResolver = (r: DnsResolver | null): void => {
  resolver = r;
};

function overridden(name: string): string[] | null {
  const file = process.env.AOM_DNS_OVERRIDE_FILE;
  if (!file) return null;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
    return Array.isArray(m[name]) ? m[name] : null;
  } catch {
    return null;
  }
}

/** The IPv4 addresses a name (or an address) resolves to. An IPv4 literal is its own answer. */
export async function resolveAddresses(nameOrIp: string): Promise<string[]> {
  if (isIPv4(nameOrIp)) return [nameOrIp];
  const fixed = overridden(nameOrIp.toLowerCase());
  if (fixed) return [...fixed].sort();
  return [...(await (resolver ?? real)(nameOrIp.toLowerCase()))].sort();
}
