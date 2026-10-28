import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { draftFromRelease, getRelease, useReleaseSource } from '../src/blog/releases.ts';
import { publishPost, submitPost } from '../src/commands/blog.ts';
import { digestTestMail } from '../src/commands/blog-digest.ts';
import { SYSTEM_ACTOR } from '../src/commands/common.ts';
import { socialTick } from '../src/commands/social.ts';
import { newestUnannouncedRelease, submitSocialPost } from '../src/commands/social-posts.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { bearer, blogContent, CaptureMailer, FakeSocial, makeKey } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
let dir: string;
const fake = new FakeSocial();
const mail = new CaptureMailer();
const TOKEN = 'EAAB-secret-facebook-token-123456';
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

/** 1.2.0 to 1.9.0 are released today, 1.1.0 twenty days ago, 1.0.0 sixty days ago. */
function changelog(): string {
  const fresh = [9, 8, 7, 6, 5, 4, 3, 2]
    .map(
      (m) =>
        `## [1.${m}.0] - ${today}\n\n### Added\n\n- Feature number ${m} lets you do something useful with agents.\n`,
    )
    .join('\n');
  return `# Changelog\n\n## [Unreleased]\n\n${fresh}\n## [1.0.2] - ${daysAgo(10)}\n\n### Added\n\n- A later small thing.\n\n## [1.0.1] - ${daysAgo(10)}\n\n### Added\n\n- A small thing.\n\n## [1.1.0] - ${daysAgo(20)}\n\n### Fixed\n\n- A fix.\n\n## [1.0.0] - ${daysAgo(60)}\n\n### Added\n\n- First.\n`;
}

const connect = (network: string) =>
  ok(
    t.req('PUT', `/api/platform/social/channels/${network}`, {
      cookie: sa.cookie,
      body: { accountId: '12345', accountName: 'Guildwise HQ', accessToken: TOKEN },
    }),
  );
const draft = (version: string) =>
  t.req('POST', '/api/platform/social/posts', { cookie: sa.cookie, body: { kind: 'release', ref: version } });
const act = (id: string, action: string, body?: unknown) =>
  t.req('POST', `/api/platform/social/posts/${id}/${action}`, {
    cookie: sa.cookie,
    ...(body ? { body } : {}),
  });
const shares = (id: string) => q('SELECT * FROM social_shares WHERE post_id=$1 ORDER BY network', [id]);
const get = (url: string) => t.app.inject({ method: 'GET', url });
const cleanShares = async () => {
  // what earlier tests approved or published is old news by now
  await q(
    `UPDATE social_posts SET approved_at = approved_at - interval '5 days' WHERE approved_at IS NOT NULL`,
  );
  await q(
    `UPDATE blog_posts SET published_at = published_at - interval '5 days' WHERE published_at IS NOT NULL`,
  );
  await q('DELETE FROM social_shares');
  fake.calls = [];
  fake.script = [];
};
/** A drafted release post taken through approval. */
async function approved(version: string) {
  const d = await ok(draft(version), 201);
  await ok(act(d.id, 'approve'));
  return d.id as string;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'social-release-'));
  mkdirSync(join(dir, 'entries'));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog());
  writeFileSync(
    join(dir, 'entries', `${today}-feature.md`),
    `---\ntitle: Feature nine\ndate: ${today}\naudience: all\nrelease: 1.9.0\n---\nA short public description of feature nine.`,
  );
  for (const n of ['a', 'b'])
    writeFileSync(
      join(dir, 'entries', `${today}-overview-${n}.md`),
      `---\ntitle: Overview ${n}\ndate: ${today}\naudience: all\nrelease: 1.9.0\n---\n## Overview\n\nText ${n}.\n\n### Details\n\nMore ${n}.`,
    );
  writeFileSync(
    join(dir, 'entries', `${today}-platform-only.md`),
    `---\ntitle: Platform secret\ndate: ${today}\naudience: superadmin\n---\nNever public.`,
  );
  useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'entries') });
  t = await createTestApp();
  t.app.ctx.mailer = mail;
  t.app.ctx.social = fake;
  sa = await t.superAdminSession();
});
afterAll(async () => {
  useReleaseSource(null);
  rmSync(dir, { recursive: true, force: true });
  await t.close();
  await closeAdminPool();
});

