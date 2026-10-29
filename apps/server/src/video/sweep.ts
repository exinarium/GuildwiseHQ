import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  type BlueskyFacet,
  composeCaption,
  defaultVideoCaption,
  SCHEDULE_DEFAULTS,
  TikTokOptionsSchema,
  VIDEO_CAPTION_LIMITS,
  VIDEO_LIMITS,
  VIDEO_POST_LIMITS,
  type VideoCaptions,
  type VideoPostMeta,
  type VideoScript,
} from '@aom/shared';
import { decryptSecret } from '../auth/secrets.ts';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import { alertOnce, SHARE_BACKOFF_MS, superAdminEmails } from '../commands/social.ts';
import { freshTiktokToken } from '../commands/tiktok.ts';
import {
  artifactPath,
  beatHeartbeat,
  ensureFinalRender,
  insertLibraryRender,
  libraryDescription,
  nextFreeSlotOf,
  renderDir,
  renderStart,
  slipVideoPost,
  videoActive,
  videoPostStream,
  videoSettings,
  videoStorageUsed,
  withLock,
  workerHeartbeat,
} from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { videoAlertMail, videoLockedMail } from '../mail/blog-mail.ts';
import { DestinationError, type DestinationPayload, type ShortDestination } from './destinations.ts';
import { libraryCatalog } from './library.ts';
import { signedMediaUrl } from './media-url.ts';
import { type PushDeps, pushArtifacts } from './push-client.ts';
import { watchUrl, YouTubeError } from './youtube.ts';

/**
 * The video worker's loop (`video-worker --loop`, a separate container): one pass does, in this order,
 *   1. a heartbeat (the UI shows "video worker not running" when it is stale),
 *   2. nothing else unless a YouTube channel is connected (status ok) AND `videoPosts.enabled` (with no channel only an
 *      explicit preview renders),
 *   3. the watch (a post that will not be rendered in time slips to the next slot, alerts), 4. the rendered posts get
 *   their destination rows, 5. ONE render is claimed (a lease, 3 attempts, one at a time; only a scheduled post whose
 *   `not_before` has passed, or an explicit preview), 6. ONE upload at a time (YouTube, `publishAt` = the slot),
 *   7. the cleanup of files nobody needs any more.
 * The render and the YouTube client are injected so tests never render or reach Google.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
const LEASE_MS = 40 * 60_000;
const STALE_POSTING_MS = 30 * 60_000;
const PUBLISH_AT_MARGIN_MS = 15 * 60_000;
const DAY = 86_400_000;
/** A video with no slot (publish now) waits this long for its file to arrive. */
const WAIT_FOR_FILE_MS = 60 * 60_000;

export interface RenderOutcome {
  artifacts: {
    video: string;
    captionsVtt: string;
    captionsSrt: string;
    thumb: string | null;
    script: string;
    description: string;
    log: string;
  };
  durationSeconds: number;
  bytes: number;
}
export type RenderFn = (
  script: VideoScript,
  opts: { outDir: string; log: (l: string) => void },
) => Promise<RenderOutcome>;

export interface SweepDeps {
  /** Defaults to `renderScript` of video/renders.ts (loaded on first use: it pulls in Playwright and ffmpeg). */
  render?: RenderFn;
  /** The artifact push (fetch, sleep and backoff); tests inject fakes. */
  push?: PushDeps;
  /** Overrides `AOM_VIDEO_ROLE`. */
  role?: 'render' | 'publish' | 'all';
}

const defaultRender: RenderFn = async (script, opts) => {
  const { renderScript } = await import('./renders.ts');
  return renderScript(script, { outDir: opts.outDir, log: opts.log });
};

// ---- renders

/**
 * Scheduled posts that need a render row but have none (a crash between the event and the insert), and renders nobody
 * wants. A post in review gets no row here: only an explicit preview renders before scheduling.
 */
async function healRenders(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const missing = await rows(
    ctx.pool,
    `SELECT p.id, p.revision, p.format, p.script, p.slot_at, p.publish_mode FROM video_posts p
      WHERE p.script IS NOT NULL AND p.status = 'approved'
        AND NOT EXISTS (SELECT 1 FROM video_renders r WHERE r.post_id = p.id AND r.revision = p.revision)`,
  );
  for (const p of missing) {
    const slot = p.slot_at ? new Date(p.slot_at) : now;
    await ensureFinalRender(ctx, p as never, await renderStart(ctx, p.format, slot, p.publish_mode ?? 'now'));
  }
  await exec(
    ctx.pool,
    `UPDATE video_renders r SET status='failed', error='superseded by a newer revision', finished_at=$1
       FROM video_posts p
      WHERE p.id = r.post_id AND r.revision < p.revision AND r.status = 'queued' AND NOT r.library`,
    [now],
  );
  // a library post whose render row was never written (a crash between its event and the insert)
  const lib = await rows(
    ctx.pool,
    `SELECT p.id, p.ref, p.revision FROM video_posts p
      WHERE p.script IS NULL AND p.ref LIKE 'lib:%'
        AND NOT EXISTS (SELECT 1 FROM video_renders r WHERE r.post_id = p.id AND r.revision = p.revision)`,
  );
  if (lib.length) {
    const catalog = libraryCatalog();
    for (const p of lib) {
      const e = catalog.find((c) => `lib:${c.slug}` === p.ref);
      if (e) await insertLibraryRender(ctx, p.id, e, p.revision);
    }
  }
  // a render whose worker died three times
  await exec(
    ctx.pool,
    `UPDATE video_renders SET status='failed', error='the render did not finish', finished_at=$1
      WHERE status='rendering' AND lease_until < $1 AND attempts >= $2`,
    [now, VIDEO_POST_LIMITS.maxAttempts],
  );
}

/** A render that may start: of an approved post once its `not_before` has passed, or an explicit preview in review. */
const CLAIMABLE = `NOT x.library AND p.script IS NOT NULL
  AND ((p.status='approved' AND (x.not_before IS NULL OR x.not_before <= $1))
       OR (x.preview AND p.status IN ('draft','in_review')))
  AND ((x.status='queued' AND (x.lease_until IS NULL OR x.lease_until <= $1))
       OR (x.status='rendering' AND x.lease_until < $1))
  AND x.attempts < $2`;

