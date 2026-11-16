# GWP-256: render a video again and retry a destination that a network refused

## 1. Question

When a network (Instagram, for example) refuses the uploaded MP4 for one destination of a video post, the screens offer
no way to make a new file and post it again:

- `retryRender` (`apps/server/src/commands/video-posts.ts`) only resets a render whose status is `failed`.
- `retryShare` / `retryUpload` reset the destination to `pending` and send the existing rendered file again. They render
  again only when the clean-up has already purged the MP4, and then they reuse the same revision.

The card asks for a separate command, "render again and retry", for one failed or rejected destination. It needs a
route, a web hook and a button in the queue screen. The design also has to settle how a post's render relates to its
destinations, and what pending destinations do with the new file.

## 2. Findings

### 2.1 Render model: one shared file per revision

- `video_renders` has one row per `(post_id, revision)`. The unique key is used by
  `ensureFinalRender ... ON CONFLICT (post_id, revision)`. The row's `artifacts` jsonb holds paths relative to
  `AOM_VIDEO_DIR`, under `renderDir(postId, revision)` = `<postId>/<revision>/`.
- Every destination of a post uses the same render. Both `runUpload` (YouTube) and `runDestination` (all other networks)
  in `apps/server/src/video/sweep.ts` pick `approved_render_id` when it is set (legacy posts only), otherwise the render
  of `(p.id, p.revision)`. The render is selected each time a share runs, so a share always follows the post's current
  revision.
- `renderNext` starts with `rm(outDir, { recursive: true })` for the render's `<postId>/<revision>` folder. **Rendering
  the same revision again deletes the old file before the new one exists.** This is why `retryShare` may only re-render
  after the purge, and why this card needs a **new revision**: the constraint "keep the old artefact until the new render
  succeeds" cannot be met by resetting the existing row.
- `video_posts.revision` is a projection column. It is written only by the `VideoPostRevised` projector, and only
  `WHERE status <> 'approved'`. An approved post has no way to change its revision today. A direct `UPDATE` would be lost
  on `rebuildProjections`, which replays `video_posts` from events, while `video_renders` and `social_shares` are
  operational tables that are kept. **The revision bump must therefore come from an event projector.**
- Projectors run inside `PgEventStore.append`, in the same transaction (`pg-event-store.ts:113`), and `append` accepts
  `{ tx }`. The event, the new render row and the share marker can be written atomically with `withTx`
  (`apps/server/src/db/tx.ts`).

### 2.2 How "rejected" is stored

`social_shares.status` values are `pending | posting | sent | failed | skipped | locked_private` (`VIDEO_UPLOAD_STATUSES`
in `packages/shared/src/video/post.ts`). **There is no `rejected` share status.** A network refusal ends as
`status='failed'` with the reason in `error`:

- Instagram `ProcessingFailedError` is a `DestinationError('retry', ..., IG_PROCESSING_ATTEMPTS)`. Once the attempts
  run out it becomes `failed` with "gave up after N attempts: Instagram upload: ...ProcessingFailedError".
- Other network refusals are `DestinationError('final')` and become `failed` with the message.
- YouTube: `runUpload` reads `videoStatus` after the upload. On `uploadStatus` `rejected`/`failed` it throws
  `YouTubeError('final', 'YouTube rejected the video: ...')`, which becomes `failed`. **`detail.videoId` stays set**
  (the video exists on the channel as a rejected upload).

So "failed or rejected" in the card means `status = 'failed'`. `skipped` (channel not connected, post no longer
approved) is not a file problem. A new render cannot fix it, and the existing retry covers it, so the new command
refuses it with 409.

### 2.3 What else reads the render or the revision

