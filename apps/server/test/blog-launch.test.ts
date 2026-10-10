import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blogSettings, submitPost } from '../src/commands/blog.ts';
import { blogDigestTick } from '../src/commands/blog-digest.ts';
import { socialTick } from '../src/commands/social.ts';
import {
  BLOG_LAUNCH_MIGRATION,
  loadLaunchArticles,
  migrateBlogLaunch,
} from '../src/data-migrations/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { blogContent, CaptureMailer, FakeSocial } from './helpers/blog.ts';
import { closeAdminPool, q, resetDb } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
const fake = new FakeSocial();
const mail = new CaptureMailer();

const env = () => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store,
  clock: t.clock,
  log: () => {},
});
const run = () => migrateBlogLaunch(env());
const posts = () =>
  q('SELECT slug, status, launch, published_at, review_since FROM blog_posts ORDER BY slug');

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.mailer = mail;
  t.app.ctx.social = fake;
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await resetDb();
  fake.calls = [];
  mail.sent = [];
});

describe('blog-launch-2026-10', () => {
  it('ships four well-formed articles', () => {
    const a = loadLaunchArticles();
    expect(a).toHaveLength(4);
    for (const c of a) {
      expect(c.sources.length).toBeGreaterThanOrEqual(3);
      const words = c.bodyMarkdown.split(/\s+/).length;
      expect(words).toBeGreaterThan(900);
      expect(words).toBeLessThan(1600);
      expect(c.aiDisclosure.model).toBeTruthy();
    }
  });

  it('publishes all four on a fresh database with the blog on, once', async () => {
    const r = await run();
    expect(r?.created).toHaveLength(4);
    const rows = await posts();
    expect(rows).toHaveLength(4);
    for (const p of rows) {
      expect(p.status).toBe('published');
      expect(p.launch).toBe(true);
      expect(new Date(p.published_at).getTime()).toBeGreaterThan(0);
    }
    expect((await q('SELECT 1 FROM data_migrations WHERE name=$1', [BLOG_LAUNCH_MIGRATION])).length).toBe(1);
    // a second boot does nothing
    expect(await run()).toBeNull();
    expect(await posts()).toHaveLength(4);
  });

  it('creates drafts when the blog is switched off', async () => {
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('blog_enabled','false'::jsonb, now())`,
    );
    const r = await run();
    expect(r?.status).toBe('draft');
    const rows = await posts();
    expect(rows).toHaveLength(4);
    for (const p of rows) {
      expect(p.status).toBe('draft');
      expect(p.published_at).toBeNull();
    }
  });

  it('skips a slug that exists and leaves that post alone', async () => {
    const slug = loadLaunchArticles()[0]?.slug as string;
    const { post } = await submitPost(
      t.app.ctx,
      blogContent(slug, { title: 'My own earlier post on the same slug' }),
      {},
      'draft',
    );
    const r = await run();
    expect(r?.skipped).toEqual([slug]);
    expect(r?.created).toHaveLength(3);
    const mine = await q('SELECT title, status, launch FROM blog_posts WHERE id=$1', [post.id]);
    expect(mine[0]).toMatchObject({
      title: 'My own earlier post on the same slug',
      status: 'draft',
      launch: false,
    });
    expect(await posts()).toHaveLength(4);
  });

  it('queues no social shares and no digest, and does not start the review period', async () => {
    const sa = await t.superAdminSession();
    await ok(
      t.req('PUT', '/api/platform/social/channels/facebook', {
        cookie: sa.cookie,
        body: {
          accountId: '1',
          accountName: 'Guildwise HQ',
          accessToken: 'EAAB-secret-facebook-token-123456',
        },
      }),
    );
    await run();
    await socialTick(t.app.ctx);
    expect(await q('SELECT 1 FROM social_shares')).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    // the digest: advance to the next Monday 08:00 Africa/Johannesburg
    const now = t.clock.now();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 5));
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
    t.clock.advance(d.getTime() - now.getTime());
    await blogDigestTick(t.app.ctx);
    expect(await q('SELECT 1 FROM blog_digest_deliveries')).toHaveLength(0);
    // the writer agent's two-week review period starts with its own first post, not with the launch set
    expect((await blogSettings(t.app.ctx)).autoPublishFrom).toBeNull();
  });

  it('survives a projection rebuild', async () => {
    await run();
    const before = await posts();
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    const after = await posts();
    expect(after).toEqual(before);
    expect(after.every((p) => p.launch === true && p.status === 'published')).toBe(true);
  });
});
