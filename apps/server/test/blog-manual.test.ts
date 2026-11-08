import { randomBytes } from 'node:crypto';
import { BLOG_IMAGE } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { bearer, blogContent, makeKey } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
let n = 0;
const slug = (p = 'manual') => `${p}-${++n}-${Math.random().toString(36).slice(2, 6)}`;

const get = (url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, headers });

const manual = (over: Record<string, unknown> = {}) => ({
  title: `My own article ${n}`,
  summary: 'A short summary of the article that is long enough.',
  bodyMarkdown: 'Hello **world**.',
  tags: [],
  ...over,
});
const create = (body: Record<string, unknown>, cookie = sa.cookie) =>
  t.req('POST', '/api/platform/blog/manual', { cookie, body });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(40)]);
const upload = (id: string, bytes: Buffer, cookie?: string, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/api/platform/blog/posts/${id}/images`,
    headers: {
      origin: 'http://aom.test',
      'content-type': 'application/octet-stream',
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    payload: bytes,
  });

beforeAll(async () => {
  t = await createTestApp();
  sa = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('manual posts: create and update', () => {
  it('creates a draft with origin manual, the given author and tags, and makes the slug from the title', async () => {
    const s = slug();
    const p = await ok(
      create(manual({ slug: s, authorName: 'Pieter J', tags: ['how-to', 'automation'] })),
      201,
    );
    expect(p).toMatchObject({
      status: 'draft',
      originKind: 'manual',
      authorName: 'Pieter J',
      slug: s,
      tags: ['how-to', 'automation'],
      sources: [],
    });
    const auto = await ok(create(manual({ title: 'Café déjà vu: a Title!!' })), 201);
    expect(auto.slug).toBe('cafe-deja-vu-a-title');
    expect(auto.tags).toEqual([]);
    expect(auto.authorName).toBeTruthy(); // the signed-in user's name
    const list = await ok(t.req('GET', '/api/platform/blog?origin=manual', { cookie: sa.cookie }));
    expect(list.posts.map((x: any) => x.id)).toContain(p.id);
    expect(list.posts.every((x: any) => x.originKind === 'manual')).toBe(true);
    const writer = await ok(t.req('GET', '/api/platform/blog?origin=writer', { cookie: sa.cookie }));
    expect(writer.posts.map((x: any) => x.id)).not.toContain(p.id);
    // a draft is not public anywhere
    expect((await get(`/blog/${s}`)).statusCode).toBe(404);
    expect((await get('/blog/rss.xml')).body).not.toContain(s);
    expect((await get('/sitemap.xml')).body).not.toContain(s);
  });

  it('refuses a slug used by a writer post or a manual post and stores nothing', async () => {
    const k = await makeKey(t, sa.cookie, ['blog:write']);
    const ws = slug('writer');
    const w = await t.req('POST', '/api/v1/blog/posts', { headers: bearer(k.secret), body: blogContent(ws) });
    expect(w.status).toBe(201);
    const before = (await q('SELECT count(*)::int AS c FROM blog_posts'))[0]?.c;
    const r = await create(manual({ slug: ws }));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('slug_taken');
    const ms = slug();
    await ok(create(manual({ slug: ms })), 201);
    expect((await create(manual({ slug: ms }))).status).toBe(409);
    expect((await q('SELECT count(*)::int AS c FROM blog_posts'))[0]?.c).toBe(before + 1);
    // update to a taken slug while still a draft
    const other = await ok(create(manual({ slug: slug() })), 201);
    const u = await t.req('PUT', `/api/platform/blog/manual/${other.id}`, {
      cookie: sa.cookie,
      body: manual({ slug: ms }),
    });
    expect(u.status).toBe(409);
    expect(u.body.error.code).toBe('slug_taken');
  });

  it('validates the fields', async () => {
    expect((await create(manual({ title: 'ab' }))).status).toBe(400);
    expect((await create(manual({ summary: 'short' }))).status).toBe(400);
    expect((await create(manual({ bodyMarkdown: '' }))).status).toBe(400);
    expect((await create(manual({ tags: ['not-a-tag'] }))).status).toBe(400);
    expect((await create(manual({ slug: 'Bad Slug' }))).status).toBe(400);
    expect((await create(manual({ tags: ['how-to', 'how-to'] }))).status).toBe(400);
  });

  it('updates a draft, allows a slug change before the first publish and locks it after', async () => {
    const s = slug();
    const p = await ok(create(manual({ slug: s })), 201);
    const put = (id: string, body: unknown) =>
      t.req('PUT', `/api/platform/blog/manual/${id}`, { cookie: sa.cookie, body });
    const u = await ok(put(p.id, manual({ slug: `${s}-b`, title: 'A new title', authorName: 'Someone' })));
    expect(u).toMatchObject({
      originKind: 'manual',
      slug: `${s}-b`,
      title: 'A new title',
      authorName: 'Someone',
    });
    await ok(t.req('POST', `/api/platform/blog/posts/${p.id}/publish`, { cookie: sa.cookie }));
    const locked = await put(p.id, manual({ slug: `${s}-c` }));
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('slug_locked');
    // an edit under the same slug keeps the status and the URL
    const e = await ok(put(p.id, manual({ slug: `${s}-b`, bodyMarkdown: 'Edited body.' })));
    expect(e.status).toBe('published');
    expect((await get(`/blog/${s}-b`)).body).toContain('Edited body.');
    // writer posts cannot be edited through the manual route
    const k = await makeKey(t, sa.cookie, ['blog:write']);
    const w = await t.req('POST', '/api/v1/blog/posts', {
      headers: bearer(k.secret),
      body: blogContent(slug('w')),
    });
    expect((await put(w.body.id, manual())).status).toBe(404);
  });
});

describe('manual posts: public pages', () => {
  it('shows a published post with its author, mixed by date with writer posts, and hides it after unpublish', async () => {
    const k = await makeKey(t, sa.cookie, ['blog:write']);
    const ws = slug('writer');
    const w = await t.req('POST', '/api/v1/blog/posts', { headers: bearer(k.secret), body: blogContent(ws) });
    await ok(t.req('POST', `/api/platform/blog/posts/${w.body.id}/publish`, { cookie: sa.cookie }));
    const ms = slug();
    const p = await ok(
      create(
        manual({
          slug: ms,
          title: 'Human wrote this one',
          authorName: 'Ann <b>Author</b>',
          tags: ['how-to'],
        }),
      ),
      201,
    );
    await ok(t.req('POST', `/api/platform/blog/posts/${p.id}/publish`, { cookie: sa.cookie }));

    const list = await get('/blog');
    expect(list.body.indexOf('Human wrote this one')).toBeGreaterThan(-1);
    // newest first: the manual post was published after the writer post
    expect(list.body.indexOf('Human wrote this one')).toBeLessThan(list.body.indexOf(ws));
    expect(list.body).toContain('Ann &lt;b&gt;Author&lt;/b&gt;');

    const page = await get(`/blog/${ms}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Ann &lt;b&gt;Author&lt;/b&gt;');
    expect(page.body).not.toContain('written by an AI agent');
    expect(page.body).toContain('"@type":"Person"');
    expect(page.body).toContain('<strong>world</strong>');

    const writerPage = await get(`/blog/${ws}`);
    expect(writerPage.body).toContain('The Guildwise HQ team');
    expect(writerPage.body).toContain('written by an AI agent');
    expect(writerPage.body).toContain('"@type":"Organization"');

    expect((await get('/blog/rss.xml')).body).toContain(`/blog/${ms}`);
    expect((await get('/blog/rss.xml')).body).toContain('Ann &lt;b&gt;Author&lt;/b&gt;');
    expect((await get('/sitemap.xml')).body).toContain(`/blog/${ms}</loc>`);

    // the JSON of Help > Blog: the manual post carries origin and author, writer posts neither
    const u = await t.userSession(uniqueEmail('reader'));
    const json = await ok(t.req('GET', '/api/blog/posts?limit=100', { cookie: u.cookie }));
    const mine = json.posts.find((x: any) => x.slug === ms);
    expect(mine).toMatchObject({ origin: 'manual', author: 'Ann <b>Author</b>' });
    const theirs = json.posts.find((x: any) => x.slug === ws);
    expect(theirs).not.toHaveProperty('origin');
    expect(theirs).not.toHaveProperty('author');
    const full = await ok(t.req('GET', `/api/blog/posts/${ws}`, { cookie: u.cookie }));
    expect(full.post?.author ?? full.author).toBe('The Guildwise HQ team');

    // unpublish: back to a draft, the URL is 404 (not 410), gone from every list, can be published again
    const un = await ok(t.req('POST', `/api/platform/blog/posts/${p.id}/unpublish`, { cookie: sa.cookie }));
    expect(un.status).toBe('draft');
    expect((await get(`/blog/${ms}`)).statusCode).toBe(404);
    expect((await get('/blog')).body).not.toContain('Human wrote this one');
    expect((await get('/blog/rss.xml')).body).not.toContain(`/blog/${ms}`);
    expect((await get('/sitemap.xml')).body).not.toContain(`/blog/${ms}</loc>`);
    const adminList = await ok(t.req('GET', '/api/platform/blog?origin=manual', { cookie: sa.cookie }));
    expect(adminList.posts.find((x: any) => x.id === p.id).status).toBe('draft');
    await ok(t.req('POST', `/api/platform/blog/posts/${p.id}/publish`, { cookie: sa.cookie }));
    expect((await get(`/blog/${ms}`)).statusCode).toBe(200);

    // a writer post is still unpublished (410)
    await ok(t.req('POST', `/api/platform/blog/posts/${w.body.id}/unpublish`, { cookie: sa.cookie }));
    expect((await get(`/blog/${ws}`)).statusCode).toBe(410);
  });
});

