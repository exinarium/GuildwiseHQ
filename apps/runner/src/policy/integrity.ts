import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The seal on the local authority files (runner-authority-fixes T2): `policy.json`, `held/*.json`, `ceo-turn.json` and
 * `window/devices.json` carry `integrity`, an HMAC-SHA256 over `JSON.stringify` of the file's object without that field
 * (the raw object as written, not a schema's output), keyed by `<policy dir>/policy.key` (32 random bytes, mode 600).
 *
 * The runner and its agents share one OS user, so the seal catches mistakes and agent tool edits, not a deliberate script
 * that reads the key (decision D1, accepted as a recorded leftover). A file with a missing or wrong seal never grants:
 * the policy falls back to the defaults (everything asks), a held item is quarantined, a CEO turn or a paired browser
 * does not count.
 */

export const POLICY_KEY_FILE = 'policy.key';
export const INTEGRITY_FIELD = 'integrity';

const keyFile = (dir: string): string => join(dir, POLICY_KEY_FILE);

/**
 * quiet-approvals S3 (follow-up of runner-authority-fixes review round 2): `<policy dir>/policy.key.seen`, written
 * whenever a key is used. Once it exists, a missing key is a LOST key: unsealed held items and paired browsers no longer
 * count (fail closed: they are asked for again), instead of being read as from before the seal.
 */
export const KEY_SEEN_FILE = 'policy.key.seen';

function noteKeySeen(dir: string): void {
  try {
    const f = join(dir, KEY_SEEN_FILE);
    if (existsSync(f)) return;
    const fd = openSync(f, 'w', 0o600);
    try {
      writeSync(fd, `${new Date().toISOString()}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // advisory: the policy store's own adoption marker still catches a lost key for policy.json
  }
}

/** S3: a key existed on this machine and is gone now (deleted or lost). */
export function keyLost(dir: string): boolean {
  return readPolicyKey(dir) === null && existsSync(join(dir, KEY_SEEN_FILE));
}

/** The key, or null when there is none (a machine from before the seal, or a deleted key). */
export function readPolicyKey(dir: string): Buffer | null {
  try {
    const k = readFileSync(keyFile(dir));
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/**
 * The key, created when absent (`wx`: two processes racing both end with the one that won). `onCreate` is told when this
 * call created it (logged at warn by the runner, shown by `guildwise-runner policy`).
 */
export function ensurePolicyKey(dir: string, onCreate?: (file: string) => void): Buffer {
  const existing = readPolicyKey(dir);
  if (existing) {
    noteKeySeen(dir);
    return existing;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(keyFile(dir), 'wx', 0o600);
    try {
      writeSync(fd, randomBytes(32));
    } finally {
      closeSync(fd);
    }
    onCreate?.(keyFile(dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const k = readPolicyKey(dir);
  if (!k) throw new Error(`${keyFile(dir)} could not be read back`);
  noteKeySeen(dir);
  return k;
}

/**
 * Rework 1 (S1): every writer except the runner's adoption (and `policy accept`) seals only with a key that already exists.
 * Before this version's first runner start there is none, so a setup or CLI write stays unsealed and the runner still adopts
 * it once (toolchains pinned, browsers re-sealed, older held items refused) instead of finding a key someone else made.
 */
export function sealIfKeyed<T extends object>(dir: string, obj: T): T | (T & { integrity: string }) {
  const key = readPolicyKey(dir);
  if (key) noteKeySeen(dir);
  return key ? seal(key, obj) : obj;
}

const mac = (key: Buffer, body: unknown): string =>
  createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');

/** `obj` with its seal (`integrity` last). Any `integrity` it had is replaced. */
export function seal<T extends object>(key: Buffer, obj: T): T & { integrity: string } {
  const { [INTEGRITY_FIELD]: _old, ...rest } = obj as Record<string, unknown>;
  return { ...(rest as T), integrity: mac(key, rest) };
}

export type SealCheck =
  /** Sealed with this key. */
  | 'ok'
  /** No key on this machine. */
  | 'no_key'
  /** A key exists but the object carries no seal. */
  | 'unsealed'
  /** The seal does not match: changed outside the runner, or sealed with another key. */
  | 'bad';

/** Checks `obj`'s seal; `body` is the object without the seal (what the schema should parse). */
export function checkSeal(
  dir: string,
  obj: unknown,
): { check: SealCheck; body: Record<string, unknown> | null } {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { check: 'bad', body: null };
  const { [INTEGRITY_FIELD]: integrity, ...body } = obj as Record<string, unknown>;
  const key = readPolicyKey(dir);
  if (!key) return { check: 'no_key', body };
  if (typeof integrity !== 'string') return { check: 'unsealed', body };
  const want = Buffer.from(mac(key, body), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(integrity) ? integrity : '', 'hex');
  return { check: got.length === want.length && timingSafeEqual(got, want) ? 'ok' : 'bad', body };
}

/**
 * Local authority files are written by the runner and its CLI only, never from an agent's session (its environment
 * carries the shift token or id). Throws there.
 */
export function assertNotAgentSession(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AOM_SHIFT_TOKEN || env.AOM_SHIFT_ID)
    throw new Error('the local approval settings are never written from an agent session');
}

/** The adoption marker (`<dataDir>/keys/policy-sealed`): this machine's policy was sealed once; never adopt again. */
export const sealMarkerFor = (dataDir: string): string => join(dataDir, 'keys', 'policy-sealed');

export function writeSealMarker(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (!existsSync(file)) {
      const fd = openSync(file, 'w', 0o600);
      writeSync(fd, `${new Date().toISOString()}\n`);
      closeSync(fd);
    }
  } catch {
    // the marker only narrows a later adoption; a failure to write it never fails the write that sealed
  }
}
