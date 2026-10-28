import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { VIDEO_LIMITS, VIDEO_POST_LIMITS, type VideoPostMeta, type VideoScript } from '@aom/shared';
import { decryptSecret } from '../auth/secrets.ts';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import { alertOnce, SHARE_BACKOFF_MS, superAdminEmails } from '../commands/social.ts';
import {
  artifactPath,
  beatHeartbeat,
  insertLibraryRender,
  libraryDescription,
  renderDir,
  slotAfter,
  takenSlots,
  videoActive,
  videoPostStream,
  videoSettings,
} from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { videoLockedMail } from '../mail/blog-mail.ts';
import { libraryCatalog } from './library.ts';
import { watchUrl, YouTubeError } from './youtube.ts';

/**
 * The video worker's loop (`video-worker --loop`, a separate container): one pass does, in this order,
 *   1. a heartbeat (the UI shows "video worker not running" when it is stale),
 *   2. nothing else unless a YouTube channel is connected (status ok) AND `videoPosts.enabled`,
 *   3. the approved posts get an upload row, 4. ONE queued render is claimed (a lease, 3 attempts, one at a time),
 *   5. ONE upload per day (at most one video a day, public at 10:00 SAST), 6. the daily cleanup of old files.
 * The render and the YouTube client are injected so tests never render or reach Google.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
const LEASE_MS = 40 * 60_000;
const STALE_POSTING_MS = 30 * 60_000;
const DAY = 86_400_000;

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
}

const defaultRender: RenderFn = async (script, opts) => {
  const { renderScript } = await import('./renders.ts');
  return renderScript(script, { outDir: opts.outDir, log: opts.log });
};

// ---- renders

/** Posts that need a render row but have none (a crash between the event and the insert), and renders nobody wants. */
async function healRenders(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO video_renders (id, post_id, revision, status, attempts, created_at)
     SELECT gen_random_uuid(), p.id, p.revision, 'queued', 0, $1 FROM video_posts p
      WHERE p.script IS NOT NULL AND p.status IN ('draft','in_review')
        AND NOT EXISTS (SELECT 1 FROM video_renders r WHERE r.post_id = p.id AND r.revision = p.revision)
        AND (SELECT count(*) FROM video_renders r WHERE r.post_id = p.id AND NOT r.library) < $2
     ON CONFLICT (post_id, revision) DO NOTHING`,
    [now, VIDEO_POST_LIMITS.maxRenders],
  );
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

async function claimRender(ctx: Ctx): Promise<Row | undefined> {
  const now = ctx.clock.now();
  return one(
    ctx.pool,
    `UPDATE video_renders r SET status='rendering', lease_until=$2, attempts=r.attempts+1, error=NULL
      WHERE r.id = (
        SELECT x.id FROM video_renders x JOIN video_posts p ON p.id = x.post_id AND p.revision = x.revision
         WHERE NOT x.library AND p.script IS NOT NULL AND p.status IN ('draft','in_review')
           AND ((x.status='queued' AND (x.lease_until IS NULL OR x.lease_until <= $1))
                OR (x.status='rendering' AND x.lease_until < $1))
           AND x.attempts < $3
           AND NOT EXISTS (SELECT 1 FROM video_renders y WHERE y.status='rendering' AND y.lease_until >= $1)
         ORDER BY x.created_at LIMIT 1 FOR UPDATE OF x SKIP LOCKED)
      RETURNING r.*`,
    [now, new Date(now.getTime() + LEASE_MS), VIDEO_POST_LIMITS.maxAttempts],
  );
}

/** Claims and renders one queued render. Returns true when it did something. */
export async function renderNext(ctx: Ctx, deps: SweepDeps = {}): Promise<boolean> {
  const r = await claimRender(ctx);
  if (!r) return false;
  const post = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [r.post_id]);
  const root = ctx.config.videoDir;
  const outDir = join(root, renderDir(r.post_id, r.revision));
  const lines: string[] = [];
  const beat = setInterval(() => {
    void beatHeartbeat(ctx, { busy: 'render' }).catch(() => {});
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

/** The calendar day in South Africa (UTC+2, no daylight saving) of an instant. */
const sastDay = (d: Date): string => new Date(d.getTime() + 2 * 3600_000).toISOString().slice(0, 10);

async function createMissingUploads(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO social_shares (post_id, network, source, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT p.id, 'youtube', 'video', 'pending', 0, $1, $1, $1 FROM video_posts p WHERE p.status='approved'
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
 * May this share upload today? At most one upload a (South African) day. Whatever already put a video on YouTube today counts
 * (even a share that failed in a later step), and so does a share that reserved today's slot and waits to retry. A video
 * YouTube kept private, or an upload in progress elsewhere, pauses everything. `self` is the share being claimed.
 */
async function uploadAllowed(ctx: Ctx, self: Row): Promise<boolean> {
  const day = sastDay(ctx.clock.now());
  const rs = await rows(
    ctx.pool,
    `SELECT status, detail->>'uploadedAt' AS uploaded, detail->>'reservedAt' AS reserved
       FROM social_shares
      WHERE source='video' AND network='youtube' AND post_id <> $1
        AND (status IN ('posting','locked_private') OR detail->>'uploadedAt' IS NOT NULL OR detail->>'reservedAt' IS NOT NULL)`,
    [self.post_id],
  );
  if (rs.some((r) => r.status === 'locked_private' || r.status === 'posting')) return false;
  return !rs.some((r) => {
    const at = r.uploaded ?? r.reserved;
    return at && sastDay(new Date(at)) === day && (r.uploaded || r.status === 'pending');
  });
}

type Detail = {
  sessionUri?: string;
  sessionStartedAt?: string;
  videoId?: string;
  uploadedAt?: string;
  reservedAt?: string;
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

async function runUpload(ctx: Ctx, share: Row): Promise<void> {
  const now = ctx.clock.now();
  const post = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [share.post_id]);
  const render = post?.approved_render_id
    ? await one(ctx.pool, 'SELECT * FROM video_renders WHERE id=$1', [post.approved_render_id])
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
    await beatHeartbeat(ctx, { busy: 'upload' });

    if (!detail.videoId) {
      const file = artifactPath(ctx, artifacts, 'video');
      if (!file || !existsSync(file))
        throw new YouTubeError(
          'final',
          'the video file was not found (the video volume, or the help videos folder)',
        );
      // the slot is reserved in `detail` before the upload starts, so a resume keeps it
      if (privacy === 'public' && !detail.publishAt) {
        detail.publishAt = slotAfter(now, await takenSlots(ctx)).toISOString();
      }
      detail.reservedAt ??= now.toISOString();
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
          privacyStatus: (privacy === 'public' ? 'private' : privacy) as 'private' | 'unlisted' | 'public',
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
        onProgress: () => beatHeartbeat(ctx, { busy: 'upload' }),
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
    if (privacy !== 'public' && !locked) detail.verifiedAt = ctx.clock.now().toISOString();
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

/** Claims and runs one due upload, if the one-a-day cap allows. Returns true when it did something. */
export async function uploadNext(ctx: Ctx): Promise<boolean> {
  const now = ctx.clock.now();
  const claimed = await one(
    ctx.pool,
    `UPDATE social_shares s SET status='posting', updated_at=$1
      WHERE (s.post_id, s.network) = (
        SELECT s2.post_id, s2.network FROM social_shares s2
          JOIN social_channels c ON c.network = s2.network AND c.status='ok'
         WHERE s2.source='video' AND s2.network='youtube' AND s2.status='pending'
           AND (s2.next_attempt_at IS NULL OR s2.next_attempt_at <= $1)
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

// ---- cleanup

const CLEANUP_KEY = 'video_cleanup_at';

/**
 * Daily: renders of superseded revisions go one day after they were replaced, those of rejected posts after 7 days, and
 * the MP4 of an uploaded video 30 days after it was sent (thumbnail, captions and script stay). A library video's file is
 * the help video itself and is never touched.
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
  // superseded: a newer revision exists and the render is older than a day
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r JOIN video_posts p ON p.id = r.post_id
      WHERE NOT r.library AND r.purged_at IS NULL AND r.revision < p.revision
        AND COALESCE(r.finished_at, r.created_at) < $1 AND p.approved_render_id IS DISTINCT FROM r.id`,
    [new Date(now.getTime() - DAY)],
  ))
    await purge(r, false);
  // rejected for a week
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r JOIN video_posts p ON p.id = r.post_id
      WHERE NOT r.library AND r.purged_at IS NULL AND p.status='rejected' AND p.updated_at < $1`,
    [new Date(now.getTime() - 7 * DAY)],
  ))
    await purge(r, false);
  // uploaded for 30 days: only the MP4 goes
  for (const r of await rows(
    ctx.pool,
    `SELECT r.* FROM video_renders r JOIN video_posts p ON p.approved_render_id = r.id
      JOIN social_shares s ON s.post_id = p.id AND s.network='youtube' AND s.source='video' AND s.status IN ('sent','locked_private')
      WHERE NOT r.library AND r.purged_at IS NULL AND r.artifacts ? 'video' AND s.updated_at < $1`,
    [new Date(now.getTime() - 30 * DAY)],
  ))
    await purge(r, true);
  return purged;
}

// ---- the loop

/** One pass of the worker. Returns what it did (for tests and the log). */
export async function videoTick(
  ctx: Ctx,
  deps: SweepDeps = {},
): Promise<{ active: boolean; rendered: boolean; uploaded: boolean; cleaned: number }> {
  await beatHeartbeat(ctx);
  if (!(await videoActive(ctx))) return { active: false, rendered: false, uploaded: false, cleaned: 0 };
  await healRenders(ctx);
  await createMissingUploads(ctx);
  const rendered = await renderNext(ctx, deps);
  const uploaded = await uploadNext(ctx);
  await recheckPublished(ctx).catch((err) => ctx.log.error({ err }, 'video re-check failed'));
  const cleaned = await cleanupVideos(ctx).catch((err) => {
    ctx.log.error({ err }, 'video cleanup failed');
    return 0;
  });
  return { active: true, rendered, uploaded, cleaned };
}
