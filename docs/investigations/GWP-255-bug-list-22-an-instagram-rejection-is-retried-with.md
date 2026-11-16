# GWP-255: an Instagram rejection is retried with the same file

## Question

When Instagram answers a Reels upload with `ProcessingFailedError`, the publish sweep sends the same unchanged MP4 again
(up to 4 attempts) and it fails every time. Wanted:
- classify the rejection as its own non-transient kind and stop re-sending the same artifact;
- check the file locally against the Reels rules and ask for a re-render instead of a retry;
- refuse a manual retry of the same file;
- make sure new renders meet the rules;
- if the file meets every rule and Instagram still rejects it, allow one bounded extra attempt, then alert.

## Findings

### 1. Where the retry comes from

- `apps/server/src/video/destinations.ts` `instagramError()` (l.299-323) maps `400 {"debug_info":{"type":"ProcessingFailedError"}}`
  to `new DestinationError('retry', msg, 'ig_processing', IG_PROCESSING_ATTEMPTS)` with `IG_PROCESSING_ATTEMPTS = 4`
  (l.289). The same helper turns Graph error 100 ("Unsupported post request / does not exist") and `is_transient`
  errors into that bounded retry.
- `postToInstagram()` calls `instagramError` on two calls. The container call (l.340) happens before any file is sent.
  The resumable upload (l.368) is where `ProcessingFailedError` comes from. After a failed upload it drops `igContainer`
  and `igUploaded`, so the next attempt creates a new container and uploads the same bytes again.
- `apps/server/src/video/sweep.ts` `runDestination()` (l.905-940): on `kind === 'retry'` it sets the share back to
  `pending` with back-off 1/5/30/120 min until `attempts >= err.maxAttempts`, then calls `fail()` with "gave up after N
  attempts", which also sends `alertOnce`.
- This was a deliberate choice in 1.7.0 (commit d436f031, `docs/BLOG-API.md` "Instagram processing failures (1.7.0)").
  Its reasoning was "one-off failures of files Instagram accepted at other times". The requirements override that for
  `ProcessingFailedError`. The recorded payload already in the tests says `"retriable": false`, which supports this change.

### 2. Is the file ours, and is it still bad?

- 1.7.0 added `MP4_MUX_ARGS = ['-movflags', '+faststart', '-use_editlist', '0']` (`packages/video/src/ffmpeg.ts:98`).
  Both encodes that write a published MP4 use it: `encodeArgs()` in `render.ts` (the Short and long render) and `toMp4Args()`.
- I probed both settings with the workstation's ffmpeg (`ffmpeg -v trace -i`, which prints the atom tree):
  - **Current final-encode arguments** (1080x1920, 30 fps, H.264 High, AAC 48 kHz): top level `ftyp, moov, mdat`, no `edts`/`elst`.
    The file is compliant.
  - **Pre-1.7.0 arguments** (the same encode without `MP4_MUX_ARGS`): top level `ftyp, mdat, moov`, and an `edts/elst` in both tracks.
    The file fails on both rules.
- So the edit-list and faststart cause has already been fixed for renders made after 1.7.0. The failing case is an
  **artifact rendered before 1.7.0** that is still on disk: the MP4 is kept until every destination is sent, or for 3
  days after a failure. A retry of that file can never work; only a **re-render** fixes it. That is why the requested
  re-render action matters more than the encoder change.
- The recorded help videos in `media/videos/*.mp4` also contain edit lists (24 of 36, for example `agents.mp4`: `edts/elst` in both
  tracks, 1280x720, 25 fps). They are library posts, which are `format: 'long'` and go to YouTube only (`importLibrary`,
  `video-posts.ts:1549`), so they never reach Instagram. Out of scope; noted for GWP-256.
- The static ffmpeg in the video-worker image (imageio-ffmpeg) has **no ffprobe** (`probeDuration` comment, `ffmpeg.ts:175`).
  The check must not depend on ffprobe.

### 3. The Reels rules

`DIAGNOSIS-SOCIAL.md` (release 1.7.0 working notes) is **outside every folder this workstation can read**: the planning step
could not read it, and neither could this investigation. The 1.7.0 code and docs show what it led to (no edit lists, faststart). The rule
values below come from Meta's current IG User Media reference ("Reels specifications"), fetched 2026-11-16:

| Rule | Meta value | Rule id |
|---|---|---|
| Container | MOV or MP4, **no edit lists**, **moov atom at the front** | `container`, `edit_list`, `faststart` |
| Video codec | HEVC or H.264, progressive scan, closed GOP, 4:2:0 chroma | `video_codec`, `video_profile`, `pixel_format`, `scan` |
| Frame rate | 23-60 fps | `frame_rate` |
| Picture size | at most 1920 columns; aspect 0.01:1 to 10:1 (9:16 recommended) | `width`, `aspect_ratio` (9:16 only a warning) |
| Video bitrate | VBR, at most 25 Mbps | `video_bitrate` |
| Audio | AAC, at most 48 kHz, 1 or 2 channels (no audio is allowed) | `audio_codec`, `audio_sample_rate`, `audio_channels` |
| Duration | 3 s to 15 min | `duration` |
| File size | at most 300 MB | `file_size` |

**Where this differs from the requirements:** they give "frame rate 60 > 30" as an example. Meta allows 23-60 fps, so the
limit is 60 and 30 is not a limit. Our renders use 30 fps. Closed GOP cannot be read from `ffmpeg -i`, so it is not
checked (libx264 writes closed GOPs by default). This is said in the code comment and the docs.

## Options

**A. State storage**
- A1: a new `social_shares.status` value `needs_rerender` (migration on the CHECK constraint). It would affect the
  phase computation (`video-posts.ts:340`), the clean-up queries (`status='failed'`), `retryShare`'s status filter,
  `VIDEO_UPLOAD_STATUSES`, every web enum and the cross-post shares. That is a lot of risk for other destinations, and
  old clients would fail to parse the new value.
- **A2 (chosen): keep `status='failed'` and add a structured record `detail.fileRejection` in the existing `detail` jsonb.**
  "Needs re-render" is derived from it. Old rows have no record and load and behave as before. Phase, clean-up and
  other destinations are unchanged. **No migration is needed:** no column or CHECK value changes, and the new DTO
  fields default to `null`.

**B. Where the check runs**
- **B1 (chosen): in the publish sweep (`runDestination`) on the video worker (publish role).** That process owns the video
  volume and the file, and the worker image ships the static ffmpeg. The check is injected through `SweepDeps`, so
  tests stub it.
- B2: in the API process. That process has no file and no ffmpeg. Rejected.

**C. How to read the MP4**
- **C1 (chosen): a small TypeScript ISO-BMFF box walker** for the structural rules (`ftyp` brand, `moov` before `mdat`,
  `trak/edts/elst`). It is exact, needs no binary, and can be unit-tested on small committed fixtures. Add **`ffmpeg -i` stderr
  parsing** (the same approach as `probeDuration`) for stream facts: codec and profile, pixel format, scan, fps, size,
  bitrate, audio codec, sample rate and channels, duration.
- C2: ffprobe JSON. It is not in the static build. Rejected.
- C3: grep the bytes for `elst` (the current test). It gives false positives from `mdat` content. Rejected for production.

**D. The re-render action**
- `retryRender` only accepts a **failed** render (`status='failed'`). A rejected file has a `rendered` render, so this
  change needs an equivalent: **`rerenderVideo`** (below). GWP-256 (a related open item) asks for exactly this
  generally ("no way to re-render a video that a network rejected"). Build it here so it can be widened there, not
  duplicated.

## Recommendation and design

### Data model (no migration)

`social_shares.detail.fileRejection` for the `instagram` share:

```ts
interface FileRejection {
  kind: 'needs_rerender'      // the check found failed rules: only a new file helps
      | 'rejected_compliant'  // the file meets every rule; Instagram still refused it
      | 'check_failed';       // the check itself could not run (no ffmpeg, unreadable file)
  /** Which file was refused: a re-render rewrites the render row, so finishedAt changes. */
  artifact: { renderId: string; finishedAt: string | null; bytes: number };
  /** ProcessingFailedError answers for THIS artifact (1 or 2). This is the per-artifact counter. */
  rejections: number;
  at: string;                 // ISO
  error: string;              // Instagram's message (trimmed)
  check: ReelsCheck | null;
}
```

Fingerprint equality is `renderId && finishedAt && bytes`, all equal to the current render row. `retryRender` and
`rerenderVideo` rewrite `finished_at`, so a new file never matches an old record. The check also returns a
`sha256` of the file for the audit only, not for the comparison. That way the API never has to hash a 50 MB file during a request.

`packages/shared/src/video/post.ts` (the Zod result schema, shared by the server and the web app):

