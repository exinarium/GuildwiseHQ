import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';

let t: TestApp;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aom-web-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(join(dir, 'privacy.html'), '<!doctype html><title>Privacy policy</title>');
  await writeFile(join(dir, 'terms.html'), '<!doctype html><title>Terms and conditions</title>');
  t = await createTestApp({ env: { AOM_SERVE_WEB: 'true', AOM_WEB_DIST: dir } });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('legal pages', () => {
  it('serves /privacy and /terms to anyone, signed in or not', async () => {
    for (const [url, title] of [
      ['/privacy', 'Privacy policy'],
      ['/terms', 'Terms and conditions'],
    ] as const) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(`<title>${title}</title>`);
      const signedIn = await t.app.inject({ method: 'GET', url, headers: { cookie: 'aom_sid=x' } });
      expect(signedIn.body).toContain(`<title>${title}</title>`);
    }
  });
});
