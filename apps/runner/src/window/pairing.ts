import {
  createHash,
  createHmac,
  createPublicKey,
  type KeyObject,
  randomBytes,
  randomInt,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAIR_CODE_RE } from '@aom/shared';
import { z } from 'zod';
import { assertNotAgentSession, checkSeal, keyLost, sealIfKeyed } from '../policy/integrity.ts';
import { writeFileAtomic } from '../policy/store.ts';
import { APPROVALS_PORT_MAX, APPROVALS_PORT_MIN } from '../sandbox/test-services.ts';

/**
 * Browser pairing and sessions of the approvals page (DESIGN "Approvals window" [B1, B2, R2-B1, R2-S1]).
 *
 * - A browser makes a non-extractable ECDSA P-256 key and asks to pair with its public key (SPKI). The runner keeps the
 *   request as `window/pending/<code>.json` (600, 10 minutes, at most 10 waiting) under a code it makes itself.
 * - `guildwise-runner approvals pair <code>` (a terminal, the runner user) moves the key into `window/devices.json` (600).
 * - Each visit: a fresh single-use nonce (60 s), signed by the browser over `gw-approvals|<instance>|<port>|<nonce>`,
 *   gives a session token that lives only in this process and in the page's memory (30 minutes idle).
 *
 * The code is not a secret: it only selects a public key whose private half never leaves the browser. Every file here is
 * per instance (under that runner's policy dir), so a UAT browser key is unknown to production.
 */

export const PENDING_TTL_MS = 10 * 60_000;
export const PENDING_MAX = 10;
export const NONCE_TTL_MS = 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;
/** Used nonces remembered at most (each lives 60 s); beyond that, sign-ins wait a minute (no replay window opens). */
const USED_NONCE_MAX = 10_000;
const SESSION_MAX = 200;
/** The code alphabet of PAIR_CODE_RE: no 0/O and no 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const windowDir = (policyRoot: string): string => join(policyRoot, 'window');

const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** The text a browser signs for a session: binds the signature to this purpose, instance and port. */
export const signedText = (instance: string, port: number, nonce: string): string =>
  `gw-approvals|${instance}|${port}|${nonce}`;

