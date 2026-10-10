import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishPost, submitPost } from '../src/commands/blog.ts';
import { SHARE_BACKOFF_MS, socialTick } from '../src/commands/social.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { blogContent, CaptureMailer, FakeSocial } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
const mail = new CaptureMailer();
const fake = new FakeSocial();
const TOKEN = 'EAAB-secret-facebook-token-123456';
let n = 0;

const connect = (network: string, extra: Record<string, unknown> = {}) =>
  ok(
    t.req('PUT', `/api/platform/social/channels/${network}`, {
      cookie: sa.cookie,
      body: { accountId: '12345', accountName: 'Guildwise HQ', accessToken: TOKEN, ...extra },
    }),
  );

async function publish() {
  const slug = `social-${++n}-${Math.random().toString(36).slice(2, 6)}`;
  const { post } = await submitPost(t.app.ctx, blogContent(slug), { userId: sa.id }, 'draft');
  await publishPost(t.app.ctx, post.id, { userId: sa.id });
  return post;
}
const shares = (postId: string) =>
  q('SELECT * FROM social_shares WHERE post_id=$1 ORDER BY network', [postId]);
const reset = async () => {
  await q('DELETE FROM social_shares');
  await q(
    `UPDATE blog_posts SET published_at = published_at - interval '5 days' WHERE published_at IS NOT NULL`,
  ); // earlier posts are old news
  fake.calls = [];
  fake.script = [];
  mail.sent = [];
};

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.mailer = mail;
  t.app.ctx.social = fake;
  sa = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('connecting channels', () => {
  it('encrypts the tokens at rest and never returns them', async () => {
    const before = await publish(); // published before the connection: never shared (no backlog)
    const res = await connect('facebook');
    await connect('linkedin', {
      refreshToken: 'refresh-token-abcdef-123456',
      expiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
    });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    const row = (
      await q(`SELECT access_token, refresh_token FROM social_channels WHERE network='facebook'`)
    )[0];
    expect(row?.access_token.startsWith('v1:')).toBe(true);
    expect(row?.access_token).not.toContain(TOKEN);
    const li = (await q(`SELECT refresh_token FROM social_channels WHERE network='linkedin'`))[0];
    expect(li?.refresh_token).not.toContain('refresh-token');
    const events = await q(`SELECT payload FROM events WHERE type LIKE 'Social%'`);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    const list = await ok(t.req('GET', '/api/platform/social/channels', { cookie: sa.cookie }));
    expect(list.channels.map((c: any) => [c.network, c.status])).toEqual([
      ['facebook', 'ok'],
      ['linkedin', 'ok'],
    ]);
    await socialTick(t.app.ctx);
    expect(await shares(before.id)).toHaveLength(0);
  });
});

