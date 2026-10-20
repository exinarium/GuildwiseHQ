import { join } from 'node:path';
import type { RunnerUpdateCheckResult, RunnerUpdateState } from '@aom/shared';
import type { Logger } from '../log.ts';
import {
  type Fetcher,
  fetchRelease,
  pruneVersions,
  type ServiceMode,
  scheduleRestart,
  stageRelease,
  switchBack,
  switchTo,
} from './apply.ts';
import {
  type InstallLayout,
  readFailed,
  readPending,
  removeFile,
  writeFailed,
  writePending,
} from './layout.ts';
import { decideProbation, PROBATION_SEC } from './rollback.ts';
import { isNewer } from './semver.ts';

export interface UpdateStatus {
  state: RunnerUpdateState;
  latestVersion: string | null;
  lastCheckedAt: string | null;
  detail: string | null;
}

export interface UpdateTiming {
  /** The first check happens a random time in [min, max] after start, so a fleet restarted together does not stampede. */
  firstCheckMinMs: number;
  firstCheckMaxMs: number;
  /** Time between checks (a day), with +-10% jitter. */
  intervalMs: number;
  /** While a downloaded update waits for the runner to be idle, how often idleness is looked at. */
  idlePollMs: number;
  /** After this long without ever being idle the update is applied anyway. */
  maxIdleWaitMs: number;
}

export const DEFAULT_TIMING: UpdateTiming = {
  firstCheckMinMs: 60_000,
  firstCheckMaxMs: 10 * 60_000,
  intervalMs: 24 * 3_600_000,
  idlePollMs: 30_000,
  maxIdleWaitMs: 6 * 3_600_000,
};

export interface UpdaterOptions {
  /** Null when this process is not running from the installer's layout: the updater then only reports `unmanaged`. */
  layout: InstallLayout | null;
  /** The version of this process. */
  version: string;
  serverUrl: () => string | null;
  /** True when no agent job or chat is running on this machine. */
  isIdle: () => boolean;
  /** Ends this process cleanly so the service manager (or the fallback helper) starts the new version. */
  restart: () => void;
  /** Called with the new status whenever it changes. */
  report: (s: UpdateStatus) => void;
  log: Logger;
  mode: ServiceMode | null;
  /** Local off switch (`AOM_RUNNER_AUTO_UPDATE=0`). */
  disabled?: boolean;
  fetch?: Fetcher;
  now?: () => number;
  random?: () => number;
  timing?: Partial<UpdateTiming>;
  /** Test seams. */
  stage?: typeof stageRelease;
  scheduleRestartFn?: typeof scheduleRestart;
}

/**
 * The runner's self-update (docs/RUNNER.md "Updates"). A day-long cycle of: ask the server for the current release,
 * download and verify the newer one, wait until no agent job is running, switch the `current` link, and restart. The new
 * version is on probation for `PROBATION_SEC`: it clears the marker when it connects; if it does not, it (or the launcher
 * script, when the new version cannot even start) switches `current` back to the previous version.
 */
export class Updater {
  private readonly timing: UpdateTiming;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly f: Fetcher;
  private timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private connected = false;
  private checking: Promise<UpdateStatus> | null = null;
  private waitingFor: string | null = null;
  /** Why the last check could not read the release (null: it could). */
  private lastCheckError: string | null = null;
  /** Safe mode: the version the platform team pinned this workstation to (null: follow the latest release). */
  private pin: string | null = null;
  private status: UpdateStatus = {
    state: 'up_to_date',
    latestVersion: null,
    lastCheckedAt: null,
    detail: null,
  };

