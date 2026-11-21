import { BlockList, isIP } from 'node:net';
import type { BlockKind, ScreenPurpose } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { type Queryable, rows } from '../db/sql.ts';
import { badRequest } from '../errors.ts';

/**
 * Address policy (R1): the owner's block list first, then each extension's `screenAddress` (the hosted disposable-domain
 * list). Called at sign-up, sign-up resend, invite (and accept), login and password reset; each caller decides the answer
 * (invite 400 `email_not_accepted`, login the uniform 401 with a `blocked` failure row, reset a silent `{ok:true}`, a
 * blocked IP 403 `request_refused`).
 */

export interface ScreenResult {
  /** `blocklist`: the owner's list; otherwise the name of the extension that refused it. */
  source: string;
  /** What matched: the address, its domain, the client IP, or an extension's own policy. */
  kind: 'email' | 'domain' | 'ip' | 'extension';
  /** For the logs and the platform audit only; callers never show it to the person asking. */
  reason: string;
}

interface BlockRow {
  kind: BlockKind;
  value: string;
}

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1);

/** `true` when `domain` is `entry` or one of its subdomains. */
export const domainMatches = (domain: string, entry: string): boolean =>
  domain === entry || domain.endsWith(`.${entry}`);

/** `true` when `ip` equals the entry or lies inside it (an IP or a CIDR, v4 or v6). */
export function ipMatches(ip: string, entry: string): boolean {
  const family = isIP(ip);
  if (!family) return false;
  const list = new BlockList();
  const [net, bits] = entry.split('/');
  const entryFamily = isIP(net ?? '');
  if (!entryFamily) return false;
  const type = entryFamily === 6 ? 'ipv6' : 'ipv4';
  if (bits === undefined) list.addAddress(net as string, type);
  else list.addSubnet(net as string, Number(bits), type);
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The canonical form of a block-list value, or a 400 `invalid_block_value`: domains and addresses lower-cased without a
 * leading `@` or `*.`, an IP as written, a CIDR with a valid prefix length.
 */
export function normalizeBlockValue(kind: BlockKind, raw: string): string {
  const v = raw.trim().toLowerCase();
  const bad = (why: string) => badRequest('invalid_block_value', why);
  if (kind === 'email') {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw bad('not an email address');
    return v;
  }
  if (kind === 'domain' || kind === 'allow_domain') {
    const d = v.replace(/^\*?\.|^@/, '');
    if (!/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(d)) throw bad('not a domain');
    return d;
  }
  const [net, bits, extra] = v.split('/');
  const family = isIP(net ?? '');
  if (!family || extra !== undefined) throw bad('not an IP address or CIDR range');
  if (bits === undefined) return net as string;
  const n = Number(bits);
  if (!/^\d+$/.test(bits) || n < 0 || n > (family === 6 ? 128 : 32)) throw bad('invalid CIDR prefix length');
  return `${net}/${n}`;
}

async function blockRows(db: Queryable): Promise<BlockRow[]> {
  return rows<BlockRow>(db, 'SELECT kind, value FROM platform_blocklist');
}

/**
 * Screens an address (and the client IP) for `purpose`. Null: allowed. Order: an `email` entry, a `domain` entry
 * (subdomains included), an `ip` entry (IP or CIDR); then, unless an `allow_domain` entry matches the domain, every
 * extension's `screenAddress` in registration order.
 */
export async function screenAddress(
  ctx: Ctx,
  input: { email: string; ip?: string | null | undefined; purpose: ScreenPurpose },
): Promise<ScreenResult | null> {
  const email = input.email.trim().toLowerCase();
  const domain = domainOf(email);
  const ip = input.ip ?? null;
  const list = await blockRows(ctx.pool);
  for (const b of list) {
    if (b.kind === 'email' && b.value === email)
      return { source: 'blocklist', kind: 'email', reason: 'address on the block list' };
  }
  for (const b of list) {
    if (b.kind === 'domain' && domainMatches(domain, b.value))
      return { source: 'blocklist', kind: 'domain', reason: `domain ${b.value} on the block list` };
  }
  if (ip) {
    for (const b of list) {
      if (b.kind === 'ip' && ipMatches(ip, b.value))
        return { source: 'blocklist', kind: 'ip', reason: `address ${b.value} on the block list` };
    }
  }
  if (list.some((b) => b.kind === 'allow_domain' && domainMatches(domain, b.value))) return null;
  for (const e of ctx.ext.list) {
    if (!e.screenAddress) continue;
    const r = await e.screenAddress(ctx, { email, ip, purpose: input.purpose });
    if (r) return { source: e.name, kind: 'extension', reason: r.reason };
  }
  return null;
}
