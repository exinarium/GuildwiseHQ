import { existsSync, statSync } from 'node:fs';
import { applyOverrides, loadConfig, type RunnerConfig } from './config.ts';
import { UNPAIRED_MESSAGE } from './connection/client.ts';
import { createLogger, type Logger } from './log.ts';
import {
  entryConfigPath,
  entryDir,
  isMachinePrimary,
  loadIndex,
  type PairingEntry,
  pairingIndexPath,
  setDisabled,
} from './pairings.ts';
import { runnerPaths } from './paths.ts';
import { Runner, type RunnerOptions } from './runner.ts';
import type { UpdateStatus } from './update/updater.ts';

export interface HostOptions {
  root: string;
  log: Logger;
  mock?: boolean;
  maxShiftMsOverride?: number;
  /** How often `pairings.json` is checked for pairings added or removed while the runner is running (default 5 s). */
  reloadMs?: number;
  /** Test hook: extra options for every Runner. */
  runnerOptions?: Partial<RunnerOptions>;
  /** Called when a pairing connects (the self-updater uses it to confirm a freshly installed version). */
  onConnected?: () => void;
}

interface Running {
  entry: PairingEntry;
  runner: Runner;
  /** `workstationId:token` the runner started with, to notice a re-pair. */
  signature: string;
  log: Logger;
  serverUrl: string;
}

const signatureOf = (c: RunnerConfig): string => `${c.workstationId}:${c.runnerToken}`;

/**
 * Runs one Runner per pairing in this process, each with its own data directory, and keeps them in step with
 * `pairings.json`: a pairing added with `aom-runner pair` while the runner runs is started within `reloadMs`, one that
 * is removed or re-paired is stopped or restarted, and the others are never touched. The pairings share one
 * concurrency budget (the machine's shift limit), see `budget()`.
 */
export class RunnerHost {
  readonly running = new Map<string, Running>();
  /** Resolves with an exit code once no pairing is left running (0: all unpaired by the server or none left). */
  readonly fatal: Promise<number>;
  private fatalResolve!: (code: number) => void;
  private timer?: NodeJS.Timeout;
  private lastStamp = '';
  private worst = 0;
  private stopping = false;
  /** Set when the last pairing ended because the server unpaired it. */
  unpaired = false;
  private reloading: Promise<void> = Promise.resolve();
  /** What the self-updater last said; every pairing reports it to its server. */
  private updateStatus: UpdateStatus | null = null;

  constructor(private readonly opts: HostOptions) {
    this.fatal = new Promise<number>((r) => {
      this.fatalResolve = r;
    });
  }

  /** Starts every enabled pairing. Throws when nothing is paired. */
  async start(): Promise<void> {
    const index = loadIndex(this.opts.root);
    if (index.pairings.length === 0)
      throw new Error(
        `No runner config at ${runnerPaths(this.opts.root).config}. Run \`aom-runner pair\` first.`,
      );
    this.lastStamp = this.stamp();
    await this.sync();
    if (this.running.size === 0) {
      this.unpaired = index.pairings.every((p) => p.disabled === 'unpaired');
      this.fatalResolve(this.unpaired ? 0 : 2);
      return;
    }
    const t = setInterval(() => void this.reload(), this.opts.reloadMs ?? 5000);
    t.unref();
    this.timer = t;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.reloading;
    await Promise.all([...this.running.values()].map((r) => r.runner.stop().catch(() => undefined)));
    this.running.clear();
  }

  /** True when no pairing runs an agent job or a chat: the runner may restart into a new version. */
  isIdle(): boolean {
    return [...this.running.values()].every((r) => r.runner.isIdle());
  }

  /** The server the self-updater asks for releases: the first running pairing's. */
  serverUrl(): string | null {
    return [...this.running.values()][0]?.serverUrl ?? null;
  }

  /** Records the self-update status and sends it to every pairing's server. */
  setUpdateStatus(s: UpdateStatus): void {
    this.updateStatus = s;
    for (const r of this.running.values()) r.runner.reportUpdate();
  }

  /** The machine-wide shift limit: the index value, else the largest limit of the configured pairings. */
  private machineLimit(): number {
    const index = loadIndex(this.opts.root);
    if (index.maxConcurrentShifts) return index.maxConcurrentShifts;
    let max = 1;
    for (const r of this.running.values())
      max = Math.max(max, loadSafe(entryConfigPath(this.opts.root, r.entry))?.maxConcurrentShifts ?? 4);
    return max;
  }

  /** Shifts the pairing `id` may still run: the machine limit minus what the other pairings run. */
  private capFor(id: string): number {
    let others = 0;
    for (const [k, r] of this.running) if (k !== id) others += r.runner.supervisor.size;
    return Math.max(0, this.machineLimit() - others);
  }

  private stamp(): string {
    const f = pairingIndexPath(this.opts.root);
    if (!existsSync(f)) return '';
    const s = statSync(f);
    return `${s.mtimeMs}:${s.size}`;
  }

