import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { checkSeal, readPolicyKey, seal } from '../policy/integrity.ts';
import { writeFileAtomic } from '../policy/store.ts';
import { underRoot } from './folder-check.ts';

/**
 * tool-pin-lib: the whole-folder pin of the Guildwise tool folder (`toolchainsRoot`). A recursive Merkle hash over every
 * entry (name, kind, permission bits, the link text or the content's sha256, a child folder's hash), with the folder's
 * absolute path mixed in, so two folders with the same content never share a pin.
 *
 * Fails (never a hash) on a fifo, socket or device, on an entry on another filesystem than the folder (a FUSE or bind
 * mount), and on a link whose target leaves the folder for anything but a read-only system path (owned by root, not
 * group- or other-writable, every component of the way). A link is followed component by component the way the kernel
 * does, so a link in the middle of a target path is checked too; a dangling link is fine only while its missing part
 * would be inside the folder (creating it changes the hash).
 *
 * Content digests are cached by `(dev, ino, size, mtimeNs, ctimeNs, mode)`; a file is read with O_NOFOLLOW and fstat'ed
 * before and after the read, and only cached once its ctime is at least `racyMs` old (a write in the same clock tick could
 * otherwise keep the old key). A synchronous check reads at most `budgetBytes`; past that the result is `pending`.
 */

export type TreeResult =
  | { kind: 'ok'; hash: string; manifest?: Manifest; empty?: boolean }
  | { kind: 'fail'; reason: string }
  | { kind: 'pending'; reason: string }
  | { kind: 'absent' };

/** Relative path -> `d <mode>` | `f <mode> <sha256>` | `l <link text>`. */
export type Manifest = Record<string, string>;

export const DEFAULT_BUDGET_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RACY_MS = 2_000;
const MAX_HOPS = 40;
const CACHE_VERSION = 1;

const statKey = (s: BigIntStats): string => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;

/**
 * Content digests by path and stat key, kept in memory and (sealed with the policy key) in `<policyDir>/tree-pin-cache.json`.
 * A tampered or unsealed file is ignored: everything is read again.
 */
export class DigestCache {
  private map = new Map<string, { k: string; d: string }>();
  private dirty = false;

  constructor(
    private readonly file?: string,
    private readonly policyDir?: string,
  ) {
    if (!file || !policyDir) return;
    try {
      const { check, body } = checkSeal(policyDir, JSON.parse(readFileSync(file, 'utf8')));
      const files = (body as { v?: number; files?: Record<string, [string, string]> } | null)?.files;
      if (
        check === 'ok' &&
        (body as { v?: number }).v === CACHE_VERSION &&
        files &&
        typeof files === 'object'
      )
        for (const [p, v] of Object.entries(files))
          if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'string')
            this.map.set(p, { k: v[0], d: v[1] });
    } catch {
      /* none yet, or unreadable: start empty */
    }
  }

  get(path: string, key: string): string | undefined {
    const hit = this.map.get(path);
    return hit && hit.k === key ? hit.d : undefined;
  }

  set(path: string, key: string, digest: string): void {
    const hit = this.map.get(path);
    if (hit && hit.k === key && hit.d === digest) return;
    this.map.set(path, { k: key, d: digest });
    this.dirty = true;
  }

  /** Drops the entries under `root` that the last full walk did not see. */
  prune(root: string, seen: Set<string>): void {
    for (const p of this.map.keys())
      if (underRoot(p, root) && !seen.has(p)) {
        this.map.delete(p);
        this.dirty = true;
      }
  }

  save(): void {
    if (!this.dirty || !this.file || !this.policyDir) return;
    const key = readPolicyKey(this.policyDir);
    if (!key) return;
    const files: Record<string, [string, string]> = {};
    for (const [p, v] of this.map) files[p] = [v.k, v.d];
    try {
      writeFileAtomic(this.file, JSON.stringify(seal(key, { v: CACHE_VERSION, files })), 0o600);
      this.dirty = false;
    } catch {
      /* advisory: the next check reads again */
    }
  }
}

export interface TreeHashOptions {
  cache: DigestCache;
  /** Bytes a synchronous check may read before it answers `pending` (default 32 MB; Infinity for a full hash). */
  budgetBytes?: number;
  /** Collect the manifest (pin time and the trust step). */
  manifest?: boolean;
  now?: () => number;
  racyMs?: number;
  /**
   * gate-fixes-3: folders directly in the root that the walk leaves out (a real directory only; a link of that name is
   * hashed and checked as usual). For the link rule they count as outside the folder, so a link into one fails. With none
   * of them present the hash is exactly as without the option.
   */
  exclude?: readonly string[];
}

