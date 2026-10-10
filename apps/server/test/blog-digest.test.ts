import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishPost, submitPost } from '../src/commands/blog.ts';
import {
  blogDigestTick,
  digestIdFor,
  digestRecipients,
  lastDigestDue,
  userOfUnsubscribeToken,
} from '../src/commands/blog-digest.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { blogContent, CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
const mail = new CaptureMailer();
const DAY = 86400_000;
let n = 0;

async function publishNow(title: string) {
  const slug = `digest-${++n}-${Math.random().toString(36).slice(2, 6)}`;
  const { post } = await submitPost(t.app.ctx, blogContent(slug, { title }), { userId: sa.id }, 'draft');
  await publishPost(t.app.ctx, post.id, { userId: sa.id });
}
/** Moves the clock to the next Monday 08:00 Africa/Johannesburg (06:00 UTC) plus `afterMin` minutes. */
function toMonday(afterMin = 5) {
  const now = t.clock.now();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, afterMin));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  t.clock.advance(d.getTime() - now.getTime());
}

let ownerIn: { id: string; email: string; cookie: string };
let ownerOut: { id: string; email: string; cookie: string };
let memberDefault: { id: string; email: string };
let memberIn: { id: string; email: string; cookie: string };
let suspendedOwner: { id: string; email: string };

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.mailer = mail;
  sa = await t.superAdminSession();
  ownerIn = await t.userSession(uniqueEmail('owner-in'));
  ownerOut = await t.userSession(uniqueEmail('owner-out'));
  memberIn = await t.userSession(uniqueEmail('member-in'));
  const memberId = await t.createUser(uniqueEmail('member-default'));
  memberDefault = {
    id: memberId,
    email: (await q('SELECT email FROM users WHERE id=$1', [memberId]))[0]?.email,
  };
  const sid = await t.createUser(uniqueEmail('suspended'));
  suspendedOwner = { id: sid, email: (await q('SELECT email FROM users WHERE id=$1', [sid]))[0]?.email };
  // memberDefault and memberIn belong to ownerIn's organization only as members (their own orgs are suspended)
  for (const u of [memberDefault.id, memberIn.id, sid])
    await q(`UPDATE organizations SET status='suspended' WHERE id=$1`, [u]);
  await t.addOrgMember(ownerIn.id, memberDefault.id);
  await t.addOrgMember(ownerIn.id, memberIn.id);
  await q(`UPDATE org_members SET role='member' WHERE user_id IN ($1,$2) AND org_id <> $3 AND role='owner'`, [
    memberDefault.id,
    memberIn.id,
    ownerIn.id,
  ]);
  await ok(t.req('PUT', '/api/me/blog-digest', { cookie: ownerOut.cookie, body: { optedIn: false } }));
  await ok(t.req('PUT', '/api/me/blog-digest', { cookie: memberIn.cookie, body: { optedIn: true } }));
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('digest schedule helpers', () => {
  it('finds Monday 08:00 Johannesburg and the ISO week', () => {
    const due = lastDigestDue(new Date('2026-10-14T12:00:00Z')); // a Wednesday
    expect(due.toISOString()).toBe('2026-10-12T06:00:00.000Z');
    expect(lastDigestDue(new Date('2026-10-12T05:59:00Z')).toISOString()).toBe('2026-10-05T06:00:00.000Z');
    expect(digestIdFor(due)).toBe('blog-digest-2026-W42');
    expect(digestIdFor(new Date('2027-01-04T06:00:00Z'))).toBe('blog-digest-2027-W01');
  });
});

