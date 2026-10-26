import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface OutboxEntry {
  id: string;
  type: string;
  frame: Record<string, unknown>;
}

/**
 * Durable queue of acked messages: one JSON file per message id, named so lexical order = creation order.
 * Persist before sending; delete on ack; resend everything (same ids) after reconnect or process restart.
 */
export class Outbox {
  private seq = 0;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    // Continue the sequence after whatever is on disk so new entries sort last.
    for (const f of readdirSync(dir)) {
      const n = Number.parseInt(f.split('-')[0] ?? '', 10);
      if (Number.isFinite(n) && n >= this.seq) this.seq = n + 1;
    }
  }

  private fileFor(id: string): string | undefined {
    return readdirSync(this.dir).find((f) => f.endsWith(`-${id}.json`));
  }

  /**
   * Persists a frame. Returns false (instead of throwing) when the file cannot be written, for example because the
   * data directory was removed underneath a runner that is shutting down: callers are often async tails (a shift
   * wrapping up) where a throw would surface as an unhandled rejection and take the process down.
   */
  add(frame: { id: string; type: string } & Record<string, unknown>): boolean {
    const name = `${String(this.seq++).padStart(12, '0')}-${frame.id}.json`;
    const tmp = join(this.dir, `${name}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(frame));
      renameSync(tmp, join(this.dir, name));
      return true;
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      return false;
    }
  }

  ack(id: string): boolean {
    const f = this.fileFor(id);
    if (!f) return false;
    unlinkSync(join(this.dir, f));
    return true;
  }

  has(id: string): boolean {
    return this.fileFor(id) !== undefined;
  }

  /** Entries in creation order. Corrupt files are dropped. */
  list(): OutboxEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: OutboxEntry[] = [];
    for (const f of readdirSync(this.dir)
      .filter((n) => n.endsWith('.json'))
      .sort()) {
      try {
        const frame = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Record<string, unknown>;
        out.push({ id: String(frame.id), type: String(frame.type), frame });
      } catch {
        try {
          unlinkSync(join(this.dir, f));
        } catch {
          // ignore
        }
      }
    }
    return out;
  }

  count(): number {
    return this.list().length;
  }

  /** Drops entries matching the predicate (e.g. a shift's unsent terminal report after `claim_lost`). */
  discard(pred: (e: OutboxEntry) => boolean): number {
    let n = 0;
    for (const e of this.list()) {
      if (pred(e) && this.ack(e.id)) n++;
    }
    return n;
  }
}
