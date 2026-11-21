import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ORIGIN, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken, messagesTo, waitForMessages } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

/**
 * R1: the owner's block list. The API (`/api/platform/blocklist`, super admin, step-up for changes, a mail to every
 * super admin), and its effect at invite, resend, new-organization invite and accept: domains with their subdomains,
 * exact addresses, IPs and CIDR ranges, and allowed domains that skip the hosted screening (an extension stub here).
 * Login and password reset screening are W1's (commands/auth.ts, password-reset.ts).
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    extensions: [
      {
        name: 'disposable-stub',
        async screenAddress(_ctx, input) {
          return input.email.endsWith('@throwaway.test') ? { reason: 'disposable domain' } : null;
        },
      },
    ],
  });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

type Who = { id: string; email: string; cookie: string };

async function world() {
  const root = await t.superAdminSession();
  const owner = await t.userSession(uniqueEmail('owner'));
  const as = (who: Who, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': owner.id }, body });
  const invite = (email: string) =>
    as(owner, 'POST', '/api/org/invitations', { email, role: 'member', projectIds: [] });
  const block = async (kind: string, value: string, note?: string) =>
    (
      await ok<any>(
        t.req('POST', '/api/platform/blocklist', { cookie: root.cookie, body: { kind, value, note } }),
        201,
      )
    ).entries as Array<{ id: string; kind: string; value: string }>;
  const unblock = (id: string) =>
    ok(t.req('DELETE', `/api/platform/blocklist/${id}`, { cookie: root.cookie }));
  return { root, owner, as, invite, block, unblock };
}

const idOf = (entries: Array<{ id: string; kind: string; value: string }>, kind: string, value: string) =>
  entries.find((e) => e.kind === kind && e.value === value)?.id as string;

describe('the block-list API', () => {
  it('is for super admins only; values are normalized; repeats and bad values are refused; changes are audited and mailed', async () => {
    const { root, owner, block, unblock } = await world();
    const other = await t.superAdminSession(uniqueEmail('root2'));
    expect((await t.req('GET', '/api/platform/blocklist', { cookie: owner.cookie })).status).toBe(404);
    expect(
      (
        await t.req('POST', '/api/platform/blocklist', {
          cookie: owner.cookie,
          body: { kind: 'domain', value: 'x.test' },
        })
      ).status,
    ).toBe(404);

    let entries = await block('domain', ' *.Spam-Corp.TEST ', 'probe from 17 Nov');
    expect(entries.find((e) => e.value === 'spam-corp.test')).toMatchObject({
      kind: 'domain',
      note: 'probe from 17 Nov',
      createdBy: { id: root.id },
    });
    entries = await block('email', 'Mallory@Example.test');
    expect(idOf(entries, 'email', 'mallory@example.test')).toBeTruthy();
    entries = await block('ip', '198.51.100.0/24');
    expect(idOf(entries, 'ip', '198.51.100.0/24')).toBeTruthy();

    const repeat = await t.req('POST', '/api/platform/blocklist', {
      cookie: root.cookie,
      body: { kind: 'domain', value: 'SPAM-corp.test' },
    });
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('block_exists');
    for (const [kind, value] of [
      ['domain', 'not a domain'],
      ['email', 'nobody'],
      ['ip', '300.1.1.1'],
      ['ip', '10.0.0.0/33'],
    ]) {
      const bad = await t.req('POST', '/api/platform/blocklist', {
        cookie: root.cookie,
        body: { kind, value },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('invalid_block_value');
    }

    const listed = await ok<any>(t.req('GET', '/api/platform/blocklist', { cookie: root.cookie }));
    expect(listed.entries.map((e: any) => e.value)).toEqual(
      expect.arrayContaining(['spam-corp.test', 'mallory@example.test', '198.51.100.0/24']),
    );
    const removed = (await unblock(idOf(entries, 'ip', '198.51.100.0/24'))) as any;
    expect(removed.entries.some((e: any) => e.value === '198.51.100.0/24')).toBe(false);
    expect(
      (
        await t.req('DELETE', `/api/platform/blocklist/${idOf(entries, 'ip', '198.51.100.0/24')}`, {
          cookie: root.cookie,
        })
      ).status,
    ).toBe(404);

    const audit = await q(
      `SELECT action, summary FROM platform_audit_log WHERE action LIKE 'PlatformBlock%' ORDER BY seq`,
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['PlatformBlockAdded', 'PlatformBlockRemoved']),
    );
    // every active super admin is told (the other one too)
    const mails = await waitForMessages(other.email, 4);
    expect(mails.map((m) => m.Subject)).toEqual(
      expect.arrayContaining(['Block list added: spam-corp.test', 'Block list removed: 198.51.100.0/24']),
    );
  });

  it('changes need a fresh step-up', async () => {
    const root = await t.superAdminSession();
    t.clock.advance(11 * 60_000);
    const add = await t.req('POST', '/api/platform/blocklist', {
      cookie: root.cookie,
      body: { kind: 'domain', value: 'late.test' },
    });
    expect(add.status).toBe(403);
    expect(add.body.error.code).toBe('step_up_required');
    expect((await t.req('GET', '/api/platform/blocklist', { cookie: root.cookie })).status).toBe(200);
  });
});

describe('screening at invite, resend, new-organization invite and accept', () => {
  it('a blocked domain, subdomain or address cannot be invited (400 email_not_accepted); others can', async () => {
    const { invite, block } = await world();
    await block('domain', 'blocked-dom.test');
    await block('email', 'exact@fine-dom.test');
    for (const email of ['a@blocked-dom.test', 'a@mail.blocked-dom.test', 'EXACT@fine-dom.test']) {
      const r = await invite(email);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('email_not_accepted');
      expect(JSON.stringify(r.body)).not.toContain('block list');
    }
    expect((await invite(uniqueEmail('ok').replace('@example.test', '@fine-dom.test'))).status).toBe(201);
    expect((await invite('a@notblocked-dom.test')).status).toBe(201);
    expect(await messagesTo('a@blocked-dom.test')).toHaveLength(0);
  });

  it('a blocked client IP or range is refused with 403 request_refused', async () => {
    const { invite, block, unblock } = await world();
    let entries = await block('ip', '127.0.0.1');
    const r = await invite(uniqueEmail('ipblock'));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('request_refused');
    await unblock(idOf(entries, 'ip', '127.0.0.1'));
    entries = await block('ip', '127.0.0.0/8');
    expect((await invite(uniqueEmail('cidr'))).status).toBe(403);
    await unblock(idOf(entries, 'ip', '127.0.0.0/8'));
    expect((await invite(uniqueEmail('free'))).status).toBe(201);
  });

  it('the hosted screening refuses a disposable domain unless an allowed domain matches', async () => {
    const { invite, block } = await world();
    const r = await invite(`x-${Date.now()}@throwaway.test`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('email_not_accepted');
    await block('allow_domain', 'throwaway.test');
    expect((await invite(`y-${Date.now()}@throwaway.test`)).status).toBe(201);
  });

  it('resend and accept screen the address again; a new-organization invite is screened too', async () => {
    const { root, invite, block } = await world();
    const fresh = `new-${Date.now()}@later-blocked.test`;
    const existing = await t.userSession(`old-${Date.now()}@later-blocked.test`);
    await ok(invite(fresh), 201);
    await ok(invite(existing.email), 201);
    const tokenNew = await latestInviteToken(fresh, ORIGIN);
    const tokenOld = await latestInviteToken(existing.email, ORIGIN);
    await block('domain', 'later-blocked.test');

    const accept = await t.req('POST', `/api/invitations/${tokenNew}/accept`, {
      body: { displayName: 'New', password: 'a-strong-password-1' },
    });
    expect(accept.status).toBe(400);
    expect(accept.body.error.code).toBe('email_not_accepted');
    const acceptExisting = await t.req('POST', `/api/invitations/${tokenOld}/accept-existing`, {
      cookie: existing.cookie,
      body: {},
    });
    expect(acceptExisting.status).toBe(400);
    expect(acceptExisting.body.error.code).toBe('email_not_accepted');
    // still pending: nothing was spent
    expect((await q(`SELECT status FROM invitations WHERE lower(email)=lower($1)`, [fresh]))[0]!.status).toBe(
      'pending',
    );

    const newOrg = await t.req('POST', '/api/platform/invitations', {
      cookie: root.cookie,
      body: {
        email: `founder-${Date.now()}@later-blocked.test`,
        proposedOrgName: 'Nope',
        plan: 'founding',
        status: 'active',
      },
    });
    expect(newOrg.status).toBe(400);
    expect(newOrg.body.error.code).toBe('email_not_accepted');
  });

  it('the Owner cannot resend an invitation whose address was blocked after it went out', async () => {
    const { as, owner, invite, block } = await world();
    const email = `r-${Date.now()}@resend-blocked.test`;
    const inv = (await ok<any>(invite(email), 201)).invitations.find((i: any) => i.email === email);
    await block('email', email);
    const r = await as(owner, 'POST', `/api/org/invitations/${inv.id}/resend`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('email_not_accepted');
  });
});
