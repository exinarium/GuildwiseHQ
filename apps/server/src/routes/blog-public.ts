import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOG_TAG_KEYS,
  type BlogContent,
  DigestPreferenceSchema,
  SetDigestPreferenceRequestSchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSession, requireUser } from '../auth/guards.ts';
import { getRelease, loadReleases } from '../blog/releases.ts';
import {
  EMBED_MARK,
  listPage,
  messagePage,
  postPage,
  releasePage,
  releasesIndexPage,
  rssFeed,
  sitemap,
} from '../blog/render.ts';
import {
  blogEnabled,
  getPublished,
  lastPublishedChange,
  listPublished,
  listPublishedFull,
  postsCount,
  publishedTags,
} from '../commands/blog.ts';
import { digestPreference, setDigestPreference, userOfUnsubscribeToken } from '../commands/blog-digest.ts';
import { embedsVersion, publicVideoEmbed } from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

const PER_PAGE = 12;
const CACHE_CONTROL = 'public, max-age=300';

/**
 * The public blog: `/blog`, `/blog/:slug`, `/blog/tag/:tag`, the RSS feed, the
 * sitemap and robots.txt, rendered by the server per request and cached in memory. The cache key carries a version
 * (post count and latest change), so a publish or an unpublish shows at once without an invalidation hook.
 */