```ts
export const REELS_RULE_IDS = ['readable','container','edit_list','faststart','video_codec','video_profile',
  'pixel_format','scan','frame_rate','width','aspect_ratio','video_bitrate','duration','file_size',
  'audio_codec','audio_sample_rate','audio_channels'] as const;
export const ReelsCheckSchema = z.object({
  passed: z.boolean(),
  checkedAt: IsoTime,
  failed: z.array(z.object({
    rule: z.enum(REELS_RULE_IDS),
    message: z.string(),            // 'edit list present (video, audio)', 'moov not at start', 'frame rate 120 > 60'
    measured: z.string().nullable(),
    limit: z.string(),
  })),
  warnings: z.array(z.string()),    // 'aspect ratio 16:9 (9:16 recommended)'
  measured: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  sha256: z.string().optional(),
});
export const VIDEO_FILE_REJECTIONS = ['needs_rerender', 'rejected_compliant', 'check_failed'] as const;
// VideoShareSchema gets (defaults keep old rows and old clients working):
fileRejection: z.enum(VIDEO_FILE_REJECTIONS).nullable().default(null),
reelsCheck: ReelsCheckSchema.nullable().default(null),
```

### packages/video: the check and the rule values (one place)

New `packages/video/src/reels.ts`, exported from `index.ts`:

```ts
/** Meta's Reels container rules (IG User Media reference, checked 2026-11-16). Update here when Meta changes them. */
export const REELS_LIMITS = {
  containers: ['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','qt  ','M4V '],
  editList: false, faststart: true,
  videoCodecs: ['h264','hevc'], h264Profiles: ['Baseline','Constrained Baseline','Main','High'],
  pixelFormats: ['yuv420p','yuvj420p'], progressive: true,
  fps: { min: 23, max: 60 }, maxWidth: 1920, aspect: { min: 0.01, max: 10 }, recommendedAspect: 9 / 16,
  maxVideoKbps: 25_000, durationS: { min: 3, max: 900 }, maxBytes: 300 * 1024 * 1024,
  audioCodecs: ['aac'], maxSampleRate: 48_000, channels: { min: 1, max: 2 },
} as const;

/** Pure: the box tree facts (no binary). Exported for tests. */
export function mp4Structure(file: string): { brand: string | null; topLevel: string[]; moovBeforeMdat: boolean;
  editListTracks: string[] /* handler type of each trak with edts/elst: 'vide', 'soun' */ };
/** Pure: stream facts from `ffmpeg -i` stderr. Exported for tests on recorded stderr text. */
export function parseStreamInfo(stderr: string): StreamInfo;
/** Pure: facts + limits -> ReelsCheck. */
export function evaluateReels(facts: ReelsFacts, limits = REELS_LIMITS): ReelsCheck;
/** The whole check on a file (async execFile, findFfmpeg(RENDER_ENCODERS)). Never throws for a bad file:
 *  an unreadable file is a failed 'readable' rule. It throws only when no ffmpeg is found. */
export async function checkReelsFile(file: string, opts?: { bin?: string }): Promise<ReelsCheck>;
```

Box walker notes: read the file with `open` and `read` (do not `readFile` 300 MB). Walk top-level boxes by size, with
64-bit `size==1` and `size==0` meaning "to the end of the file". Descend only `moov > trak > (edts, mdia > hdlr)`.
An `edts` holding an `elst` with entries counts as present. Report which track (from `hdlr`) has it.

**Encoder (AC8):** no setting changes are needed. `MP4_MUX_ARGS` already gives a clean file (see the probe above).
Replace the byte-grep test at `packages/video/test/video.test.ts:166-202` with `checkReelsFile()` on a freshly encoded
fixture, for both `encodeArgs()` and `toMp4Args()` (lavfi testsrc + sine input, 1080x1920, 4 s, `skipIf(!ffmpegAvailable())`).
Assert `passed` with no `edit_list` or `faststart` failure. Changing nothing in the encode means YouTube and TikTok output
cannot get worse.

### apps/server: classification (`destinations.ts`)

- `DestinationErrorKind = 'auth' | 'retry' | 'final' | 'file'`. Doc comment: "the network refused this very file
  while processing it; sending the same bytes again cannot help". Only Instagram produces it.
- In `instagramError()`, the `ProcessingFailedError` branch becomes
  `new DestinationError('file', msg, 'ig_processing_failed')`, with no `maxAttempts`.
  The Graph 100 / `is_transient` branch stays as it is (`'retry'`, `IG_PROCESSING_ATTEMPTS`): it comes from the container call, before any
  file is sent, so it is not about the file. Update the doc comment above `IG_PROCESSING_ATTEMPTS` to match.
