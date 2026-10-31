import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  normalizeRemoteUrl,
  type VaultConfig,
  type VaultConfigureCommand,
  VaultConfigureCommandSchema,
  type VaultMergeCommand,
  type VaultMoveCommand,
  type VaultWriteCommand,
  type VaultWriteFileCommand,
} from '@aom/shared';
import { confine } from '../fs-safe.ts';
import { type Logger, nullLogger } from '../log.ts';
import type { RunnerPaths } from '../paths.ts';
import { type DeliveryFile, type DeliverySaveResult, saveDeliveryDir } from './delivery.ts';
import { ensureLocalVault, isLocalVaultDir, localVaultWarning, setAsideLocalVault } from './local.ts';
import { mergeVaultInto, SAME_REPOSITORY_MESSAGE, type VaultMergeResult } from './merge.ts';
import { noteCountField } from './notes.ts';
import {
  ensureClone,
  isClean,
  isCloned,
  isPermanentSyncError,
  reportableConflicts,
  scrubGraphPaths,
  syncBackoffMs,
  syncVault,
  type VaultSyncResult,
} from './sync.ts';
import {
  moveVaultFolder,
  type VaultMoveResult,
  VaultWriteError,
  vaultFileHasHash,
  writeVaultBinary,
  writeVaultFile,
} from './write.ts';

export interface VaultTransport {
  /** Acked types (`vault.conflict`) are persisted in the outbox; `vault.status` is best effort. */
  send(type: 'vault.status' | 'vault.conflict', payload: Record<string, unknown>): void;
}

export interface VaultManagerOptions {
  paths: RunnerPaths;
  transport: VaultTransport;
  log?: Logger;
  /** Test hook: milliseconds per configured second (default 1000). */
  secondMs?: number;
  /** A sync resolved a conflict in generated project graph files by itself: rebuild the graph of these folders. */
  onGraphResolved?: (vaultId: string, folders: string[]) => void;
  /** A sync pass of a repository vault finished without error: its files may have changed (the capability index re-reads them). */
  onSynced?: (vaultId: string) => void;
}

interface PersistedState {
  config: VaultConfigureCommand | null;
  /** vaultId -> conflicted files. A paused vault is not synced until the manager resolves it. */
  paused: Record<string, string[]>;
}

export interface VaultWriteOutcome {
  written: boolean;
  committed: boolean;
  pushed: boolean;
  paused: boolean;
  conflict?: string[];
}

/**
 * Vault sync and writes on this workstation (docs/ARCHITECTURE.md sections 16.3 and 16.4). The set of vaults comes
 * from the server (`vault.configure`, replace semantics) and is persisted, so syncing continues while the runner is
 * offline. Per vault: one serialized git operation at a time, a timer per `syncIntervalSec`, status reports to the
 * server, and a pause after an unresolved conflict.
 */
export class VaultManager {
  private config: VaultConfigureCommand | null = null;
  private paused = new Map<string, string[]>();
  private timers = new Map<string, NodeJS.Timeout>();
  private chains = new Map<string, Promise<unknown>>();
  private lastPull = new Map<string, string>();
  private lastPush = new Map<string, string>();
  /** Consecutive permanent failures per vault and the time before which the timer does not try again. */
  private failing = new Map<string, { count: number; until: number; error: string }>();
  private stopped = false;
  /** Local vaults whose "not synced" warning was logged in this process. */
  private warned = new Set<string>();
  private readonly log: Logger;
  private readonly file: string;

  constructor(private readonly opts: VaultManagerOptions) {
    this.log = opts.log ?? nullLogger;
    this.file = join(opts.paths.root, 'vaults.json');
    this.load();
  }

  dir(vaultId: string): string {
    return confine(this.opts.paths.vaults, join(this.opts.paths.vaults, vaultId));
  }

