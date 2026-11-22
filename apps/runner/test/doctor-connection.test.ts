import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONNECTION_FAIL_MS, connectionLine } from '../src/health/connection.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/** UAT 1.10.0 finding 4: doctor says plainly that a running runner has not reached the server. */
describe('doctor: server connection', () => {
  const now = Date.parse('2026-11-22T18:00:00.000Z');
  const file = (s: unknown) => {
    const f = join(tmp(), 'status.json');
    writeFileSync(f, JSON.stringify(s));
    return f;
  };
  const alive = () => true;

  it('fails after the limit, naming how long, the attempts and the last error', () => {
    const f = file({
      pid: 1,
      connected: false,
      connection: {
        offlineSince: new Date(now - 18 * 3_600_000).toISOString(),
        failedAttempts: 2100,
        lastError: 'the server answered HTTP 502 instead of opening the connection',
      },
    });
    const r = connectionLine(f, now, alive);
    expect(r?.ok).toBe(false);
    expect(r?.detail).toMatch(/not connected for 1080 minutes; 2100 failed attempts; last error: .*HTTP 502/);
  });

  it('only warns while briefly offline, is ok when connected, and says nothing without a running runner', () => {
    const brief = file({
      pid: 1,
      connected: false,
      connection: {
        offlineSince: new Date(now - CONNECTION_FAIL_MS + 1000).toISOString(),
        failedAttempts: 1,
      },
    });
    expect(connectionLine(brief, now, alive)?.ok).toBe('warn');
    expect(connectionLine(file({ pid: 1, connected: true }), now, alive)).toEqual({
      ok: true,
      detail: 'connected',
    });
    expect(connectionLine(file({ pid: 1, connected: false }), now, () => false)).toBeNull();
    expect(connectionLine(join(tmp(), 'missing.json'), now, alive)).toBeNull();
  });
});