/** Parses a base64 SPKI and accepts only an EC P-256 public key. Returns the key and its DER, or null. */
export function parseSpki(spkiB64: string): { key: KeyObject; der: Buffer } | null {
  if (typeof spkiB64 !== 'string' || !/^[A-Za-z0-9+/]{40,400}={0,2}$/.test(spkiB64)) return null;
  try {
    const der = Buffer.from(spkiB64, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return { key, der };
  } catch {
    return null;
  }
}

const PendingSchema = z.object({
  code: z.string().regex(PAIR_CODE_RE),
  spki: z.string(),
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  userAgent: z.string().max(300),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type PendingPair = z.infer<typeof PendingSchema>;

const DeviceSchema = z.object({
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  spki: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  userAgent: z.string().max(300),
  pairedAt: z.iso.datetime(),
});
export type PairedDevice = z.infer<typeof DeviceSchema>;
export const DevicesFileSchema = z.object({ devices: z.array(DeviceSchema).max(100).default([]) });

/** Strips control characters (a user agent is shown in the terminal). */
const plain = (s: string): string => s.replace(/\p{Cc}/gu, '').slice(0, 300);

/** The paired browsers and the waiting pair requests on disk. Shared by the window (runner) and the CLI. */
export class DeviceStore {
  readonly dir: string;
  readonly pendingDir: string;
  readonly devicesFile: string;

  constructor(
    readonly policyRoot: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = windowDir(policyRoot);
    this.pendingDir = join(this.dir, 'pending');
    this.devicesFile = join(this.dir, 'devices.json');
  }

  private ensure(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // ------------------------------------------------------------ waiting pair requests

  /** Valid, unexpired requests, oldest first. Expired and unreadable files are removed. */
  pending(): PendingPair[] {
    let names: string[];
    try {
      names = readdirSync(this.pendingDir);
    } catch {
      return [];
    }
    const out: PendingPair[] = [];
    for (const n of names) {
      const file = join(this.pendingDir, n);
      const code = n.endsWith('.json') ? n.slice(0, -5) : '';
      let rec: PendingPair | null = null;
      if (PAIR_CODE_RE.test(code)) {
        try {
          const r = PendingSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
          if (r.success && r.data.code === code) rec = r.data;
        } catch {
          rec = null;
        }
      }
      if (!rec || rec.expiresAt <= this.now()) rmSync(file, { force: true });
      else out.push(rec);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.code.localeCompare(b.code));
  }

  private newCode(taken: Set<string>): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const code = `${c.slice(0, 4)}-${c.slice(4)}`;
      if (!taken.has(code)) return code;
    }
  }

  /**
   * A browser asks to pair. The runner makes the code (never the client); at most PENDING_MAX wait, the oldest is dropped.
   * Throws on a key that is not EC P-256.
   */
  addPending(spkiB64: string, userAgent: string): PendingPair {
    const parsed = parseSpki(spkiB64);
    if (!parsed) throw new Error('not an ECDSA P-256 public key');
    const cur = this.pending();
    while (cur.length >= PENDING_MAX) {
      const old = cur.shift() as PendingPair;
      rmSync(join(this.pendingDir, `${old.code}.json`), { force: true });
    }
    const taken = new Set(cur.map((p) => p.code));
    const keyHash = sha256Hex(parsed.der);
    const at = this.now();
    const rec: PendingPair = {
      code: this.newCode(taken),
      spki: parsed.der.toString('base64'),
      keyHash,
      fingerprint: keyHash.slice(0, 8),
      userAgent: plain(userAgent),
      createdAt: at,
      expiresAt: at + PENDING_TTL_MS,
    };
    this.ensure(this.pendingDir);
    writeFileAtomic(join(this.pendingDir, `${rec.code}.json`), `${JSON.stringify(rec)}\n`, 0o600);
    return rec;
  }

  /** A waiting request by its code (case-insensitive), or null. */
  findPending(code: string): PendingPair | null {
    const c = code.trim().toUpperCase();
    if (!PAIR_CODE_RE.test(c)) return null;
    return this.pending().find((p) => p.code === c) ?? null;
  }

  /** Moves a waiting request's key into devices.json (the CLI, after the typed yes). */
  confirmPending(code: string): PairedDevice {
    const p = this.findPending(code);
    if (!p) throw new Error(`no browser waits with code ${code} (codes last 10 minutes)`);
    const dev: PairedDevice = {
      keyHash: p.keyHash,
      spki: p.spki,
      fingerprint: p.fingerprint,
      userAgent: p.userAgent,
      pairedAt: new Date(this.now()).toISOString(),
    };
    this.writeDevices([...this.devices().filter((d) => d.keyHash !== p.keyHash), dev]);
    rmSync(join(this.pendingDir, `${p.code}.json`), { force: true });
    return dev;
  }

  // ------------------------------------------------------------ paired browsers

  devices(): PairedDevice[] {
    try {
      // T2 (S1): a devices file without a good seal pairs no browser (one planted outside the runner never counts)
      const { check, body } = checkSeal(this.policyRoot, JSON.parse(readFileSync(this.devicesFile, 'utf8')));
      // no key yet: the runner has not adopted the policy (a CLI pairing before its first start); it seals them then
      if (check !== 'ok' && check !== 'no_key') return [];
      // quiet-approvals S3: a key existed and is gone: an unsealed devices file pairs no browser (pair again)
      if (check === 'no_key' && keyLost(this.policyRoot)) return [];
      const r = DevicesFileSchema.safeParse(body);
      return r.success ? r.data.devices : [];
    } catch {
      return [];
    }
  }

  device(keyHash: string): PairedDevice | null {
    return this.devices().find((d) => d.keyHash === keyHash) ?? null;
  }

  writeDevices(devices: PairedDevice[]): void {
    assertNotAgentSession();
    this.ensure(this.dir);
    writeFileAtomic(
      this.devicesFile,
      `${JSON.stringify(sealIfKeyed(this.policyRoot, { devices }), null, 2)}\n`,
      0o600,
    );
  }

  /** Forgets the browsers with this fingerprint (or every one). Returns those removed. */
  forget(fingerprint: string | 'all'): PairedDevice[] {
    const cur = this.devices();
    const gone = fingerprint === 'all' ? cur : cur.filter((d) => d.fingerprint === fingerprint.toLowerCase());
    if (gone.length) this.writeDevices(cur.filter((d) => !gone.includes(d)));
    return gone;
  }
}

interface Session {
  keyHash: string;
  lastUsed: number;
}

/**
 * Challenges and sessions: memory only, so every token dies with the runner. Tokens are kept by their sha256, so a
 * lookup never compares the secret itself.
 */
export class SessionStore {
  /**
   * Nonces are self-checking (review nit: a map that evicts its oldest entry let a local process push out a real
   * challenge): `<expiry>.<random>.<hmac>` under a key that lives only in this process. Only USED nonces are remembered,
   * until they expire, so asking for many challenges pushes nothing out.
   */
  private readonly nonceKey = randomBytes(32);
  private used = new Map<string, number>();
  private sessions = new Map<string, Session>();

  private nonceMac(body: string): string {
    return createHmac('sha256', this.nonceKey).update(body).digest('base64url').slice(0, 32);
  }

  constructor(
    private readonly devices: DeviceStore,
    private readonly instance: string,
    private readonly port: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** A fresh single-use nonce (base64url of 32 bytes), valid for 60 seconds. */
  challenge(): { nonce: string; expiresAt: number } {
    const expiresAt = this.now() + NONCE_TTL_MS;
    const body = `${expiresAt}.${randomBytes(32).toString('base64url')}`;
    return { nonce: `${body}.${this.nonceMac(body)}`, expiresAt };
  }

  /** The expiry of a nonce this process issued, or null (forged, malformed). */
  private nonceExpiry(nonce: string): number | null {
    const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{32})$/.exec(nonce);
    if (!m) return null;
    const want = Buffer.from(this.nonceMac(`${m[1]}.${m[2]}`));
    const got = Buffer.from(m[3] as string);
    return want.length === got.length && timingSafeEqual(want, got) ? Number(m[1]) : null;
  }

  /**
   * Turns a signed nonce into a session. The nonce is used up whether or not the rest checks out. Returns the token and
   * the key hash, or the reason it was refused.
   */
  signIn(
    keyHash: unknown,
    nonce: unknown,
    sig: unknown,
  ): { ok: true; token: string; keyHash: string } | { ok: false; reason: string } {
    if (typeof nonce !== 'string' || typeof keyHash !== 'string' || typeof sig !== 'string')
      return { ok: false, reason: 'malformed' };
    const t0 = this.now();
    const exp = this.nonceExpiry(nonce);
    if (exp === null || exp <= t0 || this.used.has(nonce))
      return { ok: false, reason: 'unknown or expired challenge' };
    // used up whether or not the rest checks out; the used list only needs to outlive the nonce
    for (const [n, e] of this.used) if (e <= t0) this.used.delete(n);
    if (this.used.size >= USED_NONCE_MAX) return { ok: false, reason: 'too many sign-ins; wait a minute' };
    this.used.set(nonce, exp);
    if (!/^[0-9a-f]{64}$/.test(keyHash)) return { ok: false, reason: 'malformed' };
    const dev = this.devices.device(keyHash);
    if (!dev) return { ok: false, reason: 'this browser is not paired' };
    const parsed = parseSpki(dev.spki);
    if (!parsed || sha256Hex(parsed.der) !== dev.keyHash) return { ok: false, reason: 'bad device entry' };
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, 'base64');
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (sigBuf.length !== 64) return { ok: false, reason: 'malformed signature' };
    const good = verify(
      'sha256',
      Buffer.from(signedText(this.instance, this.port, nonce)),
      { key: parsed.key, dsaEncoding: 'ieee-p1363' },
      sigBuf,
    );
    if (!good) return { ok: false, reason: 'bad signature' };
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    for (const [h, s] of this.sessions) if (at - s.lastUsed > SESSION_IDLE_MS) this.sessions.delete(h);
    while (this.sessions.size >= SESSION_MAX)
      this.sessions.delete(this.sessions.keys().next().value as string);
    this.sessions.set(sha256Hex(token), { keyHash, lastUsed: at });
    return { ok: true, token, keyHash };
  }

  /**
   * The key hash of a live session for this bearer token, or null. A session ends after 30 idle minutes, and as soon as
   * its browser is no longer in devices.json (`approvals forget`, `approvals port`).
   */
  check(token: string | null): string | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const h = sha256Hex(token);
    const s = this.sessions.get(h);
    if (!s) return null;
    const at = this.now();
    if (at - s.lastUsed > SESSION_IDLE_MS || !this.devices.device(s.keyHash)) {
      this.sessions.delete(h);
      return null;
    }
    s.lastUsed = at;
    return s.keyHash;
  }
}

// ---------------------------------------------------------------- the port file

export const PORT_MIN = APPROVALS_PORT_MIN;
export const PORT_MAX = APPROVALS_PORT_MAX;

export const portFile = (policyRoot: string): string => join(windowDir(policyRoot), 'port');

/** The stored port, or null when none was picked yet (or the file is not a port). */
export function readPort(policyRoot: string): number | null {
  try {
    const n = Number(readFileSync(portFile(policyRoot), 'utf8').trim());
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

export function writePort(policyRoot: string, port: number): void {
  mkdirSync(windowDir(policyRoot), { recursive: true, mode: 0o700 });
  writeFileSync(portFile(policyRoot), `${port}\n`, { mode: 0o600 });
  chmodSync(portFile(policyRoot), 0o600);
}
