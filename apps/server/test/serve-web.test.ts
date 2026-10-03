import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';

let t: TestApp;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aom-web-'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>aom</title><div id=root></div>');
  await writeFile(join(dir, 'app.js'), 'console.log(1)');
  t = await createTestApp({ env: { AOM_SERVE_WEB: 'true', AOM_WEB_DIST: dir } });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('AOM_SERVE_WEB', () => {
  it('serves the SPA, falls back to index.html for client routes, and keeps /api as JSON', async () => {
    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<div id=root>');
    expect((await t.app.inject({ method: 'GET', url: '/app.js' })).body).toBe('console.log(1)');
    const route = await t.app.inject({ method: 'GET', url: '/cards/TOY-1' });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('<div id=root>');
    const missing = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      ok: true,
      db: true,
    });
  });
});
