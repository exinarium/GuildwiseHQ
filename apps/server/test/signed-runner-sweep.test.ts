import type { AddressInfo } from 'node:net';
import { SIGNED_RUNNER_CLOSE_CODE, streamId, UNPAIRED_CLOSE_REASON } from '@aom/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { countUnsignedWorkstations, setSecuritySetting } from '../src/auth/security-settings.ts';
import { MIN_PAIRABLE_RUNNER } from '../src/installer/release.ts';
import type { MailMessage } from '../src/mail/mailer.ts';
import { enqueueRunnerCommand } from '../src/runner-gateway/commands-queue.ts';
import {
  mailRunnerReinstallNotices,
  signedRunnersAtBoot,
  sweepUnsignedRunners,
} from '../src/runner-gateway/signed-sweep.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { proofFor, releaseDirWith, TEST_KEY_ID, TEST_PUBKEY } from './helpers/signed-release.ts';

/**
 * R21: the signed-runner sweep with "Only signed runners" on, on a populated DB. Unsigned and pre-floor pairings are
 * unlinked (`signed_required`) and nothing they could come back with survives: runner token, rotated token, workstation
 * key, sudo key id, pending commands, pairing codes and installer sessions. `hello` and pairing are then refused and the
 * legacy update paths answer 410. The same sweep on an empty DB does nothing.
 */
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
afterAll(closeAdminPool);

const env = () => ({ AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY, AOM_RUNNER_RELEASE_DIR: releaseDirWith() });
const baseUrl = (app: TestApp) => `http://127.0.0.1:${(app.app.server.address() as AddressInfo).port}`;

async function pair(app: TestApp, cookie: string, name: string, extra: Record<string, unknown> = {}) {
  const code = (await app.req('POST', '/api/workstations/pairing-codes', { cookie })).body.code as string;
  const r = await app.req('POST', '/api/runner/pair', {
    body: { code, name, platform: 'linux', hostname: `host-${name}`, runnerVersion: '0.1.77', ...extra },
  });
  expect(r.status).toBe(200);
  return r.body as { workstationId: string; runnerToken: string };
}

