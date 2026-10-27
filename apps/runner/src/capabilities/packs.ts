import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  AUTHORED_LIMITS,
  CAPABILITY_MAX_FILE_BYTES,
  diffPackSnapshots,
  indexPack,
  isScriptPath,
  type PackAuthorSavePayload,
  type PackAuthorSaveResult,
  type PackBundlePutPayload,
  type PackBundlePutResult,
  type PackBundleRequestPayload,
  type PackBundleRequestResult,
  type PackDesired,
  type PackDesiredInput,
  PackFileSetSchema,
  type PackIndexResult,
  type PackPersonaReadResult,
  type PackReadPayload,
  type PackReadResult,
  type PackSnapshot,
  type PacksReport,
  type ParsedCapability,
  packCredentialHost,
  packSnapshotOf,
  sealLarge,
  splitFrontmatter,
  validateAuthoredTree,
} from '@aom/shared';
import { execa } from 'execa';
import { type Logger, nullLogger } from '../log.ts';
import { redact } from '../secrets/redact.ts';
import type { PackCredentialStore } from './pack-credentials.ts';
import { type CheckedPackUrl, checkPackUrl, type Resolver } from './pack-url.ts';

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
 * git runs in an isolated environment: a private HOME, no global or system git config, no credential helper, no ssh agent or keys,
 * no prompts, hooks off, https only (and `file` in tests), no submodules and no LFS. A pack is public by design: it is cloned
 * as nobody, never with the identity of whoever runs this workstation. The host is resolved and checked first (no loopback,
 * link-local, metadata, private or shared addresses) and git is pinned to the addresses that were checked.
 * Pack files are read as text and never executed here.
 */

const MAX_TREE_FILES = 8000;
const MAX_TREE_BYTES = 60 * 1024 * 1024;
const TEXT_EXT =
  /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|sh|bash|py|rb|js|mjs|cjs|ts|ps1|bat|html?|xml|css)$/i;
const TEXT_NAMES = new Set(['SKILL.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt']);
const PRUNED = new Set(['.git', 'node_modules']);

export interface PackFilesState {
  /** path -> file stamp, of the files the index was built from. */
  stamps: Record<string, string>;
}

/** What identifies a file's content without reading it: size, mtime, ctime (which a program cannot set back) and inode. */
const stampOf = (st: Stats): string =>
  `${st.size}:${Math.trunc(st.mtimeMs)}:${Math.trunc(st.ctimeMs)}:${st.ino}`;

/**
 * Walks a checked-out pack and calls `visit` for every text file that belongs to it (symlinks, binaries, big files and `.git`
 * are skipped). Returns whether the limits cut the walk short. Reading and listing share this so they always agree.
 */
function walkPack(dir: string, visit: (rel: string, abs: string, st: Stats) => void): boolean {
  let count = 0;
  let bytes = 0;
  let truncated = false;
  const walk = (abs: string, rel: string): void => {
    if (truncated) return;
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
      let st: Stats;
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
        visit(r, p, st);
      }
    }
  };
  walk(dir, '');
  return truncated;
}

/** Reads the text files of a checked-out pack into a path -> text map; symlinks, binaries and big files are skipped. */
export function readPackTree(dir: string): {
  tree: Record<string, string>;
  stamps: Record<string, string>;
  truncated: boolean;
} {
  const tree: Record<string, string> = {};
  const stamps: Record<string, string> = {};
  const truncated = walkPack(dir, (r, p, st) => {
    try {
      tree[r] = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      stamps[r] = stampOf(st);
    } catch {
      // unreadable: skipped
    }
  });
  return { tree, stamps, truncated };
}

/** The stamps of the files a pack directory holds now, without reading them (to see what was added, removed or touched). */
export function stampPackTree(dir: string): Record<string, string> {
  const stamps: Record<string, string> = {};
  walkPack(dir, (r, _p, st) => {
    stamps[r] = stampOf(st);
  });
  return stamps;
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
  /** Resolves a host name (tests); default: the system resolver. */
  resolve?: Resolver;
  /** Called after the set of usable capabilities changed. */
  onChange?: () => void;
  /** R3a: deploy keys and tokens of private git packs. */
  credentials?: PackCredentialStore;
  /** R3a: opens a value sealed to this runner's key (`RunnerKeys.decryptAny`). */
  open?: (sealed: string) => string;
  /** R3a: the id of this runner's key, to refuse values sealed for another one. */
  keyId?: () => string;
  /** Tests only: a loopback address counts as a public git host (a local sshd or https server). */
  allowLoopback?: boolean;
  /** The ssh program git is told to use (default `ssh`). */
  sshBin?: string;
}

