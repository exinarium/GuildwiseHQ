import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { writeFileAtomic } from '../policy/store.ts';
import { ledgerRepoKey } from './branch-ledger.ts';
import { git } from './git.ts';
import { clonesUnder, materializeLooseRefs, WRITER_MARK } from './harden.ts';

/**
 * gate-fixes-2 P1: the runner pushes or merges only tips it made or recorded itself.
 *
 * Every sandboxed agent session that may commit (card shifts, the harness box, work-mention chats, a DevOps shift over
 * a code folder: "writers") can write the clone's shared `.git`: branch refs, remote-tracking refs, tags and objects.
 * So a branch tip in the shared clone proves nothing about who made it. The TipStore
 * (`<dataDir>/pushable-tips.json`, mode 600, in `RUNNER_PRIVATE`, written atomically like the branch ledger) keeps the
 * LATEST tip the runner made or measured per ref, and per clone the snapshots of D2:
 *
 * - Rule A: a local branch is pushed only when its tip is the latest record (by sha), or a change the user made while no
 *   writer ran (`user`, D2) on top of a trusted tip. Otherwise it is `notPushed`, an `error` finding.
 * - Rule D: a card branch is finalized only at the latest record of that card's own shift end or a runner move.
 * - D2: the writer count per clone (keyed by the real path of the common `.git`, never by the remote URL), `startTips`
 *   at 0->1, `idleTips` at 1->0, `active` written before the sandbox starts and cleared with `idleTips`.
 * - D3: one-time seeding at the first start of this version (a `seeded` marker per data dir); an unreadable store, or a
 *   missing store with the marker present, fails closed.
 *
 * The remaining gap until D1: objects themselves (same sha, other content). See DESIGN.md D1 and CHANGES.md.
 */

export const TIP_STORE_FILE = 'pushable-tips.json';
export const TIP_SEEDED_MARKER = 'pushable-tips.seeded';

export type TipHow =
  | 'created'
  | 'conflict-ff'
  | 'rebased'
  | 'merged'
  | 'shift-end'
  | 'docs-prep'
  | 'tag'
  | 'user'
  | 'seed';
const HOWS: readonly TipHow[] = [
  'created',
  'conflict-ff',
  'rebased',
  'merged',
  'shift-end',
  'docs-prep',
  'tag',
  'user',
  'seed',
];

export interface TipRecord {
  /** `ledgerRepoKey` of the clone (normalized origin URL): a sha means the same content in every clone of it. */
  repo: string;
  /** A full ref name: `refs/heads/<b>`, `refs/tags/<t>`, `refs/guildwise/<...>`. */
  ref: string;
  sha: string;
  how: TipHow;
  pushed: boolean;
  at: string;
}

/** Per clone (keyed by the real path of its common `.git`). */
export interface CloneTips {
  /** A writer is running (written before its sandbox starts; a restart that finds it set distrusts the tips). */
  active?: boolean;
  /** `refs/heads/*` at 0->1. */
  startTips?: Record<string, string>;
  /** `refs/heads/*` at 1->0 (or at seeding): the start of the idle window. */
  idleTips?: Record<string, string>;
  at: string;
}

interface StoreData {
  records: TipRecord[];
  clones: Record<string, CloneTips>;
}

const SHA = /^[0-9a-f]{40,64}$/;
const MAX_RECORDS = 20_000;

export class TipStoreUnreadable extends Error {}

export class TipStore {
  /** In memory only: the number of running writers per clone key. A restart starts at 0 (R3-B1 handles `active`). */
  readonly writers = new Map<string, number>();

  constructor(
    readonly file: string,
    readonly marker: string,
    private readonly warn: (m: string) => void = () => {},
  ) {}

  static forRoot(root: string, warn?: (m: string) => void): TipStore {
    return new TipStore(join(root, TIP_STORE_FILE), join(root, TIP_SEEDED_MARKER), warn);
  }

  get seeded(): boolean {
    return existsSync(this.marker);
  }

