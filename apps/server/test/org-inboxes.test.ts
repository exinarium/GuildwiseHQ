import { afterAll, describe, expect, it } from 'vitest';
import { migrateOrgInboxes } from '../src/data-migrations/org-inboxes.ts';
import { createTestApp, ORIGIN, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

/** An inbound inbox for every organisation (#67 B): at creation, and by the boot data migration for existing ones. */

const DOMAIN = 'in.test.example';
const ADDRESS = /^[a-z0-9-]+-[a-z2-9]{10}@in\.test\.example$/;
let t: TestApp;

afterAll(async () => {
  await t?.close();
  await closeAdminPool();
});

const inboxesOf = (cookie: string) => ok<any>(t.req('GET', '/api/mail-inboxes', { cookie }));
const env = () => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store,
  clock: t.app.ctx.clock,
  log: () => {},
  inboundDomain: DOMAIN,
});

/** A new organisation through the real invitation flow; returns the Owner's session and the organisation id. */
async function newOrg(): Promise<{ cookie: string; orgId: string }> {
  const root = await t.superAdminSession();
  const email = uniqueEmail('inbox-owner');
  await ok(
    t.req('POST', '/api/platform/invitations', {
      cookie: root.cookie,
      body: { email, proposedOrgName: 'Globex Corp', plan: 'founding', status: 'active' },
    }),
    201,
  );
  const token = await latestInviteToken(email, ORIGIN);
  const accepted = await t.req('POST', `/api/invitations/${token}/accept`, {
    body: { displayName: 'New Person', password: 'a-long-enough-password', orgName: 'Globex Corp' },
  });
  expect(accepted.status).toBe(201);
  return { cookie: accepted.cookie as string, orgId: accepted.body.activeOrg.id as string };
}

describe('a new organisation', () => {
  it('gets an inbox address from the inbound domain, before DNS or the provider exist', async () => {
    // only the domain is set: no provider, no secret
    t = await createTestApp({ env: { AOM_INBOUND_DOMAIN: DOMAIN } });
    const { orgId } = await newOrg();
    const rows = await q(
      `SELECT i.label, a.address FROM mail_inboxes i JOIN mail_addresses a ON a.inbox_id = i.id AND a.active
        WHERE i.org_id = $1`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).address).toMatch(ADDRESS);
    expect((rows[0] as any).address.startsWith('globex-corp-')).toBe(true);
    expect((rows[0] as any).label).toBe('Main inbox');
    expect((await q(`SELECT 1 FROM events WHERE type='MailInboxCreated'`)).length).toBe(1);
    await t.close();
  });

  it('shows it on the E-mail inbox page when inbound mail is configured', async () => {
    t = await createTestApp({
      env: {
        AOM_INBOUND_DOMAIN: DOMAIN,
        AOM_INBOUND_PROVIDER: 'fake',
        AOM_INBOUND_SECRET: 'inbound-secret-1234567',
      },
    });
    const { cookie } = await newOrg();
    const list = await inboxesOf(cookie);
    expect(list.configured).toBe(true);
    expect(list.inboxes).toHaveLength(1);
    expect(list.inboxes[0].address).toMatch(ADDRESS);
    await t.close();
  });

  it('gets no inbox while no inbound domain is set', async () => {
    t = await createTestApp();
    const { orgId } = await newOrg();
    expect(await q('SELECT 1 FROM mail_inboxes WHERE org_id=$1', [orgId])).toHaveLength(0);
    await t.close();
  });
});

describe('existing organisations (boot data migration)', () => {
  it('gives every organisation without an inbox one, once, and leaves the others alone', async () => {
    t = await createTestApp(); // no inbound domain: organisations are created without an inbox
    const a = await t.userSession(uniqueEmail('inbox-a'));
    const b = await t.userSession(uniqueEmail('inbox-b'));
    expect(await q('SELECT 1 FROM mail_inboxes')).toHaveLength(0);

    // without a domain the migration does nothing
    expect(await migrateOrgInboxes({ ...env(), inboundDomain: undefined })).toBeNull();
    expect(await q('SELECT 1 FROM mail_inboxes')).toHaveLength(0);

    // organisation b already has an inbox of its own (switched off): it is not touched
    await q(`INSERT INTO mail_inboxes (id, org_id, label, enabled, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, 'Mine', false, now(), now())`, [b.id]);
    const first = await migrateOrgInboxes(env());
    const created = (await q('SELECT org_id FROM mail_inboxes WHERE label=$1', ['Main inbox'])) as any[];
    expect(first?.created).toBe(created.length);
    expect(created.some((r) => r.org_id === a.id)).toBe(true);
    expect(created.some((r) => r.org_id === b.id)).toBe(false);
    const addr = (await q(`SELECT a.address FROM mail_addresses a JOIN mail_inboxes i ON i.id=a.inbox_id WHERE i.org_id=$1`, [a.id])) as any[];
    expect(addr).toHaveLength(1);
    expect(addr[0].address).toMatch(ADDRESS);

    // idempotent: a second boot adds nothing
    expect((await migrateOrgInboxes(env()))?.created).toBe(0);
    expect(await q('SELECT 1 FROM mail_inboxes WHERE org_id=$1', [a.id])).toHaveLength(1);
    // and the event log has it (projection rebuilds reproduce it)
    expect(
      (await q(`SELECT 1 FROM events WHERE type='MailInboxCreated'`)).length,
    ).toBe(created.length);
  });
});
