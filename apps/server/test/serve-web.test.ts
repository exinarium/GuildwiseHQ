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

  it('sends a CSP and no HSTS on a plain-http origin (review M8)', async () => {
    const root = await t.app.inject({ method: 'GET', url: '/' });
    const csp = String(root.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' ws://aom.test");
    expect(root.headers['strict-transport-security']).toBeUndefined();
    expect(root.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('HSTS (review M8)', () => {
  it('is sent when the public origin is https', async () => {
    const https = await createTestApp({ env: { AOM_PUBLIC_ORIGIN: 'https://aom.example.com' } });
    try {
      const r = await https.app.inject({ method: 'GET', url: '/api/health' });
      expect(r.headers['strict-transport-security']).toMatch(/max-age=31536000/);
      expect(String(r.headers['content-security-policy'])).toContain('wss://aom.example.com');
      expect(String(r.headers['content-security-policy'])).toContain('upgrade-insecure-requests');
    } finally {
      await https.close();
    }
  });
});

describe('access logs do not carry secrets (review low)', () => {
  it('redacts invitation tokens and pairing codes in logged URLs', async () => {
    const { redactUrl, requestLogSerializer } = await import('../src/app.ts');
    expect(redactUrl('/api/invitations/abcDEF123_-xyz')).toBe('/api/invitations/[redacted]');
    expect(redactUrl('/api/invitations/abc123/accept?x=1')).toBe('/api/invitations/[redacted]/accept?x=1');
    expect(redactUrl('/invite/secretToken')).toBe('/invite/[redacted]');
    expect(redactUrl('/pair?code=ABCD-1234&x=1')).toBe('/pair?code=[redacted]&x=1');
    expect(redactUrl('/api/health')).toBe('/api/health');
    expect(redactUrl('/api/m/desk/tok_en-1.2~3')).toBe('/api/m/desk/[redacted]');
    expect(redactUrl('/api/m/desk/tok_en-1/apply?x=1')).toBe('/api/m/desk/[redacted]/apply?x=1');
    expect(redactUrl('/m/desk/tok_en-1')).toBe('/m/desk/[redacted]');
    expect(redactUrl('/login?next=%2Fm%2Fdesk%2Ftok_en-1&a=b')).toBe(
      '/login?next=%2Fm%2Fdesk%2F[redacted]&a=b',
    );
    expect(redactUrl('/login?next=/m/desk/tok_en-1')).toBe('/login?next=/m/desk/[redacted]');
    expect(requestLogSerializer({ method: 'GET', url: '/invite/tok123' }).url).toBe('/invite/[redacted]');
  });
});
