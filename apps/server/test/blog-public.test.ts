import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { bearer, blogContent, makeKey } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let sa: { id: string; email: string; cookie: string };

async function publish(slug: string, over = {}) {
  const k = await makeKey(t, sa.cookie, ['blog:write']);
  const c = blogContent(slug, over);
  const r = await t.req('POST', '/api/v1/blog/posts', { headers: bearer(k.secret), body: c });
  expect(r.status).toBe(201);
  await ok(t.req('POST', `/api/platform/blog/posts/${r.body.id}/publish`, { cookie: sa.cookie }));
  return { id: r.body.id as string, c };
}
const get = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  t = await createTestApp();
  sa = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('public pages', () => {
  it('lists, renders posts with SEO tags, tag pages, RSS and sitemap; unpublished is 410, unknown 404', async () => {
    const a = await publish('alpha-agents', { tags: ['ai-agents', 'how-to'] });
    const b = await publish('beta-automation', { tags: ['automation'] });

    const list = await get('/blog');
    expect(list.statusCode).toBe(200);
    expect(list.headers['content-type']).toContain('text/html');
    expect(list.headers['cache-control']).toContain('max-age');
    expect(list.body).toContain(a.c.title);
    expect(list.body).toContain(b.c.title);

    const post = await get('/blog/alpha-agents');
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain('<link rel="canonical" href="http://aom.test/blog/alpha-agents">');
    expect(post.body).toContain('property="og:type" content="article"');
    expect(post.body).toContain('property="og:image" content="http://aom.test/blog/cover/ai-agents.png"');
    expect(post.body).toContain('name="twitter:card" content="summary_large_image"');
    expect(post.body).toContain('application/ld+json');
    expect(post.body).toContain('The Guildwise HQ team');
    expect(post.body).toContain('written by an AI agent');
    expect(post.body).toContain('rel="nofollow noopener noreferrer"');
    expect(post.body).not.toMatch(/<script(?![^>]*ld\+json)/);

    const tag = await get('/blog/tag/automation');
    expect(tag.body).toContain(b.c.title);
    expect(tag.body).not.toContain(a.c.title);
    expect((await get('/blog/tag/unknown-tag')).statusCode).toBe(404);

    const rss = await get('/blog/rss.xml');
    expect(rss.headers['content-type']).toContain('application/rss+xml');
    expect(rss.body).toContain('<item>');
    expect(rss.body).toContain('http://aom.test/blog/alpha-agents');

    const map = await get('/sitemap.xml');
    expect(map.body).toContain('<loc>http://aom.test/blog/beta-automation</loc>');
    expect(map.body).toContain('<loc>http://aom.test/blog</loc>');
    expect(map.body).toContain('<loc>http://aom.test/contact</loc>');
    expect((await get('/robots.txt')).body).toContain('Sitemap: http://aom.test/sitemap.xml');

    expect((await get('/blog/does-not-exist')).statusCode).toBe(404);
    await ok(t.req('POST', `/api/platform/blog/posts/${a.id}/unpublish`, { cookie: sa.cookie }));
    expect((await get('/blog/alpha-agents')).statusCode).toBe(410);
    expect((await get('/blog')).body).not.toContain(a.c.title);
    expect((await get('/sitemap.xml')).body).not.toContain('alpha-agents');
    // a republish restores it
    await ok(t.req('POST', `/api/platform/blog/posts/${a.id}/publish`, { cookie: sa.cookie }));
    expect((await get('/blog/alpha-agents')).statusCode).toBe(200);
  });

  it('serves the default covers as PNG', async () => {
    const r = await get('/blog/cover/ai-agents.png');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect((await get('/blog/cover/nope.png')).statusCode).toBe(404);
  });

  it('answers a repeat request from the cache with an ETag', async () => {
    const first = await get('/blog');
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect((await get('/blog', { 'if-none-match': etag })).statusCode).toBe(304);
  });

  it('never renders raw HTML or script URLs from a post body', async () => {
    const evil = `${blogContent('x').bodyMarkdown}\n\n<script>alert(1)</script> <img src=x onerror=alert(2)>\n\n[bad](javascript:alert(3)) [ok](https://example.com/a?b=1&c=2)\n\n**bold** and \`<b>code</b>\``;
    await publish('evil-post', { bodyMarkdown: evil, title: 'A title with <b>markup</b> & "quotes"' });
    const page = (await get('/blog/evil-post')).body;
    expect(page).not.toContain('<script>alert');
    expect(page).not.toContain('<img src=x');
    expect(page).not.toContain('javascript:');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(page).toContain('&lt;b&gt;markup&lt;/b&gt; &amp; &quot;quotes&quot;');
    expect(page).toContain('<strong>bold</strong>');
  });

  it('serves the reader JSON to signed-in people only (Help > Blog)', async () => {
    expect((await t.req('GET', '/api/blog/posts')).status).toBe(401);
    const u = await t.userSession(uniqueEmail('reader'));
    const list = await ok(t.req('GET', '/api/blog/posts', { cookie: u.cookie }));
    expect(list.posts.length).toBeGreaterThan(0);
    const one = await ok(t.req('GET', `/api/blog/posts/${list.posts[0].slug}`, { cookie: u.cookie }));
    expect(one.bodyMarkdown).toBeTruthy();
    expect(one.author).toBe('The Guildwise HQ team');
    expect(await q('SELECT 1 FROM blog_posts')).not.toHaveLength(0);
  });
});