  constructor(private readonly opts: UpdaterOptions) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.f = opts.fetch ?? fetch;
  }

  get current(): UpdateStatus {
    return this.status;
  }

  start(): void {
    const { layout, log } = this.opts;
    this.stopped = false;
    const why = this.unmanagedReason();
    if (why || !layout) {
      this.set({ state: 'unmanaged', detail: why });
      log.info(`self-update is off: ${why}`);
      return;
    }
    const failed = readFailed(layout);
    if (failed && !isNewer(this.opts.version, failed.version)) {
      this.set({
        state: 'rolled_back',
        latestVersion: failed.version,
        detail: `${failed.version} did not connect and was rolled back${failed.reason ? ` (${failed.reason})` : ''}`,
      });
    } else this.set({});
    void this.probation();
    const first =
      this.timing.firstCheckMinMs +
      this.random() * (this.timing.firstCheckMaxMs - this.timing.firstCheckMinMs);
    this.later(first, () => void this.cycle());
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /**
   * Safe mode (`welcome.runnerPin`, the `runner.pin` command): run exactly this version, an older one too, and do not
   * follow newer releases while it is set. Null ends it. A change starts a check at once.
   */
  setPin(version: string | null): void {
    if (version === this.pin) return;
    this.pin = version;
    this.waitingFor = null;
    if (!this.stopped && this.status.state !== 'unmanaged') void this.check().catch(() => undefined);
  }

  /** A pairing completed the handshake: a version on probation has proven it can connect. */
  noteConnected(): void {
    this.connected = true;
    void this.probation();
  }

  /** One check now (used by the daily cycle and by tests). Concurrent calls share one run. */
  check(): Promise<UpdateStatus> {
    this.checking ??= this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /**
   * "Check for updates" (the `runner.update.check` command): the same check as the daily timer, now. It goes through the
   * same pipeline (download, verify, wait for idle, switch), never restarts a busy runner, and respects the kill switches.
   * A check or download already running is joined, not repeated. The answer says what was found.
   */
  async checkNow(): Promise<RunnerUpdateCheckResult> {
    const { log } = this.opts;
    const result = await this.runCheckNow();
    log.info(
      `update check on request: ${result.outcome}${result.version ? ` ${result.version}` : ''}${result.detail ? ` (${result.detail})` : ''}`,
    );
    return result;
  }

  private async runCheckNow(): Promise<RunnerUpdateCheckResult> {
    const out = (
      outcome: RunnerUpdateCheckResult['outcome'],
      version: string | null,
      detail: string | null,
    ): RunnerUpdateCheckResult => ({ outcome, version, detail: detail ? detail.slice(0, 300) : null });
    if (this.stopped || this.status.state === 'unmanaged' || !this.opts.layout)
      return out('disabled', null, this.status.detail ?? this.unmanagedReason());
    if (!this.opts.serverUrl()) return out('failed', null, 'this runner has no server to ask');
    let status: UpdateStatus;
    try {
      status = await this.check();
    } catch (err) {
      return out('failed', null, String(err));
    }
    if (this.lastCheckError) return out('failed', null, this.lastCheckError);
    const version = status.latestVersion;
    switch (status.state) {
      case 'up_to_date':
        return out('up_to_date', version ?? this.opts.version, status.detail);
      case 'pending':
      case 'updating':
        return out('update_found', version, status.detail);
      case 'paused':
        return out('paused', version, status.detail);
      case 'unmanaged':
        return out('disabled', null, status.detail);
      case 'failed':
      case 'rolled_back':
        return out('failed', version, status.detail);
    }
  }

  private unmanagedReason(): string | null {
    const { layout, mode, version } = this.opts;
    if (this.opts.disabled) return 'turned off on this machine (AOM_RUNNER_AUTO_UPDATE=0)';
    if (!layout)
      return 'this runner was not started from the installer layout (a checkout or a hand-made copy)';
    if (layout.packageDir !== join(layout.versionDir(version), 'aom-runner'))
      return `the folder ${layout.packageDir} does not match version ${version}`;
    if (!mode) return 'this runner was not started by a service manager, so nothing would restart it';
    return null;
  }

  private set(patch: Partial<UpdateStatus>): void {
    const next: UpdateStatus = { ...this.status, detail: null, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) this.opts.report(next);
  }

  private later(ms: number, fn: () => void): void {
    if (this.stopped) return;
    const t = setTimeout(
      () => {
        this.timers.delete(t);
        fn();
      },
      Math.max(0, ms),
    );
    t.unref?.();
    this.timers.add(t);
  }

  private async cycle(): Promise<void> {
    try {
      await this.check();
    } catch (err) {
      this.opts.log.warn(`update check failed: ${String(err)}`);
    }
    this.later(this.timing.intervalMs * (0.9 + this.random() * 0.2), () => void this.cycle());
  }

  private async serverReachable(): Promise<boolean> {
    const url = this.opts.serverUrl();
    if (!url) return false;
    try {
      await this.f(new URL('/api/runner/release', url), { signal: AbortSignal.timeout(10_000) });
      return true;
    } catch {
      return false;
    }
  }

  /** The probation of a freshly switched version: confirm it once connected, roll back when it never does. */
  private async probation(): Promise<void> {
    const { layout, version, log } = this.opts;
    if (!layout || this.stopped) return;
    const pending = readPending(layout);
    const nowSec = Math.floor(this.now() / 1000);
    const overdue = !!pending && nowSec >= pending.deadline && !this.connected;
    const decision = decideProbation({
      pending,
      running: version,
      connected: this.connected,
      nowSec,
      serverReachable: overdue ? await this.serverReachable() : true,
    });
    switch (decision.action) {
      case 'none':
        return;
      case 'stale':
        removeFile(layout.pendingFile);
        return;
      case 'confirm': {
        removeFile(layout.pendingFile);
        const removed = pruneVersions(layout, [version, pending?.from ?? version]);
        log.info(
          `updated to ${version} (from ${pending?.from}); removed old versions: ${removed.join(', ') || 'none'}`,
        );
        this.set({ state: 'up_to_date', detail: `updated from ${pending?.from}` });
        return;
      }
      case 'wait':
        if (decision.reason === 'server_unreachable')
          log.warn(`${version} has not connected and the server cannot be reached: not rolling back yet`);
        this.later(Math.max(1000, decision.untilSec * 1000 - this.now()), () => void this.probation());
        return;
      case 'rollback':
        this.rollback(pending?.from ?? '', pending?.to ?? version);
    }
  }

  private rollback(from: string, to: string): void {
    const { layout, log } = this.opts;
    if (!layout) return;
    try {
      switchBack(layout, join(layout.versionDir(from), 'aom-runner'));
    } catch (err) {
      log.error(`rollback to ${from} failed: ${String(err)}`);
      this.set({
        state: 'failed',
        detail: `${to} did not connect and the rollback to ${from} failed: ${String(err)}`,
      });
      return;
    }
    writeFailed(layout, {
      version: to,
      at: Math.floor(this.now() / 1000),
      reason: `no connection within ${PROBATION_SEC / 60} minutes`,
    });
    removeFile(layout.pendingFile);
    log.warn(
      `${to} did not connect within ${PROBATION_SEC / 60} minutes: rolled back to ${from}, restarting`,
    );
    this.set({
      state: 'rolled_back',
      latestVersion: to,
      detail: `${to} did not connect and was rolled back to ${from}`,
    });
    this.restartNow();
  }

  private restartNow(): void {
    const { layout, mode } = this.opts;
    if (layout && mode) (this.opts.scheduleRestartFn ?? scheduleRestart)(layout, mode);
    this.stop();
    this.opts.restart();
  }

  private async doCheck(): Promise<UpdateStatus> {
    const { layout, version, log } = this.opts;
    const server = this.opts.serverUrl();
    this.lastCheckError = null;
    if (!layout || this.status.state === 'unmanaged' || !server) return this.status;
    let release: Awaited<ReturnType<typeof fetchRelease>>;
    try {
      release = await fetchRelease(server, this.f, undefined, this.pin ?? undefined);
    } catch (err) {
      log.warn(`update check: could not read the release from ${server}: ${String(err)}`);
      this.lastCheckError = `could not read the release from the server: ${err instanceof Error ? err.message : String(err)}`;
      return this.status;
    }
    const checkedAt = new Date(this.now()).toISOString();
    // A pin is an explicit order of the platform team: it is followed even while automatic updates are paused.
    if (this.pin && release.version === version) {
      this.waitingFor = null;
      this.set({
        state: 'up_to_date',
        latestVersion: release.version,
        lastCheckedAt: checkedAt,
        detail: `Pinned to ${release.version} by the platform team (safe mode)`,
      });
      return this.status;
    }
    if (release.autoUpdatePaused && !this.pin) {
      this.waitingFor = null;
      this.set({
        state: 'paused',
        latestVersion: release.version,
        lastCheckedAt: checkedAt,
        detail: 'Auto-updates are paused by the platform administrator.',
      });
      return this.status;
    }
    if (!this.pin && !isNewer(release.version, version)) {
      this.waitingFor = null;
      this.set({ state: 'up_to_date', latestVersion: release.version, lastCheckedAt: checkedAt });
      return this.status;
    }
    const failed = readFailed(layout);
    if (failed && failed.version === release.version) {
      this.set({
        state: 'rolled_back',
        latestVersion: release.version,
        lastCheckedAt: checkedAt,
        detail: `${failed.version} did not connect on this machine and was rolled back; waiting for a newer release`,
      });
      return this.status;
    }
    const pending = readPending(layout);
    if (pending && pending.to === version) return this.status; // this version is still on probation
    if (this.waitingFor === release.version) {
      this.set({ lastCheckedAt: checkedAt, detail: this.status.detail });
      return this.status;
    }
    let pkg: string;
    try {
      pkg = await (this.opts.stage ?? stageRelease)(layout, release, this.f);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`update to ${release.version} failed: ${msg}`);
      this.set({
        state: 'failed',
        latestVersion: release.version,
        lastCheckedAt: checkedAt,
        detail: `could not install ${release.version}: ${msg}`.slice(0, 280),
      });
      return this.status;
    }
    this.waitingFor = release.version;
    this.set({
      state: 'pending',
      latestVersion: release.version,
      lastCheckedAt: checkedAt,
      detail: `${release.version} is downloaded and installs as soon as this runner is idle`,
    });
    this.waitForIdle(release.version, pkg, this.now());
    return this.status;
  }

  private waitForIdle(target: string, pkg: string, since: number): void {
    const tick = (): void => {
      if (this.stopped || this.waitingFor !== target) return;
      const waited = this.now() - since;
      const forced = waited >= this.timing.maxIdleWaitMs;
      if (this.opts.isIdle() || forced) {
        if (forced && !this.opts.isIdle())
          this.opts.log.warn(`runner stayed busy for ${Math.round(waited / 60000)} min: updating anyway`);
        void this.apply(target, pkg).then((done) => {
          if (!done) this.later(this.timing.idlePollMs, tick);
        });
        return;
      }
      this.later(this.timing.idlePollMs, tick);
    };
    this.later(this.timing.idlePollMs, tick);
  }

  /** Last look at the kill switch, then switch and restart. Returns false when it should be tried again later. */
  private async apply(target: string, pkg: string): Promise<boolean> {
    const { layout, version, log } = this.opts;
    const server = this.opts.serverUrl();
    if (!layout || !server) return true;
    try {
      const release = await fetchRelease(server, this.f, undefined, this.pin ?? undefined);
      if (release.autoUpdatePaused && !this.pin) {
        this.waitingFor = null;
        this.set({
          state: 'paused',
          latestVersion: release.version,
          detail: 'Auto-updates are paused by the platform administrator.',
        });
        return true;
      }
      if (release.version !== target) {
        this.waitingFor = null;
        void this.check();
        return true;
      }
    } catch {
      return false; // the server is unreachable: the new version could not prove itself, so wait
    }
    writePending(layout, {
      from: version,
      to: target,
      deadline: Math.floor(this.now() / 1000) + PROBATION_SEC,
    });
    try {
      switchTo(layout, pkg, layout.packageDir);
    } catch (err) {
      removeFile(layout.pendingFile);
      this.waitingFor = null;
      this.set({
        state: 'failed',
        latestVersion: target,
        detail: `could not switch to ${target}: ${String(err)}`.slice(0, 280),
      });
      return true;
    }
    log.info(`switched ${version} -> ${target}; restarting`);
    this.set({ state: 'updating', latestVersion: target, detail: `restarting into ${target}` });
    this.restartNow();
    return true;
  }
}