  /** Re-reads the index when it changed (or a running pairing's config did) and applies the difference. */
  reload(): Promise<void> {
    this.reloading = this.reloading.then(async () => {
      if (this.stopping) return;
      const stamp = this.stamp();
      const reconfigured = [...this.running.values()].some((r) => {
        const c = loadSafe(entryConfigPath(this.opts.root, r.entry));
        return !c || signatureOf(c) !== r.signature;
      });
      if (stamp === this.lastStamp && !reconfigured) return;
      this.lastStamp = stamp;
      await this.sync();
    });
    return this.reloading;
  }

  private async sync(): Promise<void> {
    let index: ReturnType<typeof loadIndex>;
    try {
      index = loadIndex(this.opts.root);
    } catch (err) {
      this.opts.log.warn(`pairings.json unreadable, keeping the current pairings: ${String(err)}`);
      return;
    }
    const wanted = new Map(index.pairings.filter((p) => !p.disabled).map((p) => [p.id, p]));
    for (const [id, r] of [...this.running]) {
      const want = wanted.get(id);
      const cfg = want ? loadSafe(entryConfigPath(this.opts.root, want)) : undefined;
      if (!want || !cfg || signatureOf(cfg) !== r.signature) {
        this.opts.log.info(`pairing ${id} ${want ? 're-paired: restarting it' : 'removed: stopping it'}`);
        this.running.delete(id);
        await r.runner.stop().catch(() => undefined);
      }
    }
    for (const [id, entry] of wanted) {
      if (this.running.has(id)) continue;
      const cfg = loadSafe(entryConfigPath(this.opts.root, entry));
      if (!cfg) {
        this.opts.log.warn(
          `pairing ${id}: no readable config at ${entryConfigPath(this.opts.root, entry)}; skipped`,
        );
        continue;
      }
      await this.startOne(entry, applyOverrides(cfg, { mock: this.opts.mock }), signatureOf(cfg));
    }
  }

  private async startOne(entry: PairingEntry, config: RunnerConfig, signature: string): Promise<void> {
    const dir = entryDir(this.opts.root, entry);
    const paths = runnerPaths(dir);
    const log = withPrefix(createLogger(paths.runnerLog), `[${entry.id}] `);
    const runner = new Runner({
      config,
      dataDir: dir,
      log,
      maxShiftMsOverride: this.opts.maxShiftMsOverride,
      sharedCap: () => this.capFor(entry.id),
      updateStatus: () => this.updateStatus,
      isPrimaryPairing: () => {
        try {
          return isMachinePrimary(loadIndex(this.opts.root), entry);
        } catch {
          return true;
        }
      },
      onConnected: () => this.opts.onConnected?.(),
      ...this.opts.runnerOptions,
    });
    this.running.set(entry.id, { entry, runner, signature, log, serverUrl: config.serverUrl });
    try {
      await runner.start();
    } catch (err) {
      this.running.delete(entry.id);
      this.opts.log.error(`pairing ${entry.id} could not start: ${String(err)}`);
      this.worst = Math.max(this.worst, 2);
      await runner.stop().catch(() => undefined);
      this.maybeFinish();
      return;
    }
    log.info(
      `pairing ${entry.id} (${entry.label}) started: workstation ${config.workstationId}, server ${config.serverUrl}`,
    );
    void runner.fatal.then((code) => this.onEnded(entry, runner, code));
  }

  private async onEnded(entry: PairingEntry, runner: Runner, code: number): Promise<void> {
    const cur = this.running.get(entry.id);
    if (!cur || cur.runner !== runner || this.stopping) return; // already replaced or stopping
    this.running.delete(entry.id);
    await runner.stop().catch(() => undefined);
    if (runner.unpaired) {
      this.opts.log.warn(
        `pairing ${entry.id} (${entry.label}): ${UNPAIRED_MESSAGE} Other pairings keep running.`,
      );
      try {
        setDisabled(this.opts.root, entry.id, 'unpaired');
        this.lastStamp = this.stamp();
      } catch {
        // advisory
      }
    } else {
      this.opts.log.error(`pairing ${entry.id} (${entry.label}) ended with code ${code}`);
      this.worst = Math.max(this.worst, code);
    }
    this.unpaired = runner.unpaired && this.worst === 0;
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.running.size > 0 || this.stopping) return;
    this.fatalResolve(this.worst);
  }
}

function loadSafe(path: string): RunnerConfig | undefined {
  try {
    return loadConfig(path);
  } catch {
    return undefined;
  }
}

/** Log lines carry the pairing id, so a shared stderr or service journal tells the pairings apart. */
function withPrefix(inner: Logger, prefix: string): Logger {
  return {
    info: (m, e) => inner.info(`${prefix}${m}`, e),
    warn: (m, e) => inner.warn(`${prefix}${m}`, e),
    error: (m, e) => inner.error(`${prefix}${m}`, e),
  };
}
