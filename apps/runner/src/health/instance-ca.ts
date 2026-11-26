import { X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { writableByOthers } from '../policy/startup.ts';
import { instanceEtcDir, instanceOfUser, isDedicatedUser } from '../setup/admin-command.ts';

/**
 * runner-bare-bin (requirement 3): `guildwise-runner doctor` run by hand has no NODE_EXTRA_CA_CERTS (the systemd unit sets it),
 * so a server behind the instance's own CA failed its health check. Doctor now loads the very file the unit passes, named the
 * way the installer names it, and trusts it for its two health fetches only (never process-wide):
 * - a dedicated runner user: `/etc/guildwise-runner[-<instance>]/ca.pem` (guildwise-admin.cjs `RUNNER_CA_FILE`, layout
 *   `caFile`, the unit's `Environment=NODE_EXTRA_CA_CERTS=` line);
 * - a person's runner: `<home>/.local/share/guildwise/runner/ca.pem` (installer common.sh `install_runner_ca`, linux.sh unit).
 * The user and home come from the password database (`os.userInfo()`), never `$HOME`.
 */

const MAX_CA_BYTES = 1024 * 1024;

export function instanceCaPath(user: string, home: string): string {
  if (isDedicatedUser(user)) return join(instanceEtcDir(instanceOfUser(user)), 'ca.pem');
  return join(home, '.local', 'share', 'guildwise', 'runner', 'ca.pem');
}

export type InstanceCa =
  | { kind: 'env'; path: string }
  | { kind: 'missing'; path: string }
  | { kind: 'ok'; path: string; pem: string }
  | { kind: 'refused'; path: string; reason: string };

/** Every folder above `p`, up to `/`. */
function parents(p: string): string[] {
  const out: string[] = [];
  let d = dirname(p);
  for (;;) {
    out.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/**
 * The instance CA for a hand-run doctor. Opened without following a link (`O_NOFOLLOW`, then `fstat` and read through that
 * fd), owned by root (`/etc` layout) or this user (a person's layout), not group- or world-writable, every parent folder
 * likewise, at most 1 MiB, certificates only (no private key), each one a valid X.509 certificate.
 */
export function loadInstanceCa(
  o: {
    env?: NodeJS.ProcessEnv;
    user?: string;
    home?: string;
    rootUid?: number;
    ownUid?: number | null;
    /** Test hook: the file to judge instead of the derived path (judged in the person's layout unless `etcLayout`). */
    path?: string;
    etcLayout?: boolean;
  } = {},
): InstanceCa {
  const env = o.env ?? process.env;
  let user = o.user;
  let home = o.home;
  if (user === undefined || home === undefined) {
    const u = userInfo();
    user ??= u.username;
    home ??= u.homedir;
  }
  const path = o.path ?? instanceCaPath(user, home);
  if (env.NODE_EXTRA_CA_CERTS) return { kind: 'env', path: env.NODE_EXTRA_CA_CERTS };
  const rootUid = o.rootUid ?? 0;
  const ownUid =
    o.ownUid === undefined ? (typeof process.geteuid === 'function' ? process.geteuid() : null) : o.ownUid;
  const etcLayout = o.etcLayout ?? (isDedicatedUser(user) && o.path === undefined);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing', path };
    if (code === 'ELOOP') return { kind: 'refused', path, reason: 'it is a symbolic link' };
    return { kind: 'refused', path, reason: `it cannot be opened (${code ?? 'error'})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { kind: 'refused', path, reason: 'it is not a regular file' };
    const wantUid = etcLayout ? rootUid : ownUid;
    if (wantUid !== null && st.uid !== wantUid)
      return { kind: 'refused', path, reason: `it belongs to uid ${st.uid}` };
    if (st.mode & 0o022) return { kind: 'refused', path, reason: 'group or others may write it' };
    for (const d of parents(path))
      if (writableByOthers(d, ownUid))
        return {
          kind: 'refused',
          path,
          reason: `${d} is writable by group or others, or belongs to another user`,
        };
    if (st.size > MAX_CA_BYTES) return { kind: 'refused', path, reason: 'it is over 1 MiB' };
    const buf = Buffer.alloc(Math.min(st.size, MAX_CA_BYTES) + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
      if (n >= buf.length) break;
    }
    if (n > MAX_CA_BYTES) return { kind: 'refused', path, reason: 'it is over 1 MiB' };
    const pem = buf.subarray(0, n).toString('utf8');
    if (/PRIVATE KEY/.test(pem)) return { kind: 'refused', path, reason: 'it holds a private key' };
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    if (!blocks.length) return { kind: 'refused', path, reason: 'it holds no certificate' };
    for (const b of blocks)
      try {
        new X509Certificate(b);
      } catch {
        return { kind: 'refused', path, reason: 'it holds a certificate that does not parse' };
      }
    return { kind: 'ok', path, pem: blocks.join('\n') };
  } finally {
    closeSync(fd);
  }
}

/**
 * A health GET that trusts the system roots plus `pem` (the instance CA) for this request only. Without `pem` it is a plain
 * fetch. The agent is closed after.
 */
export async function healthFetch(
  url: URL | string,
  pem?: string,
  timeoutMs = 8000,
): Promise<{ ok: boolean; status: number }> {
  if (!pem) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.ok, status: res.status };
  }
  const agent = new Agent({ connect: { ca: [...rootCertificates, pem] } });
  try {
    const res = await undiciFetch(url, { dispatcher: agent, signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return { ok: res.ok, status: res.status };
  } finally {
    await agent.close().catch(() => undefined);
  }
}

/** The doctor line for the instance CA, or null when there is nothing to say (missing: production has none). */
export function caLine(ca: InstanceCa): { ok: boolean; detail: string } | null {
  if (ca.kind === 'ok') return { ok: true, detail: ca.path };
  if (ca.kind === 'refused') return { ok: false, detail: `${ca.path} not used: ${ca.reason}` };
  if (ca.kind === 'env') return { ok: true, detail: `${ca.path} (NODE_EXTRA_CA_CERTS)` };
  return null;
}

/** A TLS error from the health fetch, with the hint that no usable instance CA was there. */
export function tlsHint(err: unknown, ca: InstanceCa): string {
  const msg =
    err instanceof Error
      ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}`
      : String(err);
  const tls = /cert|self.signed|unable to verify|issuer|UNABLE_TO|DEPTH_ZERO/i.test(msg);
  return tls && ca.kind !== 'ok' && ca.kind !== 'env' ? `${msg} (no usable instance CA at ${ca.path})` : msg;
}