describe('sharing on publish', () => {
  it('posts once per network with the captions, stores ids and never posts twice', async () => {
    await reset();
    const post = await publish();
    expect(await socialTick(t.app.ctx)).toBe(2);
    expect(fake.calls.map((c) => c.network).sort()).toEqual(['facebook', 'linkedin']);
    const fb = fake.calls.find((c) => c.network === 'facebook')?.p;
    expect(fb?.text).toBe('New on the blog');
    expect(fb?.accessToken).toBe(TOKEN); // decrypted only for the call
    expect(fb?.link).toContain(`/blog/${post.slug}`);
    expect(fb?.imageUrl).toBe('http://aom.test/blog/cover/ai-agents.png');
    const rs = await shares(post.id);
    expect(rs.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(rs[0]?.external_id).toBeTruthy();
    // a second pass, a manual re-share and a concurrent pass all leave it alone
    await socialTick(t.app.ctx);
    await Promise.all([socialTick(t.app.ctx), socialTick(t.app.ctx)]);
    await ok(t.req('POST', `/api/platform/blog/posts/${post.id}/share`, { cookie: sa.cookie }));
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(2);
    // the post detail shows the status per network
    const detail = await ok(t.req('GET', `/api/platform/blog/posts/${post.id}`, { cookie: sa.cookie }));
    expect(detail.shares.map((s: any) => [s.network, s.status])).toEqual([
      ['facebook', 'sent'],
      ['linkedin', 'sent'],
    ]);
    // unpublishing does not delete or touch what was shared
    await ok(t.req('POST', `/api/platform/blog/posts/${post.id}/unpublish`, { cookie: sa.cookie }));
    await socialTick(t.app.ctx);
    expect((await shares(post.id)).map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(fake.calls).toHaveLength(2);
  });

  it('retries with backoff and never before the retry is due', async () => {
    await reset();
    const post = await publish();
    fake.script = ['retry', 'ok', 'ok'];
    await socialTick(t.app.ctx); // facebook (alphabetical by creation) fails
    const failed = (await shares(post.id)).find((r) => r.status === 'pending');
    expect(failed?.attempts).toBe(1);
    const due = new Date(failed?.next_attempt_at).getTime() - Date.now();
    expect(due).toBeGreaterThan(SHARE_BACKOFF_MS[0] - 5000);
    expect(due).toBeLessThan(SHARE_BACKOFF_MS[0] + 5000);
    const calls = fake.calls.length;
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(calls); // not due yet
    await q(`UPDATE social_shares SET next_attempt_at = now() - interval '1 second' WHERE status='pending'`);
    await socialTick(t.app.ctx);
    expect((await shares(post.id)).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('gives up after the last backoff, marks it failed, alerts the super admin once', async () => {
    await reset();
    const post = await publish();
    fake.script = Array(30).fill('retry');
    for (let i = 0; i <= SHARE_BACKOFF_MS.length; i++) {
      await socialTick(t.app.ctx);
      await q(
        `UPDATE social_shares SET next_attempt_at = now() - interval '1 second' WHERE status='pending'`,
      );
    }
    const rs = await shares(post.id);
    expect(rs.every((r) => r.status === 'failed')).toBe(true);
    expect(rs[0]?.error).toContain('503');
    expect(await q(`SELECT 1 FROM events WHERE type='SocialShareFailed'`)).not.toHaveLength(0);
    const alerts = mail.to(sa.email);
    expect(alerts).toHaveLength(2); // one per network, once each
    expect(alerts[0]?.subject).toContain('needs attention');
    const problems = await ok(t.req('GET', '/api/platform/social/channels', { cookie: sa.cookie }));
    expect(problems.failedShares).toBe(2);
    await connect('facebook'); // clears the alert flag for later tests
    await connect('linkedin');
  });

  it('pauses on an authentication error, alerts once, and resumes after a reconnect', async () => {
    await reset();
    const post = await publish();
    fake.script = ['auth'];
    await socialTick(t.app.ctx);
    const ch = await ok(t.req('GET', '/api/platform/social/channels', { cookie: sa.cookie }));
    expect(ch.channelsNeedingReconnect.length).toBe(1);
    const broken = ch.channelsNeedingReconnect[0];
    expect(mail.to(sa.email)).toHaveLength(1);
    await socialTick(t.app.ctx);
    expect(mail.to(sa.email)).toHaveLength(1);
    expect((await shares(post.id)).find((r) => r.network === broken)?.status).toBe('pending');
    await connect(broken); // reconnect with a fresh token
    await socialTick(t.app.ctx);
    expect((await shares(post.id)).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('shares nothing while the kill switch is on, and not a post that is too old', async () => {
    await reset();
    const post = await publish();
    await ok(t.req('PATCH', '/api/platform/blog/settings', { cookie: sa.cookie, body: { enabled: false } }));
    expect(await socialTick(t.app.ctx)).toBe(0);
    expect(fake.calls).toHaveLength(0);
    await ok(t.req('PATCH', '/api/platform/blog/settings', { cookie: sa.cookie, body: { enabled: true } }));
    await q(`UPDATE blog_posts SET published_at = now() - interval '3 days' WHERE id=$1`, [post.id]);
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(0);
  });

  it('warns about a token that is about to expire, once, and tries the refresh token first', async () => {
    await reset();
    await connect('linkedin', {
      refreshToken: 'refresh-token-abcdef-123456',
      expiresAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
    });
    await socialTick(t.app.ctx);
    expect(fake.refreshed).toBe(1);
    expect(mail.to(sa.email)).toHaveLength(1);
    expect(mail.to(sa.email)[0]?.text).toContain('expires on');
    await socialTick(t.app.ctx);
    expect(mail.to(sa.email)).toHaveLength(1);
  });
});
