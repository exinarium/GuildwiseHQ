import pg from 'pg';
import type { PgEventStore } from './pg-event-store.ts';

/**
 * One dedicated connection with LISTEN aom_events plus a 5 s safety poll. Reads `seq > lastSeq` in batches and
 * fans out to in-process subscribers in order. The global append lock makes commit order equal seq order,
 * so a cursor on seq can never skip a late commit (docs/ARCHITECTURE.md section 3.4).
 */
export class Notifier {
  private client: pg.Client | null = null;
  private lastSeq = 0n;
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private idle: Promise<void> = Promise.resolve();

  constructor(
    private readonly connectionString: string,
    private readonly store: PgEventStore,
    private readonly onError: (err: unknown) => void = () => {},
    private readonly pollMs = 5000,
  ) {}

  get cursor(): bigint {
    return this.lastSeq;
  }

  async start(): Promise<void> {
    this.lastSeq = await this.store.maxSeq();
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('error', (e) => this.onError(e));
    client.on('notification', () => this.kick());
    await client.connect();
    await client.query('LISTEN aom_events');
    this.client = client;
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.timer.unref();
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.idle = this.drain().finally(() => {
      this.running = false;
      if (this.again && !this.stopped) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Resolves when all events committed so far have been delivered (tests). */
  async flush(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const max = await this.store.maxSeq();
      if (this.lastSeq >= max && !this.running) return;
      this.kick();
      await this.idle;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const batch = await this.store.readAll(this.lastSeq, 500);
        if (batch.length === 0) return;
        for (const e of batch) {
          await this.store.dispatch(e, this.onError);
          this.lastSeq = e.seq;
        }
        if (batch.length < 500) return;
      }
    } catch (err) {
      this.onError(err);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.idle.catch(() => {});
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
    }
  }
}
