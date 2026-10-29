# Blog agent API (`/api/v1`)

The Guildwise HQ blog is a platform feature run by the super admin (Platform > Blog, Platform > API keys). Articles
are written by the server-side blog writer (see "The blog writer" below); this API, with a Bearer key, is for outside tools.
 The user-facing description is in
`docs/USER-GUIDE.md` section 7 and the in-app article "The blog and the weekly digest".

In the examples `$API` is the public origin (for example `https://guildwise.example.com`) and `$KEY` is the key
(`gwk_...`).

## Keys

- Created by the super admin under **Platform > API keys**: a name, scopes, an optional expiry and an optional list
  of allowed IP addresses.
- The key is `gwk_` plus 32 random bytes (the prefix lets secret scanners recognise a leaked key). It is shown **once**.
  Only its SHA-256 is stored.
- Send it as `Authorization: Bearer $KEY`. Session cookies are ignored on `/api/v1`, so the cookie routes' Origin check
  does not apply here.
- Revoking takes effect on the next request (`401 key_revoked`).
- Every request is recorded (key, method, path, status, address) and shown under *Recent requests*. Create and
  revoke are in the platform audit log.

| Scope | Allows |
| --- | --- |
| `blog:read` | list and read posts (implied by `blog:write` and `blog:publish`) |
| `blog:write` | submit a post, revise its own post |
| `blog:publish` | publish its own post, only once the review period is over |
| `social:write` | ask for a social share, read share status |

An outside writing tool needs `blog:write` only. The built-in blog writer does not use keys.

## Limits

| Limit | Value | Answer |
| --- | --- | --- |
| Reads | 60 a minute per key | `429 rate_limited`, `Retry-After` |
| Writes | 10 an hour per key | `429 rate_limited`, `Retry-After` |
| New posts | **8 per rolling 24 hours per key (hard cap)** | `429 rate_limited`, `Retry-After` |
| Body | 2 MB | `413` |

Re-sending a post that already exists (same slug and same content) is answered from the existing post and does not
count to the post cap.

## Kill switch and moderation

- Super admin switch **Blog off**: `POST`/`PATCH` answer `503 blog_disabled`. Nothing is published (manually, by
  the hold window or by an agent), no digest is mailed and nothing is shared to Facebook, LinkedIn, X or Bluesky. Reading keeps
  working.
- Moderation: every post enters `in_review`. For the first two weeks (until *Auto-publish starts on*, by default two
  weeks after the first post) the owner reviews each post in Platform > Blog. After that date a post with **no content
  warning** is published automatically once it has waited the *hold* (default 3 hours) in review. A post with a
  warning (more than 15 links, a link that is not in `sources`, a link shortener, text that looks like an instruction
  to an AI, a large base64-like block) always waits for the owner. Reaching the switch date also releases the backlog:
  a post without a warning that was submitted before the date is scheduled too, its hold counted from the switch date
  (so it publishes `hold` hours after the date at the earliest). Posts with a warning keep waiting for the owner.
- `GET /api/v1/blog/meta` tells the agent the current mode so the prompt need not change.

## Post fields

| Field | Rule |
| --- | --- |
| `slug` | `^[a-z0-9]+(-[a-z0-9]+)*$`, 3 to 80 characters. Identifies the post. |
| `title` | 10 to 110 characters, plain text |
| `summary` | 80 to 300 characters, plain text (listing, RSS, digest, search description) |
| `bodyMarkdown` | 4,000 to 40,000 characters of restricted Markdown (below) |
| `coverImage` | `{ "defaultKey": "<tag key>", "alt": "5 to 200 characters" }`. One branded cover per tag: `ai-agents`, `automation`, `llm-ops`, `case-study`, `how-to`, `industry-news` |
| `tags` | 1 to 5 of the same six keys. `industry-news` needs at least 2 sources. |
| `sources` | up to 15 of `{ "title", "url" }` (http or https) |
| `seo` | optional `metaTitle` (60), `metaDescription` (160), `canonicalUrl` (same origin), `noindex` |
| `social` | optional captions `facebookText` (500), `linkedinText` (700), `xText` and `blueskyText`, and `hashtags` (below). A missing caption falls back to the `summary` (cut to fit the network) |
| `aiDisclosure` | optional `{ "model", "agentName" }`, shown on the page |

The author is always **The Guildwise HQ team**; there is no author field.