describe('weekly digest', () => {
  it('picks recipients: Owners unless opted out, others only if opted in, never an all-suspended user', async () => {
    const emails = (await digestRecipients(t.app.ctx)).map((r) => r.email);
    expect(emails).toContain(ownerIn.email);
    expect(emails).toContain(memberIn.email);
    expect(emails).not.toContain(ownerOut.email);
    expect(emails).not.toContain(memberDefault.email);
    expect(emails).not.toContain(suspendedOwner.email);
    expect(emails).not.toContain(sa.email);
  });

  it('sends one mail per recipient with the unsubscribe headers, and nothing twice', async () => {
    await publishNow('First article of the week about agents');
    await publishNow('Second article of the week about automation');
    toMonday();
    const r = await blogDigestTick(t.app.ctx);
    expect(r.state).toBe('sent');
    expect(mail.sent.map((m) => m.to).sort()).toEqual([ownerIn.email, memberIn.email].sort());
    const m = mail.to(ownerIn.email)[0];
    expect(m?.subject).toContain('2 new articles');
    expect(m?.text).toContain('First article of the week about agents');
    expect(m?.html).toContain('unsubscribe');
    expect(m?.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/aom\.test\/blog\/unsubscribe\/.+>$/);
    expect(m?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect((await blogDigestTick(t.app.ctx)).state).toBe('sent');
    expect(mail.sent).toHaveLength(2);
    expect((await q('SELECT state, recipients FROM blog_digests'))[0]).toMatchObject({
      state: 'sent',
      recipients: 2,
    });
    expect(await q(`SELECT 1 FROM events WHERE type='BlogDigestSent'`)).toHaveLength(1);
  });

  it('one-click unsubscribe works without signing in (link and RFC 8058 POST) and can be undone', async () => {
    const header = String(mail.to(ownerIn.email)[0]?.headers?.['List-Unsubscribe']);
    const token = header.replace(/^<.*\/unsubscribe\//, '').replace(/>$/, '');
    expect(await userOfUnsubscribeToken(t.app.ctx, token)).toBe(ownerIn.id);
    expect(await userOfUnsubscribeToken(t.app.ctx, `${token}x`)).toBeNull();
    const bad = await t.app.inject({ method: 'GET', url: '/blog/unsubscribe/not-a-real-token-at-all' });
    expect(bad.statusCode).toBe(400);

    const post = await t.app.inject({
      method: 'POST',
      url: `/blog/unsubscribe/${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(post.statusCode).toBe(200);
    expect((await digestRecipients(t.app.ctx)).map((r) => r.email)).not.toContain(ownerIn.email);

    const re = await t.app.inject({
      method: 'POST',
      url: `/blog/unsubscribe/${token}/resubscribe`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(re.statusCode).toBe(200);
    expect((await digestRecipients(t.app.ctx)).map((r) => r.email)).toContain(ownerIn.email);

    // opening the link only shows the confirm page: it changes nothing (mail scanners open links)
    const link = await t.app.inject({ method: 'GET', url: `/blog/unsubscribe/${token}` });
    expect(link.statusCode).toBe(200);
    expect(link.body).toContain('Unsubscribe from the weekly digest');
    expect(link.body).toContain('Keep me subscribed');
    expect(link.body).not.toContain('You are unsubscribed');
    expect((await digestRecipients(t.app.ctx)).map((r) => r.email)).toContain(ownerIn.email);
    await t.app.inject({ method: 'GET', url: `/blog/unsubscribe/${token}` });
    expect((await digestRecipients(t.app.ctx)).map((r) => r.email)).toContain(ownerIn.email);
    // the confirm button posts and gets a page back
    const confirm = await t.app.inject({
      method: 'POST',
      url: `/blog/unsubscribe/${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'confirm=1',
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.headers['content-type']).toContain('text/html');
    expect(confirm.body).toContain('You are unsubscribed');
    expect(confirm.body).toContain('Subscribe again');
    expect((await digestRecipients(t.app.ctx)).map((r) => r.email)).not.toContain(ownerIn.email);
    const badConfirm = await t.app.inject({
      method: 'POST',
      url: '/blog/unsubscribe/not-a-real-token-at-all',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'confirm=1',
    });
    expect(badConfirm.statusCode).toBe(400);
    expect(badConfirm.body).toContain('Link not valid');
    const cookie = await t.login(ownerIn.email);
    const pref = await ok(t.req('GET', '/api/me/blog-digest', { cookie }));
    expect(pref).toEqual({ optedIn: false, isOwner: true });
    await ok(t.req('PUT', '/api/me/blog-digest', { cookie, body: { optedIn: true } }));
    expect(
      await q(
        `SELECT payload->>'via' AS via FROM events WHERE type='UserDigestPreferenceSet' AND payload->>'userId'=$1 ORDER BY seq`,
        [ownerIn.id],
      ),
    ).toHaveLength(4);
  });

  it('skips a week with no new posts and records it', async () => {
    mail.sent = [];
    t.clock.advance(7 * DAY);
    const r = await blogDigestTick(t.app.ctx);
    expect(r.state).toBe('skipped');
    expect(mail.sent).toHaveLength(0);
    expect((await q(`SELECT note FROM blog_digests WHERE state='skipped'`))[0]?.note).toBe('no new posts');
    expect(await q(`SELECT 1 FROM events WHERE type='BlogDigestSkipped'`)).toHaveLength(1);
  });

  it('resumes after a failed send without mailing anyone twice, and honours the switches', async () => {
    mail.sent = [];
    t.clock.advance(7 * DAY);
    await publishNow('Third article, published just before the digest');
    t.clock.advance(60_000);
    // the env switch and the platform switch both stop it
    t.app.ctx.config.blogDigest = false;
    expect((await blogDigestTick(t.app.ctx)).state).toBe('none');
    t.app.ctx.config.blogDigest = true;

    mail.failFor.add(memberIn.email);
    const first = await blogDigestTick(t.app.ctx);
    expect(first.state).toBe('sending');
    expect(mail.to(ownerIn.email)).toHaveLength(1);
    mail.failFor.clear();
    const second = await blogDigestTick(t.app.ctx);
    expect(second.state).toBe('sent');
    expect(mail.to(ownerIn.email)).toHaveLength(1);
    expect(mail.to(memberIn.email)).toHaveLength(1);
    await blogDigestTick(t.app.ctx);
    expect(mail.sent).toHaveLength(2);
  });
});