- Keep the container clean-up in the upload branch (`delete s.igContainer / igUploaded`).
- Do not touch `graphError`, `httpError`, `mayBePosted` or any other destination.

### apps/server: sweep (`sweep.ts`)

- `SweepDeps.reelsCheck?: (file: string) => Promise<ReelsCheck>`. The default lazily imports `checkReelsFile` from
  `@aom/video` (like `defaultRender`). Change `postNextDestination(ctx, deps = {})` to pass deps to
  `runDestination(ctx, share, deps)`, and have `videoTick` pass its `deps`.
- In `runDestination`, once `file` is known, compute `fp = { renderId: render.id, finishedAt: iso(render.finished_at), bytes }`.
  Let `rej = detail.fileRejection` when `network === 'instagram'`.
- **Pre-flight (before `publish`), Instagram only:**
  - If `rej` matches `fp` and `rej.kind !== 'rejected_compliant'`, or it matches with `rejections >= 2`: call
    `fail(...)` with the stored reason and **do not call Instagram**. This guards against a share that was set back to
    `pending` some other way.
  - If `rej` exists and does **not** match `fp` (a re-rendered file): run `reelsCheck(file)` first. If it fails, record a new
    `needs_rerender` with `rejections: 0` (no Instagram call was made), emit the events, `fail()`, and return. If it passes, go on to publish.
- **Catch** for `err instanceof DestinationError && err.kind === 'file'`. Handle it before the `final/exhausted`
  branch. `attempts` still goes up as before.
  1. Same artifact already recorded (`rej` matches `fp`): set `rejections = rej.rejections + 1`, keep the stored check,
     `fail("Instagram rejected this file again although it meets the Reels rules; it is not sent again: <msg>", alert=true)`.
     That is the bounded end (AC9). The `kind` stays `rejected_compliant`.
  2. First rejection of this artifact: `check = await reelsCheck(file)`, inside its own try. If the check throws, `kind = 'check_failed'`.
     - `!check.passed` → `needs_rerender`: error text
       `"Instagram could not process the video; it needs a new render: " + failed.map(f => f.message).join('; ')`, then `fail(..., true)`.
     - `check.passed` → `rejected_compliant`, `rejections: 1`. Log it explicitly
       (`ctx.log.warn({postId, check}, 'Instagram rejected a file that meets the Reels rules; one more attempt')`).
       Set the share `pending` with `next_attempt_at = now + 5 min` and `detail.dest` cleared, as long as this is inside the window
       (else `fail`). This is the single extra attempt.
     - `check_failed` → `fail("the file could not be checked against the Reels rules: <e>", true)`. Do not retry automatically.
  3. Save `detail.fileRejection` in the same `UPDATE` as the status (one `setShare`), so a crash cannot leave a pending
     share without its record.
- **Event stream (AC3, audit constraint):** a new event `VideoFileChecked` (defined in `packages/shared/src/events/video.ts`):
  `{ postId, network: 'instagram', renderId, passed, failed: [{rule, message}] (max 20), outcome: 'needs_rerender' | 'one_more_attempt' | 'check_failed' | 'preflight_ok' }`.
  It is written on every check. Add an entry in `projections/platform-audit.ts`
  (`"Instagram file check: edit list present; moov not at start (<title>)"`). The existing `SocialShareFailed`
  (final) is still written by `fail()`.
- `alertOnce(ctx, 'instagram', …, true)` is used for `needs_rerender`, `check_failed` and the second compliant rejection.
  Note: `alertOnce` mails only when the channel's `alerted_at` is null. This is the existing per-channel behaviour and the requirements name it.

### apps/server: commands and routes (`commands/video-posts.ts`, `routes/video-platform.ts`)

- `toDtos`: for each non-YouTube share, `fileRejection` is `detail.fileRejection?.kind` **only while `status === 'failed'`**,
  else `null`. `reelsCheck` is `detail.fileRejection?.check ?? null`.
- **`retryShare` guard (AC6):** select `r.finished_at` and `r.bytes` too. For `network === 'instagram'`, when
  `detail.fileRejection` is present, its fingerprint matches the current render, and `art.video` is still present (the
  same file would be sent), throw
  `conflict('needs_rerender', 'Instagram rejected this video file: it needs a new render (' + reasons + '). Use Re-render.')`.
  Also refuse when `kind === 'rejected_compliant'` and `rejections >= 2` (the per-artifact bound), with code `needs_rerender` and a
  message saying it was rejected twice. Do **not** refuse when the MP4 was purged: that path already re-renders, so a new file is made.
  `retryUpload` is YouTube-only (`retryShare(..., 'youtube')`), so the guard never applies to it. Say so in a test
  so the "retryUpload" requirement is covered.