| Reader | Effect of a new revision on an approved post |
|---|---|
| `healRenders` (sweep) | Inserts a missing render row for the current revision (crash safety: if the command dies after the event, the sweep creates the row). Marks *queued* older revisions `failed` ("superseded"). The old render is `rendered`, so it is not touched. |
| `CLAIMABLE` / `claimRender` | Joins `p.revision = x.revision`: only the new row can be claimed. The disk budget and the one-render-at-a-time rule still apply. |
| `createMissingUploads` (`RENDERED`) | Share rows already exist (`ON CONFLICT DO NOTHING`). No effect. |
| `runUpload` / `runDestination` | A share that runs uses the new revision's render. Until it is rendered, the share waits ("waiting for the video file") until its deadline. |
| `cleanupVideos` "superseded" purge | Purges a render with `r.revision < p.revision` once it is more than one day old. **This would purge the old MP4 while the new render is still queued or has failed.** It needs an exclusion (section 4.6). |
| `toDtos` | `render` = the current (new) revision's row: the UI shows queued/rendering/failed. `rendersUsed` goes up by one (shown only in the review screen). |
| `retryRender` | Works on the failed render of `p.revision`. After a failed re-render, that is the new row, so the existing "Retry render" applies unchanged (AC 7). |
| TikTok (`signedMediaUrl(ctx, render.id)`) | The new render id is signed. Old URLs stay valid until the purge. |
| `publicVideoEmbed`, `recheckPublished` | Read `social_shares.external_id` only. A sent YouTube share is not affected. |

### 2.4 Existing patterns to follow

- Locks: `withLock(ctx, 'video-post-edit:<postId>')` is the lock that preview, revise, schedule and unschedule take for
  one post. Using it serialises the new command against those and against itself (a double click).
- Audit: `auditRetry` appends `VideoRetryRequested { postId, what, by }`. `platform-audit.ts` turns it into a
  `platform_audit_log` row (summary plus details). It has no `video_posts` projector today.
- Route auth: every video platform route uses `requireSuperAdmin`. Any other signed-in user gets **404** (see
  `video-destinations.test.ts`, the member case on `/shares/facebook/retry`). No session gives 401 → 404.
- Server tests: `apps/server/test/video-destinations.test.ts` drives `videoTick` with a `FakeDestinations` client that
  records each `DestinationPayload` (including `filePath`), plus a fake `RenderFn`. This is the harness for the new file.

### 2.5 GWP-255 (same group)

GWP-255 (Instagram retried with the unchanged MP4) has no commits yet. Its branch is level with main. Its likely area is
`video/destinations.ts` (`postToInstagram`, the `ProcessingFailedError` handling). This card adds no code there and does
not depend on it. **No dependency is recorded.** The builder works the group in order. If GWP-255 lands first and changes
how an Instagram processing failure ends (status or `error` text), this command still works, because it keys only on
`status='failed'`.

## 3. Options

### A. Where the new file comes from

| Option | How | Verdict |
|---|---|---|
| A1: reset the current render row (same revision) | Like `retryShare` after a purge | **Rejected.** `renderNext` deletes `<postId>/<rev>` before rendering, so the old file is gone before the new one exists. A failed render leaves nothing. This breaks the constraint. |
| A2: a second render row for the same revision (new "attempt" column) | Migration on `video_renders` (unique key and `renderDir` change), plus every reader learns which row is current | **Rejected.** A migration and changes to every render reader, for no gain over A3. |
| A3: **a new revision of the approved post** (`revision + 1`), bumped by an event projector, with a new render row | New folder `<postId>/<rev+1>`, the old row and file untouched, the existing worker path unchanged | **Chosen.** No migration. Rebuild-safe because the bump is an event. `retryRender`, the claim, the heal and the shares all already follow `p.revision`. |

### B. How the invoked destination is retried only after the render succeeds

| Option | Verdict |
|---|---|
| B1: set the share to `pending` at once and let it wait for the file | **Rejected.** The share would show "pending", not failed (AC 7). It waits only until its deadline and then fails with "file not found", an unclear reason. YouTube's claim also needs `RENDERED`. |
| B2: hook into `renderNext` when the render becomes `rendered` | Possible, but it couples the render role (which may be a remote render machine) to destination state, and it is harder to test. |
| B3: **a marker on the share (`detail.rerender`) and a publish-side sweep step `resumeRerenders`** that resets the share once the marked revision is rendered | **Chosen.** The share stays `failed` until the new file exists. The sweep handles success, failure and supersession in one place, and `videoTick` tests cover it. |

