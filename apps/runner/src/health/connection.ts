import { readFileSync } from 'node:fs';

/**
 * Doctor's connection line from status.json (UAT 1.10.0 finding 4): a running runner that has not reached the server for
 * CONNECTION_FAIL_MS fails, with how long, the last error and the next try. Null when no runner is running.
 */
export const CONNECTION_FAIL_MS = 5 * 60_000;
export function connectionLine(
  statusFile: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
): { ok: boolean | 'warn'; detail: string } | null {
  let s: {
    pid?: number;
    connected?: boolean;
    connection?: {
      offlineSince?: string;
      failedAttempts?: number;
      lastError?: string;
      nextAttemptAt?: string;
    };
  };
  try {
    s = JSON.parse(readFileSync(statusFile, 'utf8'));
  } catch {
    return null;
  }
  if (typeof s.pid !== 'number' || !alive(s.pid)) return null;
  if (s.connected) return { ok: true, detail: 'connected' };
  const c = s.connection ?? {};
  const since = c.offlineSince ? Date.parse(c.offlineSince) : Number.NaN;
  const mins = Number.isFinite(since) ? Math.floor((now - since) / 60_000) : null;
  const detail = [
    mins === null ? 'not connected' : `not connected for ${mins} minute${mins === 1 ? '' : 's'}`,
    c.failedAttempts ? `${c.failedAttempts} failed attempt${c.failedAttempts === 1 ? '' : 's'}` : '',
    c.lastError ? `last error: ${c.lastError}` : '',
    c.nextAttemptAt ? `next try ${c.nextAttemptAt}` : '',
  ]
    .filter(Boolean)
    .join('; ');
  const long = Number.isFinite(since) && now - since >= CONNECTION_FAIL_MS;
  return { ok: long ? false : 'warn', detail };
}