async function claimRender(ctx: Ctx, previewsOnly = false): Promise<Row | undefined> {
  const now = ctx.clock.now();
  const claimable = previewsOnly ? `${CLAIMABLE} AND x.preview` : CLAIMABLE;
  // the disk budget: nothing starts while the rendered videos on disk plus room for one more pass the limit
  const waiting = await one(
    ctx.pool,
    `SELECT 1 AS x FROM video_renders x JOIN video_posts p ON p.id = x.post_id AND p.revision = x.revision
      WHERE ${claimable} LIMIT 1`,
    [now, VIDEO_POST_LIMITS.maxAttempts],
  );
  if (!waiting) return undefined;
  const used = await videoStorageUsed(ctx);
  if (used + VIDEO_POST_LIMITS.renderReserveBytes > ctx.config.videoMaxBytes) {
    await alertVideoOnce(
      ctx,
      `storage:${now.toISOString().slice(0, 10)}`,
      'The video disk is full',
      `Rendered videos take ${Math.round(used / 1024 ** 2)} MB of the ${Math.round(ctx.config.videoMaxBytes / 1024 ** 2)} MB budget (AOM_VIDEO_MAX_BYTES), so no new render starts until published videos are cleaned up.`,
    );
    return undefined;
  }
  // one render at a time even with several render workers: the claim runs under a transaction-scoped advisory lock, so
  // two workers cannot both see "nothing is rendering" (READ COMMITTED would let them)
  const db = await ctx.pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('video-render-claim'))`);
    const claimed = await one(
      db,
      `UPDATE video_renders r SET status='rendering', lease_until=$3, attempts=r.attempts+1, error=NULL
        WHERE r.id = (
          SELECT x.id FROM video_renders x JOIN video_posts p ON p.id = x.post_id AND p.revision = x.revision
           WHERE ${claimable}
             AND NOT EXISTS (SELECT 1 FROM video_renders y WHERE y.status='rendering' AND y.lease_until >= $1)
           ORDER BY x.not_before NULLS FIRST, p.slot_at NULLS LAST, x.created_at LIMIT 1 FOR UPDATE OF x SKIP LOCKED)
        RETURNING r.*`,
      [now, VIDEO_POST_LIMITS.maxAttempts, new Date(now.getTime() + LEASE_MS)],
    );
    await db.query('COMMIT');
    return claimed;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

/** Claims and renders one queued render (only previews with `previewsOnly`). Returns true when it did something. */
export async function renderNext(ctx: Ctx, deps: SweepDeps = {}, previewsOnly = false): Promise<boolean> {
  const r = await claimRender(ctx, previewsOnly);
  if (!r) return false;
  const post = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [r.post_id]);
  const root = ctx.config.videoDir;
  const outDir = join(root, renderDir(r.post_id, r.revision));
  const lines: string[] = [];
  const beat = setInterval(() => {
    void beatHeartbeat(ctx, 'render', { busy: 'render' }).catch(() => {});
    void exec(
      ctx.pool,
      `UPDATE video_renders SET lease_until=$2 WHERE id=$1 AND status='rendering' AND attempts=$3`,
      [r.id, new Date(ctx.clock.now().getTime() + LEASE_MS), r.attempts],
    ).catch(() => {});
  }, 30_000);
  try {
    const script = post?.script as VideoScript | null;
    if (!script) throw new Error('the post has no script');
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    const out = await (deps.render ?? defaultRender)(script, { outDir, log: (l) => lines.push(l) });
    const max = VIDEO_LIMITS.maxSeconds[script.format];
    if (out.durationSeconds > max) {
      await exec(
        ctx.pool,
        `UPDATE video_renders SET status='failed', attempts=$3, error=$2, finished_at=$4, lease_until=NULL
          WHERE id=$1 AND status='rendering' AND attempts=$5`,
        [
          r.id,
          `the video is ${Math.round(out.durationSeconds)} seconds; the limit is ${max}. Shorten the script.`,
          VIDEO_POST_LIMITS.maxAttempts,
          ctx.clock.now(),
          r.attempts,
        ],
      );
      return true;
    }
    const rel = (p: string | null) => (p ? relative(root, p) : null);
    const a = out.artifacts;
    // a render worker that is not on the machine with the video volume pushes every file to production first; the render
    // is `rendered` only once all of them are acknowledged, and the local copy goes after that
    const pushing = !!(ctx.config.videoPushUrl && ctx.config.videoWorkerToken);
    if (pushing) {
      const files = Object.values(a).filter((f): f is string => !!f && existsSync(f));
      await pushArtifacts(
        { baseUrl: ctx.config.videoPushUrl as string, token: ctx.config.videoWorkerToken as string },
        r.id,
        files,
        deps.push,
      );
    }
    await exec(
      ctx.pool,
      `UPDATE video_renders SET status='rendered', lease_until=NULL, error=NULL, duration_s=$2, bytes=$3, artifacts=$4::jsonb, finished_at=$5
        WHERE id=$1 AND status='rendering' AND attempts=$6`,
      [
        r.id,
        out.durationSeconds,
        out.bytes,
        JSON.stringify(
          Object.fromEntries(
            Object.entries({
              video: rel(a.video),
              captionsVtt: rel(a.captionsVtt),
              captionsSrt: rel(a.captionsSrt),
              thumb: rel(a.thumb),
              script: rel(a.script),
              description: rel(a.description),
              log: rel(a.log),
            }).filter(([, v]) => v),
          ),
        ),
        ctx.clock.now(),
        r.attempts,
      ],
    );
    if (pushing) {
      await rm(outDir, { recursive: true, force: true });
      await rmdir(join(root, r.post_id)).catch(() => {}); // the post's folder too, unless another revision is in it
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);
    const final = (r.attempts as number) >= VIDEO_POST_LIMITS.maxAttempts;
    await exec(
      ctx.pool,
      // a stale worker (its lease ran out and the render was reclaimed) must not overwrite the new owner's row; a failed
      // attempt waits attempts x 1 minute before the next one
      `UPDATE video_renders SET status=$2, error=$3, lease_until=$6, finished_at=$4
        WHERE id=$1 AND status='rendering' AND attempts=$5`,
      [
        r.id,
        final ? 'failed' : 'queued',
        message,
        final ? ctx.clock.now() : null,
        r.attempts,
        final ? null : new Date(ctx.clock.now().getTime() + (r.attempts as number) * 60_000),
      ],
    );
    ctx.log.warn({ err, postId: r.post_id }, 'video render failed');
  } finally {
    clearInterval(beat);
  }
  return true;
}

// ---- uploads

/** How long after its slot a destination keeps trying (retries with back-off) before the share fails for good. */
export const POST_WINDOW_MS = 6 * 3_600_000;

/** A render of the post's revision that finished and still has its video (or is a recorded help video). */
const RENDERED = `EXISTS (SELECT 1 FROM video_renders r WHERE r.post_id = p.id AND r.status = 'rendered'
                            AND (r.id = p.approved_render_id OR r.revision = p.revision)
                            AND (r.library OR r.purged_at IS NULL))`;

/**
 * Rendered, approved posts get a share row per destination. YouTube is uploaded at once (its own `publishAt` is the slot);
 * every other destination is posted by `postNextDestination` when its slot is due (`next_attempt_at` = the slot, or now for
 * "publish now"). A destination whose channel is not connected is created `skipped` ("retry" after connecting). A post with
 * no destinations (an older one) goes to YouTube.
 */
async function createMissingUploads(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO social_shares (post_id, network, source, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT p.id, 'youtube', 'video', 'pending', 0, $1, $1, $1 FROM video_posts p
      WHERE p.status='approved' AND ('youtube' = ANY(p.destinations) OR cardinality(p.destinations) = 0)
        AND ${RENDERED}
     ON CONFLICT (post_id, network) DO NOTHING`,
    [now],
  );
  await exec(
    ctx.pool,
    `INSERT INTO social_shares (post_id, network, source, status, attempts, next_attempt_at, error, created_at, updated_at)
     SELECT p.id, d.network, 'video',
            CASE WHEN c.network IS NULL THEN 'skipped' ELSE 'pending' END, 0,
            CASE WHEN c.network IS NULL THEN NULL WHEN p.publish_mode = 'slot' AND p.slot_at IS NOT NULL THEN p.slot_at ELSE $1::timestamptz END,
            CASE WHEN c.network IS NULL THEN 'not connected: connect the account under Social sharing, then retry' END,
            $1, $1
       FROM video_posts p CROSS JOIN LATERAL unnest(p.destinations) AS d(network)
       LEFT JOIN social_channels c ON c.network = d.network
      WHERE p.status='approved' AND d.network <> 'youtube' AND ${RENDERED}
     ON CONFLICT (post_id, network) DO NOTHING`,
    [now],
  );
  // an upload that died mid-way resumes (its session and video id are in `detail`), it is never started a second time
  await exec(
    ctx.pool,
    `UPDATE social_shares SET status='pending', updated_at=$1
      WHERE source='video' AND status='posting' AND updated_at < $2`,
    [now, new Date(now.getTime() - STALE_POSTING_MS)],
  );
}