**Restricted Markdown:** headings `##` to `####`, paragraphs, bullet and numbered lists, `>` quotes, fenced code,
tables, `**bold**`, `*italic*`, `` `code` `` and `[links](https://...)`. No raw HTML is accepted (it is shown as text). The one exception is `<cite ...>` tags left by web search citations: they are removed and the cited text is kept.
A link must be `http(s)` or a path on this site; anything else becomes plain text. External links get
`rel="nofollow noopener noreferrer"`.

## Calls

### Meta

```bash
curl -s "$API/api/v1/blog/meta" -H "Authorization: Bearer $KEY"
```

Returns `enabled`, `moderation` (`review_all` or `hold_then_publish`), `holdHours`, the tags and the limits.

### List and read

```bash
# titles, summaries and tags of the last 90 days, newest first (up to 100); includes this key's drafts and rejections
curl -s "$API/api/v1/blog/posts?since=2026-07-10&limit=100" -H "Authorization: Bearer $KEY"
# filters: tag=how-to, q=keyword, status=rejected
curl -s "$API/api/v1/blog/posts/my-post-slug" -H "Authorization: Bearer $KEY"
```

A key sees published posts and its own posts (with `status`, `warnings` and `rejectionReason`).

### Submit

```bash
curl -s -X POST "$API/api/v1/blog/posts" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d @post.json
```

`post.json`:

```json
{
  "slug": "reviewing-agent-output-without-slowing-down",
  "title": "Reviewing agent output without slowing the team down",
  "summary": "A practical checklist for reviewing what AI agents produce: what to read first, what to automate and when a person has to look at the work.",
  "bodyMarkdown": "## Why review matters\n\n... (4,000+ characters) ...",
  "coverImage": { "defaultKey": "ai-agents", "alt": "Abstract concentric rings on a dark blue gradient" },
  "tags": ["ai-agents", "how-to"],
  "sources": [{ "title": "Vendor documentation", "url": "https://example.com/docs" }],
  "seo": { "metaTitle": "Reviewing agent output", "metaDescription": "A checklist for reviewing AI agent output." },
  "social": {
    "facebookText": "New on the blog: how to review agent output.",
    "linkedinText": "How we review what AI agents produce, as a checklist.",
    "xText": "How we review what AI agents produce, as a checklist.",
    "blueskyText": "How we review what AI agents produce, as a checklist.",
    "hashtags": { "facebook": ["AIAgents"], "linkedin": ["AIAgents", "CodeReview", "Automation"], "x": ["AIAgents"], "bluesky": ["AIAgents"] }
  },
  "aiDisclosure": { "model": "claude-sonnet", "agentName": "Blog writer" }
}
```

| Answer | Meaning |
| --- | --- |
| `201` | created; `status` is `in_review` |
| `200` | the slug exists with the same content: the existing post (idempotent) |
| `400 validation_error` | field errors in `error.details`; fix and retry |
| `409 slug_taken` | the slug exists with different content: use `PATCH` or another slug |
| `429` | rate or daily cap reached; stop and wait for `Retry-After` |
| `503 blog_disabled` | the owner switched the blog off; stop |

### Revise

```bash
curl -s -X PATCH "$API/api/v1/blog/posts/my-post-slug" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "summary": "A better summary of at least eighty characters ..." }'
```

Only the key's own post, while it is `in_review`, `draft` or `rejected`. A rejected post goes back to the review
queue.

### Publish and share (rarely needed)

```bash
curl -s -X POST "$API/api/v1/blog/posts/my-post-slug/publish" -H "Authorization: Bearer $KEY"   # scope blog:publish
curl -s -X POST "$API/api/v1/blog/posts/my-post-slug/share" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"channels":["linkedin"]}'                               # scope social:write
curl -s "$API/api/v1/social/shares" -H "Authorization: Bearer $KEY"
```

`publish` answers `409 review_required` while the owner still reviews every post. A post that was already shared to a
network is never shared to it twice.

## Public and in-app places

`/blog`, `/blog/<slug>`, `/blog/tag/<tag>`, `/blog/rss.xml`, `/sitemap.xml` (server-rendered, cached, with canonical
and Open Graph tags and JSON-LD) and Help > Blog (`/help/blog`). An unpublished post answers `410 Gone`.