  /** Starts the sync timers for the persisted configuration (before the server connection exists). */
  start(): void {
    if (this.config) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  /** `hello.vaults`: the vaults this runner holds a clone of. */
  async report(): Promise<Array<{ vaultId: string; localPath: string; clean: boolean }>> {
    const out = [];
    for (const v of this.config?.vaults ?? []) {
      const dir = this.dir(v.vaultId);
      if (isCloned(dir)) out.push({ vaultId: v.vaultId, localPath: dir, clean: await isClean(dir) });
      else if (isLocalVaultDir(dir)) out.push({ vaultId: v.vaultId, localPath: dir, clean: true });
    }
    return out;
  }

  configured(): string[] {
    return (this.config?.vaults ?? []).map((v) => v.vaultId);
  }

  isPaused(vaultId: string): boolean {
    return this.paused.has(vaultId);
  }

  vault(vaultId: string): VaultConfig | undefined {
    return this.config?.vaults.find((v) => v.vaultId === vaultId);
  }

  /**
   * Runs `fn` with the vault's folder while no sync or write of that vault is running (the project graph writes many
   * files at once). A repository vault is cloned first when it is not here yet.
   */
  async exclusive<T>(vaultId: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const v = this.vault(vaultId);
    if (!v) throw new VaultWriteError(`vault ${vaultId} is not configured on this workstation`);
    if (v.storage === 'local') return this.serialize(vaultId, () => fn(this.localDir(vaultId)));
    if (!isCloned(this.dir(vaultId))) {
      const r = await this.syncNow(vaultId);
      if ('status' in r && r.status === 'error') throw new VaultWriteError(r.error);
    }
    return this.serialize(vaultId, () => fn(this.dir(vaultId)));
  }

  /** A local vault: a folder on this workstation, never cloned, synced or pushed (docs/design/project-graphs.md section 3). */
  isLocal(vaultId: string): boolean {
    return this.vault(vaultId)?.storage === 'local';
  }

  /** The vault's folder, created when it is a local vault (a repository vault is cloned by the sync pass). */
  localDir(vaultId: string): string {
    const dir = this.dir(vaultId);
    ensureLocalVault(dir);
    return dir;
  }

  /** A vault that was a local folder and now has a repository: the folder is set aside so the clone can take its place. */
  private adoptRepository(vaultId: string): void {
    const aside = setAsideLocalVault(this.dir(vaultId));
    if (aside) this.log.warn(`vault ${vaultId} now has a repository: the local folder was kept at ${aside}`);
  }

  /** `vault.configure`: replaces the vault set, drops state of removed vaults, resumes the ones the manager resolved. */
  configure(cmd: VaultConfigureCommand): void {
    const ids = new Set(cmd.vaults.map((v) => v.vaultId));
    this.config = cmd;
    for (const id of [...this.paused.keys()]) if (!ids.has(id)) this.paused.delete(id);
    for (const id of cmd.resume) this.paused.delete(id);
    // A new configuration (a new URL or key may fix it) ends any back-off.
    this.failing.clear();
    this.persist();
    this.schedule();
    for (const id of cmd.resume) if (ids.has(id)) void this.syncNow(id);
  }

  private schedule(): void {
    for (const [id, t] of this.timers) {
      clearInterval(t);
      this.timers.delete(id);
    }
    if (this.stopped || !this.config) return;
    for (const v of this.config.vaults) {
      if (v.storage === 'local') {
        // No timer, nothing to sync: the folder is created and its status reported once.
        void this.syncNow(v.vaultId);
        continue;
      }
      const t = setInterval(
        () => void this.timerSync(v.vaultId),
        v.syncIntervalSec * (this.opts.secondMs ?? 1000),
      );
      t.unref?.();
      this.timers.set(v.vaultId, t);
      // a vault without a clone yet (or never synced in this process) is synced right away
      if (!this.paused.has(v.vaultId) && !this.lastPull.has(v.vaultId)) void this.syncNow(v.vaultId);
    }
  }

  private serialize<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(vaultId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      vaultId,
      next.catch(() => {}),
    );
    return next;
  }

  /** The interval timer's pass: skipped while the vault backs off after a permanent error (a manual sync still runs). */
  async timerSync(vaultId: string): Promise<void> {
    const f = this.failing.get(vaultId);
    if (f && Date.now() < f.until) return;
    await this.syncNow(vaultId);
  }

  /** Vaults that are backing off after a permanent sync error, with the error and the number of failures. */
  backingOff(): Array<{ vaultId: string; failures: number; error: string }> {
    return [...this.failing].map(([vaultId, f]) => ({ vaultId, failures: f.count, error: f.error }));
  }

  /** One sync pass now (also what the interval timer runs). A paused vault is skipped. */
  syncNow(vaultId: string): Promise<VaultSyncResult | { status: 'paused' }> {
    return this.serialize(vaultId, () => this.runSync(vaultId));
  }

  private async runSync(vaultId: string): Promise<VaultSyncResult | { status: 'paused' }> {
    const cfg = this.config;
    const v = this.vault(vaultId);
    if (!cfg || !v || this.stopped) return { status: 'error', error: 'vault is not configured' };
    if (v.storage === 'local') return this.reportLocal(vaultId);
    if (this.paused.has(vaultId)) return { status: 'paused' };
    this.adoptRepository(vaultId);
    const r = await syncVault({
      dir: this.dir(vaultId),
      remoteUrl: v.remoteUrl,
      identity: cfg.identity,
      workstationName: cfg.workstationName,
    });
    this.afterSync(vaultId, r);
    return r;
  }