/**
 * May this share start uploading? One upload runs at a time, and none while a video YouTube kept private waits for the
 * owner. `self` is the share being claimed. (There is no limit per day any more: the schedule decides when a video is public.)
 */
async function uploadAllowed(ctx: Ctx, self: Row): Promise<boolean> {
  const busy = await one(
    ctx.pool,
    `SELECT 1 AS x FROM social_shares
      WHERE source='video' AND network='youtube' AND post_id <> $1 AND status IN ('posting','locked_private')`,
    [self.post_id],
  );
  return !busy;
}

type Detail = {
  sessionUri?: string;
  sessionStartedAt?: string;
  videoId?: string;
  uploadedAt?: string;
  publishAt?: string | null;
  privacy?: string;
  /** The worker saw the video public after its slot (or the owner said so). */
  verifiedAt?: string;
  lastCheckedAt?: string;
  steps?: Record<string, string>;
  warnings?: string[];
};

async function saveDetail(
  ctx: Ctx,
  share: Row,
  detail: Detail,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sets = ['detail=$3::jsonb', 'updated_at=$4'];
  const params: unknown[] = [share.post_id, share.network, JSON.stringify(detail), ctx.clock.now()];
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k}=$${params.length}`);
  }
  await exec(ctx.pool, `UPDATE social_shares SET ${sets.join(', ')} WHERE post_id=$1 AND network=$2`, params);
}

/** What went wrong with the OAuth client or token: pause the channel (invalid_grant only) and mail once. */
async function pauseChannel(ctx: Ctx, message: string): Promise<void> {
  await exec(ctx.pool, `UPDATE social_channels SET status='needs_reconnect' WHERE network='youtube'`);
  await alertOnce(ctx, 'youtube', message);
}

/**
 * Calls into YouTube with a fresh access token. An access token lasts an hour: a 401 mints another and repeats the call
 * once before anything is concluded. Only the token endpoint's `invalid_grant` (kind `auth`) means "reconnect".
 */
async function youtubeCalls(ctx: Ctx, ch: Row) {
  const { youtubeClientId: clientId, youtubeClientSecret: clientSecret } = ctx.config;
  if (!clientId || !clientSecret)
    throw new YouTubeError('config', 'AOM_YOUTUBE_CLIENT_ID and AOM_YOUTUBE_CLIENT_SECRET are not set');
  const { refreshToken } = JSON.parse(await decryptSecret(ctx, ch.access_token)) as { refreshToken: string };
  const mint = () => ctx.youtube.accessToken({ clientId, clientSecret, refreshToken });
  let token = await mint();
  return async <T>(fn: (token: string) => Promise<T>): Promise<T> => {
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof YouTubeError) || err.kind !== 'unauthorized') throw err;
    }
    token = await mint();
    try {
      return await fn(token);
    } catch (err) {
      if (err instanceof YouTubeError && err.kind === 'unauthorized')
        throw new YouTubeError('retry', `YouTube refused a fresh access token: ${err.message}`, 401);
      throw err;
    }
  };
}

/** YouTube kept the video private although it should be (or become) public: event, mail, uploads pause until the owner acts. */
async function announceLocked(ctx: Ctx, post: Row, videoId: string): Promise<void> {
  await ctx.store.append([
    {
      streamId: videoPostStream(post.id),
      event: { type: 'VideoUploadLockedPrivate', payload: { postId: post.id, videoId } },
      actor: SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
  for (const to of await superAdminEmails(ctx))
    try {
      await ctx.mailer.send(
        videoLockedMail({
          to,
          title: (post.meta as VideoPostMeta).title,
          videoUrl: watchUrl(videoId),
          origin: ctx.config.publicOrigin,
        }),
      );
    } catch (err) {
      ctx.log.error({ err }, 'video locked mail failed');
    }
}

export async function runUpload(ctx: Ctx, share: Row): Promise<void> {
  const now = ctx.clock.now();
  let post = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [share.post_id]);
  // the render the owner approved (older posts pin it), else the render of the revision that was scheduled
  const render = post
    ? await one(
        ctx.pool,
        post.approved_render_id
          ? 'SELECT * FROM video_renders WHERE id=$1'
          : 'SELECT * FROM video_renders WHERE post_id=$1 AND revision=$2',
        post.approved_render_id ? [post.approved_render_id] : [post.id, post.revision],
      )
    : undefined;
  const skip = async (why: string) =>
    exec(
      ctx.pool,
      `UPDATE social_shares SET status='skipped', error=$3, updated_at=$4 WHERE post_id=$1 AND network=$2`,
      [share.post_id, share.network, why, now],
    );
  if (!post || post.status !== 'approved' || !render)
    return void (await skip('the video is no longer approved'));
  const ch = await one(ctx.pool, `SELECT * FROM social_channels WHERE network='youtube'`);
  if (!ch) return void (await skip('channel disconnected'));
  const stream = videoPostStream(post.id);
  const detail: Detail = { ...((share.detail as Detail | null) ?? {}) };
  detail.steps ??= {};
  detail.warnings ??= [];
  try {
    const call = await youtubeCalls(ctx, ch);
    const settings = await videoSettings(ctx);
    const meta = post.meta as VideoPostMeta;
    const artifacts = (render.artifacts ?? {}) as Record<string, unknown>;
    const privacy = meta.privacy ?? settings.privacy;
    await beatHeartbeat(ctx, 'publish', { busy: 'upload' });

    if (!detail.videoId) {
      const file = artifactPath(ctx, artifacts, 'video');
      if (!file || !existsSync(file)) {
        // the render is done but its file has not reached this machine (a push in flight, a slow sync): wait for it until
        // the slot is missed, then give up
        const cutoff = post.slot_at
          ? new Date(post.slot_at).getTime()
          : new Date(share.created_at ?? now).getTime() + WAIT_FOR_FILE_MS;
        if (now.getTime() < cutoff) {
          await exec(
            ctx.pool,
            `UPDATE social_shares SET status='pending', error=$3, next_attempt_at=$4, updated_at=$5 WHERE post_id=$1 AND network=$2`,
            [
              share.post_id,
              share.network,
              'waiting for the video file',
              new Date(now.getTime() + 60_000),
              now,
            ],
          );
          return;
        }
        throw new YouTubeError(
          'final',
          'the video file was not found (the video volume, or the help videos folder)',
        );
      }
      // The owner may have moved or unscheduled the post between the claim and now: read it again under the slot lock
      // (move and unschedule take it and refuse once a share is posting), and stop if it is no longer scheduled.
      if (!detail.sessionUri) {
        const fresh = await withLock(ctx, `video-slot:${post.format}`, () =>
          one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [post?.id]),
        );
        if (!fresh || fresh.status !== 'approved')
          return void (await skip('the video is no longer scheduled'));
        post = fresh;
      }
      // YouTube publishes at the slot itself (publishAt). Fixed with the session, so a resume keeps it; before a session
      // exists it is worked out again (a retry after a long wait may find the slot passed). Less than 15 minutes ahead
      // (or "publish now") uploads public at once: YouTube refuses a publishAt that is not in the future by the time the
      // upload ends.
      if (privacy === 'public' && (detail.publishAt === undefined || !detail.sessionUri)) {
        const slot = post.slot_at ? new Date(post.slot_at) : null;
        detail.publishAt =
          post.publish_mode === 'slot' && slot && slot.getTime() > now.getTime() + PUBLISH_AT_MARGIN_MS
            ? slot.toISOString()
            : null;
      }
      detail.privacy = privacy;
      await saveDetail(ctx, share, detail);
      const descFile = artifactPath(ctx, artifacts, 'description');
      const description = (
        descFile && existsSync(descFile)
          ? readFileSync(descFile, 'utf8')
          : libraryDescription(meta, post.ref, artifacts, Number(render.duration_s ?? 0))
      ).replace(/[<>]/g, '');
      const title = meta.title.replace(/[<>]/g, '').slice(0, VIDEO_LIMITS.youtube.title);
      const spec = (sessionUri?: string) => ({
        filePath: file,
        snippet: {
          title,
          description,
          tags: meta.tags,
          categoryId: settings.categoryId,
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en',
        },
        status: {
          privacyStatus: (privacy === 'public' && detail.publishAt ? 'private' : privacy) as
            | 'private'
            | 'unlisted'
            | 'public',
          ...(privacy === 'public' && detail.publishAt ? { publishAt: detail.publishAt } : {}),
          selfDeclaredMadeForKids: false as const,
          containsSyntheticMedia: false as const,
        },
        ...(sessionUri ? { sessionUri } : {}),
        onSession: async (uri: string) => {
          detail.sessionUri = uri;
          detail.sessionStartedAt = ctx.clock.now().toISOString();
          await saveDetail(ctx, share, detail);
        },
        // a big file takes minutes: keep the heartbeat fresh between chunks
        onProgress: () => beatHeartbeat(ctx, 'publish', { busy: 'upload' }),
      });
      let videoId: string;
      try {
        videoId = (await call((t) => ctx.youtube.upload(t, spec(detail.sessionUri)))).videoId;
      } catch (err) {
        const dead = err instanceof YouTubeError && (err.status === 404 || err.status === 410);
        if (!dead || !detail.sessionUri) throw err;
        // The upload session is gone. Before starting over, look whether the video was uploaded after all (the last
        // chunk may have gone through): a second upload would be a duplicate on the channel.
        const since = new Date(Date.parse(detail.sessionStartedAt ?? now.toISOString()) - 5 * 60_000);
        const found = await call((t) => ctx.youtube.findRecentUpload(t, title, since));
        delete detail.sessionUri;
        delete detail.sessionStartedAt;
        await saveDetail(ctx, share, detail);
        videoId = found ?? (await call((t) => ctx.youtube.upload(t, spec()))).videoId;
      }
      detail.videoId = videoId;
      detail.uploadedAt = ctx.clock.now().toISOString();
      // an upload that resumed or ran long can end after its slot: YouTube would keep a video with a past publishAt private,
      // so it is made public now
      if (detail.publishAt && Date.parse(detail.publishAt) <= ctx.clock.now().getTime() + 60_000) {
        await call((t) => ctx.youtube.makePublic(t, videoId));
        detail.publishAt = null;
      }
      delete detail.sessionUri;
      delete detail.sessionStartedAt;
      await saveDetail(ctx, share, detail, { external_id: videoId, url: watchUrl(videoId) });
    }
    const videoId = detail.videoId;
    const steps = detail.steps;
    const warn = (m: string) => {
      if (!detail.warnings?.includes(m)) detail.warnings?.push(m);
    };
    /** One follow-up call: `forbidden` is a warning, other errors retry the whole upload (finished steps stay done). */
    const step = async (name: string, fn: () => Promise<void>) => {
      if (steps[name]) return;
      try {
        await fn();
        steps[name] = 'done';
      } catch (err) {
        if (err instanceof YouTubeError && err.kind === 'forbidden') {
          steps[name] = 'skipped';
          warn(`${name}: ${err.message}`.slice(0, 300));
        } else throw err;
      } finally {
        await saveDetail(ctx, share, detail);
      }
    };
    const thumb = artifactPath(ctx, artifacts, 'thumb');
    if (post.format === 'long' && thumb && existsSync(thumb))
      await step('thumbnail', async () => {
        const info = await call((t) => ctx.youtube.channelMine(t));
        if (info.verified === false) {
          warn('thumbnail: skipped, the channel is not phone-verified (YouTube refuses custom thumbnails)');
          return;
        }
        await call((t) => ctx.youtube.setThumbnail(t, videoId, thumb));
      });
    const vtt = artifactPath(ctx, artifacts, 'captionsVtt');
    if (vtt && existsSync(vtt))
      await step('captions', () => call((t) => ctx.youtube.insertCaption(t, videoId, vtt, 'en')));
    const playlist = settings.playlists[post.kind as 'article' | 'release' | 'tutorial'];
    if (playlist) await step('playlist', () => call((t) => ctx.youtube.addToPlaylist(t, playlist, videoId)));

    // YouTube may lock the video private (an API project that has not passed the audit): read back what it did. A video
    // scheduled for its slot is private WITH a publishAt; whether it really goes public is checked after the slot passes.
    const status = await call((t) => ctx.youtube.videoStatus(t, videoId));
    if (status && (status.uploadStatus === 'rejected' || status.uploadStatus === 'failed'))
      throw new YouTubeError(
        'final',
        `YouTube rejected the video: ${status.rejectionReason ?? status.failureReason ?? status.uploadStatus}`,
      );
    const locked =
      !!status && privacy !== 'private' && status.privacyStatus === 'private' && !status.publishAt;
    // unlisted/private need no check; a public video uploaded without a publishAt is verified when YouTube shows it public
    if (!locked && (privacy !== 'public' || (!detail.publishAt && status?.privacyStatus === 'public')))
      detail.verifiedAt = ctx.clock.now().toISOString();
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status=$3, error=NULL, attempts=attempts+1, next_attempt_at=NULL, detail=$4::jsonb, updated_at=$5
        WHERE post_id=$1 AND network=$2`,
      [share.post_id, share.network, locked ? 'locked_private' : 'sent', JSON.stringify(detail), now],
    );
    await ctx.store.append([
      {
        streamId: stream,
        event: {
          type: 'SocialShareSucceeded',
          payload: { postId: post.id, network: 'youtube', externalId: videoId, url: watchUrl(videoId) },
        },
        actor: SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
    if (locked) await announceLocked(ctx, post, videoId);
  } catch (err) {
    const kind = err instanceof YouTubeError ? err.kind : 'retry';
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);
    if (kind === 'auth') {
      // the refresh token was refused by the token endpoint: pause the channel, keep the upload waiting for the reconnect
      await exec(
        ctx.pool,
        `UPDATE social_shares SET status='pending', next_attempt_at=NULL, error=$3, detail=$5::jsonb, updated_at=$4 WHERE post_id=$1 AND network=$2`,
        [share.post_id, share.network, message, now, JSON.stringify(detail)],
      );
      await pauseChannel(ctx, message);
      return;
    }
    // our own OAuth client is wrong: not a reason to reconnect, but the owner must know (once), and the upload retries
    if (kind === 'config') await alertOnce(ctx, 'youtube', message);
    const attempts = (share.attempts as number) + 1;
    const final = kind === 'final' || kind === 'forbidden' || attempts > SHARE_BACKOFF_MS.length;
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status=$3, attempts=$4, error=$5, next_attempt_at=$6, detail=$8::jsonb, updated_at=$7 WHERE post_id=$1 AND network=$2`,
      [
        share.post_id,
        share.network,
        final ? 'failed' : 'pending',
        attempts,
        message,
        final ? null : new Date(now.getTime() + (SHARE_BACKOFF_MS[attempts - 1] as number)),
        now,
        JSON.stringify(detail),
      ],
    );
    if (final) {
      await ctx.store.append([
        {
          streamId: stream,
          event: {
            type: 'SocialShareFailed',
            payload: { postId: post.id, network: 'youtube', error: message, final: true },
          },
          actor: SYSTEM_ACTOR,
          scope: adminScope,
        },
      ]);
      await alertOnce(ctx, 'youtube', `An upload failed for good: ${message}`);
    }
  }
}

// ---- the other destinations (Reels, X, LinkedIn, Bluesky, TikTok)

const DEST_BACKOFF_MS = [1, 5, 30, 120].map((m) => m * 60_000);

/** The caption a destination posts: the owner's (schedule) over the drafter's (submit) over the default, composed to its limits. */
export function destinationCaption(
  post: Row,
  network: ShortDestination,
): { text: string; facets: BlueskyFacet[] } {
  const meta = post.meta as VideoPostMeta;
  // the owner's edit, else the drafter's caption, else a default; an empty text falls through to the next
  const filled = (c?: { text: string; tags: string[] }) => (c && c.text.trim() ? c : undefined);
  const c =
    filled((post.captions as VideoCaptions | null)?.[network]) ??
    filled((post.submit_captions as VideoCaptions | null)?.[network]) ??
    defaultVideoCaption(network, meta);
  // no link on any Short: X and TikTok forbid or charge for it, and a Short has no page of its own. A link the owner typed
  // into an X or TikTok caption is taken out.
  const text =
    network === 'x' || network === 'tiktok'
      ? c.text
          .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim()
      : c.text;
  return composeCaption(network, text, c.tags, '', VIDEO_CAPTION_LIMITS[network]);
}

async function runDestination(ctx: Ctx, share: Row): Promise<void> {
  const now = ctx.clock.now();
  const network = share.network as ShortDestination;
  const post = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [share.post_id]);
  const render = post
    ? await one(
        ctx.pool,
        post.approved_render_id
          ? 'SELECT * FROM video_renders WHERE id=$1'
          : 'SELECT * FROM video_renders WHERE post_id=$1 AND revision=$2',
        post.approved_render_id ? [post.approved_render_id] : [post.id, post.revision],
      )
    : undefined;
  const setShare = (sets: string, params: unknown[]) =>
    exec(ctx.pool, `UPDATE social_shares SET ${sets}, updated_at=$3 WHERE post_id=$1 AND network=$2`, [
      share.post_id,
      network,
      now,
      ...params,
    ]);
  if (!post || post.status !== 'approved' || !render)
    return void (await setShare(`status='skipped', error=$4`, ['the video is no longer approved']));
  const ch = await one(ctx.pool, `SELECT * FROM social_channels WHERE network=$1`, [network]);
  if (!ch) return void (await setShare(`status='skipped', error=$4`, ['channel disconnected']));
  const stream = videoPostStream(post.id);
  const detail = { ...((share.detail as Record<string, unknown> | null) ?? {}) };
  // the window is 6 hours from the slot (from the share for "publish now"); a retry by the owner opens a new one
  const deadline =
    Math.max(
      post.publish_mode === 'slot' && post.slot_at
        ? new Date(post.slot_at).getTime()
        : new Date(share.created_at ?? now).getTime(),
      typeof detail.retryAt === 'string' ? Date.parse(detail.retryAt) : 0,
    ) + POST_WINDOW_MS;
  const state = { ...((detail.dest as Record<string, unknown> | undefined) ?? {}) };
  const save = async () => {
    detail.dest = state;
    await setShare(`detail=$4::jsonb`, [JSON.stringify(detail)]);
  };
  const fail = async (message: string, alert: boolean) => {
    await setShare(`status='failed', error=$4, next_attempt_at=NULL, attempts=attempts+1`, [message]);
    await ctx.store.append([
      {
        streamId: stream,
        event: {
          type: 'SocialShareFailed',
          payload: { postId: post.id, network, error: message, final: true },
        },
        actor: SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
    if (alert) await alertOnce(ctx, network, `A video failed for good: ${message}`, true);
  };
  try {
    if (Object.keys(state).length === 0 && now.getTime() > deadline)
      return void (await fail(
        'the slot passed more than 6 hours ago and the video was not posted; retry it to post now',
        true,
      ));
    if (Object.keys(state).length > 0 && now.getTime() > deadline + POST_WINDOW_MS)
      return void (await fail('still processing 12 hours after the slot; check the account and retry', true));
    const artifacts = (render.artifacts ?? {}) as Record<string, unknown>;
    const file = artifactPath(ctx, artifacts, 'video');
    if (!file || !existsSync(file)) {
      if (now.getTime() < deadline) {
        await setShare(`status='pending', error=$4, next_attempt_at=$5`, [
          'waiting for the video file',
          new Date(now.getTime() + 60_000),
        ]);
        return;
      }
      return void (await fail('the video file was not found (the video volume)', true));
    }
    const settings = await videoSettings(ctx);
    const meta = post.meta as VideoPostMeta;
    const cap = destinationCaption(post, network);
    let credentials = await decryptSecret(ctx, ch.access_token);
    let tiktok: DestinationPayload['tiktok'];
    if (network === 'tiktok') {
      const parsed = TikTokOptionsSchema.safeParse(post.destination_options?.tiktok);
      if (!parsed.success)
        return void (await fail(
          'TikTok needs the options the owner chose when scheduling (who can see it, interactions, consent); schedule the video again with TikTok ticked',
          true,
        ));
      if (!settings.tiktokAudited && parsed.data.privacy !== 'SELF_ONLY')
        return void (await fail(
          `the TikTok app has not passed its audit: only private (SELF_ONLY) posts are allowed, not ${parsed.data.privacy}`,
          true,
        ));
      credentials = await freshTiktokToken(ctx, ch);
      tiktok = { options: parsed.data, videoUrl: await signedMediaUrl(ctx, render.id) };
    }
    await beatHeartbeat(ctx, 'publish', { busy: 'post' });
    const payload: DestinationPayload = {
      network,
      accountId: ch.account_id,
      credentials,
      filePath: file,
      bytes: statSync(file).size,
      durationSeconds: Number(render.duration_s ?? 0),
      text: cap.text,
      facets: cap.facets,
      title: meta.title,
      ...(tiktok ? { tiktok } : {}),
    };
    const out = await ctx.videoDestinations.publish(payload, {
      state,
      save,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => ctx.clock.now().getTime(),
    });
    if (!out.done) {
      await setShare(`status='pending', error=$4, next_attempt_at=$5, detail=$6::jsonb`, [
        out.note,
        new Date(now.getTime() + out.retryInMs),
        JSON.stringify({ ...detail, dest: state }),
      ]);
      return;
    }
    await setShare(
      `status='sent', external_id=$4, url=$5, error=NULL, attempts=attempts+1, next_attempt_at=NULL, detail=$6::jsonb`,
      [out.externalId, out.url, JSON.stringify({ ...detail, dest: state })],
    );
    await ctx.store.append([
      {
        streamId: stream,
        event: {
          type: 'SocialShareSucceeded',
          payload: { postId: post.id, network, externalId: out.externalId, url: out.url },
        },
        actor: SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
  } catch (err) {
    const kind = err instanceof DestinationError ? err.kind : 'retry';
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);
    if (kind === 'auth') {
      // not the video's fault: pause the channel, keep the share waiting for the reconnect
      await exec(ctx.pool, `UPDATE social_channels SET status='needs_reconnect' WHERE network=$1`, [network]);
      await setShare(`status='pending', next_attempt_at=NULL, error=$4, detail=$5::jsonb`, [
        message,
        JSON.stringify({ ...detail, dest: state }),
      ]);
      await alertOnce(ctx, network, message, true);
      return;
    }
    const attempts = (share.attempts as number) + 1;
    const wait = DEST_BACKOFF_MS[Math.min(attempts - 1, DEST_BACKOFF_MS.length - 1)] as number;
    if (kind === 'final' || now.getTime() + wait > deadline) {
      await setShare(`detail=$4::jsonb`, [JSON.stringify({ ...detail, dest: state })]);
      return void (await fail(
        kind === 'final' ? message : `gave up 6 hours after the slot: ${message}`,
        true,
      ));
    }
    await setShare(`status='pending', attempts=$4, error=$5, next_attempt_at=$6, detail=$7::jsonb`, [
      attempts,
      message,
      new Date(now.getTime() + wait),
      JSON.stringify({ ...detail, dest: state }),
    ]);
  }
}

/** Claims and posts one due destination share (a slot that has come, a retry that is due). Returns true when it did something. */
export async function postNextDestination(ctx: Ctx): Promise<boolean> {
  const now = ctx.clock.now();
  const claimed = await one(
    ctx.pool,
    `UPDATE social_shares s SET status='posting', updated_at=$1
      WHERE (s.post_id, s.network) = (
        SELECT s2.post_id, s2.network FROM social_shares s2
          JOIN social_channels c ON c.network = s2.network AND c.status='ok'
          JOIN video_posts p ON p.id = s2.post_id AND p.status = 'approved'
         WHERE s2.source='video' AND s2.network <> 'youtube' AND s2.status='pending'
           AND (s2.next_attempt_at IS NULL OR s2.next_attempt_at <= $1)
         ORDER BY s2.next_attempt_at NULLS FIRST, s2.created_at LIMIT 1 FOR UPDATE OF s2 SKIP LOCKED)
      RETURNING s.*`,
    [now],
  );
  if (!claimed) return false;
  await runDestination(ctx, claimed);
  return true;
}

/** Claims and runs one due upload of a rendered video, if no other upload is running. Returns true when it did something. */
export async function uploadNext(ctx: Ctx): Promise<boolean> {
  const now = ctx.clock.now();
  const claimed = await one(
    ctx.pool,
    `UPDATE social_shares s SET status='posting', updated_at=$1
      WHERE (s.post_id, s.network) = (
        SELECT s2.post_id, s2.network FROM social_shares s2
          JOIN social_channels c ON c.network = s2.network AND c.status='ok'
          JOIN video_posts p ON p.id = s2.post_id AND p.status = 'approved'
         WHERE s2.source='video' AND s2.network='youtube' AND s2.status='pending'
           AND (s2.next_attempt_at IS NULL OR s2.next_attempt_at <= $1)
           AND (s2.detail->>'videoId' IS NOT NULL OR ${RENDERED})
         ORDER BY s2.created_at LIMIT 1 FOR UPDATE OF s2 SKIP LOCKED)
      RETURNING s.*`,
    [now],
  );
  if (!claimed) return false;
  // finishing the steps of a video that is already on YouTube is never held back by the cap
  const onYoutube = !!(claimed.detail as Detail | null)?.videoId;
  if (!onYoutube && !(await uploadAllowed(ctx, claimed))) {
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status='pending' WHERE post_id=$1 AND network=$2 AND status='posting'`,
      [claimed.post_id, claimed.network],
    );
    return false;
  }
  await runUpload(ctx, claimed);
  return true;
}