class Pending extends Error {}
class Refused extends Error {}

/**
 * Is a path outside the folder trusted as a system path: owned by root and (unless a link) not group- or other-writable?
 * The folders on the way to the tool folder itself (its ancestors) are fine as a step: a link may climb through them back
 * into it, but may not end there (`linkRefusal`).
 */
function trustedOutside(p: string, st: BigIntStats, realRoot: string): boolean {
  if (p === sep || underRoot(realRoot, p)) return true;
  if (st.uid !== 0n) return false;
  return st.isSymbolicLink() || (st.mode & 0o022n) === 0n;
}

/**
 * The link rule: follows `link` (inside the folder, under `realDir`) component by component, the way the kernel resolves
 * it. Every component outside the folder must be a trusted system path; a missing component is fine only inside the
 * folder. Returns null when allowed, else the reason.
 */
export function linkRefusal(
  link: string,
  realDir: string,
  realRoot: string,
  excluded: readonly string[] = [],
): string | null {
  const inRoot = (p: string): boolean => underRoot(p, realRoot) && !excluded.some((e) => underRoot(p, e));
  let target: string;
  try {
    target = readlinkSync(link);
  } catch {
    return `${link} could not be read`;
  }
  let cur = isAbsolute(target) ? sep : realDir;
  const pending = target.split(sep);
  let hops = 0;
  while (pending.length) {
    const part = pending.shift() as string;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, part);
    let st: BigIntStats;
    try {
      st = lstatSync(next, { bigint: true });
    } catch {
      return inRoot(cur) ? null : `${link} points to ${next}, which does not exist and is outside the folder`;
    }
    const inside = inRoot(next);
    if (!inside && !trustedOutside(next, st, realRoot))
      return `${link} points to ${next}, outside the folder and not a read-only system path`;
    if (st.isSymbolicLink()) {
      if (++hops > MAX_HOPS) return `${link}: too many links`;
      let t: string;
      try {
        t = readlinkSync(next);
      } catch {
        return `${link}: ${next} could not be read`;
      }
      if (isAbsolute(t)) cur = sep;
      pending.unshift(...t.split(sep));
      continue;
    }
    cur = next;
  }
  // review B2: the folders above the tool folder may only be passed on the way back in, never be where a link ends
  if (!underRoot(cur, realRoot) && cur !== sep && underRoot(realRoot, cur))
    return `${link} points to ${cur}, a folder above the tool folder`;
  if (excluded.some((e) => underRoot(cur, e)))
    return `${link} points into ${cur}, a folder pinned on its own`;
  return null;
}

/** gate-fixes-3: the excluded folders as direct children of the real root (a name elsewhere is never excluded). */
function excludedIn(realRoot: string, exclude: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const e of exclude ?? []) {
    const name = e.slice(e.lastIndexOf(sep) + 1);
    if (name && name !== '.' && name !== '..') out.push(join(realRoot, name));
  }
  return out;
}

const digestOf = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Reads a file for its digest: lstat key, open O_NOFOLLOW, fstat, read, fstat; a change in between is `pending`. */
function readDigest(path: string, st: BigIntStats): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const a = fstatSync(fd, { bigint: true });
    if (statKey(a) !== statKey(st)) throw new Pending(`${path} is changing`);
    const size = Number(a.size);
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    const b = fstatSync(fd, { bigint: true });
    if (off !== size || statKey(b) !== statKey(st)) throw new Pending(`${path} is changing`);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** The hash of `root` (see the file comment). `absent` when it does not exist. */
