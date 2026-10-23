import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITY_MAX_FILE_BYTES,
  diffPackSnapshots,
  indexPack,
  isScriptPath,
  type PackDesired,
  type PackIndexResult,
  type PackSnapshot,
  type PacksReport,
  type ParsedCapability,
  packSnapshotOf,
} from '@aom/shared';
import { execa } from 'execa';
import { type Logger, nullLogger } from '../log.ts';

/**
 * Capability packs on this workstation (docs/ARCHITECTURE.md section 38.4). A pack is a git repository the owner added by URL
 * and ref; the server pins the commit and records the owner's approval, this class does the git and the file work:
 *
 *  - `sync(desired)` makes the packs on disk match the list: clone/fetch, check out the pinned commit (or resolve the ref when
 *    nothing is pinned yet), index it with the pack adapter and report the snapshot;
 *  - `check(packId, ref)` fetches a ref, and when it points to another commit than the pin reports what changed (never applies it);
 *  - `entries()` returns only what may be used: the pack is approved at exactly this commit AND the files on disk still hash to
 *    the approved content hash. Anything else is disabled and flagged (`integrity`). Script files are removed from what is served
 *    unless the owner enabled scripts for the pack.
 *
 * git runs with hooks off, only the protocols the runner allows (`https`, `ssh`, and `file` in tests), no submodules and no LFS.
 * Pack files are read as text and never executed here.
 */

const MAX_TREE_FILES = 8000;
const MAX_TREE_BYTES = 60 * 1024 * 1024;
const TEXT_EXT =
  /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|sh|bash|py|rb|js|mjs|cjs|ts|ps1|bat|html?|xml|css)$/i;
const TEXT_NAMES = new Set(['SKILL.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt']);
const PRUNED = new Set(['.git', 'node_modules']);

export interface PackFilesState {
  /** path -> `size:mtimeMs`, of the files the index was built from. */
  stamps: Record<string, string>;
}

