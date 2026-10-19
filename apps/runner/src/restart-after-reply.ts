/**
 * `aom runner restart` from inside a turn (docs/design/ceo-front-door.md section 5.6): a restart kills every child process
 * group, including the turn that asked for it, so the restart waits until the turn's reply (`chat.done`) was acknowledged
 * by the server and the runner is idle (at most `maxWaitMs`, then it restarts anyway; running shifts are persisted for
 * resume), and only then calls `restart`.
 */
export interface RestartDeps {
  /** The reply frame of the turn that asked is no longer in the outbox (the server acknowledged it). */
  replyAcked: (frameId: string | undefined) => boolean;
  isIdle: () => boolean;
  /** Schedules the restart (scheduleRestart plus ending the process). */
  restart: () => void;
  now?: () => number;
  /** Test seam: replaces setTimeout. */
  later?: (fn: () => void, ms: number) => void;
  pollMs?: number;
  maxWaitMs?: number;
  log?: { info(m: string): void; warn(m: string): void };
}

export class RestartAfterReply {
  private pending: { by: string; reason: string | undefined } | null = null;
  private armed = false;
  private done = false;
  private readonly now: () => number;
  private readonly later: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: RestartDeps) {
    this.now = deps.now ?? Date.now;
    this.later = deps.later ?? ((fn, ms) => void setTimeout(fn, ms).unref());
  }

  /** `aom runner restart`: remember it; nothing happens before the turn's reply is out. */
  request(by: string, reason?: string): void {
    this.pending ??= { by, reason };
  }

  get requested(): { by: string; reason: string | undefined } | null {
    return this.pending;
  }

  /** The turn `chatId` finished and its `chat.done` (frame `frameId`) was queued: if it asked for the restart, start waiting for the ack. */
  turnFinished(chatId: string, frameId?: string): void {
    if (!this.pending || this.pending.by !== chatId || this.armed) return;
    this.armed = true;
    const since = this.now();
    const tick = (): void => {
      if (this.done) return;
      const acked = this.deps.replyAcked(frameId);
      const idle = this.deps.isIdle();
      const waited = this.now() - since;
      const forced = waited >= (this.deps.maxWaitMs ?? 600_000);
      if ((acked && idle) || forced) {
        if (forced && !(acked && idle))
          this.deps.log?.warn(
            'waited 10 minutes for the acknowledgement or an idle runner: restarting anyway (the outbox is durable)',
          );
        this.done = true;
        this.deps.log?.info(
          `restarting as asked by ${this.pending?.by} (${this.pending?.reason ?? 'no reason'})`,
        );
        this.deps.restart();
        return;
      }
      this.later(tick, this.deps.pollMs ?? 1000);
    };
    this.later(tick, 0);
  }
}
