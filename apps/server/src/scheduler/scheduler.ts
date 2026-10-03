import { fireDueSchedules } from '../commands/schedules.ts';
import type { Ctx } from '../context.ts';

const TICK_MS = 15_000;

/**
 * Fires due schedules every 15 s and on boot (docs/ARCHITECTURE.md section 10). Schedules always fire on time: the
 * scheduler never waits for agents; the dispatcher gives the emitted card priority and, when no agent is free, an
 * overflow shift. Tests call `run()` after moving the test clock.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => void this.run().catch(() => {}), TICK_MS);
    this.timer.unref();
    void this.run().catch((err) => this.ctx.log.error({ err }, 'scheduler failed'));
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
    await this.chain.catch(() => {});
  }
}
