import { maskSecrets } from '@aom/shared';

/**
 * The server's own recent log lines, kept in memory so the CEO's full-power owner turn can read them
 * (`aom ceo diag server --kind logs`, docs/investigations/ceo-full-power.md). The logger writes to its usual place first; this
 * only copies the line. Nothing is persisted, and every line is masked again when it is read.
 */
export const LOG_RING_LINES = 5000;
const MAX_LINE_CHARS = 1500;

/** pino's numeric levels. */
const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
export type LogLevelName = keyof typeof LEVELS;

export class LogRing {
  private buf: string[] = [];

  constructor(private readonly max = LOG_RING_LINES) {}

  push(chunk: string | Uint8Array): void {
    for (const line of String(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')).split(
      '\n',
    )) {
      if (!line.trim()) continue;
      this.buf.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
      if (this.buf.length > this.max * 1.2) this.buf.splice(0, this.buf.length - this.max);
    }
  }

  /** A stream the logger can write to: it copies each chunk here and passes it on. */
  tee(dest: { write(chunk: string | Uint8Array): unknown }): { write(chunk: string | Uint8Array): void } {
    return {
      write: (chunk) => {
        try {
          this.push(chunk);
        } catch {
          // the copy must never stop the log
        }
        dest.write(chunk);
      },
    };
  }

  get size(): number {
    return Math.min(this.buf.length, this.max);
  }

  /** The newest `lines` lines at or above `level` that contain `grep` (case-insensitive), oldest first, secrets masked. */
  read(opts: { lines: number; level: LogLevelName; grep?: string | undefined }): string[] {
    const min = LEVELS[opts.level];
    const needle = opts.grep?.toLowerCase();
    const out: string[] = [];
    for (let i = this.buf.length - 1; i >= 0 && out.length < opts.lines; i--) {
      const line = this.buf[i] as string;
      const level = /"level":(\d+)/.exec(line)?.[1];
      if (level !== undefined && Number(level) < min) continue;
      if (needle && !line.toLowerCase().includes(needle)) continue;
      out.push(maskSecrets(line));
    }
    return out.reverse();
  }
}