export function blogPublicRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const origin = ctx.config.publicOrigin;
    const cache = new Map<string, { version: string; body: string }>();

    async function version(): Promise<string> {
      const t = await lastPublishedChange(ctx);
      const n = await postsCount(ctx);
      const rel = loadReleases(ctx);
      return `${n}:${t?.getTime() ?? 0}:${rel.length}:${rel[0]?.version ?? ''}:${await embedsVersion(ctx)}`;
    }

    /** Renders through the cache and answers with the validators a browser or crawler can reuse. */
    async function serve(
      req: FastifyRequest,
      reply: FastifyReply,
      key: string,
      type: string,
      render: () => Promise<string>,
      status = 200,
    ) {
      const v = await version();
      let hit = cache.get(key);
      if (!hit || hit.version !== v) {
        hit = { version: v, body: await render() };
        if (status === 200) cache.set(key, hit);
        if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      }
      // a page with a YouTube embed may frame youtube-nocookie.com (the onSend hook of app.ts widens frame-src)
      if (hit.body.includes(EMBED_MARK))
        void reply.header('x-aom-frame-src', 'https://www.youtube-nocookie.com');
      const etag = `"${createHash('sha1').update(hit.body).digest('base64url')}"`;
      void reply
        .header('content-type', type)
        .header('cache-control', status === 200 ? CACHE_CONTROL : 'no-cache');
      if (status === 200) {
        void reply.header('etag', etag);
        if (req.headers['if-none-match'] === etag) return reply.code(304).send();
      }
      return reply.code(status).send(hit.body);
    }

    const HTML = 'text/html; charset=utf-8';

    app.get(
      '/blog',
      { schema: { querystring: z.object({ page: z.coerce.number().int().min(1).max(500).default(1) }) } },
      async (req, reply) => {
        const page = req.query.page;
        return serve(req, reply, `list:${page}`, HTML, async () => {
          const r = await listPublished(ctx, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
          return listPage(origin, { ...r, page, perPage: PER_PAGE });
        });
      },
    );

    app.get(
      '/blog/tag/:tag',
      {
        schema: {
          params: z.object({ tag: z.string().max(40) }),
          querystring: z.object({ page: z.coerce.number().int().min(1).max(500).default(1) }),
        },
      },
      async (req, reply) => {
        const { tag } = req.params;
        if (!BLOG_TAG_KEYS.includes(tag))
          return reply
            .code(404)
            .type(HTML)
            .send(messagePage(origin, 'Not found', 'There is no such topic.'));
        const page = req.query.page;
        return serve(req, reply, `tag:${tag}:${page}`, HTML, async () => {
          const r = await listPublished(ctx, { tag, limit: PER_PAGE, offset: (page - 1) * PER_PAGE });
          return listPage(origin, { ...r, page, perPage: PER_PAGE, tag });
        });
      },
    );

    app.get('/blog/rss.xml', async (req, reply) =>
      serve(req, reply, 'rss', 'application/rss+xml; charset=utf-8', async () =>
        rssFeed(origin, await listPublishedFull(ctx, 30)),
      ),
    );

    app.get('/sitemap.xml', async (req, reply) =>
      serve(req, reply, 'sitemap', 'application/xml; charset=utf-8', async () => {
        const posts = (await listPublished(ctx, { limit: 5000 })).posts;
        return sitemap(
          origin,
          posts,
          (await publishedTags(ctx)).map((t) => t.tag),
          // pages an extension builds into the web dist and wants indexed (the hosted pricing page)
          ctx.ext.list.flatMap((e) => (e.publicPages ?? []).filter((pg) => pg.sitemap).map((pg) => pg.route)),
          (await blogEnabled(ctx)) ? loadReleases(ctx) : [],
        );
      }),
    );

    app.get('/robots.txt', async (_req, reply) => {
      void reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', CACHE_CONTROL);
      return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /platform\n\nSitemap: ${origin}/sitemap.xml\n`;
    });

    app.get(
      '/blog/:slug',
      { schema: { params: z.object({ slug: z.string().max(100) }) } },
      async (req, reply) => {
        const { slug } = req.params;
        const found = await getPublished(ctx, slug);
        if (found === 'gone')
          return reply
            .code(410)
            .type(HTML)
            .send(
              messagePage(
                origin,
                'This article was removed',
                'The article you are looking for is no longer available.',
              ),
            );
        if (!found)
          return reply
            .code(404)
            .type(HTML)
            .send(messagePage(origin, 'Not found', 'We could not find that article.'));
        return serve(req, reply, `post:${slug}`, HTML, async () => {
          const again = await getPublished(ctx, slug);
          if (!again || again === 'gone')
            return messagePage(origin, 'Not found', 'We could not find that article.');
          const c = again.row.content as BlogContent;
          return postPage(
            origin,
            again.post,
            c.seo,
            c.aiDisclosure,
            await publicVideoEmbed(ctx, 'article', slug),
          );
        });
      },
    );

    // ---- releases: own pages on our own domain (the link target of release posts). They follow the blog's kill switch.
    const releasesOff = (reply: FastifyReply) =>
      reply
        .code(404)
        .type(HTML)
        .send(messagePage(origin, 'Not found', 'There is nothing here.'));

    app.get('/releases', async (req, reply) => {
      if (!(await blogEnabled(ctx))) return releasesOff(reply);
      return serve(req, reply, 'releases', HTML, async () => releasesIndexPage(origin, loadReleases(ctx)));
    });
    app.get(
      '/releases/:version',
      { schema: { params: z.object({ version: z.string() }) } },
      async (req, reply) => {
        if (!(await blogEnabled(ctx))) return releasesOff(reply);
        const r = /^\d+\.\d+\.\d+$/.test(req.params.version)
          ? getRelease(req.params.version, ctx)
          : undefined;
        if (!r)
          return reply
            .code(404)
            .type(HTML)
            .send(messagePage(origin, 'Not found', 'We could not find that release.'));
        return serve(req, reply, `release:${r.version}`, HTML, async () =>
          releasePage(origin, r, await publicVideoEmbed(ctx, 'release', r.version)),
        );
      },
    );

    // The default covers. With the web build served (production) the static plugin serves them from dist/blog/cover;
    // otherwise (dev, tests) they come straight from apps/web/public.
    if (!ctx.config.serveWeb) {
      const here = dirname(fileURLToPath(import.meta.url));
      const dir = [
        join(here, '../../../web/public/blog/cover'),
        join(here, '../../web/public/blog/cover'),
      ].find((d) => existsSync(d));
      app.get(
        '/blog/cover/:file',
        { schema: { params: z.object({ file: z.string().regex(/^[a-z-]+\.png$/) }) } },
        async (req, reply) => {
          const file = dir ? join(dir, req.params.file) : null;
          if (!file || !existsSync(file)) return reply.code(404).send();
          void reply.header('cache-control', 'public, max-age=86400');
          return reply.type('image/png').send(readFileSync(file));
        },
      );
    }

    // ---- JSON for Help > Blog (any signed-in person, platform accounts included)
    app.get(
      '/api/blog/posts',
      {
        schema: {
          querystring: z.object({
            q: z.string().max(100).optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          }),
        },
      },
      async (req) => {
        await requireSession(ctx, req);
        return listPublished(ctx, { limit: req.query.limit, q: req.query.q });
      },
    );
    app.get(
      '/api/blog/posts/:slug',
      { schema: { params: z.object({ slug: z.string().max(100) }) } },
      async (req) => {
        await requireSession(ctx, req);
        const found = await getPublished(ctx, req.params.slug);
        if (!found || found === 'gone') throw notFound('article not found');
        return found.post;
      },
    );

    // ---- the digest preference of the signed-in person (Settings)
    app.get('/api/me/blog-digest', { schema: { response: { 200: DigestPreferenceSchema } } }, async (req) => {
      const s = await requireUser(ctx, req);
      return digestPreference(ctx, s.user.id);
    });
    app.put(
      '/api/me/blog-digest',
      { schema: { body: SetDigestPreferenceRequestSchema, response: { 200: DigestPreferenceSchema } } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setDigestPreference(ctx, s.user.id, req.body.optedIn, 'settings');
        return digestPreference(ctx, s.user.id);
      },
    );

    // ---- unsubscribe (signed token, no sign-in). Opening the link (GET) only shows a confirm page: mail scanners and
    // link previews open links, so a GET must never change anything. The POST unsubscribes: the page's confirm button
    // sends it, and mail programs send the RFC 8058 one-click POST (`List-Unsubscribe=One-Click`) to the same URL.
    const tokenParams = z.object({ token: z.string().min(10).max(300) });
    const limit = ctx.config.rateLimit ? { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } } : {};
    const resubscribeForm = (token: string) =>
      `<form class="inline" method="post" action="/blog/unsubscribe/${encodeURIComponent(token)}/resubscribe"><button type="submit">Subscribe again</button></form>`;

    const confirmForm = (token: string) =>
      `<form class="inline" method="post" action="/blog/unsubscribe/${encodeURIComponent(token)}"><input type="hidden" name="confirm" value="1"><button type="submit">Unsubscribe from the weekly digest</button></form> <a href="/blog" style="margin-left:12px">Keep me subscribed</a>`;

    app.get('/blog/unsubscribe/:token', { schema: { params: tokenParams }, ...limit }, async (req, reply) => {
      const userId = await userOfUnsubscribeToken(ctx, req.params.token);
      if (!userId || !(await one(ctx.pool, 'SELECT 1 FROM users WHERE id=$1', [userId])))
        return reply
          .code(400)
          .type(HTML)
          .send(messagePage(origin, 'Link not valid', 'This unsubscribe link is not valid.'));
      void reply.header('cache-control', 'no-store');
      return reply
        .type(HTML)
        .send(
          messagePage(
            origin,
            'Unsubscribe from the weekly digest?',
            'Confirm below and you will not get the weekly blog digest any more. You can change this any time in your settings.',
            confirmForm(req.params.token),
          ),
        );
    });
    app.post(
      '/blog/unsubscribe/:token',
      { schema: { params: tokenParams }, ...limit },
      async (req, reply) => {
        const userId = await userOfUnsubscribeToken(ctx, req.params.token);
        // The confirm button of the page sends `confirm=1` and gets a page back; a mail program's one-click POST
        // (`List-Unsubscribe=One-Click`) gets plain text.
        const fromPage = typeof req.body === 'string' && /(^|&)confirm=1(&|$)/.test(req.body);
        if (!userId)
          return fromPage
            ? reply
                .code(400)
                .type(HTML)
                .send(messagePage(origin, 'Link not valid', 'This unsubscribe link is not valid.'))
            : reply.code(400).type('text/plain').send('invalid link');
        await setDigestPreference(ctx, userId, false, 'link');
        void reply.header('cache-control', 'no-store');
        if (!fromPage) return reply.type('text/plain').send('unsubscribed');
        return reply
          .type(HTML)
          .send(
            messagePage(
              origin,
              'You are unsubscribed',
              'You will not get the weekly blog digest any more. You can change this any time in your settings.',
              resubscribeForm(req.params.token),
            ),
          );
      },
    );
    app.post(
      '/blog/unsubscribe/:token/resubscribe',
      { schema: { params: tokenParams }, ...limit },
      async (req, reply) => {
        const userId = await userOfUnsubscribeToken(ctx, req.params.token);
        if (!userId)
          return reply
            .code(400)
            .type(HTML)
            .send(messagePage(origin, 'Link not valid', 'This link is not valid.'));
        await setDigestPreference(ctx, userId, true, 'link');
        return reply
          .type(HTML)
          .send(messagePage(origin, 'Welcome back', 'You will get the weekly blog digest again.'));
      },
    );
  };
}
