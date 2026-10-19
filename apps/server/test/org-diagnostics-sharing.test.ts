import { DIAGNOSTICS_CONSENT_VERSION } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const cfg = () => t.app.ctx.config as { diagnosticsConsentForCustomers: boolean };

async function acme() {
  const owner = await t.userSession(uniqueEmail('owner'));
  const admin = await t.userSession(uniqueEmail('admin'));
  const org = await t.createOrg(owner.id, 'Acme');
  await t.addOrgMember(org, admin.id, 'admin');
  const as = (who: { cookie: string }, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });
  return { owner, admin, org, as };
}

describe('the consent "Share diagnostic data with Guildwise"', () => {
  it('is off by default, and for a customer organization it is not available until the flag is on', async () => {
    const { owner, as } = await acme();
    const org = await ok<any>(as(owner, 'GET', '/api/org'));
    expect(org).toMatchObject({ diagnosticsSharing: false, diagnosticsSharingAvailable: false });
    const r = await as(owner, 'PATCH', '/api/org', {
      diagnosticsSharing: true,
      consentVersion: DIAGNOSTICS_CONSENT_VERSION,
    });
    expect(r.status).toBe(403);
    expect(await q(`SELECT 1 FROM events WHERE type='OrgDiagnosticsSharingSet'`)).toHaveLength(0);
  });

  it('with the flag on, only the Owner sets it, with the consent version they saw', async () => {
    cfg().diagnosticsConsentForCustomers = true;
    try {
      const { owner, admin, org, as } = await acme();
      expect((await ok<any>(as(owner, 'GET', '/api/org'))).diagnosticsSharingAvailable).toBe(true);
      expect(
        (
          await as(admin, 'PATCH', '/api/org', {
            diagnosticsSharing: true,
            consentVersion: DIAGNOSTICS_CONSENT_VERSION,
          })
        ).status,
      ).toBe(403);
      const stale = await as(owner, 'PATCH', '/api/org', { diagnosticsSharing: true, consentVersion: 'old' });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('consent_version');
      expect((await as(owner, 'PATCH', '/api/org', { diagnosticsSharing: true })).status).toBe(409);

      const on = await ok<any>(
        as(owner, 'PATCH', '/api/org', {
          diagnosticsSharing: true,
          consentVersion: DIAGNOSTICS_CONSENT_VERSION,
        }),
      );
      expect(on.diagnosticsSharing).toBe(true);
      const [row] = await q(
        'SELECT diagnostics_sharing, diagnostics_consent_version FROM organizations WHERE id=$1',
        [org],
      );
      expect(row).toMatchObject({
        diagnostics_sharing: true,
        diagnostics_consent_version: DIAGNOSTICS_CONSENT_VERSION,
      });
      // the Admin sees the state but cannot change it
      expect((await ok<any>(as(admin, 'GET', '/api/org'))).diagnosticsSharing).toBe(true);
      const [ev] = await q(
        `SELECT payload FROM events WHERE type='OrgDiagnosticsSharingSet' ORDER BY seq DESC`,
      );
      expect(ev?.payload).toMatchObject({
        orgId: org,
        on: true,
        consentVersion: DIAGNOSTICS_CONSENT_VERSION,
        by: owner.id,
      });
      const audit = await q(
        `SELECT summary FROM platform_audit_log WHERE action='OrgDiagnosticsSharingSet' AND org_id=$1`,
        [org],
      );
      expect(audit[0]?.summary).toContain('switched on');

      // setting the same value again records nothing; switching off needs no version
      await ok(
        as(owner, 'PATCH', '/api/org', {
          diagnosticsSharing: true,
          consentVersion: DIAGNOSTICS_CONSENT_VERSION,
        }),
      );
      expect(
        await q(`SELECT 1 FROM events WHERE type='OrgDiagnosticsSharingSet' AND payload->>'orgId'=$1`, [org]),
      ).toHaveLength(1);
      const off = await ok<any>(as(owner, 'PATCH', '/api/org', { diagnosticsSharing: false }));
      expect(off.diagnosticsSharing).toBe(false);

      // a rebuild restores the state from the events
      await ok(
        as(owner, 'PATCH', '/api/org', {
          diagnosticsSharing: true,
          consentVersion: DIAGNOSTICS_CONSENT_VERSION,
        }),
      );
      await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
      const [after] = await q(
        'SELECT diagnostics_sharing, diagnostics_consent_version FROM organizations WHERE id=$1',
        [org],
      );
      expect(after).toMatchObject({
        diagnostics_sharing: true,
        diagnostics_consent_version: DIAGNOSTICS_CONSENT_VERSION,
      });
    } finally {
      cfg().diagnosticsConsentForCustomers = false;
    }
  });

  it('the platform organization always has it', async () => {
    const { owner, org, as } = await acme();
    expect((await ok<any>(as(owner, 'GET', '/api/org'))).diagnosticsSharingAvailable).toBe(false);
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('platform.team', $1::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ orgId: org, projectId: '11111111-1111-4111-8111-111111111111' })],
    );
    try {
      expect((await ok<any>(as(owner, 'GET', '/api/org'))).diagnosticsSharingAvailable).toBe(true);
      const on = await ok<any>(
        as(owner, 'PATCH', '/api/org', {
          diagnosticsSharing: true,
          consentVersion: DIAGNOSTICS_CONSENT_VERSION,
        }),
      );
      expect(on.diagnosticsSharing).toBe(true);
    } finally {
      await q(`DELETE FROM platform_settings WHERE key='platform.team'`);
    }
  });
});