  /** The store, or throws `TipStoreUnreadable` (fail closed): a broken file, or none while the marker says it existed. */
  load(): StoreData {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !this.seeded)
        return { records: [], clones: {} };
      throw new TipStoreUnreadable(`the runner's push records (${this.file}) cannot be read`);
    }
    try {
      const v = JSON.parse(text) as Partial<StoreData>;
      if (
        !v ||
        typeof v !== 'object' ||
        !Array.isArray(v.records) ||
        typeof v.clones !== 'object' ||
        !v.clones
      )
        throw new Error('shape');
      return {
        records: v.records.filter(
          (r): r is TipRecord =>
            !!r &&
            typeof r.repo === 'string' &&
            typeof r.ref === 'string' &&
            SHA.test(String(r.sha)) &&
            HOWS.includes(r.how),
        ),
        clones: v.clones as Record<string, CloneTips>,
      };
    } catch {
      throw new TipStoreUnreadable(`the runner's push records (${this.file}) are damaged`);
    }
  }

  private save(d: StoreData): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(
      this.file,
      `${JSON.stringify({ records: d.records.slice(-MAX_RECORDS), clones: d.clones }, null, 1)}\n`,
      0o600,
    );
  }

  /** One read-modify-write cycle (synchronous: two callers of one process cannot interleave inside it). */
  update<T>(f: (d: StoreData) => T): T {
    const d = this.load();
    const out = f(d);
    this.save(d);
    return out;
  }

  latest(repo: string, ref: string): TipRecord | null {
    return this.load().records.find((r) => r.repo === repo && r.ref === ref) ?? null;
  }

  /** Records the latest tip of `ref` (replacing the earlier record: S11, latest only). */
  record(repo: string, ref: string, sha: string, how: TipHow, pushed = false): void {
    if (!SHA.test(sha)) return;
    this.update((d) => {
      d.records = d.records.filter((r) => !(r.repo === repo && r.ref === ref));
      d.records.push({ repo, ref, sha, how, pushed, at: new Date().toISOString() });
    });
  }

  markPushed(repo: string, ref: string, sha: string): void {
    this.update((d) => {
      for (const r of d.records) if (r.repo === repo && r.ref === ref && r.sha === sha) r.pushed = true;
    });
  }

  /** S12: a record is kept until its branch is deleted. */
  drop(repo: string, ref: string): void {
    this.update((d) => {
      d.records = d.records.filter((r) => !(r.repo === repo && r.ref === ref));
    });
  }

  clone(key: string): CloneTips | undefined {
    return this.load().clones[key];
  }

  setClone(key: string, c: Omit<CloneTips, 'at'>): void {
    this.update((d) => {
      d.clones[key] = { ...c, at: new Date().toISOString() };
    });
  }

  count(key: string): number {
    return this.writers.get(key) ?? 0;
  }

  /** D3: written once per data dir after the first seeding. */
  markSeeded(): void {
    mkdirSync(dirname(this.marker), { recursive: true, mode: 0o700 });
    writeFileSync(this.marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    // the store must exist from now on (a missing one then fails closed)
    if (!existsSync(this.file)) this.save({ records: [], clones: {} });
  }

  warnOf(m: string): void {
    this.warn(m);
  }
}

/** The runner's store, set once at start (the test setup sets one per test file). Unset: every push is refused. */
let current: TipStore | null = null;
export const setTipStore = (s: TipStore | null): void => {
  current = s;
};
export const tipStore = (): TipStore | null => current;

