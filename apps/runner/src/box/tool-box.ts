import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { assertNotAgentSession, checkSeal, readPolicyKey, seal } from '../policy/integrity.ts';
import { writeFileAtomic } from '../policy/store.ts';
import type { ExecOptions, ExecResult, Executor } from '../toolchain/exec.ts';
import { underRoot } from './folder-check.ts';
import {
  DigestCache,
  type Manifest,
  rootTreeHash,
  type TreeHashOptions,
  type TreeResult,
  warmTree,
} from './tree-hash.ts';

/**
 * quiet-approvals phase B (R4-B1 "nothing box-writable is executed outside a box"):
 *
 * 1. The tool box: `env.ensure` checks and installs, and the detection-root writes, run in a runner-built box with the
 *    toolchains root and the user-space tool folders writable, the project's clone writable for its dependency steps, a
 *    private home, and nothing private present (no runner data dir, no policy dir, no `~/.ssh`, no Claude login).
 * 2. Tree pins: the bin folders under the toolchains root are pinned by a content hash (sealed `tree-pins.json` in the
 *    policy dir), recorded when the runner itself installed there, and checked before a folder goes on any unboxed PATH; a
 *    folder whose content changed outside the runner's own installs stays off until pinned again.
 * `<root>/devops-tools` is never on an unboxed PATH.
 */

// ---------------------------------------------------------------- tree pins

const cache = new Map<string, { stamp: string; hash: string }>();

/** sha256 over a bin folder's entries (name, kind, mode, link target or content), non-recursive, cached by stat. */
export function binTreeHash(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return null;
  }
  const stamp = names
    .map((n) => {
      try {
        const s = lstatSync(join(dir, n));
        return `${n}:${s.mode}:${s.size}:${s.mtimeMs}:${s.ino}`;
      } catch {
        return `${n}:gone`;
      }
    })
    .join('|');
  const hit = cache.get(dir);
  if (hit && hit.stamp === stamp) return hit.hash;
  const h = createHash('sha256');
  for (const n of names) {
    const p = join(dir, n);
    try {
      const s = lstatSync(p);
      h.update(`${n}\0${s.mode}\0`);
      if (s.isSymbolicLink()) h.update(`link:${readlinkSync(p)}`);
      else if (s.isFile()) h.update(createHash('sha256').update(readFileSync(p)).digest('hex'));
      else h.update('dir');
      h.update('\n');
    } catch {
      h.update(`${n}\0gone\n`);
    }
  }
  const hash = h.digest('hex');
  cache.set(dir, { stamp, hash });
  return hash;
}

export const TREE_PINS_FILE = 'tree-pins.json';
export const TREE_PIN_CACHE_FILE = 'tree-pin-cache.json';
export const TREE_PIN_MANIFEST_DIR = 'tree-pin-manifest';

/**
 * tool-pin-lib: which tool folders are guarded. `whole`: pinned as a whole (`rootTreeHash`), the Guildwise tool folder,
 * the only one any box may write. `legacy`: the user's own tool folders, read-only in every box, whose `bin` folders keep
 * the non-recursive pin of quiet-approvals R4-B1 (S1: every guard use takes both lists; only the box plans take the
 * writable one).
 */
export interface GuardRoots {
  whole: string[];
  legacy: string[];
}

/** The user-space tool folders of the user's own installs (read-only in every box; their bin folders stay pinned). */
export const LEGACY_TOOL_ROOTS = [
  '.dotnet',
  '.nvm',
  '.cargo',
  '.rustup',
  '.bun',
  '.pyenv',
  'go',
  '.sdkman',
  '.deno',
  '.volta',
] as const;

export function legacyToolRoots(home: string): string[] {
  return LEGACY_TOOL_ROOTS.map((r) => join(home, r)).filter((p) => existsSync(p));
}

export function guardRoots(home: string, toolchainsRoot: string): GuardRoots {
  return { whole: [toolchainsRoot], legacy: legacyToolRoots(home) };
}

/** Every guarded root, whole first. */
export const allGuarded = (g: GuardRoots): string[] => [...g.whole, ...g.legacy];

export type RootState = 'ok' | 'changed' | 'unpinned' | 'pending' | 'failed' | 'absent';
export interface RootStatus {
  state: RootState;
  /** The current hash (ok, changed, unpinned): what the trust step binds to. */
  hash?: string;
  reason?: string;
}