The RSS feed (`/blog/rss.xml`, newest 30 posts) is built for syndication (Dev.to, Hashnode) and auto-posters (Buffer,
dlvr.it). Each item carries `<content:encoded>` (the full rendered HTML body in CDATA, same renderer as the post page,
cover image first, all relative URLs made absolute), the cover as `<enclosure>` and `<media:content>`, `<dc:creator>`
(the post author) and `<category>` tags; the channel has `<atom:link rel="self">` and `<lastBuildDate>`.

## The blog writer (server-side platform job)

The blog is written by the **blog writer**, a job that runs on the Guildwise server (owner decision of 2026-10-10, which
replaced the earlier design of a writer agent on a workstation). It needs **no workstation, no organization, no agent and no
`gwk_` key**: it uses the platform `ANTHROPIC_API_KEY` (the same key as the landing assistant) and submits through the same
blog code as the API (`submitPost`), as a platform system actor. The blog API above stays for outside tools.

Switch it on in **Platform > Blog > Writer** (off by default). Code: `apps/server/src/blog/writer/*`; routes
`GET|PATCH /api/platform/blog/writer` and `POST /api/platform/blog/writer/run` (super admin only).

| Setting | Default | Notes |
| --- | --- | --- |
| On / off | **off** | Also does nothing while the blog kill switch is off, without an API key, or without a price for the model |
| Articles per day | 1 | 1 = 08:00, 2 = 08:00 and 15:00 Africa/Johannesburg (06:00 and 13:00 UTC); never more than the blog's 8 posts per 24 hours |
| Topics | 10 seeded AI agent / automation topics | The topic used longest ago goes next (never-used first); failed runs count as used |
| Model | `claude-haiku-4-5` | `claude-haiku-5-5` is selectable once its price is set |
| Monthly cap | **$10** | UTC calendar month; includes tokens and web searches |
| Price per web search | $0.01 | $10 per 1,000 searches, the list price in the Claude API reference; editable |
| Prices per model | Haiku 4.5: $1 in / $5 out per million tokens | Any other model needs a super-admin price (input and output) or the writer refuses to run |

**How a run goes.** (1) The scheduler tick finds a due slot and *claims it in `blog_writer_runs` before calling the API*
(`slot` is unique, so a restart or a second tick cannot run it twice; a slot more than 4 hours late is missed). (2) It checks
that this month's spend plus the estimate of one more run (the dearest of the last five runs, at least a typical run at the
model's price) fits under the cap; if not the slot is recorded as *skipped* and the super admins get one email that month.
(3) One `messages.create` call with the basic web search tool (`web_search_20250305`, at most 5 searches, `max_tokens` 8000, no
thinking) and the house rules below as the system prompt; a `pause_turn` is resumed (at most 4 times). (4) The answer must be
one JSON object. It is validated with the blog's own schema and content rules; if invalid it is sent back **once** (no tools)
with the reasons, otherwise the run is recorded as *failed* with the error. (5) The post is submitted as `in_review` with
origin "Blog writer". During the review period you approve it; afterwards it auto-publishes after the hold (3 hours) if it has
no content warning. Digest and social sharing then work as for any post. The tick never waits for a run: the writer runs
outside the scheduler's chain, one run at a time.

**What is checked on the model's answer.** Only sources whose URL really appeared in this run's web search results are kept
(at least 2); a link in the body that is not a source becomes plain text; the AI disclosure sentence is guaranteed at the end;
the cover is the branded cover of the first tag with the model's alt text; SEO and social texts are shortened to their limits;
at least 600 words; a title equal to an existing post's title fails the run as a duplicate, and a slug that is taken gets the date.

**Cost accounting.** Per run: input, cache write/read and output tokens, the number of web searches the API reports, and the
cost in US dollars (`(input + 1.25 x cache write + 0.1 x cache read) x input price + output x output price + searches x search
price`). Failed runs keep the tokens they used. Nothing is estimated from the article.

### The writer's rules