/** D2 (R3-B2): the clone key, the real path of the common `.git` of `path` (a clone, a worktree or a `.git`). */
export async function cloneKey(path: string): Promise<string | null> {
  const r = await git(path, ['rev-parse', '--git-common-dir']);
  const out = r.stdout.trim();
  if (r.exitCode !== 0 || !out) return null;
  const abs = isAbsolute(out) ? out : resolve(path, out);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** `refs/heads/*` -> sha of the clone `path` belongs to. */
export async function localTips(path: string): Promise<Record<string, string>> {
  const r = await git(path, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const [ref, sha] = line.trim().split(' ');
    if (ref && sha && SHA.test(sha)) out[ref] = sha;
  }
  return out;
}

const isAncestor = async (cwd: string, a: string, b: string): Promise<boolean> =>
  (await git(cwd, ['merge-base', '--is-ancestor', a, b])).exitCode === 0;

/** The record key of a clone (its origin), or null. */
const repoKeyOf = (path: string): Promise<string> => ledgerRepoKey(path);

/**
 * Records every local tip of a clone the store does not know yet as `seed` and sets its `idleTips` (D3; also for a clone
 * first seen later while no writer ever ran in it under this runner: every writer start snapshots its clone, so a clone
 * without an entry has had no writer since the store exists).
 */
export async function seedClone(store: TipStore, path: string, log?: (m: string) => void): Promise<void> {
  const key = await cloneKey(path);
  if (!key || store.clone(key)) return;
  const tips = await localTips(path);
  // Rework 1 (D5): a writer ran here before (its mark is in the common dir) but the store has no entry (a lost store, a
  // moved clone): the tips are not trusted; only a runner move or an idle-window `user` change makes one trusted again
  if (existsSync(join(key, WRITER_MARK))) {
    store.update((d) => {
      d.clones[key] = { idleTips: tips, at: new Date().toISOString() };
    });
    log?.(
      `push records: ${path} had agent sessions this runner has no record of; its branch tips are not trusted`,
    );
    return;
  }
  const repo = await repoKeyOf(path);
  store.update((d) => {
    for (const [ref, sha] of Object.entries(tips)) {
      // no writer ever ran in this clone (every writer start snapshots its clone), so its tips are the user's or the
      // runner's: they replace a record another clone of the same origin left (a stale one only refuses, never trusts)
      if (d.records.some((r) => r.repo === repo && r.ref === ref && r.sha === sha)) continue;
      d.records = d.records.filter((r) => !(r.repo === repo && r.ref === ref));
      d.records.push({ repo, ref, sha, how: 'seed', pushed: false, at: new Date().toISOString() });
    }
    d.clones[key] = { idleTips: tips, at: new Date().toISOString() };
  });
  log?.(`push records: seeded ${Object.keys(tips).length} branch tip(s) of ${path}`);
}

/** `seedClone` with the runner's store (none: nothing). Never throws. */
export async function knowClone(path: string): Promise<void> {
  if (current) await seedClone(current, path).catch(() => {});
}

/** D3: once per data dir, before any writer starts. */
export async function seedOnce(store: TipStore, clones: string[], log?: (m: string) => void): Promise<void> {
  if (store.seeded) return;
  for (const c of clones) await seedClone(store, c, log).catch(() => {});
  store.markSeeded();
  log?.(`push records: first start of this version, seeded ${clones.length} clone(s)`);
}

/** Is `sha` trusted for `ref`: the latest record of it, or reachable from origin's tip (Rule B sha)? */
async function trusted(
  store: TipStore,
  cwd: string,
  repo: string,
  ref: string,
  sha: string,
  originSha: string | null,
): Promise<boolean> {
  if (store.latest(repo, ref)?.sha === sha) return true;
  return !!originSha && (await isAncestor(cwd, sha, originSha));
}

/**
 * D2 classification of changes made while no writer ran: a ref whose tip differs from `idleTips` becomes `user` when
 * its idle tip was trusted (or the ref is new); otherwise it stays unrecorded (`notPushed` later).
 */
async function classifyIdleChanges(
  store: TipStore,
  path: string,
  key: string,
  tips: Record<string, string>,
): Promise<void> {
  const st = store.clone(key);
  if (!st || st.active) return;
  const repo = await repoKeyOf(path);
  for (const [ref, sha] of Object.entries(tips)) {
    const idle = st.idleTips?.[ref];
    if (idle === sha) continue;
    if (store.latest(repo, ref)?.sha === sha) continue;
    const ok = idle === undefined || (await trusted(store, path, repo, ref, idle, null));
    if (ok) store.record(repo, ref, sha, 'user');
  }
}

/**
 * D2: a writer is about to start in the clone of `path`. On 0->1: idle changes are classified, then `{active, startTips}`
 * is written in one atomic write, before the sandbox starts. Returns the release (idempotent) to call once the sandbox
 * process is dead. Never throws: without a store nothing is recorded (and nothing gets pushed).
 */
export async function writerStart(path: string): Promise<() => Promise<void>> {
  const store = current;
  let released = false;
  const key = store ? await cloneKey(path).catch(() => null) : null;
  if (!store || !key) return async () => {};
  // Rework 2: starts in one clone are serialised, so a second session's sandbox starts only after the first start's
  // snapshot, mark and loose refs are done (nothing it writes can pass for an idle change, its fence sees the loose refs)
  const before = startChains.get(key) ?? Promise.resolve();
  let finished: () => void = () => {};
  const mine = new Promise<void>((r) => {
    finished = r;
  });
  const chain = before.then(() => mine);
  startChains.set(key, chain);
  await before;
  try {
    await startLocked(store, path, key);
  } finally {
    finished();
    if (startChains.get(key) === chain) startChains.delete(key);
  }
  return async () => {
    if (released) return;
    released = true;
    await writerEnd(store, key);
  };
}

/** Writer starts in flight per clone key (Rework 2: serialised). */
const startChains = new Map<string, Promise<void>>();

async function startLocked(store: TipStore, path: string, key: string): Promise<void> {
  const n = store.count(key);
  store.writers.set(key, n + 1);
  if (n === 0) {
    try {
      // seeded (if never seen) BEFORE the mark, then marked BEFORE the sandbox: no later seeding trusts what it writes
      await seedClone(store, path);
      writeFileSync(join(key, WRITER_MARK), `${new Date().toISOString()}\n`, { mode: 0o644 });
      const tips = await localTips(path);
      // S7: packed-only branches get their loose files before the sandbox (and its fence) is built
      materializeLooseRefs(key, tips);
      await classifyIdleChanges(store, path, key, tips);
      const prev = store.clone(key);
      store.setClone(key, { ...prev, active: true, startTips: tips });
    } catch (err) {
      store.warnOf(`push records: writer start not recorded for ${path}: ${String(err)}`);
    }
  }
}

/**
 * D2 for several folders (S13: the folders a DevOps box binds writable): a writer in each one that is inside a git clone.
 * Folders outside any clone are skipped. Returns one release for all.
 */
export async function holdWriters(paths: readonly string[]): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = [];
  // Rework 2: the folder's own clone (it lies inside one) and every clone at or below it that the fence covers
  const targets = new Set<string>();
  for (const p of paths) {
    if (await cloneKey(p).catch(() => null)) targets.add(p);
    for (const c of clonesUnder(p)) targets.add(c);
  }
  for (const t of targets) releases.push(await writerStart(t));
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    for (const r of releases) await r();
  };
}