/** The trust code of a pinned legacy bin folder that changed (its path mixed in, like a whole root's hash). */
export const binTrustCode = (dir: string, hash: string): string =>
  createHash('sha256').update(`guildwise-bin-v2\0${dir}\0${hash}`).digest('hex');

/** The code of a root that cannot be trusted as it is (a link out of it, a mount, a device): shown, never pinned. */
export const refusedCode = (root: string, reason: string): string =>
  createHash('sha256').update(`guildwise-refused\0${root}\0${reason}`).digest('hex');

export interface PinFile {
  /** 0: no file; 1: the quiet-approvals format (bin folders only); 2: this one. */
  version: 0 | 1 | 2;
  roots: Record<string, string>;
  bins: Record<string, string>;
  /** A file that exists but whose seal does not check (everything waits). */
  bad?: boolean;
}

const realOr = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** Sleeps synchronously (the lock below; the CLI and the runner write the pin file from different processes). */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Review N1: one writer of `tree-pins.json` at a time (the runner and the CLI). An exclusive lock file; one older than
 * 30 s is left from a crash and is taken over.
 */
export function withFileLock<T>(lock: string, fn: () => T, waitMs = 10_000): T {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > until) throw new Error(`${lock} is held by another writer`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

export interface TreePinsOptions {
  /** Bytes a synchronous check may read (default 32 MB). */
  budgetBytes?: number;
  racyMs?: number;
  now?: () => number;
  /** Keep the digest cache in memory only (tests). */
  memoryCache?: boolean;
}

export class TreePins {
  readonly cache: DigestCache;
  private memo = new Map<string, RootStatus>();
  private memoArmed = false;
  private warming = new Map<string, Promise<void>>();
  /** Told about every freshly computed status of a whole root (the runner raises or clears the trust step). */
  onStatus?: (root: string, s: RootStatus) => void;

  constructor(
    readonly policyDir: string,
    private readonly warn: (m: string) => void = () => {},
    private readonly opts: TreePinsOptions = {},
  ) {
    this.cache = opts.memoryCache
      ? new DigestCache()
      : new DigestCache(join(policyDir, TREE_PIN_CACHE_FILE), policyDir);
  }

  private file(): string {
    return join(this.policyDir, TREE_PINS_FILE);
  }

  /** The sealed pin file (v1 read as bins only: its roots need the owner's yes once, Decision 1). */
  read(): PinFile {
    let raw: string;
    try {
      raw = readFileSync(this.file(), 'utf8');
    } catch {
      return { version: 0, roots: {}, bins: {} };
    }
    try {
      const { check, body } = checkSeal(this.policyDir, JSON.parse(raw));
      if (check !== 'ok') {
        if (check !== 'no_key')
          this.warn(`${this.file()} has a ${check} seal: every toolchain folder waits for a pin`);
        return { version: 2, roots: {}, bins: {}, bad: true };
      }
      const b = body as { v?: unknown; roots?: unknown; bins?: unknown; pins?: unknown };
      const rec = (v: unknown): Record<string, string> =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).filter(([, h]) => typeof h === 'string'))
          : {};
      if (b.v === 2) return { version: 2, roots: rec(b.roots), bins: rec(b.bins) };
      return { version: 1, roots: {}, bins: rec(b.pins) };
    } catch {
      return { version: 2, roots: {}, bins: {}, bad: true };
    }
  }

  /** Writes the pin file (v2) under the lock; `change` edits a fresh read of it. */
  private write(change: (f: PinFile) => void): boolean {
    assertNotAgentSession();
    const key = readPolicyKey(this.policyDir);
    if (!key) return false;
    withFileLock(join(this.policyDir, `${TREE_PINS_FILE}.lock`), () => {
      const f = this.read();
      const next: PinFile = {
        version: 2,
        roots: f.bad ? {} : { ...f.roots },
        bins: f.bad ? {} : { ...f.bins },
      };
      change(next);
      writeFileAtomic(
        this.file(),
        `${JSON.stringify(seal(key, { v: 2, roots: next.roots, bins: next.bins }))}\n`,
        0o600,
      );
    });
    this.clearMemo();
    return true;
  }

  /** Forgets this tick's verdicts (they are kept until the next turn of the event loop). */
  clearMemo(): void {
    this.memo.clear();
  }

  private hashOpts(extra: Partial<TreeHashOptions> = {}): TreeHashOptions {
    return {
      cache: this.cache,
      ...(this.opts.budgetBytes !== undefined ? { budgetBytes: this.opts.budgetBytes } : {}),
      ...(this.opts.racyMs !== undefined ? { racyMs: this.opts.racyMs } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...extra,
    };
  }

  private toStatus(root: string, r: TreeResult, pinned: string | undefined): RootStatus {
    if (r.kind === 'absent') return { state: 'absent' };
    if (r.kind === 'pending') return { state: 'pending', reason: r.reason };
    if (r.kind === 'fail') return { state: 'failed', reason: r.reason };
    if (!pinned) return { state: 'unpinned', hash: r.hash, reason: `${root} has no earlier record` };
    return r.hash === pinned ? { state: 'ok', hash: r.hash } : { state: 'changed', hash: r.hash };
  }

  /** The verdict of a whole root right now (memoized for this turn of the event loop; `pending` starts `warm`). */
  status(root: string): RootStatus {
    const hit = this.memo.get(root);
    if (hit) return hit;
    const s = this.toStatus(root, rootTreeHash(root, this.hashOpts()), this.read().roots[root]);
    this.memo.set(root, s);
    if (!this.memoArmed) {
      this.memoArmed = true;
      setImmediate(() => {
        this.memoArmed = false;
        this.memo.clear();
      });
    }
    if (s.state === 'pending') void this.warm(root);
    this.onStatus?.(root, s);
    return s;
  }

  /** Reads what the cache lacks, asynchronously, so the next check fits its budget. One warm per root at a time. */
  warm(root: string): Promise<void> {
    const cur = this.warming.get(root);
    if (cur) return cur;
    const p = warmTree(root, this.cache, {
      ...(this.opts.racyMs !== undefined ? { racyMs: this.opts.racyMs } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
    })
      .catch((err) => this.warn(`could not check ${root}: ${String(err)}`))
      .finally(() => {
        this.warming.delete(root);
        this.memo.delete(root);
      });
    this.warming.set(root, p);
    return p;
  }

  /** The guarded root (real path) `p` lies under, and whether it is a whole root. */
  private rootOf(p: string, g: GuardRoots): { root: string; whole: boolean } | null {
    const real = realOr(p);
    const lexical = resolve(p);
    for (const [list, whole] of [
      [g.whole, true],
      [g.legacy, false],
    ] as const)
      for (const r of list) {
        const rr = realOr(r);
        if ((real && rr && underRoot(real, rr)) || underRoot(lexical, resolve(r))) return { root: r, whole };
      }
    return null;
  }

  /**
   * May this bin folder go on an unboxed PATH? Under a whole root: that root verifies. Under a legacy root: the folder
   * matches its own pin (R4-B1, unchanged). Under no guarded root: not this check's business.
   */
  ok(dir: string, g: GuardRoots): boolean {
    if (!realOr(dir)) return false;
    const at = this.rootOf(dir, g);
    if (!at) return true;
    if (at.whole) return this.status(at.root).state === 'ok';
    const want = this.read().bins[dir];
    return !!want && binTreeHash(dir) === want;
  }

  /** The entry rule for read folders and variable values: false only when `p` lies in a whole root that fails. */
  pathOk(p: string, g: GuardRoots): boolean {
    const at = this.rootOf(p, g);
    return !at || !at.whole || this.status(at.root).state === 'ok';
  }

  /**
   * Pre-review 1: may this legacy root be mounted and put on an installer PATH? Every pinned bin folder under it still
   * matches its pin (a root with no pinned folder passes, as before).
   */
  legacyRootOk(root: string): boolean {
    const r = resolve(root);
    for (const [d, want] of Object.entries(this.read().bins))
      if (underRoot(resolve(d), r) && binTreeHash(d) !== want) return false;
    return true;
  }

  /** A pinned legacy bin folder whose content changed: its trust code, else null. */
  changedBin(dir: string): string | null {
    const want = this.read().bins[dir];
    const h = binTreeHash(dir);
    return want && h && h !== want ? binTrustCode(dir, h) : null;
  }

  private writeManifest(root: string, hash: string, manifest: Manifest | undefined): void {
    if (!manifest) return;
    try {
      const dir = join(this.policyDir, TREE_PIN_MANIFEST_DIR);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(
        join(dir, `${createHash('sha256').update(root).digest('hex')}.json`),
        JSON.stringify({ root, hash, at: new Date().toISOString(), entries: manifest }),
        0o600,
      );
    } catch (err) {
      this.warn(`could not keep the record of ${root}: ${String(err)}`);
    }
  }

  /** The manifest recorded when `root` was last pinned (the trust step's "what changed"), or null. */
  manifestOf(root: string): { hash: string; entries: Manifest } | null {
    try {
      const m = JSON.parse(
        readFileSync(
          join(
            this.policyDir,
            TREE_PIN_MANIFEST_DIR,
            `${createHash('sha256').update(root).digest('hex')}.json`,
          ),
          'utf8',
        ),
      ) as { root?: string; hash?: string; entries?: Manifest };
      return m.root === root && typeof m.hash === 'string' && m.entries
        ? { hash: m.hash, entries: m.entries }
        : null;
    } catch {
      return null;
    }
  }

  /** The full hash (no budget) and manifest of a root right now. */
  fullHash(root: string): TreeResult {
    return rootTreeHash(root, this.hashOpts({ budgetBytes: Number.POSITIVE_INFINITY, manifest: true }));
  }

  /**
   * Records the current content (only after the runner's own install, the one-time adoption, or the owner's yes).
   * `expect`: pin a root only while its hash still equals this one (the trust step, and S6's "only roots that still
   * match"). Returns the roots pinned.
   */
  pin(roots: readonly string[], bins: readonly string[] = [], expect?: Record<string, string>): string[] {
    const hashes: Record<string, { hash: string; manifest?: Manifest }> = {};
    for (const r of roots) {
      const h = this.fullHash(r);
      if (h.kind !== 'ok') {
        if (h.kind === 'fail' || h.kind === 'pending') this.warn(`${r} was not pinned: ${h.reason}`);
        continue;
      }
      if (expect && expect[r] !== h.hash) continue;
      hashes[r] = { hash: h.hash, ...(h.manifest ? { manifest: h.manifest } : {}) };
    }
    const binHashes: Record<string, string> = {};
    for (const d of bins) {
      const h = binTreeHash(d);
      if (h) binHashes[d] = h;
    }
    if (!Object.keys(hashes).length && !Object.keys(binHashes).length) return [];
    const wrote = this.write((f) => {
      for (const [r, h] of Object.entries(hashes)) f.roots[r] = h.hash;
      Object.assign(f.bins, binHashes);
    });
    if (!wrote) return [];
    for (const [r, h] of Object.entries(hashes)) this.writeManifest(r, h.hash, h.manifest);
    return Object.keys(hashes);
  }

  /** Records a legacy bin folder after the owner's yes, while its content still has this trust code. */
  pinBin(dir: string, code: string): boolean {
    const h = binTreeHash(dir);
    if (!h || binTrustCode(dir, h) !== code) return false;
    return this.write((f) => {
      f.bins[dir] = h;
    });
  }

  /** `pin` after warming the cache asynchronously (the runner: S3, no long synchronous hash on its event loop). */
  async pinAsync(
    roots: readonly string[],
    expect?: Record<string, string> | (() => Record<string, string> | undefined),
  ): Promise<string[]> {
    for (const r of roots) await this.warm(r);
    // review S2: a function is asked right before the synchronous pin (after the asynchronous warm), so nothing that
    // happened during the warm is missed
    return this.pin(roots, [], typeof expect === 'function' ? expect() : expect);
  }

  /** The v1 -> v2 rewrite: keeps the legacy bin pins, drops everything under a whole root (it needs the owner's yes). */
  upgradeV1(g: GuardRoots): void {
    const f = this.read();
    if (f.version !== 1) return;
    this.write((n) => {
      for (const d of Object.keys(n.bins))
        if (g.whole.some((r) => underRoot(resolve(d), resolve(r)))) delete n.bins[d];
    });
  }
}

// ---------------------------------------------------------------- the tool box

export interface ToolBoxPlan {
  /** Writable tool folders: only the Guildwise tool folder, and only in the recipe box (tool-pin-lib Decision). */
  writable: string[];
  /** Read-only tool folders: the other verified roots (both boxes) and, in the deps box, every root. */
  readonly?: string[];
  /** Writable for dependency steps: the project's clone (deps box only). */
  repoDirs: string[];
  /** The box's private home (caches). */
  home: string;
}

/**
 * The tool folders a box may write: the Guildwise tool folder only (tool-pin-lib). The user's own folders (`~/.nvm`,
 * `~/.cargo`, `~/.dotnet`, ...) are read-only in every box and keep their bin pins (`legacyToolRoots`).
 */
export function toolBoxWritable(_home: string, toolchainsRoot: string): string[] {
  return [toolchainsRoot].filter((p) => existsSync(p));
}

/**
 * The recipe box (tool installs and checks): the Guildwise tool folder writable when it verified, the other verified
 * roots read-only, a private home, and no project clone.
 */
export function recipeBoxPlan(before: readonly string[], toolchainsRoot: string, home: string): ToolBoxPlan {
  return {
    writable: before.filter((r) => r === toolchainsRoot && existsSync(r)),
    readonly: before.filter((r) => r !== toolchainsRoot && existsSync(r)),
    repoDirs: [],
    home,
  };
}

/**
 * The deps box (a project's own install steps): every verified root read-only, the clone writable, a home of that
 * repository's own. A clone inside a tool folder is refused (it would make the folder writable).
 */
export function depsBoxPlan(before: readonly string[], repoDir: string, home: string): ToolBoxPlan {
  const repo = resolve(repoDir);
  for (const r of before)
    if (underRoot(repo, resolve(r)) || underRoot(realOr(repo) ?? repo, realOr(r) ?? resolve(r)))
      throw new Error(`the clone ${repoDir} lies inside the tool folder ${r}: its install steps cannot run`);
  return { writable: [], readonly: before.filter((r) => existsSync(r)), repoDirs: [repoDir], home };
}

/** bubblewrap arguments of the tool box around one command (`--share-net`: installs download; nothing private present). */
export function toolBoxArgs(plan: ToolBoxPlan, cwd: string | undefined): string[] {
  const args = [
    '--unshare-all',
    '--share-net',
    '--unshare-user',
    '--disable-userns',
    '--new-session',
    '--die-with-parent',
    '--cap-drop',
    'ALL',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/etc',
    '/etc',
  ];
  for (const d of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
    try {
      if (lstatSync(d).isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
      else if (statSync(d).isDirectory()) args.push('--ro-bind', d, d);
    } catch {
      // not on this distribution
    }
  }
  if (existsSync('/etc/ssh')) args.push('--tmpfs', '/etc/ssh');
  // review N2: one list sorted by length, so a read-only folder inside a writable one stays read-only (and the other
  // way round); a folder in both lists is read-only. The working folder is bound only inside a clone of the plan.
  const ro = new Set(plan.readonly ?? []);
  const rw = new Set(
    [
      plan.home,
      ...plan.writable,
      ...plan.repoDirs,
      ...(cwd && plan.repoDirs.some((r) => underRoot(resolve(cwd), resolve(r))) ? [cwd] : []),
    ].filter((p) => !ro.has(p)),
  );
  const binds = [...[...rw].map((p) => ({ p, ro: false })), ...[...ro].map((p) => ({ p, ro: true }))]
    .filter((b) => existsSync(b.p))
    .sort((a, b) => a.p.length - b.p.length);
  for (const b of binds) args.push(b.ro ? '--ro-bind' : '--bind', b.p, b.p);
  return args;
}

/** An executor that runs every command inside the tool box described by `plan`. */
export function toolBoxExecutor(base: Executor, plan: ToolBoxPlan, bwrap = 'bwrap'): Executor {
  return {
    run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
      const env = {
        ...(opts.env ?? {}),
        HOME: plan.home,
        PATH: [
          ...[...plan.writable, ...(plan.readonly ?? [])].map((w) => join(w, 'bin')),
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
        ].join(delimiter),
      };
      return base.run(bwrap, [...toolBoxArgs(plan, opts.cwd), '--', cmd, ...args], {
        ...opts,
        env,
        exactEnv: true,
      });
    },
  };
}