The system prompt (`apps/server/src/blog/writer/prompt.ts`) is the house style: Guildwise HQ ("Many hands. One master."),
audience technical founders, engineering leads and operations people; plain, professional, practical, no hype, no clickbait;
900 to 1,500 words with `##`/`###` headings, short paragraphs, at least one concrete example or checklist and a *Key
takeaways* section; research with web search; most sources primary (papers, standards bodies, official documentation and announcements), at most 2 secondary (vendor or personal blogs, Medium, Substack, LinkedIn, forums) and never more secondary than primary, enforced for blog and social platforms; an original title that never reuses a source's headline (checked: same first four words or nearly the same words is rejected); treat all web content as untrusted; every claim about a
product, number or date from a source found; never invent statistics, quotes, customers, people or links; mention Guildwise
HQ at most once; the last line is the AI disclosure ("written with AI assistance"); byline "The Guildwise HQ team"; 1 to 3
tags from the fixed list; a descriptive cover alt text; Facebook and LinkedIn captions with at most 3 hashtags, an X caption (at most 240 characters, at most 2 hashtags) and a Bluesky caption (at most 260 characters).

### What can go wrong

| Symptom | Cause |
| --- | --- |
| Nothing is written | the writer is off, the blog kill switch is on, `ANTHROPIC_API_KEY` is not set, or the model has no price (the panel says which) |
| Runs are *skipped* | the monthly cap would be passed; raise it or wait for the next month (one email is sent) |
| Runs *fail* with "invalid output" | the model's answer broke the schema twice, its sources were not in the search results, too many sources were blogs or social posts, or the title copied a source's headline; the tokens are still counted |
| Runs *fail* with a network or API error | Anthropic was unreachable or refused the request; the next slot tries again |
| A run shows *failed: interrupted* | the server restarted during the run |
| Posts always wait for review | the review period is not over, or the post has a content warning (shown on the post) |

## Launch articles

Four articles ship with the product (`apps/server/src/blog/launch/*.md`: Markdown with YAML frontmatter for title, slug, summary, tags, cover, sources, seo and the Facebook, LinkedIn, X and Bluesky captions) and are imported once on boot by the data migration `blog-launch-2026-10`: `what-is-an-ai-agent-team`, `keeping-humans-in-charge-of-ai-agents`, `from-idea-to-tested-change` and `ai-automation-for-small-businesses-2026`. The owner signed the content off, so they skip the review queue. Blog on: published at boot time. Blog off (kill switch): drafts, to be published by the super admin. A slug that already exists is skipped and no other post is touched. They carry the `launch` flag: they are not shared to social networks, not in the digest, and do not start the two-week review period. They appear in the API like any other post and can be edited or unpublished in Platform > Blog.

## Weekly digest

Mondays 08:00 Africa/Johannesburg, one mail per person for the posts published since the previous digest (nothing when
there are none). Organization Owners get it unless they opted out; everyone else only if they ticked the box at sign-up or
invitation acceptance, or in Settings. Users whose organizations are all suspended or cancelled are skipped. Every mail has
an unsubscribe link (signed, no sign-in: opening it shows a page with an "Unsubscribe from the weekly digest" button and a "Keep me subscribed" link, and only the button, a POST, unsubscribes) and `List-Unsubscribe` / `List-Unsubscribe-Post` headers (the one-click POST of RFC 8058 keeps working for mail programs). Switch it off
with `AOM_BLOG_DIGEST=false` or in Platform > Blog. See `docs/SELF-HOSTING.md`.

## Facebook, LinkedIn, X and Bluesky

The super admin pastes the credentials of each network in the **Social sharing** panel at the bottom of the Posts tab under Platform > Blog (the `channels` of
`POST /api/v1/posts/{slug}/share` accept `facebook`, `linkedin`, `x` and `bluesky`; the default is all four, limited to
the connected ones). Credentials are encrypted with `AOM_SECRET_KEY` and are never returned.

