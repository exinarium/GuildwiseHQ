# Hand-written blog articles next to the blog writer's posts (design)

## Question

The owner wants to write and publish his own articles on the platform blog, next to the articles the blog writer
produces: an authoring view in Platform > Blog (create, edit, preview, draft, publish, unpublish), a Markdown body with
uploaded images, title/slug/summary/tags/author, and the published articles in the same public listing, post page, RSS
feed, sitemap and Help > Blog. Super admin only. The writer's pipeline and the blog API contract must not change.

Open points from planning: where uploaded images live and how they are served; which publish follow-ups run for a
hand-written post; how the post cap and the API ownership check see manual posts; whether the two-factor check covers
the image upload.

## Findings

### Storage and commands (apps/server)

- `blog_posts` is a projection of the `BlogPost*` events (`apps/server/src/projections/blog.ts`). Schema:
  `migrations/1450_blog.sql`, `1560_blog_launch.sql` (`launch`), `1580_blog_writer.sql` (`origin_system`).
- A post already records WHO created it: `origin_key_id` (API key), `origin_user_id` (a super admin through
  `POST /api/platform/blog/posts`), `origin_system = 'blog-writer'` (the hosted writer in guildwise-cloud, which calls
  `submitPost(ctx, content, { system: 'blog-writer' }, 'in_review', { topicId })` and `getPost` directly from
  `@aom/server/commands/blog.ts`). `BlogPost.origin` (a string: key name, user name or "Blog writer") is shown in the
  admin list's "From" column.
  - `origin_user_id` cannot be used as "manual": the e2e seed (`e2e/video/help.spec.ts`) and any super admin may already
    have created posts through that route, and the card requires every existing post to be 'writer'. An explicit new
    column is needed.
- The existing `POST /api/platform/blog/posts` takes the full writer `BlogContentSchema` (body at least 1000 characters,
  summary at least 80, at least one tag, sources, AI disclosure) and creates a draft. It is used by the e2e video seed.
  `PATCH /posts/:id` (`EditBlogPostRequestSchema`) is the writer-post editor's save; slug is not editable there.
- `submitPost` answers an existing slug with identical title+body hash with the existing post (idempotent API retry).
- `unpublishPost` sets status `unpublished`; the public post URL then answers **410** (`getPublished` returns `gone`),
  asserted by `blog-public.test.ts` for writer posts.
- `publishPost` accepts `draft`, `in_review`, `unpublished`; keeps the first `published_at`.
- `blogSettings()` derives the writer's two-week review period from `min(created_at) WHERE NOT launch`: a manual post
  created first would start the writer's review clock.
- The public cache version (`blog-public.ts` `version()`) is `postsCount : max(updated_at) of published|unpublished`.

### Events (packages/shared/src/events/blog.ts)

`BlogPostSubmitted` and `BlogPostRevised` carry `content: BlogContentSchema`, and the store validates every appended
event (`pg-event-store.ts` `DomainEventSchema.parse`). Manual content with no tags or a short body would be refused by the
event schema itself, so the event content schema must accept the looser manual shape.

### Writer API (apps/server/src/routes/blog-api.ts)

- PATCH and publish already 404 unless `r.origin_key_id === key.id`. A manual post has no key, so the writer cannot touch
  it today; the design adds a second guard in the command.
- The 24 h post cap counts `blog_api_log.is_post` rows per key: manual posts never pass through the API, so they never
  count. Nothing to change; a test pins it.
- GET list/get show every **published** post plus the key's own posts. A published manual post therefore appears in a
  key's list like any published post (that is "behave exactly as before": published posts are visible to readers of the
  API, drafts are not).

### Rendering

- One restricted Markdown parser (`packages/shared/src/blog/markdown.ts`) feeds the server pages, RSS and the React
  `BlogBody`. It has **no image support**: `![alt](url)` renders today as the text `!` followed by a link. No raw HTML is
  ever produced.