/**
 * Who is asking for capabilities. A private pack is served to its owner's sessions (`owner`) and to the agents its owner
 * granted it to (`agentId`); nobody else on a shared workstation sees it.
 */
export interface PackViewer {
  owner?: boolean;
  agentId?: string;
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
  /** Where the indexed files are (a git checkout, or a revision folder of an authored pack). */
  dir: string | null;
}

interface AuthoredState {
  /** The newest saved revision (what the author is working on; may be ahead of the pin). */
  latest: string | null;
  /** sha -> revision number (the `v<N>` of the ref). */
  revs: Record<string, number>;
  next: number;
}

const dirOf = (root: string, id: string): string => join(root, id);

/** The R3a fields of a pack from an older server or state file take their defaults (no schema parse: tests use local paths as URLs). */
const withDefaults = (d: PackDesiredInput): PackDesired =>
  ({
    source: 'git',
    visibility: 'org',
    ownerUserId: null,
    authorWorkstationId: null,
    credentialKind: null,
    hostKey: null,
    accepted: true,
    grantedAgentIds: [],
    ...d,
  }) as PackDesired;

export const PACK_TEXT_EXT =
  /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|sh|bash|py|rb|js|mjs|cjs|ts|ps1|bat|html?|xml|css)$/i;
/** Whether a file would be read back from a pack folder (so an authored save does not store what indexing would skip). */
export const isPackTextFile = (path: string): boolean =>
  PACK_TEXT_EXT.test(path) || TEXT_NAMES.has(path.split('/').pop() ?? '');

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

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
      const desired = JSON.parse(readFileSync(this.stateFile, 'utf8')) as unknown[];
      for (const d0 of desired) {
        // an older state file has none of the R3a fields: they take their defaults
        const d = withDefaults(d0 as PackDesiredInput);
        this.packs.set(d.packId, this.indexFromDisk(d));
      }
      this.opts.credentials?.load(this.packs.keys());
    } catch {
      // first start
    }
  }

  private saveState(): void {
    mkdirSync(this.opts.dir, { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify([...this.packs.values()].map((p) => p.desired)));
  }

  private authoredFile(id: string): string {
    return join(dirOf(this.opts.dir, id), 'authored.json');
  }

  private authored(id: string): AuthoredState {
    try {
      return JSON.parse(readFileSync(this.authoredFile(id), 'utf8')) as AuthoredState;
    } catch {
      return { latest: null, revs: {}, next: 1 };
    }
  }

  private saveAuthored(id: string, st: AuthoredState): void {
    mkdirSync(dirOf(this.opts.dir, id), { recursive: true });
    writeFileSync(this.authoredFile(id), JSON.stringify(st));
  }

  private revDir(id: string, sha: string): string {
    return join(dirOf(this.opts.dir, id), 'revs', sha);
  }

  // ------------------------------------------------------------------------------------------------ git

  /** A private home for git: it never sees the user's `~/.gitconfig`, credential store, ssh keys or known hosts. */
  private get gitHome(): string {
    const home = join(this.opts.dir, '.githome');
    mkdirSync(home, { recursive: true });
    return home;
  }

  /**
   * The one-shot askpass of a token pack: a script with no secret in it. Git runs it for the user name and the password of the
   * pack's host only (it refuses any other host); the token reaches it in the environment of that single git process.
   */
  private askpass(): string {
    const f = join(this.gitHome, 'askpass.sh');
    const body = `#!/bin/sh
case "$1" in
  *"$AOM_PACK_HOST"*) ;;
  *) exit 1 ;;
esac
case "$1" in
  *sername*) printf '%s\\n' "$AOM_PACK_USER" ;;
  *) printf '%s\\n' "$AOM_PACK_TOKEN" ;;
esac
`;
    if (!existsSync(f) || readFileSync(f, 'utf8') !== body) writeFileSync(f, body, { mode: 0o700 });
    try {
      chmodSync(f, 0o700);
    } catch {
      // Windows
    }
    return f;
  }

  /** The `GIT_SSH_COMMAND` of an ssh pack: this key only, no agent, no config, the host key pinned for this pack alone. */
  private sshCommand(d: PackDesired, net: CheckedPackUrl): string {
    const creds = this.opts.credentials as PackCredentialStore;
    const pinned = !!creds.hostKey(d.packId);
    const args = [
      this.opts.sshBin ?? 'ssh',
      '-F',
      '/dev/null',
      '-i',
      creds.keyFile(d.packId),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'BatchMode=yes',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      `UserKnownHostsFile=${creds.knownHostsFile(d.packId)}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      // first fetch: record the host key and pin it; every later fetch insists on it
      '-o',
      `StrictHostKeyChecking=${pinned ? 'yes' : 'accept-new'}`,
      '-o',
      'ConnectTimeout=20',
      // connect to the address that was checked; the key is looked up under the host name
      '-o',
      `HostKeyAlias=${net.host}`,
      ...(net.addresses[0] ? ['-o', `HostName=${net.addresses[0]}`] : []),
    ];
    return args.map(shQuote).join(' ');
  }

  private async git(
    cwd: string,
    args: string[],
    opts: { timeout?: number; net?: CheckedPackUrl; pack?: PackDesired } = {},
  ): Promise<string> {
    const d = opts.pack;
    const net = opts.net;
    const viaSsh = net?.scheme === 'ssh';
    const allow = viaSsh ? 'https:ssh' : this.opts.allowLocal ? 'https:file' : 'https';
    const home = this.gitHome;
    // the addresses that were checked: git must not look the name up again and land somewhere else
    const pin =
      net?.host && net.addresses[0] && !viaSsh
        ? ['-c', `http.curloptResolve=${net.host}:${net.port}:${net.addresses.join(',')}`]
        : [];
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GIT_ALLOW_PROTOCOL: allow,
      GIT_LFS_SKIP_SMUDGE: '1',
      LANG: 'C',
    };
    if (viaSsh && d && this.opts.credentials?.has(d.packId)) {
      env.GIT_SSH_COMMAND = this.sshCommand(d, net as CheckedPackUrl);
    } else if (d?.credentialKind === 'token' && this.opts.credentials && net?.scheme === 'https') {
      const token = this.opts.credentials.token(d.packId);
      if (token) {
        env.GIT_ASKPASS = this.askpass();
        env.AOM_PACK_HOST = net.host;
        env.AOM_PACK_USER = this.opts.credentials.meta(d.packId)?.username ?? 'x-access-token';
        env.AOM_PACK_TOKEN = token;
      }
    }
    const r = await execa(
      this.opts.gitBin ?? 'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...(env.GIT_SSH_COMMAND ? [] : ['-c', 'core.sshCommand=false']),
        '-c',
        'credential.helper=',
        '-c',
        'http.followRedirects=false',
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
        ...pin,
        ...args,
      ],
      {
        cwd,
        timeout: opts.timeout ?? 180_000,
        extendEnv: false,
        env,
        reject: true,
      },
    );
    return r.stdout.trim();
  }

  /** Throws unless a runner may clone this URL (see `checkPackUrl`). */
  private async checkUrl(d: PackDesired): Promise<CheckedPackUrl> {
    // a deploy key or token goes only to the host it was bound to when the admin sealed it (the server cannot redirect it)
    if (d.credentialKind && this.opts.credentials?.has(d.packId)) {
      const problem = this.opts.credentials.hostProblem(d.packId, packCredentialHost(d.url));
      if (problem) throw new Error(problem);
    }
    return checkPackUrl(d.url, {
      ...(this.opts.allowLocal !== undefined ? { allowLocal: this.opts.allowLocal } : {}),
      ...(this.opts.resolve ? { resolve: this.opts.resolve } : {}),
      ...(this.opts.allowLoopback ? { allowLoopback: true } : {}),
      // an ssh URL is accepted only for a pack that has its deploy key here
      allowSsh: d.credentialKind === 'ssh' && !!this.opts.credentials?.has(d.packId),
    });
  }

  private repoDir(id: string): string {
    return join(dirOf(this.opts.dir, id), 'repo');
  }

  private async ensureRepo(d: PackDesired): Promise<string> {
    await this.checkUrl(d);
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

  /** Fetches `what` (a ref or a commit) shallowly from the pack's URL and returns the commit it points to. */
  private async fetchCommit(repo: string, what: string, d: PackDesired): Promise<string> {
    const net = await this.checkUrl(d);
    if (d.credentialKind && this.opts.credentials && d.hostKey)
      this.opts.credentials.seedHostKey(d.packId, d.hostKey);
    await this.git(repo, ['fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', what], {
      net,
      pack: d,
    });
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
    return { desired: d, sha, index, snapshot, stamps, integrity: 'ok', dir };
  }

  /** Re-indexes what is on disk without the network (after a restart, or when a file changed). */
  private indexFromDisk(d: PackDesired): Loaded {
    try {
      if (d.source === 'authored') {
        const st = this.authored(d.packId);
        const sha = d.pinnedSha ?? st.latest;
        if (!sha || !existsSync(this.revDir(d.packId, sha))) return this.empty(d);
        return this.judge(this.indexDir(d, this.revDir(d.packId, sha), sha, `v${st.revs[sha] ?? 1}`));
      }
      const repo = this.repoDir(d.packId);
      const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim();
      if (!/^[0-9a-f]{40,64}$/.test(head)) return this.empty(d);
      const l = this.indexDir(d, repo, head, d.ref);
      return this.judge(l);
    } catch {
      return this.empty(d);
    }
  }

  private empty(d: PackDesired): Loaded {
    return { desired: d, sha: null, index: null, snapshot: null, stamps: {}, integrity: 'ok', dir: null };
  }

  /** Compares the indexed content with what the owner approved. */
  private judge(l: Loaded): Loaded {
    const t = l.desired.trusted;
    if (t && l.snapshot && l.sha === t.sha && this.approval(l) === 'none') l.integrity = 'mismatch';
    // an authored revision is named by its content hash: files that no longer hash to their own name were changed by hand
    else if (l.desired.source === 'authored' && l.snapshot && l.sha && l.snapshot.contentHash !== l.sha)
      l.integrity = 'mismatch';
    else l.integrity = 'ok';
    return l;
  }

  private usable(l: Loaded): boolean {
    if (!l.snapshot || l.integrity !== 'ok' || !l.desired.accepted) return false;
    // a private pack of its owner needs no review: it is theirs, on their workstation
    if (l.desired.visibility === 'private') return !l.desired.pinnedSha || l.sha === l.desired.pinnedSha;
    const t = l.desired.trusted;
    return !!(t && l.sha === t.sha && this.approval(l) !== 'none');
  }

  /**
   * How the owner's approval covers the files on disk: `full` (the hash of everything this reader sees), `legacy` (approved
   * before the Claude Code plugin layout was read: the hash without the items of that layout, which are then not served until the
   * owner approves the full hash), or `none`.
   */
  private approval(l: Loaded): 'full' | 'legacy' | 'none' {
    const t = l.desired.trusted;
    if (!t || !l.snapshot) return 'none';
    if (l.snapshot.contentHash === t.contentHash) return 'full';
    if (l.snapshot.legacyContentHash && l.snapshot.legacyContentHash === t.contentHash) return 'legacy';
    return 'none';
  }

  /** The indexed entries this workstation may serve for a pack: all, or without the plugin-layout ones awaiting approval. */
  private servable(l: Loaded): ParsedCapability[] {
    const all = l.index?.entries ?? [];
    return l.desired.visibility !== 'private' && this.approval(l) === 'legacy'
      ? all.filter((e) => e.layout !== 'plugin')
      : all;
  }

  /**
   * Before a pack's content is served: have the files changed since they were indexed (a file touched, added or removed)? A
   * change triggers a re-read of every file and a new comparison with the approved hash; a mismatch disables the pack and
   * tells the server. The stamp (size, mtime, ctime, inode) only decides whether to look again, never what is trusted.
   */
  private verify(l: Loaded): void {
    if (!l.index || !l.sha || !l.dir) return;
    // the directory is listed again, so a file that was added or removed is noticed as well as one that was touched
    const now = stampPackTree(l.dir);
    const had = Object.keys(l.stamps);
    const changed = had.length !== Object.keys(now).length || had.some((p) => now[p] !== l.stamps[p]);
    if (!changed) return;
    const was = l.integrity;
    const next = this.indexFromDisk(l.desired);
    Object.assign(l, next);
    if (l.integrity === 'mismatch' && was !== 'mismatch') {
      this.log.warn(`pack ${l.desired.name}: files changed on disk, the pack is disabled`);
      this.opts.report({
        packId: l.desired.packId,
        state: 'integrity',
        expected: l.desired.trusted?.contentHash ?? l.sha,
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
  sync(input: PackDesiredInput[]): Promise<void> {
    const desired = input.map(withDefaults);
    return this.serial(async () => {
      const ids = new Set(desired.map((d) => d.packId));
      for (const [id] of this.packs)
        if (!ids.has(id)) {
          rmSync(dirOf(this.opts.dir, id), { recursive: true, force: true });
          this.opts.credentials?.clear(id);
          this.packs.delete(id);
        }
      for (const d of desired) await this.syncOne(d);
      this.saveState();
      this.opts.onChange?.();
    });
  }

  private async syncOne(d: PackDesired): Promise<void> {
    // The member has not accepted the pack: nothing is cloned or kept (the files of a pack they declined are gone already).
    if (!d.accepted) {
      this.packs.set(d.packId, this.empty(d));
      return;
    }
    if (d.source === 'authored') return this.syncAuthored(d);
    const prev = this.packs.get(d.packId);
    try {
      if (d.credentialKind && !this.opts.credentials?.has(d.packId)) {
        // the pack is private and its deploy key or token has not arrived (or was cleared): there is nothing to clone with
        const keep = prev ?? this.empty(d);
        keep.desired = d;
        this.packs.set(d.packId, keep);
        this.opts.report({
          packId: d.packId,
          state: 'failed',
          message: 'waiting for the deploy key or token of this private pack',
          waiting: 'credential',
        });
        return;
      }
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
      const sha = d.pinnedSha ? await this.fetchPinned(repo, d) : await this.fetchCommit(repo, d.ref, d);
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

  /** An authored pack: a plain folder per revision (no git). The pinned revision is served; the files of a newer save wait. */
  private async syncAuthored(d: PackDesired): Promise<void> {
    const l = this.indexFromDisk(d);
    this.packs.set(d.packId, l);
    if (!l.snapshot) {
      // the pin names a revision this workstation does not have (it holds the pack but the files have not arrived)
      this.opts.report({
        packId: d.packId,
        state: 'failed',
        message: 'waiting for the files of this pack',
        waiting: 'content',
      });
      return;
    }
    this.gcRevisions(d.packId, [d.pinnedSha, this.authored(d.packId).latest]);
    if (l.integrity === 'mismatch') this.reportIntegrity(l);
    else this.reportResolved(l);
  }

  private gcRevisions(id: string, keep: Array<string | null>): void {
    const dir = join(dirOf(this.opts.dir, id), 'revs');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const keepSet = new Set(keep.filter((k): k is string => !!k));
    for (const n of names) if (!keepSet.has(n)) rmSync(join(dir, n), { recursive: true, force: true });
  }

  /** The pinned commit: fetch it directly, else the ref when it still points to it. A moved ref is an error, never a silent change. */
  private async fetchPinned(repo: string, d: PackDesired): Promise<string> {
    const pin = d.pinnedSha as string;
    try {
      const got = await this.fetchCommit(repo, pin, d);
      if (got === pin) return pin;
    } catch (err) {
      // some servers do not serve a commit by id: try the ref. A refused key or host key is not that case.
      if (
        /host key|permission denied|publickey|could not read from remote|authentication/i.test(String(err)) &&
        d.credentialKind
      )
        throw err;
    }
    const viaRef = await this.fetchCommit(repo, d.ref, d);
    if (viaRef !== pin)
      throw new Error(
        `the pinned commit ${pin.slice(0, 7)} cannot be fetched and ${d.ref} now points to ${viaRef.slice(0, 7)}; check for updates and accept the new commit`,
      );
    return pin;
  }

  private reportResolved(l: Loaded): void {
    if (!l.snapshot) return;
    const d = l.desired;
    // the first ssh fetch pinned the host key of the git host: tell the server once so a re-installed runner keeps it
    const hk =
      d.credentialKind === 'ssh' && !d.hostKey ? this.opts.credentials?.hostKey(d.packId) : undefined;
    this.opts.report({
      packId: d.packId,
      state: 'resolved',
      snapshot: l.snapshot,
      ...(hk ? { hostKey: { host: hostOfUrl(d.url), key: hk } } : {}),
    });
  }

  private reportIntegrity(l: Loaded): void {
    this.opts.report({
      packId: l.desired.packId,
      state: 'integrity',
      expected: l.desired.trusted?.contentHash ?? l.sha ?? '',
      actual: l.snapshot?.contentHash ?? '',
      ...(l.sha ? { sha: l.sha as never } : {}),
    });
  }

  /** `pack.check`: fetch a ref and report whether it moved. The checked-out pin is never touched. */
  check(packId: string, ref?: string): Promise<void> {
    return this.serial(async () => {
      const l = this.packs.get(packId);
      if (!l?.sha) {
        this.opts.report({ packId, state: 'failed', message: 'the pack is not on this workstation yet' });
        return;
      }
      const d = l.desired;
      if (d.source === 'authored') {
        // an authored pack has no remote: its "update" is the author's next save
        this.opts.report({ packId, state: 'current', sha: l.sha as never });
        return;
      }
      const target = ref ?? d.ref;
      let tmp: string | undefined;
      const repo = this.repoDir(packId);
      try {
        const sha = await this.fetchCommit(repo, target, d);
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

  // ------------------------------------------------------------------------------------------------ authored packs

  private openSealed(sealed: string): string {
    if (!this.opts.open) throw new Error('this runner cannot open sealed values');
    return this.opts.open(sealed);
  }

  /**
   * `pack.author.save`: the editor's files, sealed in the browser to this runner. They are checked (the layout must index with
   * no issue, text files only, within the limits), written as a new revision named by its content hash and reported: the first
   * revision as `resolved`, a later one as an `update` the server accepts (own private pack, or an approving Owner/Admin) or
   * offers for review.
   */
  saveAuthoredFiles(p: PackAuthorSavePayload): Promise<PackAuthorSaveResult> {
    return this.serial(async () => {
      const l0 = this.packs.get(p.packId);
      if (l0?.desired.source !== 'authored')
        return { ok: false, error: 'this pack is not an authored pack on this workstation', issues: [] };
      if (this.opts.keyId && p.keyId !== this.opts.keyId())
        return {
          ok: false,
          error: 'the files were sealed for another runner key: reload the page and save again',
          issues: [],
        };
      let tree: Record<string, string>;
      try {
        tree = PackFileSetSchema.parse(JSON.parse(this.openSealed(p.ciphertext))).tree;
      } catch {
        return { ok: false, error: 'the files could not be opened: save again', issues: [] };
      }
      const clean: Record<string, string> = {};
      for (const [path, text] of Object.entries(tree))
        clean[path.replace(/\\/g, '/')] = text.replace(/\r\n/g, '\n');
      const bad = Object.keys(clean).filter((f) => !isPackTextFile(f));
      const issues = [
        ...validateAuthoredTree(clean),
        ...bad.map((f) => ({
          path: f,
          message: 'only text files can be stored in a pack',
          severity: 'error' as const,
        })),
      ].filter((i) => i.severity === 'error');
      if (issues.length)
        return {
          ok: false,
          error: issues[0]?.message ?? 'the pack has problems',
          issues: issues.slice(0, 50).map((i) => ({ path: i.path, message: i.message })),
        };
      const d = l0.desired;
      const index = indexPack({ name: d.name, adapter: 'generic', tree: clean });
      if (!index.entries.length)
        return { ok: false, error: 'the pack has no skill, persona or playbook yet', issues: [] };
      const contentHash = packSnapshotOf({ name: d.name, ref: 'v0', sha: 'a'.repeat(64), index }).contentHash;
      const sha = contentHash;
      const st = this.authored(p.packId);
      const known = st.revs[sha];
      const dir = this.revDir(p.packId, sha);
      if (known === undefined || !existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        for (const [path, text] of Object.entries(clean)) {
          const abs = join(dir, path);
          mkdirSync(join(abs, '..'), { recursive: true });
          writeFileSync(abs, text);
        }
        st.revs[sha] = st.next++;
      }
      st.latest = sha;
      this.saveAuthored(p.packId, st);
      const next = this.indexDir(d, dir, sha, `v${st.revs[sha]}`);
      if (!d.pinnedSha) {
        // the very first save pins itself on the server
        const l = this.judge(next);
        this.packs.set(p.packId, l);
        this.reportResolved(l);
        this.opts.onChange?.();
      } else if (d.pinnedSha === sha) {
        this.opts.report({ packId: p.packId, state: 'current', sha: sha as never });
      } else {
        const cur = l0.snapshot;
        if (!cur || !next.snapshot) return { ok: false, error: 'nothing to compare with', issues: [] };
        this.opts.report({
          packId: p.packId,
          state: 'update',
          snapshot: next.snapshot,
          diff: diffPackSnapshots(cur, next.snapshot),
        });
      }
      this.gcRevisions(p.packId, [d.pinnedSha, st.latest]);
      return { ok: true, issues: [] };
    });
  }

  /** `pack.read`: the files of an authored pack (the pinned revision, or the newest save) sealed to the browser's one-time key. */
  async readFiles(p: PackReadPayload): Promise<PackReadResult> {
    const l = this.packs.get(p.packId);
    if (l?.desired.source !== 'authored') return { ok: false, error: 'this pack is not on this workstation' };
    const st = this.authored(p.packId);
    const sha = st.latest ?? l.desired.pinnedSha;
    if (!sha || !existsSync(this.revDir(p.packId, sha)))
      return { ok: false, error: 'the pack has no saved files yet' };
    const { tree } = readPackTree(this.revDir(p.packId, sha));
    // R3c: the approved revision too (when it is another one and still on disk), for the diff against it
    const pin = l.desired.pinnedSha;
    const pinned =
      p.withPinned && pin && pin !== sha && existsSync(this.revDir(p.packId, pin))
        ? { tree: readPackTree(this.revDir(p.packId, pin)).tree, sha: pin }
        : undefined;
    return {
      ok: true,
      ciphertext: await sealLarge(p.replyKey, JSON.stringify({ tree, sha, ...(pinned ? { pinned } : {}) })),
    };
  }

  /** `pack.persona.read`: the persona file as pinned, for hiring. Only a pack that may be used here is read. */
  readPersona(packId: string, key: string): PackPersonaReadResult {
    const l = this.packs.get(packId);
    if (!l) return { ok: false, error: 'the pack is not on this workstation' };
    this.verify(l);
    if (!this.usable(l) || !l.index)
      return { ok: false, error: 'the pack is not approved or its files changed on this workstation' };
    const e = this.servable(l).find((x) => x.kind === 'persona' && x.key === `${l.desired.name}:${key}`);
    if (!e?.files[e.main]) return { ok: false, error: `the pack has no persona "${key}"` };
    return { ok: true, text: e.files[e.main], hash: e.hash, sha: l.sha as never };
  }

  /** `pack.bundle.request`: the author's workstation seals the pinned files to each workstation that must hold them. */
  async bundleRequest(p: PackBundleRequestPayload): Promise<PackBundleRequestResult> {
    const l = this.packs.get(p.packId);
    if (l?.desired.source !== 'authored' || l.sha !== p.sha || !l.dir)
      return { ok: false, error: 'this workstation does not hold that revision', bundles: [] };
    this.verify(l);
    if (l.integrity !== 'ok')
      return { ok: false, error: 'the files changed on this workstation', bundles: [] };
    const { tree } = readPackTree(l.dir);
    const body = JSON.stringify({ tree });
    const bundles = [];
    for (const t of p.targets)
      bundles.push({ workstationId: t.workstationId, ciphertext: await sealLarge(t.publicKey, body) });
    return { ok: true, contentHash: l.snapshot?.contentHash, bundles };
  }

  /** `pack.bundle.put`: files of an authored organization pack from its author's workstation; stored when they hash to what was pinned. */
  bundlePut(p: PackBundlePutPayload): Promise<PackBundlePutResult> {
    return this.serial(async () => {
      const l = this.packs.get(p.packId);
      if (l?.desired.source !== 'authored' || !l.desired.accepted)
        return { stored: false, error: 'this workstation does not hold that pack' };
      if (this.opts.keyId && p.keyId !== this.opts.keyId())
        return { stored: false, error: 'sealed for another runner key' };
      let tree: Record<string, string>;
      try {
        tree = PackFileSetSchema.parse(JSON.parse(this.openSealed(p.ciphertext))).tree;
      } catch {
        return { stored: false, error: 'the files could not be opened' };
      }
      const clean: Record<string, string> = {};
      for (const [path, text] of Object.entries(tree)) clean[path.replace(/\\/g, '/')] = text;
      if (
        validateAuthoredTree(clean).some((i) => i.severity === 'error') ||
        !Object.keys(clean).every(isPackTextFile)
      )
        return { stored: false, error: 'the files are not a valid pack' };
      const d = l.desired;
      const index = indexPack({ name: d.name, adapter: 'generic', tree: clean });
      const hash = packSnapshotOf({ name: d.name, ref: 'v0', sha: 'a'.repeat(64), index }).contentHash;
      // the files must be exactly what the server pinned, and the revision is named by that hash
      if (hash !== p.contentHash || p.sha !== hash)
        return { stored: false, error: 'the files do not match the approved content' };
      const dir = this.revDir(p.packId, hash);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const [path, text] of Object.entries(clean)) {
        const abs = join(dir, path);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, text);
      }
      const st = this.authored(p.packId);
      if (st.revs[hash] === undefined) st.revs[hash] = st.next++;
      st.latest = hash;
      this.saveAuthored(p.packId, st);
      await this.syncOne(d);
      this.saveState();
      this.opts.onChange?.();
      return { stored: true };
    });
  }

  /** Renames helper for tests: moves a revision folder (simulates tampering). */
  _tamper(packId: string, rel: string, text: string): void {
    const l = this.packs.get(packId);
    if (l?.dir) writeFileSync(join(l.dir, rel), text);
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
   * packs scoped to another project are not offered. A private pack is served only to its owner's sessions and to the agents
   * the owner granted it to (`viewer`): on a shared workstation nobody else sees it.
   */
  entries(projectId?: string, orgId?: string, viewer?: PackViewer): ParsedCapability[] {
    const out: ParsedCapability[] = [];
    for (const l of this.packs.values()) {
      if (!this.inOrg(l, orgId)) continue;
      if (!this.mayView(l, viewer)) continue;
      if (l.desired.scope === 'project' && l.desired.projectId !== (projectId ?? null)) continue;
      this.verify(l);
      if (!this.usable(l) || !l.index) continue;
      for (const e of this.servable(l)) {
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

  /** Whether the caller may see a pack at all: an organization pack, or a private one granted to the caller. */
  private mayView(l: Loaded, viewer?: PackViewer): boolean {
    if (l.desired.visibility !== 'private') return true;
    if (viewer?.owner) return true;
    return !!viewer?.agentId && l.desired.grantedAgentIds.includes(viewer.agentId);
  }

  /** Whether the pack of a capability has scripts enabled (informs `aom skill show`). */
  scriptsEnabled(packName: string, orgId?: string): boolean {
    for (const l of this.packs.values())
      if (l.desired.name === packName && this.inOrg(l, orgId)) return l.desired.scriptsEnabled;
    return false;
  }

  /**
   * Packs belong to one organization; a workstation of several organizations never serves one organization's pack to another.
   * A pack from a server that did not name the organization (an older server) is served to every caller, as before.
   */
  private inOrg(l: Loaded, orgId: string | undefined): boolean {
    return !l.desired.orgId || l.desired.orgId === orgId;
  }
}

/** The host of a pack URL (https or ssh), for the host key record. */
function hostOfUrl(url: string): string {
  const ssh = /^(?:ssh:\/\/)?git@([^/:]+)/i.exec(url);
  if (ssh) return (ssh[1] as string).toLowerCase();
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * A git error for the admin: git's own words (stderr, without the banner lines ssh draws), without a URL that may carry a token or
 * any registered secret, cut short.
 */
function scrub(err: unknown): string {
  const stderr =
    typeof (err as { stderr?: unknown })?.stderr === 'string' ? (err as { stderr: string }).stderr : '';
  const raw = stderr.trim() || (err instanceof Error ? err.message : String(err));
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^@+$/.test(l));
  const m = redact(lines.join('\n').replace(/https?:\/\/[^\s/@]+@/g, 'https://'));
  return m.split('\n').slice(0, 3).join(' ').slice(0, 480);
}

void AUTHORED_LIMITS;
void splitFrontmatter;
void renameSync;
