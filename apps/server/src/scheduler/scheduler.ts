import { fireDueHygiene } from '../commands/hygiene.ts';
import { fireDueSchedules } from '../commands/schedules.ts';
import type { Ctx } from '../context.ts';
import { licensingTick } from '../orgs/licensing.ts';

const TICK_MS = 15_000;
const LICENSING_MS = 5 * 60_000;

/**
 * Fires due schedules every 15 s and on boot (docs/ARCHITECTURE.md section 10). Schedules always fire on time: the
 * scheduler never waits for agents; the dispatcher gives the emitted card priority and, when no agent is free, an
 * overflow shift. Tests call `run()` after moving the test clock.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private licensingTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.run().catch(() => {});
      if (this.ctx.config.hygieneSchedule) void this.runHygiene().catch(() => {});
    }, TICK_MS);
    this.timer.unref();
    this.licensingTimer = setInterval(() => void this.runLicensing().catch(() => {}), LICENSING_MS);
    this.licensingTimer.unref();
    void this.runLicensing().catch((err) => this.ctx.log.error({ err }, 'licensing tick failed'));
    void this.run().catch((err) => this.ctx.log.error({ err }, 'scheduler failed'));
    if (this.ctx.config.hygieneSchedule)
      void this.runHygiene().catch((err) => this.ctx.log.error({ err }, 'hygiene scheduler failed'));
  }

  /** The workstations' repository hygiene jobs that are due (their own cadence, default daily). Returns the request ids. */
  runHygiene(): Promise<string[]> {
    if (this.stopped) return Promise.resolve([]);
    const next = this.chain.then(() => fireDueHygiene(this.ctx));
    this.chain = next.catch(() => {});
    return next;
  }

  /** Trial and licence ends suspend organizations; warnings go to their desks (every 5 minutes). */
  runLicensing(): Promise<{ suspended: number; warned: number }> {
    if (this.stopped) return Promise.resolve({ suspended: 0, warned: 0 });
    const next = this.chain.then(() => licensingTick(this.ctx));
    this.chain = next.catch(() => {});
    return next;
  }

  /** One pass, serialized in-process. Returns the cards it created. */
  run(): Promise<Array<{ scheduleId: string; cardId: string }>> {
    if (this.stopped) return Promise.resolve([]);
    const next = this.chain.then(() => fireDueSchedules(this.ctx));
    this.chain = next.catch(() => {});
    return next;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.licensingTimer) clearInterval(this.licensingTimer);
    await this.chain.catch(() => {});
  }
}