describe('newestUnannouncedRelease', () => {
  it('is the newest release within the age limit that has no post', async () => {
    expect((await newestUnannouncedRelease(t.app.ctx, 7))?.version).toBe('1.9.0');
    expect((await newestUnannouncedRelease(t.app.ctx, 30))?.version).toBe('1.9.0');
  });
  it('ignores releases older than the limit', async () => {
    const old = mkdtempSync(join(tmpdir(), 'old-releases-'));
    writeFileSync(
      join(old, 'CHANGELOG.md'),
      `# Changelog\n\n## [1.1.0] - ${daysAgo(20)}\n\n### Fixed\n\n- A fix.\n`,
    );
    useReleaseSource({ changelogPath: join(old, 'CHANGELOG.md'), entriesDir: join(old, 'none') });
    try {
      expect(await newestUnannouncedRelease(t.app.ctx, 7)).toBeNull();
      expect((await newestUnannouncedRelease(t.app.ctx, 30))?.version).toBe('1.1.0');
    } finally {
      useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'entries') });
      rmSync(old, { recursive: true, force: true });
    }
  });
});

describe('release posts: drafting and approval', () => {
  it('lists the releases without posts, then drafts one by hand, once', async () => {
    const list = await ok(t.req('GET', '/api/platform/social/releases', { cookie: sa.cookie }));
    expect(list.releases.map((r: { version: string }) => r.version).slice(0, 2)).toEqual(['1.9.0', '1.8.0']);
    expect(list.releases[0].post).toBeNull();
    expect(list.releases[0].whatsNew.map((w: { title: string }) => w.title)).toEqual([
      'Feature nine',
      'Overview a',
      'Overview b',
    ]);
    const d = await ok(draft('1.9.0'), 201);
    expect(d).toMatchObject({ kind: 'release', ref: '1.9.0', status: 'draft' });
    expect(d.content.captions.hashtags.linkedin.length).toBeGreaterThanOrEqual(3);
    expect(d.content.title).toContain('1.9.0');
    const again = await ok(draft('1.9.0'), 200);
    expect(again.id).toBe(d.id);
    expect(await q(`SELECT 1 FROM social_posts WHERE ref='1.9.0'`)).toHaveLength(1);
    expect((await newestUnannouncedRelease(t.app.ctx, 7))?.version).toBe('1.8.0');
    const after = await ok(t.req('GET', '/api/platform/social/releases', { cookie: sa.cookie }));
    expect(after.releases[0].post.status).toBe('draft');
  });

  it('refuses an unknown release', async () => {
    expect((await draft('7.7.7')).status).toBe(400);
  });

  it('edits, reviews and rejects with a reason, and a rejected post comes back through review', async () => {
    const id = (await ok(draft('1.8.0'), 201)).id;
    const edited = await ok(
      t.req('PATCH', `/api/platform/social/posts/${id}`, {
        cookie: sa.cookie,
        body: { captions: { xText: 'Edited for X', hashtags: { x: ['AI'] } } },
      }),
    );
    expect(edited.content.captions.xText).toBe('Edited for X');
    expect((await ok(act(id, 'submit'))).status).toBe('in_review');
    expect(
      (await ok(t.req('GET', '/api/platform/blog/summary', { cookie: sa.cookie }))).pendingReleases,
    ).toBe(1);
    expect((await act(id, 'reject', {})).status).toBe(400); // a reason is required
    const rej = await ok(act(id, 'reject', { reason: 'too salesy' }));
    expect(rej).toMatchObject({ status: 'rejected', rejectionReason: 'too salesy' });
    expect((await act(id, 'approve')).status).toBe(409);
    expect((await ok(act(id, 'submit'))).status).toBe('in_review');
  });

  it('will not approve with no network connected (409 no_channel)', async () => {
    await q('DELETE FROM social_channels');
    const id = (await ok(draft('1.7.0'), 201)).id;
    const r = await act(id, 'approve');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_channel');
    expect((await ok(t.req('GET', `/api/platform/social/posts/${id}`, { cookie: sa.cookie }))).status).toBe(
      'draft',
    );
  });

  it('only a super admin may use the routes', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/platform/social/releases' });
    expect([401, 403, 404]).toContain(r.statusCode);
  });
});