/** Reads the text files of a checked-out pack into a path -> text map; symlinks, binaries and big files are skipped. */
export function readPackTree(dir: string): {
  tree: Record<string, string>;
  stamps: Record<string, string>;
  truncated: boolean;
} {
  const tree: Record<string, string> = {};
  const stamps: Record<string, string> = {};
  let count = 0;
  let bytes = 0;
  let truncated = false;
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (PRUNED.has(name)) continue;
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, r);
      else if (
        st.isFile() &&
        st.size <= CAPABILITY_MAX_FILE_BYTES &&
        (TEXT_EXT.test(name) || TEXT_NAMES.has(name))
      ) {
        count++;
        bytes += st.size;
        if (count > MAX_TREE_FILES || bytes > MAX_TREE_BYTES) {
          truncated = true;
          return;
        }
        try {
          tree[r] = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
          stamps[r] = `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  walk(dir, '');
  return { tree, stamps, truncated };
}

export interface PackManagerOptions {
  /** `<runner root>/packs`. */
  dir: string;
  log?: Logger;
  /** Where reports go (the runner sends `packs.report`). */
  report: (r: PacksReport) => void;
  /** Allow `file://` and local paths (tests only). */
  allowLocal?: boolean;
  gitBin?: string;
  /** Called after the set of usable capabilities changed. */
  onChange?: () => void;
}

interface Loaded {
  desired: PackDesired;
  sha: string | null;
  index: PackIndexResult | null;
  snapshot: PackSnapshot | null;
  stamps: Record<string, string>;
  /** The files on disk no longer match the approved hash. */
  integrity: 'ok' | 'mismatch';
  error?: string;
}

const dirOf = (root: string, id: string): string => join(root, id);

export class PackManager {
  private readonly log: Logger;
  private packs = new Map<string, Loaded>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: PackManagerOptions) {
    this.log = opts.log ?? nullLogger;
    this.loadState();
  }

  // ------------------------------------------------------------------------------------------------ persistence

  private get stateFile(): string {
    return join(this.opts.dir, 'state.json');
  }

  /** What was last asked for survives a restart, so shifts that resume before the server answers still find their skills. */
  private loadState(): void {
    try {
      const desired = JSON.parse(readFileSync(this.stateFile, 'utf8')) as PackDesired[];
      for (const d of desired) this.packs.set(d.packId, this.indexFromDisk(d));
    } catch {
      // first start
    }
  }

  private saveState(): void {
    mkdirSync(this.opts.dir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify([...this.packs.values()].map((p) => p.desired)));
  }

  // ------------------------------------------------------------------------------------------------ git

  private async git(cwd: string, args: string[], timeout = 180_000): Promise<string> {
    const allow = this.opts.allowLocal ? 'https:ssh:file' : 'https:ssh';
    const r = await execa(
      this.opts.gitBin ?? 'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'submodule.recurse=false',
        '-c',
        'protocol.ext.allow=never',
        '-c',
        'filter.lfs.smudge=',
        '-c',
        'filter.lfs.process=',
        '-c',
        'filter.lfs.required=false',
        '-c',
        'advice.detachedHead=false',
        ...args,
      ],
      {
        cwd,
        timeout,
        extendEnv: false,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
          GIT_TERMINAL_PROMPT: '0',
          GIT_ALLOW_PROTOCOL: allow,
          GIT_LFS_SKIP_SMUDGE: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          LANG: 'C',
        },
        reject: true,
      },
    );
    return r.stdout.trim();
  }

  private repoDir(id: string): string {
    return join(dirOf(this.opts.dir, id), 'repo');
  }

  private async ensureRepo(d: PackDesired): Promise<string> {
    const repo = this.repoDir(d.packId);
    if (!existsSync(join(repo, '.git'))) {
      mkdirSync(repo, { recursive: true });
      await this.git(repo, ['init', '-q']);
    }
    // the URL can be corrected by the owner: always set it
    await this.git(repo, ['remote', 'remove', 'origin']).catch(() => undefined);
    await this.git(repo, ['remote', 'add', 'origin', d.url]);
    return repo;
  }

  /** Fetches `what` (a ref or a commit) shallowly and returns the commit it points to. */
  private async fetchCommit(repo: string, what: string): Promise<string> {
    await this.git(repo, ['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', what]);
    return this.git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  }

  private async checkout(repo: string, sha: string): Promise<void> {
    await this.git(repo, ['checkout', '-q', '--detach', '--force', sha]);
    await this.git(repo, ['clean', '-fdxq']);
  }

  // ------------------------------------------------------------------------------------------------ indexing

  private indexDir(d: PackDesired, dir: string, sha: string, ref: string): Loaded {
    const { tree, stamps, truncated } = readPackTree(dir);
    const index = indexPack({ name: d.name, adapter: d.adapter, tree });
    if (truncated)
      index.issues.push({
        path: '.',
        message: 'the pack has too many or too large files; the rest was ignored',
      });
    for (const e of index.entries) e.pack = { name: d.name, sha };
    const snapshot = packSnapshotOf({ name: d.name, ref, sha, index });
    return { desired: d, sha, index, snapshot, stamps, integrity: 'ok' };
  }

  /** Re-indexes what is on disk without the network (after a restart, or when a file changed). */
  private indexFromDisk(d: PackDesired): Loaded {
    const repo = this.repoDir(d.packId);
    try {
      const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
      if (!/^[0-9a-f]{40,64}$/.test(head)) return this.empty(d);
      const l = this.indexDir(d, repo, head, d.ref);
      return this.judge(l);
    } catch {
      return this.empty(d);
    }
  }

  private empty(d: PackDesired): Loaded {
    return { desired: d, sha: null, index: null, snapshot: null, stamps: {}, integrity: 'ok' };
  }

  /** Compares the indexed content with what the owner approved. */
  private judge(l: Loaded): Loaded {
    const t = l.desired.trusted;
    if (t && l.snapshot && l.sha === t.sha && l.snapshot.contentHash !== t.contentHash)
      l.integrity = 'mismatch';
    else l.integrity = 'ok';
    return l;
  }

  private usable(l: Loaded): boolean {
    const t = l.desired.trusted;
    return !!(
      t &&
      l.snapshot &&
      l.sha === t.sha &&
      l.snapshot.contentHash === t.contentHash &&
      l.integrity === 'ok'
    );
  }

  /**
   * Before a pack's content is served: have the files changed since they were indexed? A changed file triggers a re-read and
   * a new comparison with the approved hash; a mismatch disables the pack and tells the server.
   */
  private verify(l: Loaded): void {
    if (!l.index || !l.sha) return;
    const repo = this.repoDir(l.desired.packId);
    let changed = false;
    for (const [p, stamp] of Object.entries(l.stamps)) {
      try {
        const st = statSync(join(repo, p));
        if (`${st.size}:${Math.trunc(st.mtimeMs)}` !== stamp) {
          changed = true;
          break;
        }
      } catch {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const was = l.integrity;
    const next = this.indexFromDisk(l.desired);
    Object.assign(l, next);
    if (l.integrity === 'mismatch' && was !== 'mismatch') {
      this.log.warn(`pack ${l.desired.name}: files changed on disk, the pack is disabled`);
      this.opts.report({
        packId: l.desired.packId,
        state: 'integrity',
        expected: l.desired.trusted?.contentHash ?? '',
        actual: l.snapshot?.contentHash ?? '',
        ...(l.sha ? { sha: l.sha as never } : {}),
      });
      this.opts.onChange?.();
    }
  }

  // ------------------------------------------------------------------------------------------------ commands

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** `packs.sync`: bring the packs on this workstation to the list. */
  sync(desired: PackDesired[]): Promise<void> {
    return this.serial(async () => {
      const ids = new Set(desired.map((d) => d.packId));
      for (const [id] of this.packs)
        if (!ids.has(id)) {
          rmSync(dirOf(this.opts.dir, id), { recursive: true, force: true });
          this.packs.delete(id);
        }
      for (const d of desired) await this.syncOne(d);
      this.saveState();
      this.opts.onChange?.();
    });
  }

  private async syncOne(d: PackDesired): Promise<void> {
    const prev = this.packs.get(d.packId);
    try {
      const sameSource =
        prev && prev.desired.url === d.url && prev.sha && (!d.pinnedSha || prev.sha === d.pinnedSha);
      if (sameSource && prev.sha) {
        // already on the right commit: only trust and scripts may have changed
        const l: Loaded = { ...prev, desired: d };
        this.judge(l);
        this.packs.set(d.packId, l);
        this.verify(l);
        if (l.snapshot && !prev.snapshot) this.reportResolved(l);
        else if (l.integrity === 'mismatch') this.reportIntegrity(l);
        else if (!d.pinnedSha) this.reportResolved(l);
        return;
      }
      const repo = await this.ensureRepo(d);
      const sha = d.pinnedSha ? await this.fetchPinned(repo, d) : await this.fetchCommit(repo, d.ref);
      await this.checkout(repo, sha);
      const l = this.judge(this.indexDir(d, repo, sha, d.ref));
      this.packs.set(d.packId, l);
      this.reportResolved(l);
      if (l.integrity === 'mismatch') this.reportIntegrity(l);
    } catch (err) {
      const message = scrub(err);
      this.log.warn(`pack ${d.name}: ${message}`);
      const keep = prev ?? this.empty(d);
      keep.desired = d;
      keep.error = message;
      this.packs.set(d.packId, keep);
      this.opts.report({ packId: d.packId, state: 'failed', message });
    }
  }

  /** The pinned commit: fetch it directly, else the ref when it still points to it. A moved ref is an error, never a silent change. */
  private async fetchPinned(repo: string, d: PackDesired): Promise<string> {
    const pin = d.pinnedSha as string;
    try {
      const got = await this.fetchCommit(repo, pin);
      if (got === pin) return pin;
    } catch {
      // some servers do not serve a commit by id: try the ref
    }
    const viaRef = await this.fetchCommit(repo, d.ref);
    if (viaRef !== pin)
      throw new Error(
        `the pinned commit ${pin.slice(0, 7)} cannot be fetched and ${d.ref} now points to ${viaRef.slice(0, 7)}; check for updates and accept the new commit`,
      );
    return pin;
  }

  private reportResolved(l: Loaded): void {
    if (!l.snapshot) return;
    this.opts.report({ packId: l.desired.packId, state: 'resolved', snapshot: l.snapshot });
  }

  private reportIntegrity(l: Loaded): void {
    this.opts.report({
      packId: l.desired.packId,
      state: 'integrity',
      expected: l.desired.trusted?.contentHash ?? '',
      actual: l.snapshot?.contentHash ?? '',
      ...(l.sha ? { sha: l.sha as never } : {}),
    });
  }

  /** `pack.check`: fetch a ref and report whether it moved. The checked-out pin is never touched. */
  check(packId: string, ref?: string): Promise<void> {
    return this.serial(async () => {
      const l = this.packs.get(packId);
      if (!l || !l.sha) {
        this.opts.report({ packId, state: 'failed', message: 'the pack is not on this workstation yet' });
        return;
      }
      const d = l.desired;
      const target = ref ?? d.ref;
      let tmp: string | undefined;
      const repo = this.repoDir(packId);
      try {
        const sha = await this.fetchCommit(repo, target);
        if (sha === l.sha) {
          this.opts.report({ packId, state: 'current', sha: sha as never });
          return;
        }
        tmp = join(dirOf(this.opts.dir, packId), 'check');
        rmSync(tmp, { recursive: true, force: true });
        await this.git(repo, ['worktree', 'prune']).catch(() => undefined);
        await this.git(repo, ['worktree', 'add', '--detach', '--force', tmp, sha]);
        const next = this.indexDir(d, tmp, sha, target);
        if (!next.snapshot || !l.snapshot) throw new Error('nothing to compare');
        // the pin stays checked out: the worktree is a second directory
        this.opts.report({
          packId,
          state: 'update',
          snapshot: next.snapshot,
          diff: diffPackSnapshots(l.snapshot, next.snapshot),
        });
      } catch (err) {
        this.opts.report({ packId, state: 'failed', message: scrub(err) });
      } finally {
        if (tmp) {
          await this.git(repo, ['worktree', 'remove', '--force', tmp]).catch(() => undefined);
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    });
  }

  // ------------------------------------------------------------------------------------------------ use

  /** Packs this workstation holds, for the status line of the runner. */
  summary(): Array<{ packId: string; name: string; sha: string | null; usable: boolean; integrity: string }> {
    return [...this.packs.values()].map((l) => ({
      packId: l.desired.packId,
      name: l.desired.name,
      sha: l.sha,
      usable: this.usable(l),
      integrity: l.integrity,
    }));
  }

  /**
   * The capabilities that may be used now, for a project (or none): packs the owner approved at exactly the commit on disk
   * whose files still match the approved hash. Script files are left out unless scripts are enabled for the pack. Pack
   * packs scoped to another project are not offered.
   */
  entries(projectId?: string): ParsedCapability[] {
    const out: ParsedCapability[] = [];
    for (const l of this.packs.values()) {
      if (l.desired.scope === 'project' && l.desired.projectId !== (projectId ?? null)) continue;
      this.verify(l);
      if (!this.usable(l) || !l.index) continue;
      for (const e of l.index.entries) {
        if (l.desired.scriptsEnabled || !e.hasScripts) {
          out.push(e);
          continue;
        }
        const files = Object.fromEntries(Object.entries(e.files).filter(([p]) => !isScriptPath(p)));
        out.push({ ...e, files });
      }
    }
    return out;
  }

  /** Whether the pack of a capability has scripts enabled (informs `aom skill show`). */
  scriptsEnabled(packName: string): boolean {
    for (const l of this.packs.values()) if (l.desired.name === packName) return l.desired.scriptsEnabled;
    return false;
  }
}

/** A git error without a URL that may carry a token, cut short. */
function scrub(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).replace(/https?:\/\/[^\s/@]+@/g, 'https://');
  return m.split('\n').slice(0, 3).join(' ').slice(0, 480);
}