async function writerEnd(store: TipStore, key: string): Promise<void> {
  const n = store.count(key);
  if (n <= 1) store.writers.delete(key);
  else store.writers.set(key, n - 1);
  if (n !== 1) return;
  try {
    const tips = await localTips(key);
    const prev = store.clone(key);
    // 1->0: `active` is cleared in the same write that stores the idle tips (untrusted unless they equal a record)
    store.setClone(key, { ...prev, active: false, idleTips: tips });
  } catch (err) {
    store.warnOf(`push records: writer end not recorded for ${key}: ${String(err)}`);
  }
}

/**
 * R3-B1: at runner start (after orphan writers were killed, before any writer starts), every clone still marked
 * `active` gets `idleTips` = its current tips, untrusted, and `active` cleared.
 */
export async function recoverActiveClones(store: TipStore, log?: (m: string) => void): Promise<void> {
  let clones: Record<string, CloneTips>;
  try {
    clones = store.load().clones;
  } catch {
    return;
  }
  for (const [key, st] of Object.entries(clones)) {
    if (!st.active) continue;
    const tips = existsSync(key) ? await localTips(key).catch(() => ({})) : {};
    store.setClone(key, { ...st, active: false, idleTips: tips });
    log?.(
      `push records: ${key} had a session running when the runner stopped; its branch tips are not trusted`,
    );
  }
}

