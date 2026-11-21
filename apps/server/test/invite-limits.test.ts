import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

/**
 * R10 (audit F5): invitations per organization per hour and per actor per day (429 `invite_limit`), pending invitations
 * per organization (409 `pending_invitations_cap`), and 3 resends an hour per invitation. Counted in the database, so
 * they survive restarts. Small limits through the env keys.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    env: { AOM_INVITE_PER_ORG_HOUR: '3', AOM_INVITE_PER_ACTOR_DAY: '5', AOM_INVITE_PENDING_MAX: '4' },
  });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

type Who = { id: string; email: string; cookie: string };
const asIn = (org: string) => (who: Who, method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });
const HOUR = 3600_000;

describe('invitation limits', () => {
  it('per organization per hour, pending per organization, then per actor per day', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const as = asIn(owner.id);
    const invite = (who: Who = owner, a = as) =>
      a(who, 'POST', '/api/org/invitations', {
        email: uniqueEmail('invitee'),
        role: 'member',
        projectIds: [],
      });
    for (let i = 0; i < 3; i++) expect((await invite()).status).toBe(201);
    const hour = await invite();
    expect(hour.status).toBe(429);
    expect(hour.body.error).toMatchObject({ code: 'invite_limit', details: { scope: 'org_hour', limit: 3 } });

    t.clock.advance(HOUR + 60_000);
    const fresh = { ...owner, cookie: await t.login(owner.email) };
    expect((await invite(fresh)).status).toBe(201); // 4 pending now
    const cap = await invite(fresh);
    expect(cap.status).toBe(409);
    expect(cap.body.error).toMatchObject({ code: 'pending_invitations_cap', details: { limit: 4 } });

    // revoking one frees a pending slot (the hourly count is 1)
    const list = (await ok<any>(as(fresh, 'GET', '/api/org/invitations'))).invitations;
    await ok(as(fresh, 'POST', `/api/org/invitations/${list[0].id}/revoke`));
    expect((await invite(fresh)).status).toBe(201); // the actor's 5th in 24 h

    // the same actor in another organization they own hits the per-actor daily limit
    const second = await t.createOrg(owner.id, 'Second');
    const actor = await invite(fresh, asIn(second));
    expect(actor.status).toBe(429);
    expect(actor.body.error).toMatchObject({
      code: 'invite_limit',
      details: { scope: 'actor_day', limit: 5 },
    });
    // another Admin of that organization is not limited by this actor's count
    const admin = await t.userSession(uniqueEmail('admin'));
    await t.addOrgMember(second, admin.id, 'admin');
    expect((await invite(admin, asIn(second))).status).toBe(201);

    t.clock.advance(24 * HOUR);
    const later = { ...owner, cookie: await t.login(owner.email) };
    expect((await invite(later, asIn(second))).status).toBe(201);
  });

  it('a pending invitation is resent at most 3 times an hour', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const as = asIn(owner.id);
    const list = (
      await ok<any>(
        as(owner, 'POST', '/api/org/invitations', {
          email: uniqueEmail('r'),
          role: 'member',
          projectIds: [],
        }),
        201,
      )
    ).invitations;
    const resend = (who: Who) => as(who, 'POST', `/api/org/invitations/${list[0].id}/resend`);
    for (let i = 0; i < 3; i++) expect((await resend(owner)).status).toBe(200);
    const fourth = await resend(owner);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toMatchObject({
      code: 'invite_limit',
      details: { scope: 'resend_hour', limit: 3 },
    });
    t.clock.advance(HOUR + 60_000);
    expect((await resend({ ...owner, cookie: await t.login(owner.email) })).status).toBe(200);
  });
});