/**
 * A public video is uploaded private with a `publishAt`. Once its slot has passed, look at what YouTube did: public is
 * confirmed (`verifiedAt`, the page may embed it); still private means the API project is locked, so the share becomes
 * `locked_private`, the owner is mailed and uploads pause. At most one look per share every 30 minutes.
 */
export async function recheckPublished(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const due = await rows(
    ctx.pool,
    `SELECT * FROM social_shares
      WHERE source='video' AND network='youtube' AND status='sent' AND external_id IS NOT NULL
        AND detail->>'privacy' = 'public' AND detail->>'verifiedAt' IS NULL
        AND (detail->>'publishAt')::timestamptz <= $1
        AND (detail->>'lastCheckedAt' IS NULL OR (detail->>'lastCheckedAt')::timestamptz <= $2)
      ORDER BY (detail->>'publishAt')::timestamptz LIMIT 3`,
    [new Date(now.getTime() - 5 * 60_000), new Date(now.getTime() - 30 * 60_000)],
  );
  if (!due.length) return 0;
  const ch = await one(ctx.pool, `SELECT * FROM social_channels WHERE network='youtube' AND status='ok'`);
  if (!ch) return 0;
  let call: Awaited<ReturnType<typeof youtubeCalls>>;
  try {
    call = await youtubeCalls(ctx, ch);
  } catch (err) {
    if (err instanceof YouTubeError && err.kind === 'auth') await pauseChannel(ctx, err.message);
    else ctx.log.warn({ err }, 'video re-check could not get a token');
    return 0;
  }
  let n = 0;
  for (const share of due) {
    const detail = { ...(share.detail as Detail) };
    detail.lastCheckedAt = now.toISOString();
    try {
      const st = await call((t) => ctx.youtube.videoStatus(t, share.external_id));
      const post = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [share.post_id]);
      if (st?.privacyStatus === 'public') {
        detail.verifiedAt = now.toISOString();
        await saveDetail(ctx, share, detail);
      } else if (
        st &&
        st.privacyStatus === 'private' &&
        (!st.publishAt || Date.parse(st.publishAt) <= now.getTime())
      ) {
        await exec(
          ctx.pool,
          `UPDATE social_shares SET status='locked_private', detail=$3::jsonb, updated_at=$4 WHERE post_id=$1 AND network=$2`,
          [share.post_id, share.network, JSON.stringify(detail), now],
        );
        if (post) await announceLocked(ctx, post, share.external_id);
      } else {
        await saveDetail(ctx, share, detail);
      }
      n++;
    } catch (err) {
      ctx.log.warn({ err, postId: share.post_id }, 'video re-check failed');
      await saveDetail(ctx, share, detail);
    }
  }
  return n;
}

