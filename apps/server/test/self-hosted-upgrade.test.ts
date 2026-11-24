import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamId } from '@aom/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MIN_PAIRABLE_RUNNER } from '../src/installer/release.ts';
import type { MailMessage } from '../src/mail/mailer.ts';
import { mailRunnerReinstallNotices, signedRunnersAtBoot } from '../src/runner-gateway/signed-sweep.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';

/**
 * R29, R21 with the core defaults: a self-hosted install upgrades to 1.10.0 with "Only signed runners" off (no env, no
 * own key, the official key still the placeholder, an unsigned `dev` runner release). Nothing is revoked or refused:
 * every runner paired before the upgrade keeps connecting, the legacy update paths keep serving the release so the
 * runners self-update, an unsigned runner still pairs, and nobody gets a reinstall mail. Nobody is locked out.
 */
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
afterAll(closeAdminPool);

function devReleaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aom-dev-release-'));
  writeFileSync(join(dir, 'aom-runner-1.10.0.tgz'), randomBytes(512));
  return dir;
}

describe('a self-hosted upgrade with the default settings', () => {
  it('keeps every runner connected and updating, and refuses nothing', async () => {
    t = await createTestApp({ listen: true, env: { AOM_RUNNER_RELEASE_DIR: devReleaseDir() } });
    const mails: MailMessage[] = [];
    // every pairing also mails its owner (release-readiness O3); this test counts the refusal notices only
    t.app.ctx.mailer = {
      send: async (m) => void (m.subject === 'A new workstation was added to your account' || mails.push(m)),
      close: () => {},
    };
    const base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;

    // The DB as 1.9.x left it: two users with runners paired by old versions (no proof, no release on the event).
    const owners = [await t.userSession(uniqueEmail('a')), await t.userSession(uniqueEmail('b'))];
    const tokens: Array<{ id: string; token: string }> = [];
    for (const [i, o] of owners.entries()) {
      const code = (await t.req('POST', '/api/workstations/pairing-codes', { cookie: o.cookie })).body.code;
      const r = await t.req('POST', '/api/runner/pair', {
        body: { code, name: `old-${i}`, platform: 'linux', hostname: `h${i}`, runnerVersion: '0.1.70' },
      });
      expect(r.status).toBe(200);
      tokens.push({ id: r.body.workstationId, token: r.body.runnerToken });
    }
    // One more paired straight through the store with an event shape from before 1.10.0.
    const legacyId = randomUUID();
    await t.app.ctx.store.append([
      {
        streamId: streamId.workstation(legacyId),
        event: {
          type: 'WorkstationPaired',
          payload: {
            workstationId: legacyId,
            userId: owners[0]!.id,
            name: 'legacy',
            platform: 'darwin',
            hostname: 'mac',
            runnerVersion: '0.1.40',
            tokenHash: 'legacy-hash',
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: null, projectId: null, audience: 'user', userId: owners[0]!.id },
      },
    ]);

    // The boot step of the upgrade does nothing.
    expect(await signedRunnersAtBoot(t.app.ctx)).toEqual({ unlinked: 0, mailed: 0 });
    expect(await q(`SELECT status FROM workstations ORDER BY name`)).toEqual([
      { status: 'active' },
      { status: 'active' },
      { status: 'active' },
    ]);

    // Every old runner connects and gets its welcome, without a proof.
    for (const w of tokens) {
      const r = await FakeRunner.connect(base, w.token);
      r.hello({ runnerVersion: '0.1.70' });
      const welcome = await r.waitFor('welcome');
      expect(welcome.workstationId).toBe(w.id);
      expect(welcome.requireSignedRunners).toBeUndefined();
      r.ws.close();
    }

    // The legacy update paths serve the release, so the runners update themselves to 1.10.0 as today.
    const rel = await t.req('GET', '/api/runner/release');
    expect(rel.status).toBe(200);
    expect(rel.body).toMatchObject({ version: '1.10.0', autoUpdatePaused: false });
    expect((await t.req('GET', '/api/runner/release/aom-runner-1.10.0.tgz')).status).toBe(200);

    // An unsigned runner still pairs; the platform view shows the setting off and what turning it on would unlink.
    const code = (await t.req('POST', '/api/workstations/pairing-codes', { cookie: owners[1]!.cookie })).body
      .code;
    expect(
      (
        await t.req('POST', '/api/runner/pair', {
          body: { code, name: 'new', platform: 'linux', hostname: 'n', runnerVersion: '1.10.0' },
        })
      ).status,
    ).toBe(200);
    const admin = await t.superAdminSession();
    const view = await t.req('GET', '/api/platform/security-settings', { cookie: admin.cookie });
    expect(view.body.requireSignedRunners).toEqual({ value: false, locked: false, source: 'default' });
    expect(view.body.unsignedWorkstations).toBe(4);

    // Nothing to mail, nothing unlinked, no reinstall notice for anyone.
    expect(await mailRunnerReinstallNotices(t.app.ctx)).toBe(0);
    expect(mails).toEqual([]);
    expect(await q(`SELECT 1 FROM events WHERE type='WorkstationUnlinked'`)).toHaveLength(0);
    const status = await t.req('GET', '/api/workstations/signed-runners', { cookie: owners[0]!.cookie });
    expect(status.body).toEqual({
      requireSignedRunners: false,
      minRunner: MIN_PAIRABLE_RUNNER,
      since: 'Guildwise 1.10.0',
      reinstallRequired: [],
    });
  });
});