export type RuleA =
  | { push: true; how: TipHow }
  | { push: false; nothing: true }
  | { push: false; notPushed: string };

/**
 * Rule A for a local branch `branch` at `tip` (read once by the caller) against origin's Rule B sha (null: origin lacks
 * the branch). The caller has checked that it is a fast-forward. `user` changes are recorded here (D2).
 */
export async function ruleA(
  repoPath: string,
  branch: string,
  tip: string,
  originSha: string | null,
): Promise<RuleA> {
  if (originSha === tip) return { push: false, nothing: true };
  const store = current;
  if (!store) return { push: false, notPushed: 'the runner has no push records here' };
  const ref = `refs/heads/${branch}`;
  try {
    const repo = await repoKeyOf(repoPath);
    const key = await cloneKey(repoPath);
    if (!key) return { push: false, notPushed: 'the clone could not be identified' };
    let rec = store.latest(repo, ref);
    // S11: a pushed record origin no longer descends from (a person removed it there) is dropped
    if (rec?.pushed && originSha && !(await isAncestor(repoPath, rec.sha, originSha))) {
      store.drop(repo, ref);
      rec = null;
    }
    if (rec && rec.sha === tip) return { push: true, how: rec.how };
    if (store.count(key) > 0)
      return {
        push: false,
        notPushed: `${branch} (${tip.slice(0, 10)}) changed while an agent session could write to this clone, and the runner did not make that commit`,
      };
    await seedClone(store, repoPath);
    if (store.latest(repo, ref)?.sha === tip) return { push: true, how: 'seed' };
    const st = store.clone(key);
    if (!st || st.active)
      return {
        push: false,
        notPushed: `${branch}: an agent session was running here when the runner stopped`,
      };
    const idle = st.idleTips?.[ref];
    if (idle === tip)
      return {
        push: false,
        notPushed: `${branch} (${tip.slice(0, 10)}) was left by an agent session; the runner did not make that commit`,
      };
    const ok = idle === undefined || (await trusted(store, repoPath, repo, ref, idle, originSha));
    if (!ok)
      return {
        push: false,
        notPushed: `${branch} (${tip.slice(0, 10)}) sits on top of a commit an agent session left (${idle?.slice(0, 10)})`,
      };
    store.record(repo, ref, tip, 'user');
    return { push: true, how: 'user' };
  } catch (err) {
    return {
      push: false,
      notPushed: err instanceof TipStoreUnreadable ? err.message : `push records: ${String(err)}`,
    };
  }
}

/** Records a tip the runner made or measured (never throws; a failed write only withholds a later push). */
export async function recordTip(
  repoPath: string,
  ref: string,
  sha: string,
  how: TipHow,
  pushed = false,
): Promise<void> {
  const store = current;
  if (!store) return;
  try {
    store.record(await repoKeyOf(repoPath), ref, sha, how, pushed);
  } catch (err) {
    store.warnOf(`push records: ${ref} not recorded: ${String(err)}`);
  }
}

export async function markTipPushed(repoPath: string, ref: string, sha: string): Promise<void> {
  const store = current;
  if (!store) return;
  try {
    store.markPushed(await repoKeyOf(repoPath), ref, sha);
  } catch {}
}

export async function dropTip(repoPath: string, ref: string): Promise<void> {
  const store = current;
  if (!store) return;
  try {
    store.drop(await repoKeyOf(repoPath), ref);
  } catch {}
}

/** The latest record of `ref` in the clone of `repoPath`, or null (also when the store cannot be read). */
export async function latestTip(repoPath: string, ref: string): Promise<TipRecord | null> {
  const store = current;
  if (!store) return null;
  try {
    return store.latest(await repoKeyOf(repoPath), ref);
  } catch {
    return null;
  }
}