  /** The "sync" of a local vault: make sure the folder exists and say where it is. */
  private reportLocal(vaultId: string): VaultSyncResult {
    try {
      const dir = this.localDir(vaultId);
      if (!this.warned.has(vaultId)) {
        this.warned.add(vaultId);
        this.log.warn(localVaultWarning(dir));
      }
      this.opts.transport.send('vault.status', {
        vaultId,
        lastPullAt: null,
        lastPushAt: null,
        localPath: dir,
        ...noteCountField(dir),
      });
      return { status: 'ok', cloned: false, committed: false, pulled: false, pushed: false };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private afterSync(vaultId: string, r: VaultSyncResult): void {
    const now = new Date().toISOString();
    if (r.status === 'error' && isPermanentSyncError(r.error)) {
      const count = (this.failing.get(vaultId)?.count ?? 0) + 1;
      const interval = (this.vault(vaultId)?.syncIntervalSec ?? 150) * (this.opts.secondMs ?? 1000);
      this.failing.set(vaultId, {
        count,
        until: Date.now() + syncBackoffMs(count, interval),
        error: r.error,
      });
      if (count > 1) {
        // Already reported: the server has the status; say it once more only in the log.
        this.log.warn(`vault ${vaultId} sync failed again (${count} in a row, backing off): ${r.error}`);
        return;
      }
    } else this.failing.delete(vaultId);
    if (r.status === 'ok') {
      if (r.graphResolved?.length) {
        this.log.warn(
          `vault ${vaultId}: conflicts in generated graph files were resolved by the sync; rebuilding the graph`,
        );
        this.opts.onGraphResolved?.(vaultId, r.graphResolved);
      }
      this.lastPull.set(vaultId, now);
      if (r.pushed) this.lastPush.set(vaultId, now);
      try {
        this.opts.onSynced?.(vaultId);
      } catch (err) {
        this.log.warn(`vault ${vaultId} after-sync hook failed: ${String(err)}`);
      }
      this.opts.transport.send('vault.status', {
        vaultId,
        lastPullAt: this.lastPull.get(vaultId) ?? null,
        lastPushAt: this.lastPush.get(vaultId) ?? null,
        ...this.pathField(vaultId),
        ...noteCountField(this.dir(vaultId)),
      });
      return;
    }
    if (r.status === 'conflict') {
      // never a generated graph file name (they come from the customer's code): the sync already left them out
      const files = reportableConflicts(r.files);
      this.paused.set(vaultId, files);
      this.persist();
      this.log.warn(`vault ${vaultId} has a sync conflict; syncing paused`, files);
      this.opts.transport.send('vault.conflict', { vaultId, files });
      this.opts.transport.send('vault.status', {
        vaultId,
        lastPullAt: this.lastPull.get(vaultId) ?? null,
        lastPushAt: this.lastPush.get(vaultId) ?? null,
        error: `sync conflict in ${files.join(', ')}`,
        ...this.pathField(vaultId),
      });
      return;
    }
    this.log.warn(`vault ${vaultId} sync failed: ${r.error}`);
    this.opts.transport.send('vault.status', {
      vaultId,
      lastPullAt: null,
      lastPushAt: null,
      error: scrubGraphPaths(r.error).slice(0, 500),
      ...this.pathField(vaultId),
    });
  }

  private pathField(vaultId: string): { localPath?: string } {
    return isCloned(this.dir(vaultId)) ? { localPath: this.dir(vaultId) } : {};
  }

  /**
   * `vault.write`: write + commit locally, then push through a sync pass (unless the vault is paused, then the commit
   * waits for the manager to resolve the conflict). Throws on a bad path, an existing different file or no vault.
   */
  write(cmd: VaultWriteCommand): Promise<VaultWriteOutcome> {
    return this.serialize(cmd.vaultId, async () => {
      const cfg = this.config;
      const v = this.vault(cmd.vaultId);
      if (!cfg || !v) throw new VaultWriteError(`vault ${cmd.vaultId} is not configured on this workstation`);
      if (v.storage === 'local') {
        const w = await writeVaultFile(this.localDir(cmd.vaultId), cmd, cfg.identity, { commit: false });
        return { ...w, pushed: false, paused: false };
      }
      const dir = this.dir(cmd.vaultId);
      this.adoptRepository(cmd.vaultId);
      await ensureClone(dir, v.remoteUrl, {});
      const w = await writeVaultFile(dir, cmd, cfg.identity);
      if (this.paused.has(cmd.vaultId))
        return { ...w, pushed: false, paused: true, conflict: this.paused.get(cmd.vaultId) };
      if (!cmd.push) return { ...w, pushed: false, paused: false };
      const r = await syncVault({
        dir,
        remoteUrl: v.remoteUrl,
        identity: cfg.identity,
        workstationName: cfg.workstationName,
      });
      this.afterSync(cmd.vaultId, r);
      if (r.status === 'conflict') return { ...w, pushed: false, paused: true, conflict: r.files };
      if (r.status === 'error') throw new VaultWriteError(r.error);
      return { ...w, pushed: r.pushed, paused: false };
    });
  }

  /**
   * `vault.write_file`: the bytes of an uploaded document are fetched from the server (unless the vault already holds
   * them), checked against the size and hash in the command, written and committed like `write`, then pushed.
   */
  writeFile(
    cmd: VaultWriteFileCommand,
    fetchBytes: (documentId: string) => Promise<Buffer>,
  ): Promise<VaultWriteOutcome> {
    return this.serialize(cmd.vaultId, async () => {
      const cfg = this.config;
      const v = this.vault(cmd.vaultId);
      if (!cfg || !v) throw new VaultWriteError(`vault ${cmd.vaultId} is not configured on this workstation`);
      const local = v.storage === 'local';
      const dir = local ? this.localDir(cmd.vaultId) : this.dir(cmd.vaultId);
      if (!local) {
        this.adoptRepository(cmd.vaultId);
        await ensureClone(dir, v.remoteUrl, {});
      }
      let w: { written: boolean; committed: boolean } = { written: false, committed: false };
      if (!(await vaultFileHasHash(dir, cmd.path, cmd.sha256))) {
        const bytes = await fetchBytes(cmd.documentId);
        if (bytes.byteLength !== cmd.size || createHash('sha256').update(bytes).digest('hex') !== cmd.sha256)
          throw new VaultWriteError('the file does not match what the server announced');
        w = await writeVaultBinary(dir, cmd, bytes, { commit: !local });
      }
      if (local) return { ...w, pushed: false, paused: false };
      if (this.paused.has(cmd.vaultId))
        return { ...w, pushed: false, paused: true, conflict: this.paused.get(cmd.vaultId) };
      if (!cmd.push) return { ...w, pushed: false, paused: false };
      const r = await syncVault({
        dir,
        remoteUrl: v.remoteUrl,
        identity: cfg.identity,
        workstationName: cfg.workstationName,
      });
      this.afterSync(cmd.vaultId, r);
      if (r.status === 'conflict') return { ...w, pushed: false, paused: true, conflict: r.files };
      if (r.status === 'error') throw new VaultWriteError(r.error);
      return { ...w, pushed: r.pushed, paused: false };
    });
  }

  /**
   * `aom recipe save`: writes the project's `delivery/` folder into the vault. A git vault commits it and pushes through a
   * sync pass (the commit is what the Owner approves, and another workstation must be able to fetch it); a local vault
   * is rewritten in place.
   */
  saveDelivery(cmd: {
    vaultId: string;
    folder: string;
    files: DeliveryFile[];
    message: string;
  }): Promise<DeliverySaveResult & { pushed: boolean; paused: boolean }> {
    return this.serialize(cmd.vaultId, async () => {
      const cfg = this.config;
      const v = this.vault(cmd.vaultId);
      if (!cfg || !v) throw new VaultWriteError(`vault ${cmd.vaultId} is not configured on this workstation`);
      if (v.storage === 'local') {
        const w = await saveDeliveryDir(this.localDir(cmd.vaultId), cmd.folder, cmd.files, cfg.identity, {
          commit: false,
          message: cmd.message,
        });
        return { ...w, pushed: false, paused: false };
      }
      const dir = this.dir(cmd.vaultId);
      this.adoptRepository(cmd.vaultId);
      await ensureClone(dir, v.remoteUrl, {});
      const w = await saveDeliveryDir(dir, cmd.folder, cmd.files, cfg.identity, {
        commit: true,
        message: cmd.message,
      });
      if (this.paused.has(cmd.vaultId)) return { ...w, pushed: false, paused: true };
      const r = await syncVault({
        dir,
        remoteUrl: v.remoteUrl,
        identity: cfg.identity,
        workstationName: cfg.workstationName,
      });
      this.afterSync(cmd.vaultId, r);
      if (r.status === 'conflict') return { ...w, pushed: false, paused: true };
      if (r.status === 'error') throw new VaultWriteError(r.error);
      return { ...w, pushed: r.pushed, paused: false };
    });
  }

  /** `vault.move`: renames a folder of the clone (one commit), then pushes through a sync pass like a write. */
  move(
    cmd: VaultMoveCommand,
  ): Promise<VaultMoveResult & { pushed: boolean; paused: boolean; error?: string }> {
    return this.serialize(cmd.vaultId, async () => {
      const cfg = this.config;
      const v = this.vault(cmd.vaultId);
      if (!cfg || !v) throw new VaultWriteError(`vault ${cmd.vaultId} is not configured on this workstation`);
      if (v.storage === 'local') throw new VaultWriteError('a local vault cannot be moved or merged');
      const dir = this.dir(cmd.vaultId);
      await ensureClone(dir, v.remoteUrl, {});
      const w = await moveVaultFolder(dir, cmd, cfg.identity);
      if (this.paused.has(cmd.vaultId)) return { ...w, pushed: false, paused: true };
      if (!cmd.push) return { ...w, pushed: false, paused: false };
      const r = await syncVault({
        dir,
        remoteUrl: v.remoteUrl,
        identity: cfg.identity,
        workstationName: cfg.workstationName,
      });
      this.afterSync(cmd.vaultId, r);
      if (r.status === 'conflict') return { ...w, pushed: false, paused: true };
      if (r.status === 'error') throw new VaultWriteError(r.error);
      return { ...w, pushed: r.pushed, paused: false };
    });
  }

  /**
   * `vault.merge`: copies the files of another vault into this one under a folder (see `mergeVaultInto`). The source is
   * cloned from the URL the command carries (it is no longer a registered vault) and synced first, so the merge sees its
   * latest state; then the target is committed and pushed through a sync pass like a write.
   */
  merge(
    cmd: VaultMergeCommand,
  ): Promise<VaultMergeResult & { pushed: boolean; paused: boolean; error?: string }> {
    return this.serialize(cmd.vaultId, async () => {
      const cfg = this.config;
      const v = this.vault(cmd.vaultId);
      if (!cfg || !v) throw new VaultWriteError(`vault ${cmd.vaultId} is not configured on this workstation`);
      if (v.storage === 'local') throw new VaultWriteError('a local vault cannot be moved or merged');
      const dir = this.dir(cmd.vaultId);
      const srcDir = this.dir(cmd.from.vaultId);
      const env = {};
      // A repository is never merged into itself (before cloning: the URLs; mergeVaultInto checks the clones again).
      if (normalizeRemoteUrl(cmd.from.remoteUrl) === normalizeRemoteUrl(v.remoteUrl))
        return {
          copied: 0,
          committed: false,
          conflicts: [],
          skipped: SAME_REPOSITORY_MESSAGE,
          pushed: false,
          paused: false,
        };
      await ensureClone(dir, v.remoteUrl, env);
      await ensureClone(srcDir, cmd.from.remoteUrl, env);
      // The latest state of the source: pull what other workstations pushed (a source that was never configured here has no local edits).
      const fresh = await syncVault({
        dir: srcDir,
        remoteUrl: cmd.from.remoteUrl,
        identity: cfg.identity,
        workstationName: cfg.workstationName,
      });
      if (fresh.status !== 'ok')
        throw new VaultWriteError(
          fresh.status === 'conflict'
            ? `the source vault has a sync conflict in ${fresh.files.join(', ')}`
            : fresh.error,
        );
      const w = await mergeVaultInto(dir, srcDir, cmd, cfg.identity);
      if (w.skipped) return { ...w, pushed: false, paused: false };
      if (this.paused.has(cmd.vaultId)) return { ...w, pushed: false, paused: true };
      if (!cmd.push) return { ...w, pushed: false, paused: false };
      const r = await syncVault({
        dir,
        remoteUrl: v.remoteUrl,
        identity: cfg.identity,
        workstationName: cfg.workstationName,
      });
      this.afterSync(cmd.vaultId, r);
      if (r.status === 'conflict') return { ...w, pushed: false, paused: true };
      if (r.status === 'error') throw new VaultWriteError(r.error);
      return { ...w, pushed: r.pushed, paused: false };
    });
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as PersistedState;
      const cfg = s.config ? VaultConfigureCommandSchema.safeParse(s.config) : null;
      if (cfg?.success) this.config = cfg.data;
      for (const [id, files] of Object.entries(s.paused ?? {})) this.paused.set(id, files);
    } catch (err) {
      this.log.warn(`ignoring unreadable ${this.file}: ${String(err)}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const s: PersistedState = { config: this.config, paused: Object.fromEntries(this.paused) };
      writeFileSync(`${this.file}.tmp`, JSON.stringify(s), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log.warn(`could not persist vault state: ${String(err)}`);
    }
  }
}