### C. Pending or scheduled destinations of the same post

| Option | Verdict |
|---|---|
| C1: **they follow the post's current revision (the existing model): a not-yet-started pending share posts the new file** | **Chosen.** It matches how renders work today (a share reads the current revision's render each time it runs), and it needs no change to `runUpload`/`runDestination`. Their status, `next_attempt_at` and slot stay as they are. If one becomes due while the new render runs, it waits for the file ("waiting for the video file") within its normal window. |
| C2: pin them to the old file until the new render succeeds | **Rejected.** It needs per-share render selection in both runners: a larger and riskier change for a rare case. |

C1 needs one safety guard. A share that has **already started** with the current file must not switch files mid-upload:
a resumable session or container is bound to the old file's bytes. Examples are any other share of the post that is
`posting`, or `pending` with saved progress (`detail.dest` is a non-empty object, or `detail.sessionUri`, or YouTube
`pending` with `detail.videoId` while follow-up steps remain). In that case the command returns **409
`share_in_progress`**: "another destination is still uploading the current file; try again when it has finished". This
is the same "has started" idea that `shareStarted` uses.

## 4. Design

### 4.1 Shared types: `packages/shared/src/events/video.ts` and `packages/shared/src/video/post.ts`

Extend `VideoRetryRequested` in a backward-compatible way (old events still parse):

```ts
defineEvent(
  'VideoRetryRequested',
  z.object({
    postId: Id,
    what: z.enum(['render', 'upload', 'resolve-locked', 'render-again']),
    by: Id,
    /** render-again: the destination that is retried once the new render is done. */
    network: z.enum(VIDEO_DESTINATIONS).optional(),
    /** render-again: the new revision of the approved post (its render is the new file). */
    revision: z.number().int().min(2).optional(),
  }),
),
```

Add an optional marker to both share DTOs, so the UI can show "rendering again":

```ts
const RerenderSchema = z.object({ revision: z.number().int(), requestedAt: IsoTime }).nullable();
// VideoUploadSchema: rerender: RerenderSchema.default(null)
// VideoShareSchema:  rerender: RerenderSchema.default(null)
```

`.default(null)` keeps older payloads and the web fixtures valid. Update `apps/web/src/test/video-fixtures.ts` only if a
type check asks for it.

### 4.2 Projection: `apps/server/src/projections/video-posts.ts`

New projector entry `VideoRetryRequested`. It acts only on `what === 'render-again'` and is idempotent on replay:

```ts
VideoRetryRequested: async (tx, e) => {
  const p = (e.event as EventOf<'VideoRetryRequested'>).payload;
  if (p.what !== 'render-again' || !p.revision) return;
  await exec(
    tx,
    `UPDATE video_posts SET revision=$2, approved_render_id=NULL, updated_at=$3
      WHERE id=$1 AND status='approved' AND revision < $2`,
    [p.postId, p.revision, e.createdAt],
  );
},
```

`approved_render_id = NULL` makes legacy posts that pinned a render follow the new revision too. The column is only set
by old `VideoPostApproved` events, so replay order keeps it correct. The `platform-audit.ts` projector for the same event
stays, and both run (registration order).

### 4.3 Audit: `apps/server/src/projections/platform-audit.ts`

Extend the `what` map with `'render-again': 'rendered again and retried'`. When `p.network` is set, add it to the
summary and details:

- Summary: `Video rendered again and retried on Instagram: <title>`
- Details: `{ postId, what: 'render-again', network, revision }`

The actor is already `userActor(by)`. This meets AC 8: actor, destination and the render-again marker.

`auditRetry` gets an optional `extra: { network, revision }` parameter (default none), so existing callers are
unchanged.

### 4.4 Command: `apps/server/src/commands/video-posts.ts`, `renderAgainAndRetry`

Place it next to `retryShare`. Do not change `retryRender`, `retryShare`, `retryUpload` or `ensureFinalRender`.