describe('the signed-runner sweep (R21)', () => {
  it('unlinks unsigned and pre-floor runners on a populated DB and leaves nothing they could come back with', async () => {
    t = await createTestApp({ listen: true, env: env() });
    const mails: MailMessage[] = [];
    // the reinstall notices only (every pairing also mails its owner: release-readiness O3)
    t.app.ctx.mailer = {
      send: async (m) => void (m.subject.startsWith('A new workstation') || mails.push(m)),
      close: () => {},
    };
    const admin = await t.superAdminSession();
    const alice = await t.userSession(uniqueEmail('alice'));
    const bob = await t.userSession(uniqueEmail('bob'));

    // A pre-1.10.0 runner (no proof), a runner signed at pairing but now below the floor, and a signed 1.10.0 runner.
    const old = await pair(t, alice.cookie, 'old');
    const stale = await pair(t, bob.cookie, 'stale', {
      runnerVersion: '1.10.0',
      release: proofFor('1.10.0'),
    });
    const good = await pair(t, bob.cookie, 'good', { runnerVersion: '1.10.0', release: proofFor('1.10.0') });
    await q(`UPDATE workstations SET runner_version='0.1.77' WHERE id=$1`, [stale.workstationId]);
    const signed = await q('SELECT id, release_signed, release_key_id FROM workstations WHERE id=$1', [
      good.workstationId,
    ]);
    expect(signed[0]).toMatchObject({ release_signed: true, release_key_id: TEST_KEY_ID });

    // What the old install could use to come back: a workstation key, a sealed sudo key id, a rotated token, pending
    // commands, an unused pairing code and an installer session.
    await q(
      `INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,'k1','pk',now())`,
      [old.workstationId],
    );
    await t.app.ctx.store.append([
      {
        streamId: streamId.workstation(old.workstationId),
        event: {
          type: 'DevOpsSudoPasswordSet',
          payload: { workstationId: old.workstationId, by: alice.id, keyId: 'k1' },
        },
        actor: { kind: 'user', id: alice.id },
        scope: { orgId: null, projectId: null, audience: 'user', userId: alice.id },
      },
    ]);
    await q(
      `INSERT INTO runner_token_rotations (workstation_id, token_hash, issued_at) VALUES ($1, 'rot-hash', now())`,
      [old.workstationId],
    );
    await enqueueRunnerCommand(t.app.ctx.pool, old.workstationId, 'shifts.limit', {
      shiftLimit: null,
      maxConcurrentShifts: 1,
    });
    expect(
      (await t.req('POST', '/api/workstations/installers', { cookie: alice.cookie, body: { os: 'linux' } }))
        .status,
    ).toBe(201);
    const goodCommand = await enqueueRunnerCommand(t.app.ctx.pool, good.workstationId, 'shifts.limit', {
      shiftLimit: null,
      maxConcurrentShifts: 1,
    });
    expect(goodCommand).toBeTruthy();

    expect(await countUnsignedWorkstations(t.app.ctx.pool)).toBe(2);
    const r = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: admin.cookie,
      body: { requireSignedRunners: true, confirmUnlink: true },
    });
    expect(r.status).toBe(200);
    expect(r.body.requireSignedRunners.value).toBe(true);
    expect(r.body.unsignedWorkstations).toBe(0);

    const ws = await q('SELECT id, status FROM workstations ORDER BY name');
    expect(Object.fromEntries(ws.map((w) => [w.id, w.status]))).toEqual({
      [good.workstationId]: 'active',
      [old.workstationId]: 'unlinked',
      [stale.workstationId]: 'unlinked',
    });
    const unlinked = await q(
      `SELECT payload, actor_kind, actor_id FROM events WHERE type='WorkstationUnlinked' ORDER BY seq`,
    );
    expect(unlinked.map((e) => e.payload.by)).toEqual(['signed_required', 'signed_required']);
    expect(unlinked.every((e) => e.actor_kind === 'user' && e.actor_id === admin.id)).toBe(true);
    const changed = await q(`SELECT payload FROM events WHERE type='SecuritySettingChanged'`);
    expect(changed[0]?.payload).toMatchObject({ key: 'requireSignedRunners', value: true, unlinked: 2 });

    const swept = [old.workstationId, stale.workstationId];
    expect(
      await q('SELECT 1 FROM workstation_keys WHERE workstation_id = ANY($1::uuid[])', [swept]),
    ).toHaveLength(0);
    expect(
      await q('SELECT 1 FROM runner_token_rotations WHERE workstation_id = ANY($1::uuid[])', [swept]),
    ).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE workstation_id = ANY($1::uuid[])`, [swept]),
    ).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE workstation_id=$1`, [good.workstationId]),
    ).toHaveLength(1);
    const sudo = await q('SELECT devops_sudo_key_id FROM workstations WHERE id=$1', [old.workstationId]);
    expect(sudo[0]?.devops_sudo_key_id).toBeNull();
    expect(
      await q('SELECT 1 FROM pairing_codes WHERE workstation_id = ANY($1::uuid[])', [swept]),
    ).toHaveLength(0);
    expect(
      await q('SELECT 1 FROM pairing_codes WHERE user_id=$1 AND used_at IS NULL', [alice.id]),
    ).toHaveLength(0);
    expect(await q('SELECT 1 FROM installer_sessions WHERE user_id=$1', [alice.id])).toHaveLength(0);
    // The signed workstation's pairing is untouched.
    expect(await q('SELECT 1 FROM pairing_codes WHERE workstation_id=$1', [good.workstationId])).toHaveLength(
      1,
    );

    // The old tokens get the unpaired close; the signed runner connects.
    const base = baseUrl(t);
    for (const token of [old.runnerToken, stale.runnerToken]) {
      const rr = await FakeRunner.connect(base, token);
      expect(await rr.waitClosed()).toEqual({
        code: SIGNED_RUNNER_CLOSE_CODE,
        reason: UNPAIRED_CLOSE_REASON,
      });
    }
    const ok = await FakeRunner.connect(base, good.runnerToken);
    ok.hello({ runnerVersion: '1.10.0', release: proofFor('1.10.0') });
    const welcome = await ok.waitFor('welcome');
    expect(welcome.requireSignedRunners).toBe(true);
    ok.ws.close();

    // Pairing without a proof is refused; the legacy update paths answer 410.
    const code = (await t.req('POST', '/api/workstations/pairing-codes', { cookie: alice.cookie })).body.code;
    const refused = await t.req('POST', '/api/runner/pair', {
      body: { code, name: 'again', platform: 'linux', hostname: 'host-old', runnerVersion: '0.1.77' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('signed_runner_required');
    expect((await t.req('GET', '/api/runner/release')).status).toBe(410);
    expect((await t.req('GET', '/api/runner/release/aom-runner-1.10.0.tgz')).status).toBe(410);

    // Each affected owner gets one reinstall mail.
    expect(mails.map((m) => m.to).sort()).toEqual([alice.email, bob.email].sort());
    expect(mails.find((m) => m.to === alice.email)?.subject).toContain('old');
    expect((await sweepUnsignedRunners(t.app.ctx)) + (await signedRunnersAtBoot(t.app.ctx)).unlinked).toBe(0);
    expect((await signedRunnersAtBoot(t.app.ctx)).mailed).toBe(0);
    expect(mails).toHaveLength(2);

    // "Reinstall required" on the owner's Workstations page, until the host is paired again.
    const status = await t.req('GET', '/api/workstations/signed-runners', { cookie: alice.cookie });
    expect(status.body).toMatchObject({
      requireSignedRunners: true,
      minRunner: MIN_PAIRABLE_RUNNER,
      since: 'Guildwise 1.10.0',
    });
    expect(status.body.reinstallRequired.map((w: { id: string }) => w.id)).toEqual([old.workstationId]);
    const code2 = (await t.req('POST', '/api/workstations/pairing-codes', { cookie: alice.cookie })).body
      .code;
    const again = await t.req('POST', '/api/runner/pair', {
      body: {
        code: code2,
        name: 'old',
        platform: 'linux',
        hostname: 'host-old',
        runnerVersion: '1.10.0',
        release: proofFor('1.10.0'),
      },
    });
    expect(again.status).toBe(200);
    const after = await t.req('GET', '/api/workstations/signed-runners', { cookie: alice.cookie });
    expect(after.body.reinstallRequired).toEqual([]);
  });

  it('runs at boot while the setting is on, and does nothing on an empty DB', async () => {
    t = await createTestApp({ env: { ...env(), AOM_REQUIRE_SIGNED_RUNNERS: 'true' } });
    const before = await q('SELECT count(*)::int AS n FROM events');
    expect(await signedRunnersAtBoot(t.app.ctx)).toEqual({ unlinked: 0, mailed: 0 });
    expect(await q('SELECT count(*)::int AS n FROM events')).toEqual(before);

    // A runner that was paired before the switch (straight through the store, as an old DB has it) goes at the next boot.
    const owner = await t.createUser(uniqueEmail('owner'));
    const id = crypto.randomUUID();
    await t.app.ctx.store.append([
      {
        streamId: streamId.workstation(id),
        event: {
          type: 'WorkstationPaired',
          payload: {
            workstationId: id,
            userId: owner,
            name: 'legacy',
            platform: 'linux',
            hostname: 'legacy',
            runnerVersion: '0.1.70',
            tokenHash: 'h',
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: null, projectId: null, audience: 'user', userId: owner },
      },
    ]);
    const r = await signedRunnersAtBoot(t.app.ctx);
    expect(r.unlinked).toBe(1);
    const e = await q(`SELECT payload, actor_kind FROM events WHERE type='WorkstationUnlinked'`);
    expect(e).toEqual([{ payload: { workstationId: id, by: 'signed_required' }, actor_kind: 'system' }]);
  });

  it('leaves simulated workstations alone', async () => {
    t = await createTestApp({ env: env() });
    const owner = await t.createUser(uniqueEmail('sim'));
    const org = await t.createOrg(owner, 'Sim org');
    const id = crypto.randomUUID();
    await t.app.ctx.store.append([
      {
        streamId: streamId.workstation(id),
        event: {
          type: 'WorkstationPaired',
          payload: {
            workstationId: id,
            userId: owner,
            name: 'sim',
            platform: 'linux',
            hostname: 'sim',
            runnerVersion: '0.0.0-simulation',
            tokenHash: 'h2',
            simulationOrgId: org,
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: null, projectId: null, audience: 'user', userId: owner },
      },
    ]);
    const admin = await t.superAdminSession();
    await setSecuritySetting(t.app.ctx, { id: admin.id }, 'requireSignedRunners', true);
    expect(await q('SELECT status FROM workstations WHERE id=$1', [id])).toEqual([{ status: 'active' }]);
  });

  it('sends no reinstall mail while the setting is off (switched on, mail not working, switched back off)', async () => {
    t = await createTestApp({ env: env() });
    let working = false;
    const mails: MailMessage[] = [];
    t.app.ctx.mailer = {
      send: async (m) => {
        if (!working) throw new Error('smtp down');
        mails.push(m);
      },
      close: () => {},
    };
    const admin = await t.superAdminSession();
    const owner = await t.userSession(uniqueEmail('late'));
    await pair(t, owner.cookie, 'late');
    await setSecuritySetting(t.app.ctx, { id: admin.id }, 'requireSignedRunners', true, {
      confirmUnlink: true,
    });
    expect(mails).toEqual([]);
    await setSecuritySetting(t.app.ctx, { id: admin.id }, 'requireSignedRunners', false);
    working = true;
    expect(await mailRunnerReinstallNotices(t.app.ctx)).toBe(0);
    expect(mails).toEqual([]);
    // On again: the owner who was never told gets the one mail.
    await setSecuritySetting(t.app.ctx, { id: admin.id }, 'requireSignedRunners', true);
    expect(await mailRunnerReinstallNotices(t.app.ctx)).toBe(1);
    expect(mails.map((m) => m.to)).toEqual([owner.email]);
  });
});