describe('manual posts: access', () => {
  it('refuses anonymous callers, other users and API keys on every manual route', async () => {
    const p = await ok(create(manual({ slug: slug() })), 201);
    const plain = await t.userSession(uniqueEmail('plain'));
    const k = await makeKey(t, sa.cookie, ['blog:write', 'blog:publish']);
    const callers: Array<{ cookie?: string; headers?: Record<string, string> }> = [
      {},
      { cookie: plain.cookie },
      { headers: bearer(k.secret) },
    ];
    for (const c of callers) {
      const o = { ...c, body: manual({ slug: slug() }) };
      expect((await t.req('POST', '/api/platform/blog/manual', o)).status).toBe(404);
      expect((await t.req('PUT', `/api/platform/blog/manual/${p.id}`, o)).status).toBe(404);
      expect((await t.req('POST', `/api/platform/blog/posts/${p.id}/publish`, c)).status).toBe(404);
      expect((await t.req('POST', `/api/platform/blog/posts/${p.id}/unpublish`, c)).status).toBe(404);
      expect((await upload(p.id, PNG, c.cookie, c.headers)).statusCode).toBe(404);
    }
    expect((await q('SELECT count(*)::int AS c FROM blog_images WHERE post_id=$1', [p.id]))[0]?.c).toBe(0);
  });

  it('keeps the writer API away from manual posts and out of the post cap', async () => {
    const key = await makeKey(t, sa.cookie, ['blog:write', 'blog:publish']);
    const s = slug();
    const p = await ok(create(manual({ slug: s })), 201);
    const patch = await t.req('PATCH', `/api/v1/blog/posts/${s}`, {
      headers: bearer(key.secret),
      body: { title: 'Taken over by the writer' },
    });
    expect(patch.status).toBe(404);
    const pub = await t.req('POST', `/api/v1/blog/posts/${s}/publish`, { headers: bearer(key.secret) });
    expect(pub.status).toBe(404);
    // a writer POST with a manual post's slug is a conflict, even with the same text
    const clash = await t.req('POST', '/api/v1/blog/posts', {
      headers: bearer(key.secret),
      body: blogContent(s),
    });
    expect(clash.status).toBe(409);
    // the cap counts the key's own API posts only (a fresh key: the writes above count to the hourly write limit)
    const capKey = await makeKey(t, sa.cookie, ['blog:write']);
    for (let i = 0; i < 3; i++) await ok(create(manual({ slug: slug() })), 201);
    let created = 0;
    for (let i = 0; i < 9; i++) {
      const r = await t.req('POST', '/api/v1/blog/posts', {
        headers: bearer(capKey.secret),
        body: blogContent(slug('cap')),
      });
      if (r.status === 201) created++;
    }
    expect(created).toBe(8);
    const row = (await q('SELECT title FROM blog_posts WHERE id=$1', [p.id]))[0];
    expect(row?.title).not.toContain('Taken over');
  });
});