export function rootTreeHash(root: string, o: TreeHashOptions): TreeResult {
  let realRoot: string;
  let rootSt: BigIntStats;
  try {
    realRoot = realpathSync(root);
    rootSt = lstatSync(realRoot, { bigint: true });
  } catch {
    return { kind: 'absent' };
  }
  if (!rootSt.isDirectory()) return { kind: 'fail', reason: `${root} is not a folder` };
  const now = o.now ?? Date.now;
  const racyNs = BigInt(o.racyMs ?? DEFAULT_RACY_MS) * 1_000_000n;
  let budget = o.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const manifest: Manifest | undefined = o.manifest ? {} : undefined;
  // the cache is pruned only by a full hash (pin time), not by every per-spawn check
  const seen = o.manifest ? new Set<string>() : null;
  const excluded = excludedIn(realRoot, o.exclude);
  let entries = 0;

  const walk = (dir: string, rel: string): string => {
    const h = createHash('sha256');
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      throw new Refused(`${dir} could not be read`);
    }
    for (const name of names) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st: BigIntStats;
      try {
        st = lstatSync(p, { bigint: true });
      } catch {
        throw new Pending(`${p} disappeared while it was checked`);
      }
      if (st.isDirectory() && excluded.includes(p)) continue;
      entries++;
      if (st.dev !== rootSt.dev)
        throw new Refused(`${p} is on another filesystem (a mount inside the folder)`);
      const mode = (st.mode & 0o7777n).toString(8);
      let line: string;
      if (st.isDirectory()) {
        if (manifest) manifest[r] = `d ${mode}`;
        line = `d\0${mode}\0${walk(p, r)}`;
      } else if (st.isSymbolicLink()) {
        const why = linkRefusal(p, dir, realRoot, excluded);
        if (why) throw new Refused(why);
        const t = readlinkSync(p);
        if (manifest) manifest[r] = `l ${t}`;
        line = `l\0${mode}\0${t}`;
      } else if (st.isFile()) {
        seen?.add(p);
        const key = statKey(st);
        let d = o.cache.get(p, key);
        if (!d) {
          if (Number(st.size) > budget) throw new Pending('the folder is still being checked');
          budget -= Number(st.size);
          let buf: Buffer;
          try {
            buf = readDigest(p, st);
          } catch (err) {
            if (err instanceof Pending) throw err;
            throw new Pending(`${p} could not be read`);
          }
          d = digestOf(buf);
          if (BigInt(now()) * 1_000_000n - st.ctimeNs >= racyNs) o.cache.set(p, key, d);
        }
        if (manifest) manifest[r] = `f ${mode} ${d}`;
        line = `f\0${mode}\0${d}`;
      } else {
        throw new Refused(`${p} is a fifo, socket or device`);
      }
      h.update(`${name}\0${line}\n`);
    }
    return h.digest('hex');
  };

  try {
    const top = walk(realRoot, '');
    if (seen) o.cache.prune(realRoot, seen);
    o.cache.save();
    const hash = createHash('sha256').update(`guildwise-tree-v2\0${root}\0${top}`).digest('hex');
    return {
      kind: 'ok',
      hash,
      ...(manifest ? { manifest } : {}),
      ...(entries === 0 ? { empty: true } : {}),
    };
  } catch (err) {
    o.cache.save();
    if (err instanceof Pending) return { kind: 'pending', reason: err.message };
    if (err instanceof Refused) return { kind: 'fail', reason: err.message };
    return { kind: 'fail', reason: String(err) };
  }
}

/**
 * Reads every file of `root` whose digest is not cached yet, asynchronously (no budget), so the next synchronous check
 * fits its budget. Waits until fresh files are `racyMs` old before caching them.
 */
export async function warmTree(
  root: string,
  cache: DigestCache,
  o: {
    now?: () => number;
    racyMs?: number;
    sleep?: (ms: number) => Promise<void>;
    exclude?: readonly string[];
  } = {},
): Promise<void> {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return;
  }
  const now = o.now ?? Date.now;
  const racyMs = o.racyMs ?? DEFAULT_RACY_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  let youngest = 0;
  const excluded = excludedIn(realRoot, o.exclude);
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st: BigIntStats;
      try {
        st = await lstat(p, { bigint: true });
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!excluded.includes(p)) await walk(p);
      } else if (st.isFile() && !cache.get(p, statKey(st))) {
        const ageMs = now() - Number(st.ctimeNs / 1_000_000n);
        if (ageMs < racyMs) {
          youngest = Math.max(youngest, racyMs - ageMs);
          continue;
        }
        try {
          const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const a = await fh.stat({ bigint: true });
            if (statKey(a) !== statKey(st)) continue;
            const h = createHash('sha256');
            for await (const chunk of fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
            const b = await fh.stat({ bigint: true });
            if (statKey(b) === statKey(st)) cache.set(p, statKey(st), h.digest('hex'));
          } finally {
            await fh.close();
          }
        } catch {
          /* gone or unreadable: the synchronous check decides */
        }
      }
    }
  };
  await walk(realRoot);
  if (youngest > 0) {
    await sleep(youngest + 50);
    await walk(realRoot);
  }
  cache.save();
}