```ts
/**
 * A destination the network refused (failed) gets a NEW file: the approved post moves to a new revision, that revision is
 * rendered through the normal worker path, and only once it is rendered is this destination tried again with it (the
 * sweep's resumeRerenders). The old render and its file stay until then. Destinations already sent are never touched;
 * pending ones follow the current revision as always.
 * 404 unknown post or destination; 409 not_scheduled, library_video, not_failed, already_uploaded, render_in_progress,
 * share_in_progress.
 */
export function renderAgainAndRetry(ctx: Ctx, by: string, postId: string, network: string): Promise<VideoPost> {
  return withLock(ctx, `video-post-edit:${postId}`, async () => { ... });
}
```

Steps inside the lock, in this order (the 404s come first):

1. `SELECT * FROM video_posts WHERE id=$1`. Missing → **404** `video_post_not_found`.
2. `SELECT * FROM social_shares WHERE post_id=$1 AND network=$2 AND source='video'`. Missing, or `network` not in
   `VIDEO_DESTINATIONS` → **404** `share_not_found`. Unlike `retryShare`, YouTube is not special-cased to 409.
3. `p.status !== 'approved'` → 409 `not_scheduled`. `!p.script` → 409 `library_video` ("a recorded help video cannot be
   rendered again").
4. `share.status !== 'failed'` → 409 `not_failed` ("only a failed destination can be rendered again"). This covers
   sent, locked_private, pending (scheduled), posting and skipped.
5. YouTube only: `detail.videoId` set and **not** a rejection → 409 `already_uploaded` ("the video is on YouTube
   already; use Retry"). This prevents a duplicate upload. A rejection is `detail.rejected` (new, section 4.7) **or**
   `error LIKE 'YouTube rejected the video%'`, for shares that failed before this change.
6. The current render row `(postId, p.revision)` has status `queued` or `rendering` → 409 `render_in_progress`. This
   also catches a second concurrent call: the first call's new row is `queued`, and the lock makes the second call see
   it.
7. Another share of the post has started with the current file (section 3 C) → 409 `share_in_progress`.
8. One transaction (`withTx`):
   - `ctx.store.append([{ streamId: videoPostStream(postId), event: { type: 'VideoRetryRequested', payload: { postId,
     what: 'render-again', by, network, revision: p.revision + 1 } }, actor: userActor(by), scope: adminScope }], { tx })`.
     The projector bumps the revision.
   - `INSERT INTO video_renders (id, post_id, revision, status, attempts, created_at, not_before, preview) VALUES
     ($1,$2,$3,'queued',0,$4,NULL,false) ON CONFLICT (post_id, revision) DO NOTHING`. `not_before = NULL` means render
     at once. The render limit (`VIDEO_POST_LIMITS.maxRenders`) is **not** applied: this is a manual recovery on an
     approved post, the limit guards scripts in review, and the disk budget in `claimRender` still applies.
   - Set the marker and keep the share `failed`:
     `UPDATE social_shares SET detail = COALESCE(detail,'{}'::jsonb) || jsonb_build_object('rerender',
     jsonb_build_object('revision', $3::int, 'requestedAt', $4::text, 'by', $5::text)), updated_at=$6
     WHERE post_id=$1 AND network=$2 AND source='video' AND status='failed'`.
9. Return `getVideoPost(ctx, postId)`.

The old render row and its folder `<postId>/<rev>` are not touched.

### 4.5 Sweep: `apps/server/src/video/sweep.ts`, `resumeRerenders(ctx)`

This is a new exported function. In `videoTick`, call it in the `doPublish` block after `healRenders` and before
`createMissingUploads`, and again right after `renderNext` when `rendered && doPublish`, the same way
`createMissingUploads` is called. It acts on each share with `source='video' AND detail ? 'rerender'`, joined to its post
and to the render `(post_id, (detail->'rerender'->>'revision')::int)`:

| State | Action |
|---|---|
| Share status ≠ `failed` (someone used the plain Retry, or it ran) | Remove the marker only (`detail - 'rerender'`). |
| Post not `approved`, or `p.revision ≠ marker.revision` (unscheduled or revised since) | Remove the marker, leave the share `failed`, set `error = 'the render made for this retry was replaced; retry again'`. |
| Render `rendered` and `purged_at IS NULL` | **Retry with the new file.** Atomically: `status='pending', attempts=0, next_attempt_at=now, error=NULL, updated_at=now`, then `detail` = old detail minus `dest`, minus `rerender`, plus `retryAt: now` (a new 6-hour window, as in `retryShare`). For YouTube, also drop `videoId`, `sessionUri`, `sessionStartedAt`, `uploadedAt`, `steps`, `warnings`, `publishAt`, `verifiedAt`, `rejected`, and set `external_id=NULL, url=NULL`, so `uploadNext` uploads the new file. Guard with `WHERE ... AND status='failed' AND detail->'rerender'->>'revision' = $rev`. For TikTok, drop `dest` completely: a new file is a new publish, and unlike `retryShare` the old publish id is not kept. |
| Render `failed` | Keep the marker and the `failed` status. Set `error = 'the new render failed: ' + render.error` (cut to 480 characters), once: only when the error does not already start with that prefix. Nothing is uploaded. When "Retry render" (unchanged) later makes this revision `rendered`, the next sweep retries the destination (row above). |
| Render `queued` / `rendering` | Nothing. |

The old file is never used for the invoked destination. While the marker is present the share stays `failed`, so
neither `uploadNext` nor `postNextDestination` claims it. After the reset, the share reads the current (new) revision's
render.

### 4.6 Purge exclusion: `cleanupVideos`

Add this to the "superseded" query, so the old MP4 stays while any share of the post waits for a re-render:

```sql
AND NOT EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video' AND s.detail ? 'rerender')
```

Once the marker is cleared (on success, or when superseded), the normal one-day superseded rule applies. Posts without a
marker behave as before.

### 4.7 YouTube rejection marker: `runUpload`

In the `uploadStatus === 'rejected' || 'failed'` branch, set `detail.rejected = status.rejectionReason ??
status.failureReason ?? status.uploadStatus` before the throw. The catch already writes `detail` back. This one line lets
step 5 tell a rejection from an upload that is live on YouTube. No other `runUpload` behaviour changes.

### 4.8 DTO: `toDtos`

`uploadDto` and the `others` share mapping add `rerender: detail.rerender ? { revision, requestedAt } : null`.

### 4.9 Route: `apps/server/src/routes/video-platform.ts`

Add this right after `/shares/:network/retry`:

```ts
/** Renders the video again (a new file) and then tries this one failed destination with it. */
app.post(
  '/api/platform/video/posts/:id/shares/:network/rerender',
  { schema: { params: z.object({ id: z.uuid(), network: z.string().min(1).max(40) }) } },
  async (req) => {
    const s = await requireSuperAdmin(ctx, req);
    return renderAgainAndRetry(ctx, s.user.id, req.params.id, req.params.network);
  },
);
```

`network` is a free string, so an unknown destination name gives **404** from the command (AC 6), not a 400 from the
schema. The authorisation is the same `requireSuperAdmin`: a member or an anonymous caller gets 404, exactly as on the
retry routes (AC 9).

### 4.10 Web: `apps/web/src/api/queries/video.ts`

```ts
/** Renders the video again and then retries one failed destination with the new file. */
export const useRenderAgainShare = () =>
  useVideoMutation((v: { id: string; network: VideoDestination }) =>
    post<VideoPost>(`/platform/video/posts/${v.id}/shares/${v.network}/rerender`, undefined, VideoPostSchema),
  );
```

### 4.11 Web: `apps/web/src/components/video/QueueCalendar.tsx` (`ScheduledPost`)

- Extend `destinationStates` to return `rerender` (from `p.upload?.rerender` / `s?.rerender`) and `error`.
- For each destination with `state === 'failed'`:
  - **No marker:** show the existing `Retry <Network>` button and next to it a
    `Render again and retry <Network>` button (`data-testid="rerender-<dest>"`, `size="sm"`, `loading` while its own
    mutation runs). On success show the toast "Rendering again; <Network> is retried when it is done".
  - **Marker present** and `post.render?.status` is `queued`/`rendering`: show `<Badge tone="info">Rendering again
    for <Network></Badge>` (`data-testid="rerender-progress-<dest>"`) and **hide both buttons** for that destination.
    This blocks a double submission from the UI as well.
  - **Marker present** and `post.render?.status === 'failed'`: show `<Badge tone="danger">New render failed</Badge>` and
    the share's error text (the reason). The existing "Retry render" button is shown, because `renderFailed` is true.
- After the reset the share is `pending` → `posting`, and the existing icons show the "retrying" stage (the spinner on
  posting). No extra state is needed.
- Hide the action for YouTube when `post.upload.videoId` is set and the error is not a rejection. A simpler client rule
  is acceptable: show it for YouTube only when `post.upload.videoId` is null **or** the error starts with
  "YouTube rejected the video". The server is the authority either way.
- Add `rerender.error` to the existing `ErrorBox` chain:
  `unschedule.error ?? retry.error ?? retryShare.error ?? rerender.error`.
- Touch: the buttons are already in a wrapping `flex-wrap` row of `size="sm"` buttons. Keep the labels short enough to
  wrap on a phone. No input field is involved.

The action is never rendered for sent, scheduled/pending, posting, skipped or locked_private destinations (AC 4, UI
side), because it sits inside the `state === 'failed'` branch.

## 5. Risks and decisions recorded

1. **New revision on an approved post.** This is new: until now only a post in review could change revision. Every
   reader was checked (section 2.3). Only the superseded purge needed a change (section 4.6).
2. **Byte-identical output.** The renderer may produce a file with the same bytes from the same script. The AC's
   "uploaded artefact differs" is met by a **new render id, revision and path**: the destination gets
   `<postId>/<rev+1>/…`, a new upload, container or publish. If the network refuses the *content* itself, a re-render can
   be refused again. GWP-255 deals with Instagram's handling of an unchanged MP4.
3. **YouTube duplicates.** Re-uploading is allowed only when no video is on the channel or YouTube rejected it
   (section 4.4, step 5). A rejected YouTube video stays on the channel as a rejected upload, which is outside this card.
4. **TikTok.** The marker path drops the saved publish id. A TikTok share is `failed` only after TikTok reported failure,
   or after 12 hours of processing. In the rare case where a "still processing" publish later succeeds, a duplicate is
   possible. This is accepted for a manual action.
5. **No render limit.** Each use costs one render and disk space. `claimRender`'s disk budget still stops runaway use.
6. **Pending shares follow the new file (C1).** A pending, not-started share that comes due during the re-render waits
   for the file within its normal window. If the re-render fails, it can fail with "video file not found" at the end of
   its window. "Retry render" and then "Retry" recover it.
7. Size: server (command, sweep step, projector, audit, route, DTO), shared (event, DTO) and web (hook, UI), with tests.
   About 350 to 450 lines. The card is already marked large.

## 6. Acceptance criteria → design

| AC | Covered by |
|---|---|
| Rejected Instagram + succeeded render → new render, Instagram retried with the new file | 4.4 (revision + 1, queued row, marker) → worker renders `<postId>/<rev+1>` → 4.5 resets only that share → `runDestination` reads the new revision. Test: `FakeDestinations.payloads` last Instagram `filePath` contains `/<rev+1>/` and differs from the first. |
| Published destination not posted again, keeps state and link | 4.4 touches only the invoked share. 4.5 acts only on marked shares. Sent shares are never claimed. Test: Facebook `sent`, `external_id`/`url` unchanged, payload count for Facebook unchanged. |
| Failed (not only rejected) works the same | A rejection *is* `status='failed'` (2.2). There is one code path. Test with a `final` failure and with an `igfail` exhaustion. |
| Published/scheduled/pending → not shown, server 409 | 4.4 step 4 (`not_failed`). 4.11 shows the action only in the failed branch. |
| Render in progress / concurrent second request → 409, one render | 4.4 step 6 under the `video-post-edit` lock. Test: `Promise.all` of two calls → one 200, one 409 `render_in_progress`, exactly one new `video_renders` row. A queued render beforehand → 409. |
| Unknown post or destination → 404 | 4.4 steps 1 and 2. The route schema takes `network` as a string (4.9). |
| New render fails → failed render, "Retry render" works, destination failed with reason, old file not re-sent | 4.5 "Render failed" row. The marker keeps the share `failed`, so no upload happens. `retryRender` resets the new revision's row (unchanged code). After it renders, 4.5 retries with the new file. |
| Audit entry with actor, destination, render-again marker | 4.1 event fields, 4.3 audit summary and details. Rebuild replays via 4.2 (idempotent). |
| Same authorisation as the retry routes | 4.9 `requireSuperAdmin`. Member → 404, as in the existing retry test. |
| Existing Retry render / destination retry unchanged | No edits to `retryRender`, `retryShare`, `retryUpload` or `ensureFinalRender`. Their existing tests stay green. A regression test runs `retryShare` on a failed share: same file path (same revision). |

## 7. Test plan for the builder

New file `apps/server/test/video-rerender.test.ts`, in the style of `video-destinations.test.ts` (`createTestApp`, fake
`RenderFn` and `FakeDestinations`, `videoTick`):

1. Short with `instagram` and `facebook`. Instagram scripted `['igfail', ...]` until it fails, Facebook `ok`. Then POST
   `/shares/instagram/rerender` → 200. The post revision is 2, there is a new queued render row, and the share is still
   `failed` with `rerender` in the DTO. Tick: render, then retry. Instagram is `sent`, and its last payload `filePath`
   is under `/<postId>/2/` and differs from the first payload. Facebook is still `sent` with the same url, and was
   posted only once. The rev-1 render row and file still exist.
2. A `final` failure on X: the same flow works.
3. 409 `not_failed` for a sent destination (Facebook), a pending/scheduled one (a future slot, before any tick), and a
   skipped one.
4. 409 `render_in_progress` when the current render is queued. Two concurrent calls → one 409, one new row.
5. 404 for a random uuid post, a destination the post does not have, and an invalid network name. 404 for a member
   session and for an anonymous caller (same as `/shares/facebook/retry`).
6. Render fails: `RenderFn` throws until `maxAttempts`. The render is `failed`, the share is `failed` with an error that
   starts with "the new render failed:", and no new Instagram payload is sent. Then `retry-render` → tick →
   Instagram is retried with the rev-2 file.
7. Audit: a `platform_audit_log` row `VideoRetryRequested` with `details.what='render-again'`,
   `details.network='instagram'`, `details.revision=2`. Run `rebuildProjections`; afterwards `video_posts.revision` is
   still 2 and nothing throws.
8. Purge: run `cleanupVideos(force)` with the old render more than a day old while the marker is present → the rev-1 MP4
   is kept. After success, plus a day → it is purged.
9. YouTube: a share failed with `detail.videoId` and a non-rejection error → 409 `already_uploaded`. A rejected one is
   accepted, and the upload runs again without the old `videoId`.
10. Regression: the existing `retryShare` and `retryRender` tests are unchanged, and `retryShare` keeps the same revision
    and file path.

Web (`apps/web/src/test/video-panel.test.tsx`, which already covers `retry-facebook`):

11. `rerender-<dest>` is shown only for failed destinations, not for sent, pending or skipped ones. Clicking it POSTs
    `/shares/<dest>/rerender`. With a marker and a queued render, the "Rendering again" badge shows and both buttons are
    hidden. With a marker and a failed render, the "New render failed" badge, the reason and "Retry render" show. A 409
    response appears in the `ErrorBox`. Extend the URL regex at line ~198 to accept `/rerender`.

Run only the server and web unit suites, not e2e.
