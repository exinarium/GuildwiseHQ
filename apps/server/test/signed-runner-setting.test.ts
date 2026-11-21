import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import {
  OFFICIAL_RUNNER_RELEASE_KEY_ID,
  OFFICIAL_RUNNER_RELEASE_PUBKEY,
  runnerAtLeast,
  SIGNED_RUNNER_CLOSE_CODE,
  UNPAIRED_CLOSE_REASON,
  WS_CLOSE,
} from '@aom/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  checkReleaseProof,
  MIN_PAIRABLE_RUNNER,
  trustedReleaseKey,
  verifyServedRelease,
} from '../src/installer/release.ts';
import { signedRunnersAtBoot } from '../src/runner-gateway/signed-sweep.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import {
  fixtureProof,
  minisign,
  OTHER_PUBKEY,
  proofFor,
  releaseDirWith,
  TEST_KEY_ID,
  TEST_PUBKEY,
  writeInto,
} from './helpers/signed-release.ts';

/**
 * R27 "Only signed runners": pairing and `hello` need a valid signed-release proof at or above `MIN_PAIRABLE_RUNNER`
 * while the setting is on, and nothing is refused while it is off. The proof is the installer-kept `manifest.json` and
 * its `.minisig`, verified with `AOM_RUNNER_RELEASE_PUBKEY` (own-key) or the official key. A server whose own runner
 * release does not verify refuses to boot with the setting on, and refuses to turn it on.
 */
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
afterAll(closeAdminPool);

const baseUrl = (app: TestApp) => `http://127.0.0.1:${(app.app.server.address() as AddressInfo).port}`;

async function tryPair(app: TestApp, cookie: string, extra: Record<string, unknown>) {
  const code = (await app.req('POST', '/api/workstations/pairing-codes', { cookie })).body.code as string;
  return app.req('POST', '/api/runner/pair', {
    body: { code, name: 'Desk', platform: 'linux', hostname: 'desk', runnerVersion: '1.10.0', ...extra },
  });
}

