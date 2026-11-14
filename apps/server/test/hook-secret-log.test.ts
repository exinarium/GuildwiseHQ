import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';

/** A hook called with its secret in the path leaves the id in the request log, never the secret. */
const lines: string[] = [];
const logStream = { write: (line: string) => void lines.push(line) };
const HOOK_ID = '00000000-0000-4000-8000-00000000abcd';
const DUMMY_SECRET = 'DUMMY_HOOK_SECRET_e41c9a07';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: 'info' }, logStream });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('request log of a hook call in the path form', () => {
  it('logs the hook id and not the secret', async () => {
    lines.length = 0;
    await t.app.inject({
      method: 'POST',
      url: `/api/hooks/${HOOK_ID}/${DUMMY_SECRET}?x=1`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    const logged = lines
      .map((l) => JSON.parse(l) as { req?: { url?: string } })
      .filter((l) => l.req?.url?.includes('/api/hooks/'));
    expect(logged.length).toBeGreaterThan(0);
    for (const l of logged) expect(l.req!.url).toBe(`/api/hooks/${HOOK_ID}/[redacted]?x=1`);
    expect(lines.join('\n')).not.toContain(DUMMY_SECRET);
    expect(lines.join('\n')).toContain(HOOK_ID);
  });
});