// ---- alerts and the watch over the slots

/** A mail to the owner, once per `key` (ever). The claim is a row in the platform settings. */
export async function alertVideoOnce(
  ctx: Ctx,
  key: string,
  heading: string,
  reason: string,
): Promise<boolean> {
  const claimed = await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,NULL,$3)
     ON CONFLICT (key) DO NOTHING`,
    [`video_alert:${key}`, JSON.stringify({ heading, reason }), ctx.clock.now()],
  );
  if (!claimed) return false;
  for (const to of await superAdminEmails(ctx))
    try {
      await ctx.mailer.send(videoAlertMail({ to, heading, reason, origin: ctx.config.publicOrigin }));
    } catch (err) {
      ctx.log.error({ err }, 'video alert mail failed');
    }
  return true;
}

const HOUR = 3_600_000;

/**
 * What the owner must hear about before a slot passes, and the one thing the system does by itself:
 * - at slot minus 30 minutes a post that is still not rendered slips to the next free slot of its format (never cascading);
 * - 24 hours (Shorts: 12) before a slot, a render that has not started while no render worker is alive: "render worker offline";
 * - 6 hours before a slot, a render that failed for good;
 * - 24 hours before a slot nobody holds, while scripts wait in review: "empty slot".
 * Only database work, so the app runs it too: a dead render worker cannot report itself.
 */
export async function videoWatch(ctx: Ctx): Promise<{ slipped: number; alerts: number }> {
  const out = { slipped: 0, alerts: 0 };
  if (!(await videoActive(ctx))) return out;
  const now = ctx.clock.now();
  const send = async (key: string, heading: string, reason: string) => {
    if (await alertVideoOnce(ctx, key, heading, reason)) out.alerts++;
  };
  // 1. slip
  const late = await rows(
    ctx.pool,
    `SELECT p.id, p.title, p.format, p.slot_at FROM video_posts p
      WHERE p.status='approved' AND p.publish_mode='slot' AND p.script IS NOT NULL
        AND p.slot_at <= $1
        AND NOT EXISTS (SELECT 1 FROM video_renders r WHERE r.post_id = p.id AND r.revision = p.revision
                          AND r.status = 'rendered' AND r.purged_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video'
                          AND (s.external_id IS NOT NULL OR s.status IN ('posting','sent','locked_private')))
      ORDER BY p.slot_at`,
    [new Date(now.getTime() + SCHEDULE_DEFAULTS.slipBeforeMs)],
  );
  for (const p of late) {
    const moved = await slipVideoPost(ctx, p.id);
    if (!moved) continue;
    out.slipped++;
    await send(
      `slip:${p.id}:${moved.from.getTime()}`,
      'A video missed its slot',
      `"${p.title}" was not rendered in time for ${moved.from.toISOString()} and now goes out at ${moved.to.toISOString()}. Check that the video render worker is running.`,
    );
  }
  // 2. render worker offline / render failed
  const pending = await rows(
    ctx.pool,
    `SELECT p.id, p.title, p.format, p.slot_at, r.status AS render_status, r.attempts, r.error
       FROM video_posts p JOIN video_renders r ON r.post_id = p.id AND r.revision = p.revision
      WHERE p.status='approved' AND p.publish_mode='slot' AND NOT r.library AND p.slot_at > $1
        AND r.status IN ('queued','failed')`,
    [now],
  );
  const alive = (await workerHeartbeat(ctx, 'render')).running;
  for (const p of pending) {
    const left = new Date(p.slot_at).getTime() - now.getTime();
    const warn = (p.format === 'short' ? 12 : 24) * HOUR;
    if (p.render_status === 'queued' && p.attempts === 0 && left <= warn && !alive)
      await send(
        `offline:${p.id}`,
        'The video render worker is offline',
        `"${p.title}" goes out at ${new Date(p.slot_at).toISOString()} but its render has not started and the render worker is not running.`,
      );
    if (p.render_status === 'failed' && left <= 6 * HOUR)
      await send(
        `failed:${p.id}`,
        'A video failed to render',
        `"${p.title}" goes out at ${new Date(p.slot_at).toISOString()} but its render failed: ${p.error ?? 'unknown error'}. Fix the script or retry the render.`,
      );
  }
  // 3. an empty slot while scripts wait
  for (const format of ['long', 'short'] as const) {
    const waiting = await one(
      ctx.pool,
      `SELECT count(*)::int AS n FROM video_posts WHERE format=$1 AND status='in_review' AND ref NOT LIKE 'lib:%'`,
      [format],
    );
    if (!waiting?.n) continue;
    const next = await nextFreeSlotOf(ctx, format, { leadMs: 0 });
    if (next && next.getTime() - now.getTime() <= 24 * HOUR)
      await send(
        `empty:${format}:${next.getTime()}`,
        'A video slot is still empty',
        `The ${format === 'short' ? 'Short' : 'long video'} slot at ${next.toISOString()} has nothing scheduled while ${waiting.n} script${waiting.n === 1 ? ' waits' : 's wait'} for your review.`,
      );
  }
  return out;
}

// ---- cleanup

const CLEANUP_KEY = 'video_cleanup_at';

/** A push that died (killed process, cut connection) leaves `.push-<uuid>.tmp` next to the target: remove those over an hour old. */
export async function cleanupPushTemps(ctx: Ctx): Promise<number> {
  const root = ctx.config.videoDir;
  const cutoff = ctx.clock.now().getTime() - 3_600_000;
  let removed = 0;
  const dirs = async (p: string) =>
    (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());
  for (const post of await dirs(root))
    for (const rev of await dirs(join(root, post.name))) {
      const dir = join(root, post.name, rev.name);
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!/^\.push-.*\.tmp$/.test(f)) continue;
        const st = await stat(join(dir, f)).catch(() => null);
        if (st && st.mtimeMs < cutoff) {
          await rm(join(dir, f), { force: true });
          removed++;
        }
      }
    }
  return removed;
}

/**
 * Daily storage policy. Thumbnails, captions, scripts, descriptions and logs are kept for good; the MP4 goes:
 * - published: once every destination is sent or skipped (at least one sent) AND (YouTube verified the video public OR the
 *   slot is 6 hours past);
 * - a failed destination: 3 days after its last failure (a retry renders the same revision again);
 * - a rejected post: all files after 1 day; a superseded revision's render after 1 day;
 * - a preview in review: the MP4 after 7 days without activity on the post.
 * A library video's file is the help video itself and is never touched.
 */
export async function cleanupVideos(ctx: Ctx, opts: { force?: boolean } = {}): Promise<number> {
  const now = ctx.clock.now();
  const last = await one(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [CLEANUP_KEY]);
  const at = (last?.value as { at?: string } | undefined)?.at;
  if (!opts.force && at && now.getTime() - Date.parse(at) < DAY) return 0;
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,NULL,$3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
    [CLEANUP_KEY, JSON.stringify({ at: now.toISOString() }), now],
  );
  const root = ctx.config.videoDir;
  let purged = 0;
  await cleanupPushTemps(ctx);
  const purge = async (r: Row, onlyVideo: boolean) => {
    const a = (r.artifacts ?? {}) as Record<string, unknown>;
    const keep: Record<string, unknown> = { ...a };
    const files = onlyVideo ? ['video'] : Object.keys(a);
    for (const k of files) {
      const v = a[k];
      if (typeof v !== 'string' || !v || v.startsWith('/') || v.startsWith('lib:')) continue; // a help video, not ours
      await rm(join(root, v), { force: true });
      delete keep[k];
    }
    if (!onlyVideo) await rm(join(root, renderDir(r.post_id, r.revision)), { recursive: true, force: true });
    await exec(
      ctx.pool,
      `UPDATE video_renders SET artifacts=$2::jsonb, purged_at=COALESCE(purged_at,$3) WHERE id=$1`,
      [r.id, JSON.stringify(keep), now],
    );
    purged++;
  };
  const ago = (ms: number) => new Date(now.getTime() - ms);
  // superseded: a newer revision exists and the render is older than a day
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r JOIN video_posts p ON p.id = r.post_id
      WHERE NOT r.library AND r.purged_at IS NULL AND r.revision < p.revision
        AND COALESCE(r.finished_at, r.created_at) < $1 AND p.approved_render_id IS DISTINCT FROM r.id`,
    [ago(DAY)],
  ))
    await purge(r, false);
  // rejected for a day
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r JOIN video_posts p ON p.id = r.post_id
      WHERE NOT r.library AND r.purged_at IS NULL AND p.status='rejected' AND p.updated_at < $1`,
    [ago(VIDEO_POST_LIMITS.rejectedKeepDays * DAY)],
  ))
    await purge(r, false);
  // a preview nobody touched for a week: only the MP4 goes
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r JOIN video_posts p ON p.id = r.post_id AND p.revision = r.revision
      WHERE NOT r.library AND r.purged_at IS NULL AND r.artifacts ? 'video' AND p.status IN ('draft','in_review')
        AND COALESCE(r.finished_at, r.created_at) < $1 AND p.updated_at < $1`,
    [ago(VIDEO_POST_LIMITS.previewKeepDays * DAY)],
  ))
    await purge(r, true);
  // published: every destination sent or skipped (one sent), YouTube verified or the slot is 6 hours past
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r
      JOIN video_posts p ON p.id = r.post_id AND p.status = 'approved'
        AND (p.approved_render_id = r.id OR (p.approved_render_id IS NULL AND p.revision = r.revision))
      WHERE NOT r.library AND r.purged_at IS NULL AND r.artifacts ? 'video'
        AND NOT EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video'
                          AND s.status NOT IN ('sent','skipped'))
        AND EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video' AND s.status = 'sent')
        AND (EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video'
                       AND s.network='youtube' AND s.detail->>'verifiedAt' IS NOT NULL)
             OR COALESCE(p.slot_at, (SELECT max(s.updated_at) FROM social_shares s WHERE s.post_id = p.id AND s.source='video')) < $1)`,
    [ago(VIDEO_POST_LIMITS.publishedKeepHours * 3_600_000)],
  ))
    await purge(r, true);
  // a failed destination: the MP4 waits 3 days for a retry
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r
      JOIN video_posts p ON p.id = r.post_id AND p.status = 'approved'
        AND (p.approved_render_id = r.id OR (p.approved_render_id IS NULL AND p.revision = r.revision))
      WHERE NOT r.library AND r.purged_at IS NULL AND r.artifacts ? 'video'
        AND EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video'
                      AND s.status = 'failed' AND s.updated_at < $1)
        AND NOT EXISTS (SELECT 1 FROM social_shares s WHERE s.post_id = p.id AND s.source='video'
                          AND s.status IN ('pending','posting','locked_private'))`,
    [ago(VIDEO_POST_LIMITS.failedKeepDays * DAY)],
  ))
    await purge(r, true);
  return purged;
}