- The app CSP is `img-src 'self' data:`: images must be same-origin.
- The public post page (`render.ts` `postPage`) prints `BLOG_AUTHOR` ("The Guildwise HQ team"), an Organization author
  in JSON-LD and the paragraph "This article was written by an AI agent ...". Help > Blog (`HelpBlog.tsx`) prints
  `p.author` and the same AI paragraph. Both must not claim AI authorship for a person's article.
- `PublicBlogPostSchema` and `BlogPostSchema` pick `tags` from `BlogContentSchema` (min 1). The web parses every response
  with these schemas (`apps/web/src/api/queries/blog.ts`): one post without tags would make Help > Blog and the admin
  list fail to load. They must be relaxed if manual posts may have zero tags.
- Tags are a fixed vocabulary (`BLOG_TAGS`, six keys) driving `/blog/tag/:tag` pages and the per-tag covers; free-text tags
  would produce dead tag links.

### Follow-ups on publish (all origin-agnostic, confirmed by reading)

| Follow-up | Selection | Works for a manual post? |
| --- | --- | --- |
| Public list, post page, tag pages, sitemap, RSS, Help > Blog | `status='published'` | Yes, once author/disclosure are handled |
| Weekly digest (`blog-digest.ts` l.136) | published, `NOT launch`, in the window | Yes: included; the mail shows title, summary, link only |
| Social sharing (`social.ts` `createMissingShares` l.303, `loadShareable` l.425) | published, `NOT launch`, fresh, channel connected | Yes: included; captions fall back to the summary (`captionFor`), image is the cover |
| Article videos (`video-posts.ts` `articlesNeedingVideo` l.1579, hosted drafter in guildwise-cloud `video.ts`) | published, `NOT launch` | Yes: a video draft is made and, like every video, waits for the owner's approval; it reads title/summary/tags/body only and copes with empty tags |
| Topic dedup (`topics.ts` l.81) | published titles | Yes: a manual post also counts as "already covered" (desirable) |
| Auto-publish (`autoPublishDue`) | `in_review` only | Never touches manual posts (they go draft → published) |

None of these read `origin_*`, `aiDisclosure` or `sources`. Decision: manual posts follow the existing behaviour for
published posts: they go into the digest, social sharing and the video queue. The kill switch (`blog_enabled = false`)
also blocks publishing a manual post (existing `publishPost` rule), which is the documented meaning of the switch.

### Image storage options

| Option | For | Against |
| --- | --- | --- |
| A. New operational table `blog_images` (bytea in Postgres), like `card_attachment_data` and documents | Pattern already used twice; backups and restores include it; no new service; access can follow the post's status | Bytes in the database (fine at 5 MB × a few images per article) |
| B. `storage-relay` | | Relays to a workstation's storage; GuildWise does not host user data there and the public site cannot depend on a workstation being online |
| C. Media container (`/videos`, `media-proxy.ts`) | Already serves public files | Separate service, read-only from the app's point of view, no upload path; optional in deployments |
| D. Files on the server's disk | Simple | Lost on redeploy of the container; no backup story |
| E. Public forms / inbound mail attachments | | Org-scoped, different lifecycle; not reusable as-is |

**Choice: A.** Images are stored in a new `blog_images` table (operational, not a projection, no foreign key to
`blog_posts`, so a projection rebuild never touches it), served at `/blog/media/<uuid>.<ext>` by the app server. Because
each image row knows its post, an image is served publicly **only while its post is published**; a super admin session
can see it at any time (for the preview). Names are server-generated UUIDs; the client's file name is ignored.

## Recommendation and design

Keep one posts table and one rendering path. Add an explicit origin kind and an author name to `blog_posts`, a
dedicated manual create/update pair of super-admin routes (the writer schema does not fit a hand-written post and the
existing create route is a contract used by the e2e seed), an image table with an upload route and a public media route,
and image support in the shared Markdown renderer that only accepts our own media URLs, so every existing writer post
renders byte-for-byte as before.

### Data model

New migration `apps/server/migrations/2860_blog_manual_posts.sql` (check the highest number on main when building and
take the next free one; never edit an applied migration). Additive and safe to run again:

```sql
-- Hand-written articles (origin_kind 'manual') next to the writer's posts. Set from BlogPostSubmitted.manual by the
-- projection, so a rebuild keeps it; every existing row becomes 'writer' through the default.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS origin_kind text NOT NULL DEFAULT 'writer';
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS author_name text;          -- the byline of a manual post; NULL for writer posts
DO $$ BEGIN
  ALTER TABLE blog_posts ADD CONSTRAINT blog_posts_origin_kind CHECK (origin_kind IN ('writer','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Images of hand-written articles. OPERATIONAL (like card_attachment_data): never in the event log, kept over a
-- projection rebuild, no foreign key to the projection table.
CREATE TABLE IF NOT EXISTS blog_images (
  id           uuid PRIMARY KEY,
  post_id      uuid NOT NULL,
  content_type text NOT NULL,       -- detected from the bytes: image/png, image/jpeg, image/webp, image/gif
  ext          text NOT NULL,       -- png | jpg | webp | gif
  size         integer NOT NULL,
  sha256       text NOT NULL,
  data         bytea NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS blog_images_post ON blog_images (post_id, created_at);
```

No data migration is needed: the column default fills existing rows with 'writer', nothing is rewritten.

### Shared (packages/shared)

`src/blog/constants.ts`:

```ts
/** Hand-written articles: looser than the writer's limits (a person's short note is fine), same maxima. */
export const MANUAL_POST_LIMITS = { titleMin: 3, summaryMin: 20, bodyMin: 1, authorMax: 80 } as const;
export const BLOG_IMAGE = {
  maxBytes: 5 * 1024 * 1024,
  perPost: 50,
  types: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' },
} as const;
/** The only image URL the blog Markdown renders: an uploaded blog image on this site. */
export const BLOG_IMAGE_SRC_RE =
  /^\/blog\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;
export const BLOG_ORIGIN_KINDS = ['writer', 'manual'] as const;
```

`src/blog/schema.ts`:

- `slugifyTitle(title)`: NFKD, strip diacritics, lowercase, runs of non `[a-z0-9]` → `-`, trim dashes, cut to 80 at a
  dash boundary; pad to 3 characters (`post-…`) if shorter. Used by the web form and by the server when `slug` is omitted.
- `ManualBlogContentSchema = BlogContentSchema.extend({ title: min 3 max 110, summary: min 20 max 300, bodyMarkdown:
  min 1 max 40000, tags: z.array(z.enum(BLOG_TAG_KEYS)).max(5) })` (min 0 tags). Text fields `.trim()`.

`src/api/blog.ts`:

- `BlogOriginKindSchema = z.enum(BLOG_ORIGIN_KINDS)`.
- `BlogPostSchema`: add `originKind: BlogOriginKindSchema`, `authorName: z.string().nullable()`, and override
  `tags: z.array(z.string()).max(BLOG_LIMITS.tagsMax)` (relaxed: manual posts may have none).
- `PublicBlogPostSchema`: override `tags: z.array(z.string())`, add `origin: z.literal('manual').optional()` and
  `author: z.string().optional()`. Both keys are **only present on manual posts**, so the JSON of writer posts is
  unchanged. `PublicBlogPostFullSchema` keeps `author: z.string()` (required, as today).
- `PlatformBlogQuerySchema`: add `origin: BlogOriginKindSchema.optional()`.
- New request schemas:

```ts
export const ManualPostRequestSchema = z.object({
  title: z.string().trim().min(MANUAL_POST_LIMITS.titleMin).max(BLOG_LIMITS.titleMax),
  slug: BlogSlugSchema.optional(),                // omitted: made from the title
  summary: z.string().trim().min(MANUAL_POST_LIMITS.summaryMin).max(BLOG_LIMITS.summaryMax),
  bodyMarkdown: z.string().min(MANUAL_POST_LIMITS.bodyMin).max(BLOG_LIMITS.bodyMax),
  tags: z.array(z.enum(BLOG_TAG_KEYS)).max(BLOG_LIMITS.tagsMax).default([]),
  authorName: z.string().trim().min(1).max(MANUAL_POST_LIMITS.authorMax)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'no control characters').optional(), // omitted: the signed-in name
  coverImage: z.object({ defaultKey: z.enum(BLOG_COVER_KEYS), alt: z.string().trim().min(5).max(200) }).optional(),
});
export const BlogImageUploadedSchema = z.object({
  id: z.uuid(), url: z.string(), markdown: z.string(), contentType: z.string(), size: z.number().int(),
});
```

