import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  isQuietRepoSyncReason,
  REPO_SYNC_REASON_MESSAGE_MAX,
  type RepoReport,
  type RepoSyncStatus,
} from '@aom/shared';
import { type Logger, nullLogger } from '../log.ts';
import { type SyncResult, safeSyncText, syncWorkingBranch, syncWorkingBranchUnlocked } from './sync-branch.ts';
import type { GitAuth } from './worktrees.ts';

/** The repositories whose working branch the runner keeps in step with origin, with the branch the server confirmed. */
export interface SyncTarget {
  repoId: string;
  remoteUrlNormalized: string;
  workingBranch: string;
}

export interface SyncStatusReport extends SyncResult {
  repoId: string;
  remoteUrlNormalized: string;
  workingBranch: string;
  checkedAt: string;
}

/** The wire form of a sync result (`repo.sync_status` and the `repo.sync` answer). */
export function toRepoSyncStatus(r: SyncStatusReport): RepoSyncStatus {
  const cut = (s: string) => s.slice(0, REPO_SYNC_REASON_MESSAGE_MAX);
  return {
    repoId: r.repoId,
    workingBranch: r.workingBranch,
    state: r.state,
    ahead: r.ahead,
    behind: r.behind,
    dirty: r.dirty,
    onBranch: r.onBranch,
    checkedOutBranch: r.checkedOutBranch,
    ...(r.detail ? { detail: cut(r.detail) } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.reasonMessage ? { reasonMessage: cut(r.reasonMessage) } : {}),
    checkedAt: r.checkedAt,
  };
}

export interface SyncServiceDeps {
  /** Persisted targets (so the periodic check works after a restart, before any shift or hygiene run). */
  file: string;
  findRepo: (remoteUrlNormalized: string) => Promise<RepoReport | undefined>;
  /** Worktrees with a running card shift. */
  busyWorktrees: () => string[];
  auth?: GitAuth;
  send: (status: SyncStatusReport) => void;
  log?: Logger;
  now?: () => Date;
  /** The home folder masked as `~` in messages (default: the user's home). */
  home?: string;
}

/** Light check every 10 minutes: fetch the working branch, measure ahead/behind, fast-forward when it is safe. */
export const SYNC_INTERVAL_MS = 10 * 60_000;

export class SyncService {
  private targets = new Map<string, SyncTarget>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly log: Logger;

  constructor(private readonly deps: SyncServiceDeps) {
    this.log = deps.log ?? nullLogger;
    this.load();
  }

  private load(): void {
    try {
      const list = JSON.parse(readFileSync(this.deps.file, 'utf8')) as SyncTarget[];
      for (const t of list)
        if (t?.repoId && t.workingBranch && t.remoteUrlNormalized) this.targets.set(t.repoId, t);
    } catch {
      // none yet
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify([...this.targets.values()]), { mode: 0o600 });
      renameSync(`${this.deps.file}.tmp`, this.deps.file);
    } catch (err) {
      this.log.warn(`could not save the sync targets: ${String(err)}`);
    }
  }

  /** Learns (or updates) which branch of which repository to keep in step. */
  remember(t: SyncTarget): void {
    const old = this.targets.get(t.repoId);
    if (old && old.workingBranch === t.workingBranch && old.remoteUrlNormalized === t.remoteUrlNormalized)
      return;
    this.targets.set(t.repoId, t);
    this.save();
  }

  list(): SyncTarget[] {
    return [...this.targets.values()];
  }

  /** Syncs one repository now and reports the result to the server. Never throws. */
  async sync(
    t: SyncTarget,
    opts: { fetch?: boolean; readOnly?: boolean; locked?: boolean } = {},
  ): Promise<SyncStatusReport> {
    this.remember(t);
    const checkedAt = (this.deps.now?.() ?? new Date()).toISOString();
    let result: SyncResult;
    try {
      const repo = await this.deps.findRepo(t.remoteUrlNormalized);
      const run = opts.locked ? syncWorkingBranchUnlocked : syncWorkingBranch;
      result = repo
        ? await run({
            repoPath: repo.localPath,
            workingBranch: t.workingBranch,
            busyWorktrees: this.deps.busyWorktrees(),
            ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
            ...(opts.readOnly ? { readOnly: true } : {}),
            ...(this.deps.auth ? { auth: this.deps.auth } : {}),
            ...(this.deps.home ? { home: this.deps.home } : {}),
          })
        : {
            state: 'error',
            ahead: 0,
            behind: 0,
            dirty: false,
            onBranch: false,
            checkedOutBranch: null,
            detail: 'no local clone on this workstation',
            reason: 'no-clone',
            reasonMessage: 'there is no local clone of this repository on this workstation',
          };
    } catch (err) {
      const why = safeSyncText(
        (err instanceof Error ? err.message : String(err)).slice(0, 300),
        this.deps.home,
      );
      result = {
        state: 'error',
        ahead: 0,
        behind: 0,
        dirty: false,
        onBranch: false,
        checkedOutBranch: null,
        detail: why,
        reason: 'sync-failed',
        reasonMessage: safeSyncText(`the sync failed: ${why}`, this.deps.home),
      };
    }
    const report: SyncStatusReport = { ...t, ...result, checkedAt };
    if (result.reason && !isQuietRepoSyncReason(result.reason))
      this.log.info(
        `working branch sync left ${t.workingBranch} unchanged in ${t.remoteUrlNormalized} ` +
          `(reason=${result.reason}): ${result.reasonMessage ?? ''}`,
        { repoId: t.repoId, state: result.state },
      );
    this.deps.send(report);
    return report;
  }

  /** One pass over every known target (the periodic check). Skips a pass still in flight. */
  async checkAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const t of this.list()) await this.sync(t);
    } finally {
      this.running = false;
    }
  }

  start(intervalMs: number = SYNC_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkAll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