- **New `rerenderVideo(ctx, by, postId)`**, route `POST /api/platform/video/posts/:id/rerender` (super admin, same
  guard as `retry-render`). In one transaction:
  1. 404 if the post is unknown. 409 `not_scheduled` unless approved. 409 `library_video` for a library render. 409
     `no_rerender_needed` unless the current render is `rendered` and at least one `source='video'` share is `failed` with
     `detail.fileRejection.kind` in (`needs_rerender`, `rejected_compliant`). 409 `already_started` if any share of the post is
     `posting` (a destination is reading the file right now).
  2. `UPDATE video_renders SET status='queued', attempts=0, error=NULL, lease_until=NULL, purged_at=NULL, artifacts='{}'::jsonb, bytes=NULL, duration_s=NULL, finished_at=NULL, not_before=NULL, preview=false WHERE id=$1 AND status='rendered'`
     (the same reset `retryShare` uses for a purged file).
  3. For each share with such a record: `status='pending', attempts=0, error=NULL, next_attempt_at=now, detail=(detail - 'dest') || {retryAt: now}`.
     Keep `fileRejection`: the new render's `finishedAt` differs, so the pre-flight check runs on the new file (AC7).
     The share shows "waiting for the video file" until the render lands. The other shares are not touched.
  4. `auditRetry(ctx, postId, 'rerender', by)`: extend `VideoRetryRequested.what` with `'rerender'` and add the label in
     `platform-audit.ts` ("render made again after a network rejected the file").
- Note on stale files: the old MP4 on disk is no longer referenced once `artifacts` is `{}`. The new render writes its own
  artifacts, and the clean-up handles the rest as today.

### apps/web

- `apps/web/src/api/queries/video.ts`: add `'rerender'` to `useRetryVideo`'s `what` union (the URL is `/platform/video/posts/:id/rerender`).
- `QueueCalendar.tsx` `destinationStates()` / `ScheduledPost`:
  - A share with `fileRejection` in (`needs_rerender`, `rejected_compliant`) is **not** in `failedDestinations` (no
    "Retry Instagram" button).
  - Show a "Re-render for Instagram" button (`data-testid="rerender-instagram"`) that calls `rerender`.
  - Icons/state label: "needs re-render" with the warning tone.
- `VideoReview.tsx` shares list (`data-testid="video-shares"`): for such a share, render a `Callout tone="warning"` with the title
  "Instagram needs a new render". Its body is a list of `reelsCheck.failed[].message`; for `rejected_compliant` it reads "The file meets the
  Reels rules; Instagram still refused it twice. Re-render or check the account." The `actions` slot holds the "Re-render" button
  (the same mutation). Do not show a retry-share button for it.
- All devices and touch: the reasons are visible text (a list), not a tooltip or `title`. The buttons use the existing
  `Button size="sm"` (a touch target that wraps in the flex row), and nothing depends on hover.

### Docs

Update `docs/BLOG-API.md` "Instagram processing failures (1.7.0)":
- `ProcessingFailedError` is no longer retried. The Reels check, the "needs re-render" state, the `rerender` endpoint
  and the 409 `needs_rerender` on `/shares/instagram/retry` are described.
- The rule table points at `REELS_LIMITS`.

Add one line to `docs/VIDEO-RENDERER.md` saying `checkReelsFile` exists.

## Acceptance criteria → design