Cover when omitted: `defaultKey` = first tag, else `'ai-agents'`; `alt` = the title (padded to 5 characters if
shorter). The stored content is a full `BlogContent` with `sources: []`, `seo: {}`, `social: {}`, `aiDisclosure: {}`,
so every reader of `content` (digest, social, video, `postDto`) keeps working unchanged.

`src/events/blog.ts` (all changes optional or looser, so replay of old events is unchanged):

- `BlogPostSubmitted.content` and `BlogPostRevised.content`: `BlogContentSchema.or(ManualBlogContentSchema)` (the
  writer shape parses first and produces today's output).
- `BlogPostSubmitted.manual: z.object({ authorName: z.string().min(1).max(80) }).optional()`.
- `BlogPostRevised.authorName: z.string().min(1).max(80).optional()`, `BlogPostRevised.slug: BlogSlugSchema.optional()`
  (slug change of a never-published manual draft).
- `BlogPostUnpublished.toDraft: z.boolean().optional()`.

`src/blog/markdown.ts` (images):

- `MdInline` gets `{ t: 'img'; src: string; alt: string }`.
- `INLINE` gets a new alternative **before** the link alternative:
  `(!\[[^\]\n]*\]\(\/blog\/media\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif)\))`. `parseMdInline` turns it into an `img` node
  only if the URL matches `BLOG_IMAGE_SRC_RE`. Any other `![..](..)` does not match this alternative and falls through to
  today's behaviour (`!` text + link), so **writer bodies render exactly as before** (none contains `/blog/media/` since
  the path is new).
- `renderMarkdownHtml`/`inlineHtml`: `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy">`.
- `mdInlineText`: `img` → `''` (today it would crash on the missing `c`; also keeps word count and reading time
  unchanged). `markdownLinks` ignores images. Check every other `switch` over `MdInline` (typecheck finds them).

### Server (apps/server)

`commands/blog.ts` (small, targeted edits; the writer paths keep their behaviour):

- `postDto`: add `originKind: r.origin_kind`, `authorName: r.author_name ?? null`. `BlogPost.origin` stays as it is
  ("From" column), for a manual post it is the user's name.
- `publicDto`: add `...(r.origin_kind === 'manual' ? { origin: 'manual', author: r.author_name } : {})`.
- `listPublishedFull` and `getPublished`: `author: r.origin_kind === 'manual' ? r.author_name : BLOG_AUTHOR` (the full
  DTO's `author` then overrides the list DTO's optional one).
- `listPosts`: optional `origin` filter → `p.origin_kind = ?`.
- `blogSettings`: the review-period default becomes `min(created_at) WHERE NOT launch AND origin_kind = 'writer'`.
- `lastPublishedChange`: `WHERE status IN ('published','unpublished') OR published_at IS NOT NULL`, so taking a manual
  post back to draft still moves the public cache version forward (an unpublish bumps `updated_at`).