describe('manual posts: images', () => {
  it('stores an allowed image, serves it only while published (or to a super admin) and refuses bad files', async () => {
    const p = await ok(create(manual({ slug: slug() })), 201);
    const r = await upload(p.id, PNG, sa.cookie);
    expect(r.body).toContain('url');
    expect(r.statusCode).toBe(201);
    const img = JSON.parse(r.body);
    expect(img.url).toMatch(/^\/blog\/media\/[0-9a-f-]{36}\.png$/);
    expect(img.markdown).toBe(`![](${img.url})`);
    expect(img.contentType).toBe('image/png');

    // a draft's image: not public, visible to the super admin
    expect((await get(img.url)).statusCode).toBe(404);
    const mine = await get(img.url, { cookie: sa.cookie });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('image/png');

    // the markdown renders as an image in the public page once published
    await ok(
      t.req('PUT', `/api/platform/blog/manual/${p.id}`, {
        cookie: sa.cookie,
        body: manual({ slug: p.slug, bodyMarkdown: `Before\n\n${img.markdown}\n\nAfter` }),
      }),
    );
    await ok(t.req('POST', `/api/platform/blog/posts/${p.id}/publish`, { cookie: sa.cookie }));
    const pub = await get(img.url);
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/png');
    expect(pub.headers['x-content-type-options']).toBe('nosniff');
    expect(pub.rawPayload.equals(PNG)).toBe(true);
    expect((await get(`/blog/${p.slug}`)).body).toContain(`<img src="${img.url}" alt="" loading="lazy">`);
    expect((await get('/blog/rss.xml')).body).toContain(`http://aom.test${img.url}`);

    await ok(t.req('POST', `/api/platform/blog/posts/${p.id}/unpublish`, { cookie: sa.cookie }));
    expect((await get(img.url)).statusCode).toBe(404);

    // other types
    const kinds: Array<[string, Buffer, string]> = [
      ['jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg'],
      ['gif', Buffer.from('GIF89a......'), 'image/gif'],
      ['webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]), 'image/webp'],
    ];
    for (const [ext, bytes, type] of kinds) {
      const up = await upload(p.id, bytes, sa.cookie);
      expect(up.statusCode).toBe(201);
      expect(JSON.parse(up.body)).toMatchObject({ contentType: type });
      expect(JSON.parse(up.body).url.endsWith(`.${ext}`)).toBe(true);
    }
    // not an image, whatever its name or header says
    const pdf = await upload(p.id, Buffer.from('%PDF-1.4 hello'), sa.cookie, { 'content-type': 'image/png' });
    expect(pdf.statusCode).toBe(415);
    expect(JSON.parse(pdf.body).error.code).toBe('unsupported_image');
    const svg = await upload(p.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), sa.cookie);
    expect(svg.statusCode).toBe(415);
    // too large
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(BLOG_IMAGE.maxBytes)]);
    const tooBig = await upload(p.id, big, sa.cookie);
    expect(tooBig.statusCode).toBe(413);
    // far beyond the limit: refused by the server before the route runs
    const huge = await upload(
      p.id,
      Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(BLOG_IMAGE.maxBytes + 4096)]),
      sa.cookie,
    );
    expect(huge.statusCode).toBe(413);
    // images belong to manual posts only
    const k = await makeKey(t, sa.cookie, ['blog:write']);
    const w = await t.req('POST', '/api/v1/blog/posts', {
      headers: bearer(k.secret),
      body: blogContent(slug('w')),
    });
    expect((await upload(w.body.id, PNG, sa.cookie)).statusCode).toBe(404);
  });
});

describe('manual posts: migration', () => {
  it('gives every post written by the writer origin kind writer and no author name', async () => {
    const k = await makeKey(t, sa.cookie, ['blog:write']);
    const w = await t.req('POST', '/api/v1/blog/posts', {
      headers: bearer(k.secret),
      body: blogContent(slug('w')),
    });
    const row = (await q('SELECT origin_kind, author_name FROM blog_posts WHERE id=$1', [w.body.id]))[0];
    expect(row).toMatchObject({ origin_kind: 'writer', author_name: null });
    expect(
      (await q(`SELECT count(*)::int AS c FROM blog_posts WHERE origin_kind NOT IN ('writer','manual')`))[0]
        ?.c,
    ).toBe(0);
  });
});
