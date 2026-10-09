import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from './secrets/redact.ts';

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

/** Logs to stderr and, when `file` is given, appends to it (logs/runner.log). */
export function createLogger(file?: string, quiet = false): Logger {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const write = (level: string, msg: string, extra?: unknown) => {
    const line = redact(
      `${new Date().toISOString()} ${level} ${msg}${extra === undefined ? '' : ` ${safeJson(extra)}`}\n`,
    );
    if (!quiet) process.stderr.write(line);
    if (file) {
      try {
        appendFileSync(file, line);
      } catch {
        // logging must never throw
      }
    }
  };
  return {
    info: (m, e) => write('INFO', m, e),
    warn: (m, e) => write('WARN', m, e),
    error: (m, e) => write('ERROR', m, e),
  };
}

function safeJson(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