- `submitPost`: if the existing row with that slug is `origin_kind = 'manual'`, always `409 slug_taken` (never answer a
  writer retry with a person's post, not even on a hash match). Signature unchanged (guildwise-cloud calls it).
- `revisePost` with `ownKeyOnly` or any `by.apiKeyId`: a manual post is `404 post_not_found` (second guard after the
  route's key check).
- `unpublishPost`: for a manual post append `BlogPostUnpublished { postId, by, toDraft: true }`.

`projections/blog.ts`:

- `BlogPostSubmitted`: also insert `origin_kind = p.manual ? 'manual' : 'writer'`, `author_name = p.manual?.authorName ?? null`.
- `BlogPostRevised`: `author_name = COALESCE($authorName, author_name)`, `slug = COALESCE($slug, slug)`.
- `BlogPostUnpublished`: `status = CASE WHEN $toDraft THEN 'draft' ELSE 'unpublished' END`. Old events (no field) keep
  `unpublished`, so writer posts and their 410 behaviour do not change. A manual post goes back to `draft`, its URL
  answers **404** (getPublished sees a non-published, non-unpublished row), and it can be published again (`publishPost`
  allows `draft`; the first `published_at` is kept, as for writer posts).

New `commands/blog-manual.ts`:

- `createManualPost(ctx, user, req)`: slug = `req.slug ?? slugifyTitle(req.title)`; `SELECT 1 FROM blog_posts WHERE slug=$1`
  → `409 slug_taken` "That slug is already used by another post. Choose a different one." with details
  `[{ field: 'slug', message }]`, nothing appended. `contentErrors` (duplicate tags). Append `BlogPostSubmitted` with
  `origin: { userId }`, `status: 'draft'`, `warnings: []` (the writer's link/source heuristics would flag every link of a
  person's article; they only gate auto-publish, which never applies here), `manual: { authorName: req.authorName ??
  user.displayName }`, `contentHash: contentHash(content)`. Does not call `assertBlogEnabled` (drafting while the blog is
  switched off is harmless; publishing is still blocked by `publishPost`). Returns `getPost`.
- `updateManualPost(ctx, user, id, req)`: row must exist and be `origin_kind = 'manual'`, else 404. Slug: if it differs,
  allowed only while `published_at IS NULL` (never published), else `409 slug_locked` "The address of a published
  article cannot change."; uniqueness check `slug=$1 AND id<>$2` → `409 slug_taken`. Append `BlogPostRevised` with
  `by: { userId }`, `resubmit: false` (status stays: draft stays draft, published stays published, so the public page
  updates in place under the same URL), `authorName`, `slug` when changed. No-op if nothing changed (same check as
  `revisePost`).
- `uploadBlogImage(ctx, user, postId, bytes)`: post must be manual (404 otherwise). Size `0 < n <= BLOG_IMAGE.maxBytes`
  else `413 image_too_large` "Images can be at most 5 MB.". Type from the **magic bytes**, never the header or a name:
  PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`, WebP `RIFF????WEBP`; anything else
  `415 unsupported_image` "Only PNG, JPEG, WebP and GIF images can be uploaded.". At most `BLOG_IMAGE.perPost` images per
  post (`409 too_many_images`). Insert with `id = randomUUID()`; return `{ id, url: '/blog/media/<id>.<ext>', markdown:
  '![](/blog/media/<id>.<ext>)', contentType, size }`.
- `readBlogImage(ctx, id, ext)`: `SELECT i.*, p.status FROM blog_images i LEFT JOIN blog_posts p ON p.id = i.post_id
  WHERE i.id=$1 AND i.ext=$2`.

`routes/blog-platform.ts` (every route starts with `requireSuperAdmin`, which includes the password-change and
two-factor checks and answers 404 to anonymous callers, other users and API keys, exactly like the other platform blog
routes):

- `POST /api/platform/blog/manual` (body `ManualPostRequestSchema`) → 201 `BlogPost`.
- `PUT /api/platform/blog/manual/:id` (params `IdParamsSchema`, body `ManualPostRequestSchema`) → `BlogPost`.
- `POST /api/platform/blog/posts/:id/images`: inside an encapsulated child plugin with
  `addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BLOG_IMAGE.maxBytes + 1024 })` and route `bodyLimit`, the
  same way `routes/documents.ts` does raw uploads (the web `upload()` helper sends `application/octet-stream` and a `name`
  query, which is ignored). Not a Buffer → `400 file_required`. Make sure Fastify's own 413 for a body over the limit
  reaches the client with a clear message (check the app error handler maps `FST_ERR_CTP_BODY_TOO_LARGE`; the web
  helper already turns a bare 413 into "The file is too large").
- `GET /api/platform/blog` passes `req.query.origin` to `listPosts`.
- Publish and unpublish reuse `POST /posts/:id/publish|unpublish` unchanged.
- The existing `POST /api/platform/blog/posts` and `PATCH /posts/:id` stay exactly as they are (writer-shaped content,
  origin 'writer'); the web authoring view never calls them for a manual post.

`routes/blog-public.ts`: `GET /blog/media/:file` with `file` matching
`^([0-9a-f-]{36})\.(png|jpg|webp|gif)$`. Serve when the post is `published`; otherwise try `requireSuperAdmin` (catch →
404) and serve with `cache-control: private, no-store`; otherwise 404. Published: `cache-control: public, max-age=3600`
(short, so an unpublished article's images stop being served from caches soon). Always set the stored `content-type`,
`x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, `content-disposition: inline`.
No route conflict: `/blog/media/:file` has two segments, `/blog/:slug` one; `@fastify/static` is registered with
`wildcard: false`; the Vite dev proxy already forwards `^/blog(/|$)`.

`blog/render.ts`:

- `card()`: when `p.author` is set, the meta line becomes `Author · date · N min read`; writer cards unchanged.
- `postPage()`: byline `esc(post.author)` (equals `BLOG_AUTHOR` for writer posts, so their HTML is unchanged); JSON-LD
  author `{ '@type': 'Person', name }` when `post.origin === 'manual'`, the Organization as today otherwise; the AI
  disclosure paragraph is **left out** for manual posts; sources only when present (already so).
- CSS: `article p img{display:block;max-width:100%;height:auto;border-radius:8px;margin:16px auto}`.
- RSS: `dc:creator` already uses `p.author`; `absolutizeHtml` already makes `/blog/media/...` absolute. Sitemap: no change.
- GWP-114 (same group) edits `releasesIndexPage` in this file; the edits do not overlap, merge carefully.

### Web (apps/web)

- `api/queries/blog.ts`: `usePlatformBlog(status, origin)`; `useCreateManualPost()` (POST, returns `BlogPost`),
  `useUpdateManualPost(id)` (PUT), `useUploadBlogImage(postId)` (uses `upload()` from `api/client.ts` with
  `BlogImageUploadedSchema`). All invalidate `['platform','blog']`.
- `pages/platform/PlatformBlog.tsx`: a "New article" button in the page header (links to `/platform/blog/new`); an
  "Origin" column with a Writer/Manual badge (keep "From"); a second filter group "Origin: All / Writer / Manual" bound
  to `?origin=`; the empty-state text mentions "New article". Status label for a manual draft that was published before:
  "Draft" (it is a draft).
- New `pages/platform/PlatformBlogArticle.tsx` (the authoring view), used by the new route `/platform/blog/new`
  (in `router.tsx`, next to `/platform/blog/:id`) and by `PlatformBlogPost` when `post.originKind === 'manual'` (it
  renders `<ArticleEditor post={...} />` instead of the writer editor). Fields: title, slug, summary (with a character
  count against 300 and a note that the first 160 characters are the search snippet), tags (the six fixed tags as toggle
  chips, zero or more), author name (defaults to the signed-in user's display name), cover (select of the tag covers,
  defaults to the first tag), Markdown body.
  - Slug follows `slugifyTitle(title)` until the user edits the slug field (a `slugTouched` flag); after the first
    publish the slug is read-only with the explanation "The address of a published article cannot change."
  - Required-field validation inline under each field (title, summary, body, author; slug format), not only a toast.
    A `409 slug_taken` from the server is shown under the slug field.
  - "Write" / "Preview" tabs on small screens, side by side from `lg` up. The preview renders a listing card (title,
    summary, author, date) and the article (title, `author · date · reading time`, tags, cover, `BlogBody`, no AI
    paragraph), with the same components and parser as Help > Blog; extract a shared `BlogArticleView` from
    `HelpBlogPost` so both use one component.
  - Images: an "Add image" button opens a file input with `accept="image/png,image/jpeg,image/webp,image/gif"` (on phones
    this offers camera and gallery); client-side check of type and 5 MB before uploading, with the message shown inline.
    The returned `markdown` is inserted at the remembered caret position of the body (store `selectionStart` on blur,
    because the soft keyboard and the file picker take focus away). The button is disabled with a visible hint "Save the
    draft first to add images" until the post exists (images belong to a post).
  - Actions: "Save draft" (create, then navigate to `/platform/blog/:id`; later saves update), "Publish" (saves first if
    dirty, then `usePublishPost`), "Unpublish" (with a confirm dialog, `useUnpublishPost`), "Open public page" when
    published. Buttons at least 44 px high; the action bar wraps on narrow screens.
- `components/blog/BlogBody.tsx`: `case 'img'` → `<img src={n.src} alt={n.alt} loading="lazy" className="my-3 h-auto max-w-full rounded-control" />`.
- `components/blog/HelpBlog.tsx`: list item meta shows `p.author ·` when present; the post view hides the AI paragraph when
  `p.origin === 'manual'` (via the shared `BlogArticleView`).

### Docs

`docs/USER-GUIDE.md` (platform blog section): writing your own article, images (types, 5 MB), unpublish back to draft,
the slug locking after the first publish. `docs/BLOG-API.md` unchanged (no API change).

## Risks

- **Event schema change**: the content union must keep the writer shape first so stored payloads of writer events are
  identical; all new fields are optional, so replay and projection rebuilds behave as before.
- **Response schemas relaxed** (`tags` of `BlogPostSchema`/`PublicBlogPostSchema`): needed, otherwise one tagless manual
  post breaks Help > Blog and the admin list. Writer API responses are not validated by these schemas server-side.
- **Renderer change touches every post**: guarded by the strict `/blog/media/<uuid>.<ext>` pattern; add a regression test
  that renders a body containing `![x](https://example.com/a.png)` and asserts the old output.
- **Unpublish semantics differ by origin** (manual → draft/404, writer → unpublished/410). Intentional, per the card;
  documented in the code comment of the projector.
- **Orphaned images** (removed from the body, or of a deleted draft) stay in `blog_images`. Small; a cleanup is a backlog
  item, not this card.
- **Slug race** (two saves with the same slug at once): the command check plus the `UNIQUE` index; the loser gets an
  error from the append. Acceptable for a single owner.
- **Kill switch** blocks publishing manual posts too (existing `publishPost`). Drafting still works.
- **Migration number** may collide with another card merged first: take the next free number at build time.

## Acceptance criteria → design

| Acceptance criterion | Where it is met |
| --- | --- |
| Super admin sees "New article" in Platform > Blog; view has title, slug, summary, tags, author, Markdown body | `PlatformBlog.tsx` header button; `PlatformBlogArticle.tsx` at `/platform/blog/new` |
| Saving a valid new post creates a draft, origin 'manual', listed as manual/draft, not public anywhere | `createManualPost` (`status: 'draft'`, `manual`) → `origin_kind='manual'`; public queries select `status='published'` only |
| Slug from title, editable; duplicate slug (manual or writer) refused with a clear message, nothing saved | `slugifyTitle` + `slugTouched`; `createManualPost`/`updateManualPost` check all rows → `409 slug_taken` before appending; shown under the slug field |
| Preview shows body, title, summary, author, images as on the public page, without publishing | Shared `BlogArticleView` + listing card, same parser; draft images served to the super-admin session |
| Upload PNG/JPEG/WebP/GIF stores and inserts a Markdown reference; image public after publishing; other types and > 5 MB refused | `POST /posts/:id/images`, magic-byte check, 5 MB limit; `GET /blog/media/:file` serves only for published posts (or super admin); renderer `img` node |
| Publishing shows it in public list, help blog, RSS, sitemap, ordered by publish date with writer posts; public page shows the author | Existing publish; `listPublished` orders by `published_at`; `author` in `publicDto`/full DTO; `postPage` byline and `card()` meta |
| Editing a published manual post updates the public page; slug URL keeps working | `updateManualPost` with `resubmit: false` keeps `published`; slug locked after first publish; cache version follows `updated_at` |
| Unpublishing removes it everywhere, URL not-found, stays as draft, can be published again | `BlogPostUnpublished.toDraft` → `draft`; `getPublished` → 404; `lastPublishedChange` change refreshes the cache; `publishPost` accepts `draft` |
| Non-super-admin, anonymous and API key refused on create, edit, upload, publish, unpublish (same response) | `requireSuperAdmin` on every route (404, with 2FA/password checks) |
| Writer API create/revise/publish/list/get unchanged; the named server suites pass unchanged | No change to `blog-api.ts` contract, `submitPost` signature, writer schemas; writer output of public pages identical |
| API key cannot revise or publish a manual post; manual posts not in the cap | Route `origin_key_id` check + `revisePost` manual guard; cap counts `blog_api_log` rows only |
| Existing posts show 'writer'; pages, author, URLs unchanged | Column default 'writer'; author/disclosure branches only for `origin_kind='manual'` |

## Test plan for the builder

Server, new `apps/server/test/blog-manual.test.ts` (plus a shared-package test for the renderer):

1. Create as super admin → draft, `originKind 'manual'`, given author, tags (also zero tags), summary, slug; omitted
   slug is made from the title; omitted author is the user's display name.
2. Duplicate slug against a writer post and a manual post (create and update) → 409 `slug_taken`, no event appended,
   row count unchanged.
3. Update a draft: fields change, `originKind` stays 'manual'; slug change allowed before the first publish, refused
   (`slug_locked`) after it; PUT on a writer post id → 404.
4. Publish then unpublish: `/blog`, `/blog/<slug>`, `/blog/rss.xml`, `/sitemap.xml`, `/api/blog/posts` contain it only
   while published; after unpublish the URL is 404, the admin list shows `draft`; publish again works.
5. Ordering mixes writer and manual posts by `published_at`; manual author on list card, post page, RSS `dc:creator`,
   Help JSON; no AI disclosure on the manual page; a writer post's public JSON and page HTML equal the output before the
   change (field comparison: no `origin`/`author` keys on list DTOs, `BLOG_AUTHOR`, disclosure present).
6. Access: anonymous, signed-in non-super-admin, and `Authorization: Bearer gwk_...` on create, update, upload, publish,
   unpublish → the same 404 as `GET /api/platform/blog`; a super admin with two-factor setup pending → 403
   `two_factor_setup_required`.
7. Blog API: PATCH and publish of a manual post's slug with a valid key → 404; posting 8 writer posts after creating
   manual posts still hits the cap at exactly the same count; a writer POST with a manual post's slug → 409.
8. Images: PNG/JPEG/WebP/GIF within 5 MB → 201 with `/blog/media/<uuid>.<ext>`; a PDF or a PNG-named text file → 415;
   5 MB + 1 byte → 413; a draft's image → 404 anonymous, 200 for the super admin; after publish → 200 anonymous with the
   stored content type and `nosniff`; after unpublish → 404 again.
9. Migration: a row inserted before (or a replayed old `BlogPostSubmitted`) has `origin_kind 'writer'`, `author_name`
   NULL, other columns untouched.
10. Renderer (packages/shared): `![a](/blog/media/<uuid>.png)` → `<img ...>`; `![a](https://x/y.png)` and
    `![a](/blog/media/../x.png)` render exactly as today; word count ignores images.
11. Run the existing blog suites unchanged: blog, blog-launch, blog-digest, blog-social, social-release, video-youtube,
    video-destinations, blog-public, blog-rss.

Web (vitest): the authoring view (slug follows the title until edited; required-field messages; preview renders Markdown
and an image; save/publish/unpublish call the right hooks; upload refuses a wrong type and a big file before sending);
the admin list shows the origin badge and the origin filter sets `?origin=`; `BlogBody` renders an `img` node; Help >
Blog hides the AI paragraph for a manual post.

Manual/E2E for the testers (not run by the builder): plan items 13 and 14 of the card (full flow as super admin with an
uploaded image; the writer's "write now" next to a manual post).