| AC | Where | Test |
|---|---|---|
| 1 own failure kind | `instagramError` → `DestinationError('file','…','ig_processing_failed')` | `video-destinations-client.test.ts`: change the test at ~l.183-211 on purpose. The recorded payload (`debug_info.retriable:false, type ProcessingFailedError`) → `kind:'file'`, no `maxAttempts`, container dropped, no publish. Add: 503 / network error is still `retry`; Graph 100 is still `retry` with `IG_PROCESSING_ATTEMPTS` |
| 2 no re-send across N ticks | share `failed` + pre-flight guard | `video-destinations.test.ts`: change "retried with back-off, then posted" (~l.525) and "gives up after its number of attempts" on purpose. Script `igfile` (throws `'file'`) with a stub `reelsCheck` that fails. Run 10 ticks while advancing the clock: Instagram `payloads` count stays 1 and the check is called once. Also set the share to `pending` by SQL and tick: still no call (the guard) |
| 3 check stored + event | `fileRejection.check`, `VideoFileChecked` | the same test: DTO `shares[instagram].reelsCheck.failed` lists the rules with measured values, and an events row of type `VideoFileChecked` exists on `video-<id>` |
| 4 edit list flagged / clean passes | `mp4Structure` + `evaluateReels` | `packages/video/test/reels.test.ts` on committed fixtures (see below), plus `parseStreamInfo` on recorded stderr (fps 120, 2160 wide, 2 s, 16 min, yuv444p, vp9, 96 kHz audio) for each rule |
| 5 UI state + re-render | `QueueCalendar`, `VideoReview` | `apps/web/src/test/` component test: an Instagram share with `fileRejection:'needs_rerender'` shows the reasons and `rerender-instagram`, and no `retry-instagram` |
| 6 409 manual retry | `retryShare` guard | the server test: `POST /shares/instagram/retry` → 409 `needs_rerender` with "new render" in the message. A purged file is accepted. `retry-upload` (YouTube) is unaffected |
| 7 re-render then post | `rerenderVideo` + pre-flight | `POST /rerender` → render queued; fake render produces a new artifact, the stub check passes, the next tick posts to Instagram (`sent`). Variant: the stub check fails on the new file → `needs_rerender` again with 0 extra Instagram calls |
| 8 fresh render clean | `MP4_MUX_ARGS` (unchanged) | ffmpeg-gated probe of `encodeArgs` and `toMp4Args` output with `checkReelsFile` |
| 9 compliant: at most 1 extra, alert, no loop | `rejected_compliant` / `rejections` | stub check passes and the script gives `igfile` ×5: exactly 2 Instagram calls over 10 ticks, then `failed`, one mail, and manual retry → 409 |
| 10 other destinations unchanged | only `instagramError` and the `kind==='file'` branch | the existing facebook/x/linkedin/bluesky/tiktok tests stay green unchanged. Add: a post with instagram + bluesky where instagram gets `igfile` → bluesky is still `sent` |

**Fixtures:** commit three small MP4s under `packages/video/test/fixtures/reels/` (320x568, 1 s, about 10-20 KB each),
made once with the workstation ffmpeg:
- `editlist.mp4`: the encode without `MP4_MUX_ARGS`, which gives an `elst` and moov at the end;
- `moov-at-end.mp4`: `-use_editlist 0` without `+faststart`;
- `compliant.mp4`: with `MP4_MUX_ARGS`.

Put the ffmpeg commands in a `README.md` next to them, so the structural tests run without ffmpeg. Note:
`compliant.mp4` is 320 px wide, which is allowed (only a maximum width exists). Its duration is 1 s, so test the
structural rules on it with `mp4Structure`, and use a 4 s render for the full `checkReelsFile` pass.

## Risks and traps

- **Existing tests assert the old retry** (`video-destinations.test.ts` ~l.47-60 stub `igfail`, ~l.525; `video-destinations-client.test.ts`
  ~l.183-211, 264). Change them on purpose; do not delete the coverage of the Graph 100 / transient retry, which stays.
- `kind === 'file'` must be handled **before** `kind === 'final' || exhausted || deadline`. Otherwise it falls into the
  generic `pending` back-off branch, which is the bug again.
- `alertOnce` only mails if `social_channels.alerted_at` is null. That is the accepted existing behaviour.
- The check runs `ffmpeg -i` with async `execFile` (never `execFileSync` in the sweep: an IG upload is already a long step).
  It needs a timeout of about 60 s.
- A render-role-only worker (`AOM_VIDEO_ROLE=render`) never runs the sweep, so the check runs only on the publish side,
  which owns the file. GWP-263 touches `video-worker.ts` / `push.ts`; this design does not change `video-worker.ts`.
- `rerenderVideo` while YouTube is still `pending` and not uploaded: the upload waits for the new render
  (`uploadNext` requires `RENDERED`). This is intended: YouTube also gets the corrected file.
- Not in scope: a container `status_code: ERROR` during polling is already `final` (no loop). Running the check there too
  would be a small follow-up.

## Size

Large: about 600-800 changed lines across packages/video (new module, fixtures, tests), packages/shared, server (destinations, sweep,
commands, route, events, audit), web (two components, query, test) and docs. It is already marked `large`.
