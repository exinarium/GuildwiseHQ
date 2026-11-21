import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { setRunnerUpdatesPaused } from '../src/installer/release.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import {
  FIXTURES,
  manifestText,
  minisign,
  releaseDirWith,
  TEST_PUBKEY,
  writeInto,
} from './helpers/signed-release.ts';

/**
 * R21: `GET /api/runner/release` and `/api/runner/release/:file` are the only paths a pre-1.10.0 updater calls. While
 * "Only signed runners" is on they answer 410 `reinstall_required`, so no untrusted runner updates itself; while it is
 * off they answer as before. The new paths `/api/runner/releases/{manifest.json, manifest.json.minisig,
 * aom-runner-<v>.tgz}` serve the signed release to 1.10.0 runners and installers either way.
 */
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
afterAll(closeAdminPool);

const LEGACY = [
  '/api/runner/release',
  '/api/runner/release/aom-runner-1.10.0.tgz',
  '/api/runner/release/aom-runner-1.10.0.tgz.sha256',
];

async function app(on: boolean) {
  return createTestApp({
    env: {
      AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
      AOM_RUNNER_RELEASE_DIR: releaseDirWith(),
      ...(on ? { AOM_REQUIRE_SIGNED_RUNNERS: 'true' } : {}),
    },
  });
}

describe('the runner release paths', () => {
  it('answer 410 reinstall_required on the legacy paths while the setting is on', async () => {
    t = await app(true);
    for (const url of LEGACY) {
      const r = await t.req('GET', url);
      expect(r.status, url).toBe(410);
      expect(r.body.error.code).toBe('reinstall_required');
    }
  });

  it('answer as before on the legacy paths while the setting is off', async () => {
    t = await app(false);
    const info = await t.req('GET', '/api/runner/release');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      version: '1.10.0',
      sha256: 'c0365f8580934d0be3bfe769275180a302585ba4d547d58093dc2c7428285e41',
      url: expect.stringContaining('/api/runner/release/aom-runner-1.10.0.tgz'),
    });
    expect((await t.req('GET', '/api/runner/release/aom-runner-1.10.0.tgz')).status).toBe(200);
    const sum = await t.req('GET', '/api/runner/release/aom-runner-1.10.0.tgz.sha256');
    expect(sum.body).toContain('c0365f85');
  });

  for (const on of [true, false])
    it(`serve the manifest, its signature and the tarball on the new paths (setting ${on ? 'on' : 'off'})`, async () => {
      t = await app(on);
      const manifest = await t.req('GET', '/api/runner/releases/manifest.json');
      expect(manifest.status).toBe(200);
      expect(manifest.headers['content-type']).toContain('application/json');
      expect(manifest.body).toEqual(JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')));
      const sig = await t.req('GET', '/api/runner/releases/manifest.json.minisig');
      expect(sig.status).toBe(200);
      expect(sig.body).toBe(readFileSync(join(FIXTURES, 'manifest.json.minisig'), 'utf8'));
      const tgz = await t.req('GET', '/api/runner/releases/aom-runner-1.10.0.tgz');
      expect(tgz.status).toBe(200);
      expect(tgz.headers['content-type']).toBe('application/gzip');
      expect((await t.req('GET', '/api/runner/releases/aom-runner-9.9.9.tgz')).status).toBe(404);
      expect((await t.req('GET', '/api/runner/releases/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
      expect((await t.req('GET', '/api/runner/releases/notes.txt')).status).toBe(404);
    });

  it('tells 1.10.0 runners about the paused auto-updates on manifest.json (x-runner-updates-paused)', async () => {
    t = await app(false);
    const before = await t.req('GET', '/api/runner/releases/manifest.json');
    expect(before.headers['x-runner-updates-paused']).toBe('false');
    await setRunnerUpdatesPaused(t.app.ctx, true, randomUUID());
    const paused = await t.req('GET', '/api/runner/releases/manifest.json');
    expect(paused.status).toBe(200);
    expect(paused.headers['x-runner-updates-paused']).toBe('true');
  });

  it('serves a pinned version its own signed manifest, and refuses a pin below the floor', async () => {
    const dir = releaseDirWith();
    // Another retained release at or above the floor, with its own signed manifest (manifest.json names 1.10.0).
    const v = '1.10.1';
    writeInto(dir, `aom-runner-${v}.tgz`, 'older runner');
    const manifest = manifestText(v);
    writeInto(dir, `manifest-${v}.json`, manifest);
    writeInto(dir, `manifest-${v}.json.minisig`, minisign(manifest));
    t = await createTestApp({ env: { AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY, AOM_RUNNER_RELEASE_DIR: dir } });

    const latest = await t.req('GET', '/api/runner/releases/manifest.json?version=1.10.0');
    expect(latest.status).toBe(200);
    expect(latest.body.version).toBe('1.10.0');
    const pinned = await t.req('GET', `/api/runner/releases/manifest.json?version=${v}`);
    expect(pinned.status).toBe(200);
    expect(pinned.body.version).toBe(v);
    expect(pinned.headers['x-runner-updates-paused']).toBe('false');
    const sig = await t.req('GET', `/api/runner/releases/manifest.json.minisig?version=${v}`);
    expect(sig.body).toBe(minisign(manifest));
    expect((await t.req('GET', `/api/runner/releases/aom-runner-${v}.tgz`)).status).toBe(200);
    // A retained version without its own signed manifest: nothing to verify, so nothing is served.
    writeInto(dir, 'aom-runner-1.10.2.tgz', 'unsigned retained');
    expect((await t.req('GET', '/api/runner/releases/manifest.json?version=1.10.2')).status).toBe(404);
    const low = await t.req('GET', '/api/runner/releases/manifest.json?version=0.1.77');
    expect(low.status).toBe(409);
    expect(low.body.error).toMatchObject({
      code: 'runner_pin_below_floor',
      message: expect.stringContaining('remove the pin'),
    });
  });
});