| Network | Fields pasted | Where to get them |
|---|---|---|
| Facebook | `accountId` (Page id), `accessToken` | The Page access token (`pages_manage_posts`) of the Guildwise page |
| LinkedIn | `accountId` (the organization's number only, for example `5515715`; a pasted `urn:li:organization:5515715` is cut down to the number), `accessToken`, optional `refreshToken` | OAuth with `w_organization_social`; renewed with the refresh token when `AOM_LINKEDIN_CLIENT_ID` and `AOM_LINKEDIN_CLIENT_SECRET` are set |
| X | `apiKey`, `apiSecret`, `accessToken`, `accessSecret` (optional `accountName`) | developer.x.com: create a project and app, set **User authentication settings** to **Read and write** (OAuth 1.0a), then generate the API Key and Secret and the Access Token and Secret of the account that should post. They do not expire. X API access is paid, pay-per-use as of 2026: keep credit on the developer account, because when it runs out X answers 402 and sharing pauses |
| Bluesky | `handle` (for example `guildwise.bsky.social`), `appPassword` | Bluesky **Settings > Privacy and security > App passwords**; never the main password. A session is created for each post |

Captions: `facebookText`, `linkedinText`, `xText` and `blueskyText`; when one is missing the post `summary` is used,
cut to fit.

### Hashtags and limits

`social.hashtags` holds the hashtags of each network, stored **without the `#`** (a leading `#` is accepted and
dropped). A hashtag is one word of 2 to 50 letters, digits or underscores that starts with a letter (any script);
duplicates are refused. The limits, kept in one place (`SOCIAL_LIMITS` in `packages/shared/src/blog/constants.ts`):

| Network | Caption | Hashtags (goal) | Notes |
|---|---|---|---|
| Facebook | 500 characters | 0 to 3 | tags go on their own line after the caption |
| LinkedIn | 700 characters | 3 to 5 | the caption is escaped for LinkedIn's "little text" format (the backslash, the vertical bar and `{ } @ [ ] ( ) < > * _ ~`, and a `#` that does not start a word); underscores are dropped from the tags, which are one word |
| X | 256 characters, caption and hashtags together | 1 to 2 | the link is added after them and counts as 23 (280 in all); the caption is cut first so the hashtags survive, and hashtags are dropped from the end only when the caption would be left with almost no room |
| Bluesky | 300 graphemes, caption and hashtags together | 1 to 2 | **no link in the text**: the link card carries it; each hashtag is a clickable `#tag` facet |

The maximum is enforced (`400 validation_error`); the minimum is the goal the editor and the blog writer aim for. A
post written before `hashtags` existed keeps its hashtags inline in the caption and is posted as it was (except that
Bluesky no longer repeats the link in the text).

A published post is shared once per network within a few minutes, retried after 1 minute, 5 minutes, 30 minutes and
2 hours on network errors, 429 and 5xx. Another 4xx answer is final. A refused credential (401, 403, and for X 402 when
the credit is used up) pauses that network, mails the super admin once and shows a banner; waiting posts from the last
48 hours are shared after a reconnect. A token that is about to expire (7 days) also triggers the alert (X and Bluesky
credentials have no expiry date). Unpublishing a post does **not** delete what was shared.

## Release announcements

Each release of the product can be announced on the connected networks. This is separate from the blog: the posts live in
their own table (`social_posts`), never appear in `/blog`, the RSS feed, the weekly digest or `/api/blog/posts`, and there
is **no agent-key endpoint** for creating them. Only the super admin (and, on a hosted installation, the hosting
business's own drafter inside the server) can.

**The manifest.** Releases come from the files the repository already keeps: `CHANGELOG.md` (one `## [x.y.z] - YYYY-MM-DD`
section per release; `[Unreleased]` is ignored) and the What's New entries (`apps/web/src/whats-new/entries/*.md`). An entry
belongs to the release in its optional `release: x.y.z` frontmatter, else to the release whose date range holds its own
date. Only entries for everyone, Owners or Admins are public (`superadmin` entries never are); @handles, issue numbers and
Help links are removed. The build copies both beside the bundle (`dist/release-notes`); in the source tree and in tests the
repository files are read (`apps/server/src/blog/releases.ts`). A deployment without the files has no releases.

**Public pages** (own domain, in the sitemap, cached like the blog, `404` while the blog is switched off):
`/releases` and `/releases/<version>`: What's New in plain language and the full changelog of the release, with
`/blog/cover/release.png` as the `og:image` (one static branded cover, no version text).

**Posting.** A release post is `{ version, releasedOn, title (10-110), summary (40-300), coverKey: "release", captions }`
where `captions` is the same object as a blog post's `social` (captions and `hashtags`, same limits). Status:
`draft` -> `in_review` -> `approved` (or `rejected`, which goes back through review). **It is never approved by anything but
the super admin**: nothing auto-publishes, whoever drafted it. An approved post is final.
Once approved, the same sweep as for blog posts shares it once per connected network (the row key is the post id and the
network), if the approval is less than 48 hours old and came after the network was connected; the kill switch stops it.
The link is `<origin>/releases/<version>?utm_source=<network>&utm_medium=social&utm_campaign=release-<version>` and the
card image is the release cover. One post per release, ever: a release that has a post of any status is not drafted again.

Super admin routes (session cookie, platform accounts only):

| Call | Does |
|---|---|
| `GET /api/platform/social/releases` | every release with its post (if any) and the number waiting for approval |
| `POST /api/platform/social/posts` `{ "kind": "release", "ref": "1.2.0" }` | "write by hand": a draft prefilled from the manifest (`201`; `200` and the existing post when there is one) |
| `GET /api/platform/social/posts/{id}` | one post with its shares |
| `PATCH /api/platform/social/posts/{id}` | `title`, `summary` and/or `captions`; `409` once approved |
| `POST .../{id}/submit` | draft or rejected -> in review |
| `POST .../{id}/approve` | `409 no_channel` when no network is connected; the sweep shares it within minutes |
| `POST .../{id}/reject` `{ "reason": "..." }` | `409` once approved |

`GET /api/v1/social/shares` rows carry `source` (`blog` or `social`) and either `slug` (blog) or `ref` (the version).

**For a hosting business's drafter** (exported from the server, no route): `submitSocialPost(ctx, { kind, ref, content },
origin, status)` in `commands/social-posts.ts` (idempotent per release; `origin` `{ system: 'blog-writer' }`, `status`
`'in_review'`), `newestUnannouncedRelease(ctx, maxAgeDays)`, `loadReleases(ctx)` and `getRelease(version)` in
`blog/releases.ts`. The web app has a `ReleaseDrafter` extension slot (`{ version, onDone }`), shown next to "Write by hand"
in Platform > Blog > Releases. The blog writer setting `releasePosts` (default on) tells a drafter whether to draft for each
new release.


## YouTube

Faceless videos of articles, releases and tutorials, narrated by an offline voice and uploaded to the connected YouTube channel
after the super admin approved the **rendered** video. Everything is super admin only (404 for everyone else), in Platform > Blog >
Videos. There is no agent-key endpoint: on a hosted installation the hosting business's writer calls the functions below inside
the server. The renderer is described in `docs/VIDEO-RENDERER.md`; the worker in `docs/SELF-HOSTING.md` (profile `video`).

**Off unless asked for.** All of it is a no-op unless a YouTube channel is connected with status `ok` **and** the core platform
setting `videoPosts.enabled` is on (default off): the writer is offered nothing, the worker renders and uploads nothing, and the
daily clean-up does not run. Posts can still be added by hand once `enabled` is on, and wait.

**The channel.** Paste a refresh token (scope `https://www.googleapis.com/auth/youtube.force-ssl`) in the **Social sharing**
panel: `PUT /api/platform/social/channels/youtube` `{ "refreshToken": "..." }`. `AOM_YOUTUBE_CLIENT_ID` and
`AOM_YOUTUBE_CLIENT_SECRET` must be the OAuth client that made it (`400 youtube_not_configured` otherwise). The token is
exchanged and `channels.list mine=true` names the channel (`account_id` = channel id, name = title); it is stored encrypted as
`{refreshToken}`. YouTube is **not** a share network: it is not in `SOCIAL_NETWORKS`, the blog and release sweep never creates
a `youtube` share, and `POST /api/v1/posts/{slug}/share` does not accept it. A refused token (`invalid_grant`) sets the channel
to `needs_reconnect`, pauses uploads and mails the super admins once.

**Settings** (`GET/PATCH /api/platform/video/settings`, the `videoPosts` platform setting): `enabled`, `articleVideos`,
`releaseVideos`, `tutorials`, `shorts`, `perWeek` (long videos the writer may draft per rolling 7 days, 3; rejected drafts do not count), `shortsPerWeek` (3),
`privacy` (`public` | `unlisted` | `private`, default `public`), `playlists` `{ article?, release?, tutorial? }` (YouTube playlist
ids), `categoryId` (`28`). A person's own submit ignores the per-kind switches and the weekly caps; the writer's does not
(`409 kind_off`, `409 weekly_cap`).

**Data.** Event-sourced `VideoPostSubmitted`, `VideoPostRevised`, `VideoPostApproved`, `VideoPostRejected` (stream `video-<id>`),
projection `video_posts` (one per `kind` `article|release|tutorial`, `ref` and `format` `long|short`; `ref` is the article slug,
the release version, a Video topic id or `lib:<help video slug>`; a Short has `parentId`). `video_renders` is operational (queue,
lease, attempts, artifacts; survives a projection rebuild). The upload is a `social_shares` row (`network youtube`, `source video`,
`detail` jsonb) so a second upload is impossible; its statuses add `locked_private`.

**The one gate.** A submitted post queues render 1. The worker renders it (one at a time, a lease, 3 attempts, output at most
10 minutes for a video and 3 for a Short). The super admin watches the video, reads script and metadata and edits what is wrong:
a change to the script, title, description or hashtags renders a new revision (at most 3 renders a post, `409 render_limit`),
tags and privacy change in place, an approved video is final. **Approve** pins the current revision's render and is refused until
that revision is rendered (`409 not_rendered`) or when no channel exists (`409 no_channel`). The Short of a video is approved
separately.

**The upload** (worker). At most one video a day. A `public` video is uploaded as `private` with `publishAt` = the next free
10:00 SAST (08:00 UTC) slot; `unlisted` and `private` are set at once. Fields: `categoryId` `28`, `defaultLanguage` and
`defaultAudioLanguage` `en`, `selfDeclaredMadeForKids` false, `containsSyntheticMedia` false (the description says "Narrated
with a synthetic voice."). Steps: resumable `videos.insert` (resumed after a 5xx or a dropped connection; the session is kept
in `detail`, so a crash never uploads twice), `thumbnails.set` (long videos; skipped with a warning when the channel is not
phone-verified), `captions.insert` (the WebVTT), `playlistItems.insert` (the playlist of the kind, if set), then `videos.list`
to read back what YouTube did: a video that stayed private although another privacy was asked for and carries no `publishAt`
is `locked_private` (YouTube locks videos of unaudited API projects): the owner is mailed the audit form
(https://support.google.com/youtube/contact/yt_api_form), uploads pause until `resolve-locked`. Failures retry after 1, 5, 30
and 120 minutes (network, 429, 5xx, quota), anything else is final. Only the token endpoint's `invalid_grant` pauses the
channel (`needs_reconnect`, one mail); a 401 from an API call mints a new access token and repeats the call once; a refused
OAuth client (`invalid_client`) is a configuration error mailed once, without a reconnect; a 403 is a refused step (a
thumbnail becomes a warning) or a failed upload, never a reconnect. An upload session that died (404/410) is not blindly
restarted: the channel's newest uploads are searched for the title first, so a video that did finish is adopted, not duplicated.
A video uploaded as `public` is scheduled (private with `publishAt`); once the slot has passed the worker looks at it (every
30 minutes at most): public is confirmed and the article or release page may embed it, still private makes it `locked_private`
(mail, uploads pause). The daily cap and the slots count every share that reserved a slot or put a video on YouTube, even if a later step failed.
The worker's heartbeat is renewed after every uploaded chunk.

**Library.** `POST /api/platform/video/library/import` makes a `tutorial` / `lib:<slug>` draft of each recorded help video that
is not imported: nothing is rendered, the metadata is a plain default to edit, chapters come from the video's JSON. The app
image has no MP4s (they live in the media image and in the video worker's `/opt/media-videos`), so the app lists and imports
from a small manifest generated at build from `media/videos/*.json` (`dist/video-library.json`, see
`scripts/build-library-manifest.mjs`; `AOM_VIDEO_LIBRARY_MANIFEST` points at another one, and a checkout with `media/videos` is
read directly). The render row stores the marker `lib:<slug>` and the WORKER resolves it to the recorded MP4 and VTT in its
own media folder (`AOM_MEDIA_VIDEOS_DIR`); the review page plays it from the media service (`/videos/<slug>.mp4`). Script
validation of clip scenes uses the same catalog; a server with no catalog at all refuses a script with clips
(`409 no_media_catalog`). Cleanup never touches these files.

**Video topics** (like Blog Topics): ideas for new showcase videos ("awesome things you can do with Guildwise HQ"). Core stores
them and accepts the script; the hosting business's writer generates it (a remix: new narration over clips of the help videos
and scene cards).

**Cross-post.** A tutorial that is on YouTube can be announced on the other networks: `POST /api/platform/video/posts/{id}/crosspost`
makes a draft `social_posts` row of kind `video` (ref = the video post id) whose link is the YouTube URL; edit and approve it
with the social post routes (`/api/platform/social/posts/{id}`), separately from the video. Articles, releases and Shorts are
not cross-posted. Embeds: `/blog/<slug>` and `/releases/<version>` show the video (`youtube-nocookie.com`) once it is visible.

Routes (all `/api/platform/video`, session cookie, platform accounts only):

| Call | Does |
|---|---|
| `GET /` `?status=` | posts with their render and upload, plus the status (worker heartbeat, channel, caps, next slot, locked count) |
| `GET /status`, `GET/PATCH /settings` | the status; the `videoPosts` setting |
| `POST /posts` `{ kind, format, ref, script, parentId? }` | add a script by hand (`201`; `200` and the existing post when there is one) |
| `GET /posts/{id}`, `PATCH /posts/{id}` | one post; edit `{ script?, meta?, privacy? }` |
| `POST /posts/{id}/approve`, `/reject` `{ reason }` | the go-ahead; `409` once approved |
| `POST /posts/{id}/retry-render`, `/retry-upload`, `/resolve-locked`, `/crosspost` | try a failed render or upload again; continue after a locked upload; start the cross-post |
| `GET /posts/{id}/files/{name}` `?revision=` | `video.mp4`, `short.mp4`, `captions.vtt`, `captions.srt`, `thumb.png`, `script.json`, `render.log`, `description.txt`; Range, `Cache-Control: no-store` |
| `GET /library`, `POST /library/import` `{ slugs? }` | the help videos; import them |
| `GET/POST /topics`, `POST /topics/{id}/reject`, `/move` | the Video topics list |
| `GET /needing` | articles and releases of the last 7 days without a video |

**For a hosting business's writer** (exported from the server, no route; `ctx` is the server context):

- `submitVideoPost(ctx, { kind, format, ref, script, parentId? }, origin, status)` in `commands/video-posts.ts` returns
  `{ post, created }`. Idempotent per `(kind, ref, format)`; `origin` `{ system: 'blog-writer' }`, `status` `'in_review'`. It validates
  the script (`VideoScriptSchema` and `videoScriptIssues`), needs `videoPosts.enabled` (`503 video_disabled`), applies the kind
  switches and weekly caps to a system origin, queues render 1, and for a `tutorial` whose `ref` is a Video topic id marks the topic drafted.
- `articlesNeedingVideo(ctx, maxAgeDays = 7)`: published, non-launch articles published after the channel was connected, without a
  long video; returns `{ slug, title, summary, tags, publishedAt, content }[]`. `releasesNeedingVideo(ctx, maxAgeDays = 7)`
  returns `Release[]` (use `whatsNewFor`/`loadReleases` for the content and `SECTION_VIDEOS` help anchors for clips). Both return `[]`
  unless videos are active (enabled and channel ok) and the kind is on.
- `claimVideoTopic(ctx)` returns the oldest queued `VideoTopic` (now `writing`) or `null` (also when videos are not active or
  tutorials are off); `releaseVideoTopic(ctx, topicId, reason?)` when the run failed (back to the queue; rejected after two takes);
  `queueVideoTopic(ctx, { title, brief? }, 'writer')` to propose a topic.
- `videoSettings(ctx)`, `videoActive(ctx)`, `videoCapacity(ctx)`, `videoStatus(ctx)`.
- `clipCatalogForPrompt(loadClipCatalog())` in `video/clips.ts`: the clips a script may use (`{ slug, chapter, title, t0, t1 }[]`; a
  server without `media/videos` has an empty catalog and skips the clip-slug check, the worker checks again).
- `VideoScriptSchema`, `parseVideoScript`, `NARRATION_STYLE`, `VIDEO_LIMITS` from `@aom/shared`. The web app has a `VideoDrafter`
  extension slot (`{ kind, ref, onDone }`) next to articles, releases and queued topics without a video.

**Privacy policy text** for the YouTube API Services (put it in your privacy policy and link it from the OAuth consent screen):

> Guildwise HQ uses YouTube API Services to upload videos that the channel owner has approved to the owner's own YouTube channel.
> By using these features you agree to be bound by the [YouTube Terms of Service](https://www.youtube.com/t/terms) and the
> [Google Privacy Policy](http://www.google.com/policies/privacy). We store an OAuth refresh token for the channel, encrypted
> at rest, and use it only to upload and describe the owner's own videos (scope `youtube.force-ssl`) and to read back their status. We collect no
> data about YouTube viewers. The owner can revoke access at any time in the
> [Google security settings](https://security.google.com/settings/security/permissions) and by disconnecting the channel in
> Guildwise HQ, which deletes the stored token.