// ---- the loop

/**
 * Render machines that push their files delete them after the push; a crash in between leaves a directory behind.
 * Remove local render directories older than a day whose render is not being worked on. At most once an hour.
 */
let lastLocalSweep = 0;
export async function cleanupLocalRenders(ctx: Ctx): Promise<number> {
  const nowMs = ctx.clock.now().getTime();
  if (nowMs - lastLocalSweep < 3_600_000) return 0;
  lastLocalSweep = nowMs;
  const root = ctx.config.videoDir;
  let removed = 0;
  const dirs = async (p: string) =>
    (await readdir(p, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());
  for (const post of await dirs(root))
    for (const rev of await dirs(join(root, post.name))) {
      const dir = join(root, post.name, rev.name);
      const age = nowMs - (await stat(dir)).mtimeMs;
      if (age < DAY || !/^\d+$/.test(rev.name)) continue;
      const busy = await one(
        ctx.pool,
        `SELECT 1 AS x FROM video_renders WHERE post_id::text=$1 AND revision=$2 AND status='rendering'`,
        [post.name, Number(rev.name)],
      );
      if (busy) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    }
  return removed;
}

/**
 * One pass of the worker, by role (`AOM_VIDEO_ROLE`): `render` beats `video_worker_render` and renders (plus clearing its
 * own leftovers when it pushes); `publish` beats `video_worker_publish` and does everything else (render rows, the watch,
 * destination rows, uploads, re-checks, cleanup); `all` does both. Returns what it did (for tests and the log).
 */
export async function videoTick(
  ctx: Ctx,
  deps: SweepDeps = {},
): Promise<{ active: boolean; rendered: boolean; uploaded: boolean; cleaned: number }> {
  const role = deps.role ?? ctx.config.videoRole;
  const doRender = role !== 'publish';
  const doPublish = role !== 'render';
  if (doRender) await beatHeartbeat(ctx, 'render');
  if (doPublish) await beatHeartbeat(ctx, 'publish');
  if (!(await videoActive(ctx))) {
    // no channel yet: a preview the owner asked for still renders (it uploads nothing), so the script can be checked
    // before YouTube is connected; scheduled renders wait for the channel
    const rendered =
      doRender && (await videoSettings(ctx)).enabled ? await renderNext(ctx, deps, true) : false;
    return { active: false, rendered, uploaded: false, cleaned: 0 };
  }
  if (doPublish) {
    await healRenders(ctx);
    await videoWatch(ctx).catch((err) => ctx.log.error({ err }, 'video watch failed'));
    await createMissingUploads(ctx);
  }
  let rendered = false;
  if (doRender) {
    rendered = await renderNext(ctx, deps);
    if (rendered && doPublish) await createMissingUploads(ctx);
  }
  let uploaded = false;
  let cleaned = 0;
  if (doPublish) {
    uploaded = await uploadNext(ctx);
    // the slots that have come: up to a handful of destinations per pass (each can take minutes)
    for (let i = 0; i < 5 && (await postNextDestination(ctx)); i++) uploaded = true;
    await recheckPublished(ctx).catch((err) => ctx.log.error({ err }, 'video re-check failed'));
    cleaned = await cleanupVideos(ctx).catch((err) => {
      ctx.log.error({ err }, 'video cleanup failed');
      return 0;
    });
  } else if (ctx.config.videoPushUrl) {
    cleaned = await cleanupLocalRenders(ctx).catch((err) => {
      ctx.log.error({ err }, 'local render cleanup failed');
      return 0;
    });
  }
  return { active: true, rendered, uploaded, cleaned };
}