describe('the signed-release proof', () => {
  const config = { runnerReleasePubkey: TEST_PUBKEY };

  it('accepts the installer-kept manifest signed by the trusted key at the reported version', () => {
    const v = checkReleaseProof(config, '1.10.0', fixtureProof());
    expect(v).toMatchObject({ ok: true, release: { version: '1.10.0', keyId: TEST_KEY_ID } });
    expect(v.ok && v.release.sha256).toBe('c0365f8580934d0be3bfe769275180a302585ba4d547d58093dc2c7428285e41');
  });

  it('refuses a missing proof, another key, a tampered manifest, another version and a version below the floor', () => {
    expect(checkReleaseProof(config, '1.10.0', undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(checkReleaseProof(config, '1.10.0', proofFor('1.10.0', 'other'))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const p = fixtureProof();
    expect(
      checkReleaseProof(config, '1.10.0', { ...p, manifest: p.manifest.replace('1.10.0', '1.10.1') }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(checkReleaseProof(config, '1.10.1', p)).toEqual({ ok: false, reason: 'version_mismatch' });
    expect(checkReleaseProof(config, '0.1.77', proofFor('0.1.77'))).toEqual({
      ok: false,
      reason: 'below_floor',
    });
    const notJson = 'not a manifest';
    expect(checkReleaseProof(config, '1.10.0', { manifest: notJson, minisig: minisign(notJson) })).toEqual({
      ok: false,
      reason: 'bad_manifest',
    });
    // Own-key mode with another key: the test key's signature is not trusted.
    expect(checkReleaseProof({ runnerReleasePubkey: OTHER_PUBKEY }, '1.10.0', p)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it("trusts the owner's committed official key when no own key is set, and refuses a proof signed by another key", () => {
    expect(trustedReleaseKey({ runnerReleasePubkey: undefined })).toBe(OFFICIAL_RUNNER_RELEASE_PUBKEY);
    expect(OFFICIAL_RUNNER_RELEASE_KEY_ID).toBe('0403EF6CE164E7D8');
    expect(checkReleaseProof({ runnerReleasePubkey: undefined }, '1.10.0', fixtureProof())).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('keeps MIN_PAIRABLE_RUNNER equal to the runner floor and the admin tool floor', () => {
    const runner = resolve(import.meta.dirname, '../../runner');
    const read = (f: string) => readFileSync(f, 'utf8');
    const floorSrc = join(runner, 'src/update/floor.ts');
    const adminSrc = join(runner, 'admin/guildwise-admin.cjs');
    const treeVersion = /RUNNER_VERSION = '([^']+)'/.exec(
      read(join(runner, 'src/version.ts')),
    )?.[1] as string;
    // Runner and product share one number space from 1.10.0 on: the floor is the 1.10.0 runner. It does not follow the
    // releases (owner, 2026-11-21): at or below the version in the tree, raised only by hand (docs/RUNNER.md).
    expect(MIN_PAIRABLE_RUNNER).toBe('1.10.0');
    expect(runnerAtLeast(treeVersion, MIN_PAIRABLE_RUNNER)).toBe(true);
    if (existsSync(floorSrc))
      expect(/MIN_TRUSTED_RUNNER = '([^']+)'/.exec(read(floorSrc))?.[1]).toBe(MIN_PAIRABLE_RUNNER);
    expect(
      /SIGNED_RUNNER_FLOOR="([^"]+)"/.exec(
        read(resolve(import.meta.dirname, '../src/installer/templates/common.sh')),
      )?.[1],
    ).toBe(MIN_PAIRABLE_RUNNER);
    if (existsSync(adminSrc))
      expect(/RUNNER_FLOOR = '([^']+)'/.exec(read(adminSrc))?.[1]).toBe(MIN_PAIRABLE_RUNNER);
  });
});

describe('the served release (boot and switch-on)', () => {
  it('verifies the release directory: signed manifest, matching tarball', async () => {
    const config = { runnerReleasePubkey: TEST_PUBKEY };
    expect(await verifyServedRelease({ ...config, runnerReleaseDir: releaseDirWith() })).toEqual({
      ok: true,
      version: '1.10.0',
      keyId: TEST_KEY_ID,
    });
    expect(
      (await verifyServedRelease({ ...config, runnerReleaseDir: releaseDirWith({ unsigned: true }) })).ok,
    ).toBe(false);
    expect(
      (await verifyServedRelease({ ...config, runnerReleaseDir: releaseDirWith({ key: 'other' }) })).ok,
    ).toBe(false);
    const tampered = releaseDirWith();
    writeInto(tampered, 'aom-runner-1.10.0.tgz', 'something else');
    expect(await verifyServedRelease({ ...config, runnerReleaseDir: tampered })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not match'),
    });
    expect(
      (await verifyServedRelease({ runnerReleasePubkey: undefined, runnerReleaseDir: releaseDirWith() })).ok,
    ).toBe(false);
  });

  it('boot refuses with the setting on and an unsigned (dev) release; with it off boot goes on', async () => {
    t = await createTestApp({
      env: {
        AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
        AOM_RUNNER_RELEASE_DIR: releaseDirWith({ unsigned: true }),
        AOM_REQUIRE_SIGNED_RUNNERS: 'true',
      },
    });
    await expect(signedRunnersAtBoot(t.app.ctx)).rejects.toThrow(/Only signed runners.*does not verify/);
    await t.close();
    t = await createTestApp({
      env: {
        AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
        AOM_RUNNER_RELEASE_DIR: releaseDirWith({ unsigned: true }),
      },
    });
    expect(await signedRunnersAtBoot(t.app.ctx)).toEqual({ unlinked: 0, mailed: 0 });
  });

  it('turning the setting on is refused while the served release does not verify (nobody is locked out at the next boot)', async () => {
    t = await createTestApp({
      env: {
        AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
        AOM_RUNNER_RELEASE_DIR: releaseDirWith({ unsigned: true }),
      },
    });
    const admin = await t.superAdminSession();
    const r = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: admin.cookie,
      body: { requireSignedRunners: true },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('runner_release_unsigned');
    expect(await q(`SELECT 1 FROM events WHERE type='SecuritySettingChanged'`)).toHaveLength(0);
  });
});

describe('pairing and hello', () => {
  it('with the setting off: an unsigned pairing and hello are accepted, and the proof is recorded when there is one', async () => {
    t = await createTestApp({
      listen: true,
      env: { AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY, AOM_RUNNER_RELEASE_DIR: releaseDirWith() },
    });
    const u = await t.userSession(uniqueEmail('off'));
    const plain = await tryPair(t, u.cookie, { runnerVersion: '0.1.77' });
    expect(plain.status).toBe(200);
    const signed = await tryPair(t, u.cookie, { release: fixtureProof() });
    expect(signed.status).toBe(200);
    const paired = await q(`SELECT payload FROM events WHERE type='WorkstationPaired' ORDER BY seq`);
    expect(paired[0]?.payload.release).toBeUndefined();
    expect(paired[1]?.payload.release).toEqual({
      version: '1.10.0',
      sha256: 'c0365f8580934d0be3bfe769275180a302585ba4d547d58093dc2c7428285e41',
      keyId: TEST_KEY_ID,
    });

    const r = await FakeRunner.connect(baseUrl(t), plain.body.runnerToken);
    r.hello({ runnerVersion: '0.1.77', startupRefused: 'runs as root' });
    const welcome = await r.waitFor('welcome');
    expect(welcome.requireSignedRunners).toBeUndefined();
    const row = await q(
      'SELECT release_signed, release_key_id, startup_refused FROM workstations WHERE id=$1',
      [plain.body.workstationId],
    );
    expect(row[0]).toEqual({ release_signed: false, release_key_id: null, startup_refused: 'runs as root' });
    r.ws.close();

    const bad = await FakeRunner.connect(baseUrl(t), 'aomr_unknown-token-of-an-old-install');
    expect((await bad.waitClosed()).code).toBe(WS_CLOSE.unauthorized);
  });

  it('with the setting on: pairing needs a valid proof at or above the floor (403 signed_runner_required)', async () => {
    t = await createTestApp({
      env: {
        AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
        AOM_RUNNER_RELEASE_DIR: releaseDirWith(),
        AOM_REQUIRE_SIGNED_RUNNERS: 'true',
      },
    });
    const u = await t.userSession(uniqueEmail('on'));
    const code = (await t.req('POST', '/api/workstations/pairing-codes', { cookie: u.cookie })).body
      .code as string;
    const body = { code, name: 'Desk', platform: 'linux', hostname: 'desk', runnerVersion: '1.10.0' };
    for (const extra of [
      { runnerVersion: '0.1.77' },
      { release: proofFor('1.10.0', 'other') },
      { runnerVersion: '1.10.1', release: fixtureProof() },
      { runnerVersion: '0.1.77', release: proofFor('0.1.77') },
    ]) {
      const r = await t.req('POST', '/api/runner/pair', { body: { ...body, ...extra } });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('signed_runner_required');
    }
    expect(await q('SELECT 1 FROM workstations')).toHaveLength(0);
    // The refusals came before the code was checked, so it is not spent: a signed runner pairs with it.
    const ok = await t.req('POST', '/api/runner/pair', { body: { ...body, release: fixtureProof() } });
    expect(ok.status).toBe(200);
    expect(await q('SELECT release_signed, release_key_id FROM workstations')).toEqual([
      { release_signed: true, release_key_id: TEST_KEY_ID },
    ]);
  });

  it('with the setting on: a hello without a valid proof is closed with 4403 and the workstation is unlinked', async () => {
    t = await createTestApp({
      listen: true,
      env: {
        AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
        AOM_RUNNER_RELEASE_DIR: releaseDirWith(),
        AOM_REQUIRE_SIGNED_RUNNERS: 'true',
      },
    });
    const u = await t.userSession(uniqueEmail('hello'));
    const p = (await tryPair(t, u.cookie, { release: fixtureProof() })).body;

    // The same workstation now says hello with a proof by another key (a replayed or modified install).
    const r = await FakeRunner.connect(baseUrl(t), p.runnerToken);
    r.hello({ runnerVersion: '1.10.0', release: proofFor('1.10.0', 'other') });
    expect(await r.waitClosed()).toEqual({ code: SIGNED_RUNNER_CLOSE_CODE, reason: UNPAIRED_CLOSE_REASON });
    expect(r.received.find((f) => f.type === 'welcome')).toBeUndefined();
    expect(await q('SELECT status, release_signed FROM workstations WHERE id=$1', [p.workstationId])).toEqual(
      [{ status: 'unlinked', release_signed: false }],
    );
    const e = await q(`SELECT payload FROM events WHERE type='WorkstationUnlinked'`);
    expect(e[0]?.payload.by).toBe('signed_required');

    // Its token stays refused; an unknown token of an old install gets the same clean close.
    const again = await FakeRunner.connect(baseUrl(t), p.runnerToken);
    expect(await again.waitClosed()).toEqual({
      code: SIGNED_RUNNER_CLOSE_CODE,
      reason: UNPAIRED_CLOSE_REASON,
    });
    const unknown = await FakeRunner.connect(baseUrl(t), 'aomr_unknown-token-of-an-old-install');
    expect(await unknown.waitClosed()).toEqual({
      code: SIGNED_RUNNER_CLOSE_CODE,
      reason: UNPAIRED_CLOSE_REASON,
    });
  });

  it('with the setting on: a signed hello is welcomed and told the setting is on', async () => {
    t = await createTestApp({
      listen: true,
      env: {
        AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY,
        AOM_RUNNER_RELEASE_DIR: releaseDirWith(),
        AOM_REQUIRE_SIGNED_RUNNERS: 'true',
      },
    });
    const u = await t.userSession(uniqueEmail('order'));
    const p = (await tryPair(t, u.cookie, { release: fixtureProof() })).body;
    const r = await FakeRunner.connect(baseUrl(t), p.runnerToken);
    r.hello({ runnerVersion: '1.10.0', release: fixtureProof() });
    const welcome = await r.waitFor('welcome');
    expect(welcome.requireSignedRunners).toBe(true);
    await r.barrier();
    expect(await q('SELECT status, release_signed FROM workstations WHERE id=$1', [p.workstationId])).toEqual(
      [{ status: 'active', release_signed: true }],
    );
    r.ws.close();
  });
});