describe('release posts: sharing', () => {
  it('shares nothing before approval, then once per connected network, with the release link and cover', async () => {
    await cleanShares();
    await connect('facebook');
    await connect('linkedin');
    const d = await ok(draft('1.6.0'), 201);
    await ok(act(d.id, 'submit'));
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(0); // in review: not before approval
    await ok(act(d.id, 'approve'));
    expect(await socialTick(t.app.ctx)).toBe(2);
    expect(fake.calls.map((c) => c.network).sort()).toEqual(['facebook', 'linkedin']);
    const fb = fake.calls.find((c) => c.network === 'facebook')?.p;
    expect(fb?.link).toBe(
      'http://aom.test/releases/1.6.0?utm_source=facebook&utm_medium=social&utm_campaign=release-1.6.0',
    );
    expect(fb?.imageUrl).toBe('http://aom.test/blog/cover/release.png');
    expect(fb?.tags).toEqual(['GuildwiseHQ']);
    expect(fb?.text).toContain('1.6.0');
    expect(fb?.title).toContain('1.6.0');
    expect(fb?.accessToken).toBe(TOKEN);
    expect((await shares(d.id)).map((r) => [r.network, r.status, r.source])).toEqual([
      ['facebook', 'sent', 'social'],
      ['linkedin', 'sent', 'social'],
    ]);
    // again: never twice
    await socialTick(t.app.ctx);
    await Promise.all([socialTick(t.app.ctx), socialTick(t.app.ctx)]);
    expect(fake.calls).toHaveLength(2);
    const detail = await ok(t.req('GET', `/api/platform/social/posts/${d.id}`, { cookie: sa.cookie }));
    expect(detail.shares.map((s: { network: string; status: string }) => [s.network, s.status])).toEqual([
      ['facebook', 'sent'],
      ['linkedin', 'sent'],
    ]);
    expect(
      (
        await q(`SELECT 1 FROM events WHERE type='SocialShareSucceeded' AND stream_id=$1`, [
          `social-post-${d.id}`,
        ])
      ).length,
    ).toBe(2);
    // an approved post is final
    expect(
      (
        await t.req('PATCH', `/api/platform/social/posts/${d.id}`, {
          cookie: sa.cookie,
          body: { title: 'Changed my mind' },
        })
      ).status,
    ).toBe(409);
    expect((await act(d.id, 'reject', { reason: 'late' })).status).toBe(409);
  });

  it('does not share a post approved more than 48 hours ago', async () => {
    await cleanShares();
    const id = await approved('1.5.0');
    await q(`UPDATE social_posts SET approved_at = now() - interval '3 days' WHERE id=$1`, [id]);
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(0);
    expect(await shares(id)).toHaveLength(0);
  });

  it('skips a share that became too old before it ran, and a post that is not approved', async () => {
    await cleanShares();
    const id = await approved('1.4.0');
    // the share exists, but by the time it runs the approval is old
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1,'facebook','social','pending',0,now(),now(),now())`,
      [id],
    );
    await q(`UPDATE social_posts SET approved_at = now() - interval '3 days' WHERE id=$1`, [id]);
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(0);
    expect((await shares(id))[0]).toMatchObject({ status: 'skipped', error: 'older than 48 hours' });
  });

  it('shares nothing while the kill switch is on', async () => {
    await cleanShares();
    const id = await approved('1.3.0');
    await ok(t.req('PATCH', '/api/platform/blog/settings', { cookie: sa.cookie, body: { enabled: false } }));
    expect(await socialTick(t.app.ctx)).toBe(0);
    expect(fake.calls).toHaveLength(0);
    await ok(t.req('PATCH', '/api/platform/blog/settings', { cookie: sa.cookie, body: { enabled: true } }));
    expect(await socialTick(t.app.ctx)).toBe(2);
    expect((await shares(id)).map((r) => r.status)).toEqual(['sent', 'sent']);
  });

  it('a network connected after the approval gets no backlog', async () => {
    await cleanShares();
    await q(`DELETE FROM social_channels WHERE network='linkedin'`);
    const id = await approved('1.2.0');
    await q(`UPDATE social_channels SET connected_at = now() + interval '1 minute' WHERE network='facebook'`);
    await socialTick(t.app.ctx);
    expect(await shares(id)).toHaveLength(0);
    await q(`UPDATE social_channels SET connected_at = now() - interval '1 hour' WHERE network='facebook'`);
    await connect('linkedin');
  });

  it('shares a blog post and a release post in the same pass, and the agent API tells them apart', async () => {
    await cleanShares();
    await q(`UPDATE social_channels SET connected_at = now() - interval '1 hour'`);
    const rel = await ok(draft('1.9.0'), 200); // the draft made earlier
    await ok(act(rel.id, 'approve'));
    const slug = `mixed-${Math.random().toString(36).slice(2, 6)}`;
    const { post } = await submitPost(t.app.ctx, blogContent(slug), { userId: sa.id }, 'draft');
    await publishPost(t.app.ctx, post.id, { userId: sa.id });
    expect(await socialTick(t.app.ctx)).toBe(4);
    const links = fake.calls.map((c) => c.p.link);
    expect(links.filter((l) => l.includes('/releases/1.9.0'))).toHaveLength(2);
    expect(links.filter((l) => l.includes(`/blog/${slug}`))).toHaveLength(2);
    const key = await makeKey(t, sa.cookie, ['social:write']);
    const r = await ok(t.req('GET', '/api/v1/social/shares', { headers: bearer(key.secret) }));
    const mine = r.shares.filter((s: { postId: string }) => [rel.id, post.id].includes(s.postId));
    expect(mine).toHaveLength(4);
    expect(
      mine.filter((s: { source: string; ref?: string }) => s.source === 'social' && s.ref === '1.9.0'),
    ).toHaveLength(2);
    expect(
      mine.filter((s: { source: string; slug?: string }) => s.source === 'blog' && s.slug === slug),
    ).toHaveLength(2);
  });
});

describe('public release pages', () => {
  it("renders the index and a release with the cover as og:image, What's New and the changelog", async () => {
    const idx = await get('/releases');
    expect(idx.statusCode).toBe(200);
    expect(idx.headers['content-type']).toContain('text/html');
    expect(idx.body).toContain('Guildwise HQ 1.9.0');
    expect(idx.body).toContain('/releases/1.9.0');
    const page = await get('/releases/1.9.0');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<h1>Guildwise HQ 1.9.0</h1>');
    expect(page.body).toContain('og:image" content="http://aom.test/blog/cover/release.png"');
    expect(page.body).toContain('Feature nine');
    expect(page.body).toContain('A short public description of feature nine.');
    expect(page.body).toContain('Feature number 9 lets you do something useful with agents.');
    expect(page.body).not.toContain('Platform secret');
    expect(page.body).toContain('rel="canonical"');
    expect(page.headers['cache-control']).toContain('max-age');
    const etag = page.headers.etag as string;
    const cached = await t.app.inject({
      method: 'GET',
      url: '/releases/1.9.0',
      headers: { 'if-none-match': etag },
    });
    expect(cached.statusCode).toBe(304);
  });

  it('404s an unknown or malformed version', async () => {
    expect((await get('/releases/7.7.7')).statusCode).toBe(404);
    expect((await get('/releases/not-a-version')).statusCode).toBe(404);
  });

  it('is in the sitemap', async () => {
    const sm = await get('/sitemap.xml');
    expect(sm.body).toContain('http://aom.test/releases</loc>');
    expect(sm.body).toContain('http://aom.test/releases/1.9.0</loc>');
  });

  it('never appears in the blog list, the feed, the digest or the blog API', async () => {
    const slug = `plain-${Math.random().toString(36).slice(2, 6)}`;
    const { post } = await submitPost(t.app.ctx, blogContent(slug), { userId: sa.id }, 'draft');
    await publishPost(t.app.ctx, post.id, { userId: sa.id });
    for (const url of ['/blog', '/blog/rss.xml']) {
      const body = (await get(url)).body;
      expect(body).toContain(slug);
      expect(body).not.toContain('Guildwise HQ 1.9.0');
    }
    const api = await ok(t.req('GET', '/api/platform/blog', { cookie: sa.cookie }));
    expect(JSON.stringify(api.posts)).not.toContain('1.9.0');
    expect(await q(`SELECT 1 FROM blog_posts WHERE title LIKE '%1.9.0%'`)).toHaveLength(0);
    const pub = await ok(t.req('GET', '/api/blog/posts', { cookie: sa.cookie }));
    expect(JSON.stringify(pub)).not.toContain('1.9.0');
    expect(await digestTestMail(t.app.ctx, sa.email, sa.id)).toBeGreaterThan(0);
    const digest = mail.to(sa.email).at(-1);
    expect(digest?.text).toContain(slug);
    expect(`${digest?.text}${digest?.html}`).not.toContain('1.9.0');
  });

  it('is gone (404) while the blog is switched off', async () => {
    await ok(t.req('PATCH', '/api/platform/blog/settings', { cookie: sa.cookie, body: { enabled: false } }));
    expect((await get('/releases')).statusCode).toBe(404);
    expect((await get('/releases/1.9.0')).statusCode).toBe(404);
    expect((await get('/sitemap.xml')).body).not.toContain('/releases/1.9.0');
    await ok(t.req('PATCH', '/api/platform/blog/settings', { cookie: sa.cookie, body: { enabled: true } }));
    expect((await get('/releases/1.9.0')).statusCode).toBe(200);
  });
});

describe('projection', () => {
  it('rebuilds social_posts from the events', async () => {
    const snapshot = () =>
      q(
        'SELECT id, kind, ref, title, status, rejection_reason, (approved_at IS NOT NULL) AS approved, (review_since IS NOT NULL) AS reviewed, content FROM social_posts ORDER BY ref',
      );
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(3);
    expect(before.map((r) => r.status)).toEqual(expect.arrayContaining(['draft', 'in_review', 'approved']));
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await snapshot()).toEqual(before);
  });
});

describe('hardening', () => {
  it('serializes concurrent submits of one release: one post, one event, all callers get it', async () => {
    const release = getRelease('1.0.1');
    if (!release) throw new Error('fixture release missing');
    const content = draftFromRelease(release);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        submitSocialPost(t.app.ctx, { kind: 'release', ref: '1.0.1', content }, { userId: sa.id }, 'draft'),
      ),
    );
    expect(new Set(results.map((r) => r.post.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(
      await q(`SELECT 1 FROM events WHERE type='SocialPostSubmitted' AND payload->>'ref'='1.0.1'`),
    ).toHaveLength(1);
    expect(await q(`SELECT 1 FROM social_posts WHERE ref='1.0.1'`)).toHaveLength(1);
  });

  it('skips the share of a release the notes no longer know ("release page not available")', async () => {
    await cleanShares();
    await q(`UPDATE social_channels SET connected_at = now() - interval '1 hour'`);
    const id = await approved('1.0.2');
    const gone = mkdtempSync(join(tmpdir(), 'gone-'));
    writeFileSync(join(gone, 'CHANGELOG.md'), `# Changelog\n\n## [1.9.0] - ${today}\n\n### Added\n\n- x.\n`);
    useReleaseSource({ changelogPath: join(gone, 'CHANGELOG.md'), entriesDir: join(gone, 'none') });
    try {
      await socialTick(t.app.ctx);
    } finally {
      useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'entries') });
      rmSync(gone, { recursive: true, force: true });
    }
    expect(fake.calls).toHaveLength(0);
    expect((await shares(id)).map((r) => [r.status, r.error])).toEqual([
      ['skipped', 'release page not available'],
      ['skipped', 'release page not available'],
    ]);
  });

  it('never shares a draft or an in-review release post', async () => {
    await cleanShares();
    await q(`UPDATE social_channels SET connected_at = now() - interval '1 hour'`);
    await socialTick(t.app.ctx);
    expect(fake.calls).toHaveLength(0);
    const open = await q(`SELECT id FROM social_posts WHERE status IN ('draft','in_review')`);
    expect(open.length).toBeGreaterThan(0);
    for (const p of open) expect(await shares(p.id)).toHaveLength(0);
  });

  it("demotes headings inside What's New bodies and keeps heading ids unique", async () => {
    const page = (await get('/releases/1.9.0')).body;
    expect(page).toContain('<h3>Overview a</h3>');
    expect(page).toContain(`<h4 id="${today}-overview-a-overview">Overview</h4>`);
    const ids = [...page.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page).not.toMatch(/<h2 id="overview/);
  });

  it('answers an over-long version with the HTML 404 page', async () => {
    const r = await get(`/releases/${'1'.repeat(50)}`);
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('keeps an approved post as it is when a stray revision arrives, also after a rebuild', async () => {
    const approvedRow = (await q(`SELECT id, content FROM social_posts WHERE status='approved' LIMIT 1`))[0];
    if (!approvedRow) throw new Error('no approved post');
    await t.app.ctx.store.append([
      {
        streamId: `social-post-${approvedRow.id}`,
        event: {
          type: 'SocialPostRevised',
          payload: {
            postId: approvedRow.id,
            content: { ...approvedRow.content, title: 'A stray title after approval' },
            by: { userId: sa.id },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: { orgId: null, projectId: null, audience: 'admin' },
      },
    ]);
    const snapshot = () => q('SELECT id, ref, title, status, content FROM social_posts ORDER BY ref');
    const before = await snapshot();
    expect(before.find((r) => r.id === approvedRow.id)?.title).not.toBe('A stray title after approval');
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await snapshot()).toEqual(before);
  });

  it('migration 2720 runs twice on a database that already has share rows', async () => {
    const sql = readFileSync(new URL('../migrations/2720_social_posts.sql', import.meta.url), 'utf8');
    const old = '99999999-9999-4999-8999-999999999999';
    await q(
      `INSERT INTO social_shares (post_id, network, status, attempts, created_at, updated_at)
       VALUES ($1,'facebook','sent',1,now(),now()) ON CONFLICT DO NOTHING`,
      [old],
    );
    await q(sql);
    await q(sql);
    expect((await q('SELECT source FROM social_shares WHERE post_id=$1', [old]))[0]?.source).toBe('blog');
    await expect(q(`UPDATE social_shares SET source='nope' WHERE post_id=$1`, [old])).rejects.toThrow();
    expect(await q(`SELECT 1 FROM pg_constraint WHERE conname='blog_writer_runs_kind_check'`)).toHaveLength(
      1,
    );
    await q('DELETE FROM social_shares WHERE post_id=$1', [old]);
  });

  it('answers every platform route with 404 to anonymous callers and ordinary users', async () => {
    const user = await t.userSession(`plain-${Math.random().toString(36).slice(2, 8)}@example.test`);
    const id = '11111111-1111-4111-8111-111111111111';
    const routes: Array<[string, string, unknown?]> = [
      ['GET', '/api/platform/social/releases'],
      ['POST', '/api/platform/social/posts', { kind: 'release', ref: '1.9.0' }],
      ['GET', `/api/platform/social/posts/${id}`],
      ['PATCH', `/api/platform/social/posts/${id}`, { title: 'A new title here' }],
      ['POST', `/api/platform/social/posts/${id}/submit`],
      ['POST', `/api/platform/social/posts/${id}/approve`],
      ['POST', `/api/platform/social/posts/${id}/reject`, { reason: 'no' }],
    ];
    for (const [method, url, body] of routes) {
      const anon = await t.req(method as 'GET', url, body ? { body } : {});
      expect(anon.status, `anonymous ${method} ${url}`).toBe(404);
      const r = await t.req(method as 'GET', url, { cookie: user.cookie, ...(body ? { body } : {}) });
      expect(r.status, `user ${method} ${url}`).toBe(404);
    }
  });
});
