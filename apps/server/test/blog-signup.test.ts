import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let root: { id: string; cookie: string };
const mail = new CaptureMailer();
const PW = 'a-long-enough-password';

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.mailer = mail;
  root = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const tokenFor = (email: string) => {
  const text = mail.to(email).at(-1)?.text ?? '';
  return /\/invite\/([A-Za-z0-9_-]+)/.exec(text)?.[1] as string;
};

describe('the digest checkbox at invitation acceptance', () => {
  it('records the choice of a new account and shows it in settings', async () => {
    const email = uniqueEmail('signup-yes');
    await ok(
      t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email, proposedOrgName: 'Globex' },
      }),
      201,
    );
    const accept = await t.req('POST', `/api/invitations/${tokenFor(email)}/accept`, {
      body: { displayName: 'New Person', password: PW, blogDigest: false },
    });
    expect(accept.status).toBe(201);
    // an Owner is in by default; the unticked box is an opt-out
    const pref = await ok(t.req('GET', '/api/me/blog-digest', { cookie: accept.cookie }));
    expect(pref).toEqual({ optedIn: false, isOwner: true });
    const consent = await q(`SELECT payload FROM events WHERE type='UserDigestPreferenceSet'`);
    expect(consent[0]?.payload).toMatchObject({ optedIn: false, via: 'invite' });
  });

  it('keeps the Owner default when the box is not part of the request, and members are out by default', async () => {
    const email = uniqueEmail('signup-default');
    await ok(
      t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email, proposedOrgName: 'Initech' },
      }),
      201,
    );
    const accept = await t.req('POST', `/api/invitations/${tokenFor(email)}/accept`, {
      body: { displayName: 'Other Person', password: PW },
    });
    expect(await ok(t.req('GET', '/api/me/blog-digest', { cookie: accept.cookie }))).toEqual({
      optedIn: true,
      isOwner: true,
    });
    const member = await t.userSession(uniqueEmail('plain-member'));
    await q(`UPDATE org_members SET role='member' WHERE user_id=$1`, [member.id]);
    expect(await ok(t.req('GET', '/api/me/blog-digest', { cookie: member.cookie }))).toEqual({
      optedIn: false,
      isOwner: false,
    });
    await ok(t.req('PUT', '/api/me/blog-digest', { cookie: member.cookie, body: { optedIn: true } }));
    expect((await ok(t.req('GET', '/api/me/blog-digest', { cookie: member.cookie }))).optedIn).toBe(true);
  });
});
