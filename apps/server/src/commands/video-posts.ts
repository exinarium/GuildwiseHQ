import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  type BlogContent,
  buildDescription,
  DEFAULT_VIDEO_SETTINGS,
  type EditVideoPostRequest,
  fitCaption,
  isLibraryRef,
  type PatchVideoSettingsRequest,
  type Release,
  SOCIAL_LIMITS,
  type SocialCaptions,
  type SubmitVideoPostRequest,
  VIDEO_LIBRARY_PREFIX,
  VIDEO_POST_LIMITS,
  VIDEO_TOPIC_LIMITS,
  type VideoCapacity,
  type VideoCrossPost,
  type VideoFormat,
  type VideoKind,
  type VideoLibraryEntry,
  type VideoPost,
  type VideoPostList,
  type VideoPostMeta,
  type VideoPostStatus,
  type VideoRender,
  type VideoScript,
  VideoScriptSchema,
  type VideoSettings,
  type VideoStatus,
  type VideoTopic,
  type VideoTopicList,
  type VideoUpload,
  videoScriptIssues,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadReleases } from '../blog/releases.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Row, rows } from '../db/sql.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { YOUTUBE_AUDIT_FORM_URL } from '../mail/blog-mail.ts';
import { LIBRARY_MARKER, type LibraryEntry, libraryCatalog, libraryFile } from '../video/library.ts';
import { watchUrl } from '../video/youtube.ts';
import type { Origin } from './blog.ts';
import { SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * The review side of the YouTube push (docs/BLOG-API.md "YouTube"): video posts, their renders, the platform setting,
 * the Video topics list and the cross-post of a tutorial. Event-sourced (`VideoPost*`, `VideoTopic*`); the renders and
 * the upload are operational tables the video worker (video/sweep.ts) works on.
 *
 * ONE review gate: the rendered video. A post renders on its own (revision 1 is queued when it is submitted), the owner
 * watches the video and reads script and metadata, edits re-render (at most 3 renders a post) and only an approval of the
 * rendered revision lets the worker upload it. Everything automatic is a no-op unless a YouTube channel is connected
 * (status ok) AND `videoPosts.enabled`.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
export const videoPostStream = (postId: string) => `video-${postId}`;
const DAY = 86_400_000;

// ---- settings

const SETTINGS_KEY = 'video_posts';
const HEARTBEAT_KEY = 'video_worker_heartbeat';

async function putSetting(ctx: Ctx, by: string | null, key: string, value: unknown): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), by, ctx.clock.now()],
  );
}

/** The core platform setting `videoPosts` (defaults for whatever was never set). */
export async function videoSettings(ctx: Ctx): Promise<VideoSettings> {
  const r = await one(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [SETTINGS_KEY]);
  const v = (r?.value ?? {}) as Partial<VideoSettings>;
  return {
    ...DEFAULT_VIDEO_SETTINGS,
    ...v,
    playlists: { ...DEFAULT_VIDEO_SETTINGS.playlists, ...(v.playlists ?? {}) },
  };
}

export async function patchVideoSettings(
  ctx: Ctx,
  by: AuthSession['user'],
  patch: PatchVideoSettingsRequest,
): Promise<VideoSettings> {
  const cur = await videoSettings(ctx);
  const next: VideoSettings = { ...cur, ...stripUndefined(patch), playlists: { ...cur.playlists } };
  if (patch.playlists) {
    for (const k of ['article', 'release', 'tutorial'] as const) {
      const v = patch.playlists[k];
      if (v === undefined) continue;
      if (v === '') delete next.playlists[k];
      else next.playlists[k] = v;
    }
  }
  await putSetting(ctx, by.id, SETTINGS_KEY, next);
  await ctx.store.append([
    {
      streamId: 'video-settings',
      event: { type: 'VideoSettingsChanged', payload: { change: stripUndefined(patch), by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return videoSettings(ctx);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function assertVideoEnabled(settings: VideoSettings): void {
  if (!settings.enabled)
    throw new HttpError(503, 'video_disabled', 'video posts are switched off in the platform settings');
}

/** The YouTube channel row, if any. */
export async function youtubeChannel(
  ctx: Ctx,
): Promise<{ status: 'ok' | 'needs_reconnect'; accountName: string | null; connectedAt: Date } | null> {
  const r = await one(ctx.pool, `SELECT * FROM social_channels WHERE network='youtube'`);
  return r
    ? { status: r.status, accountName: r.account_name || r.account_id, connectedAt: new Date(r.connected_at) }
    : null;
}

/** True when everything automatic may run: `videoPosts.enabled` AND a YouTube channel with status ok. */
export async function videoActive(ctx: Ctx): Promise<boolean> {
  const [s, c] = await Promise.all([videoSettings(ctx), youtubeChannel(ctx)]);
  return s.enabled && c?.status === 'ok';
}

// ---- worker heartbeat

export async function beatHeartbeat(ctx: Ctx, info: Record<string, unknown> = {}): Promise<void> {
  await putSetting(ctx, null, HEARTBEAT_KEY, { at: ctx.clock.now().toISOString(), ...info });
}
export async function workerHeartbeat(ctx: Ctx): Promise<{ running: boolean; lastSeen: string | null }> {
  const r = await one(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [HEARTBEAT_KEY]);
  const at = (r?.value as { at?: string } | undefined)?.at ?? null;
  const running =
    !!at && ctx.clock.now().getTime() - Date.parse(at) <= VIDEO_POST_LIMITS.heartbeatStaleSeconds * 1000;
  return { running, lastSeen: at };
}

// ---- slots

/** 10:00 SAST (08:00 UTC) on the day of `t` or the day after. */
export function slotAfter(t: Date, taken: Iterable<string> = []): Date {
  const used = new Set([...taken].map((x) => new Date(x).toISOString().slice(0, 10)));
  const minimum = t.getTime() + 30 * 60_000; // YouTube wants publishAt well in the future
  const d = new Date(t);
  d.setUTCHours(VIDEO_POST_LIMITS.slotHourUtc, 0, 0, 0);
  for (let i = 0; i < 400; i++, d.setUTCDate(d.getUTCDate() + 1))
    if (d.getTime() >= minimum && !used.has(d.toISOString().slice(0, 10))) return new Date(d);
  return d;
}

/**
 * The slots (ISO) already given to uploads: any share that holds a reserved `publishAt` and is either still going to upload
 * (pending with its reservation, posting, sent, locked) or already put a video on YouTube (a `videoId`, even if a later
 * step failed). A failed share that never uploaded gives its slot back.
 */
export async function takenSlots(ctx: Ctx): Promise<string[]> {
  const rs = await rows(
    ctx.pool,
    `SELECT detail->>'publishAt' AS at FROM social_shares
      WHERE source='video' AND network='youtube' AND detail->>'publishAt' IS NOT NULL
        AND (status IN ('pending','posting','sent','locked_private') OR detail->>'videoId' IS NOT NULL)`,
  );
  return rs.map((r) => r.at as string);
}

export async function nextUploadSlot(ctx: Ctx): Promise<Date> {
  return slotAfter(ctx.clock.now(), await takenSlots(ctx));
}

// ---- artifacts on disk

const ARTIFACT_NAMES: Record<string, string> = {
  'video.mp4': 'video',
  'short.mp4': 'video',
  'captions.vtt': 'captionsVtt',
  'captions.srt': 'captionsSrt',
  'thumb.png': 'thumb',
  'script.json': 'script',
  'render.log': 'log',
  'description.txt': 'description',
};
/** The artifact key a preview file name stands for (own properties only: never `constructor` or `__proto__`). */
export const artifactKeyOf = (name: string): string | null =>
  Object.hasOwn(ARTIFACT_NAMES, name) ? (ARTIFACT_NAMES[name] as string) : null;
const FILE_KEYS = ['video', 'captionsVtt', 'captionsSrt', 'thumb', 'script', 'log', 'description'];

/**
 * The absolute path of a render's artifact on THIS machine. A relative entry lives under AOM_VIDEO_DIR and may not leave it.
 * A `lib:<slug>` marker (a library video: the recorded help video is the artifact) is resolved through the media folder,
 * which only the video worker has; elsewhere it is null.
 */
export function artifactPath(ctx: Ctx, artifacts: Record<string, unknown>, key: string): string | null {
  const v = artifacts[key];
  if (typeof v !== 'string' || !v) return null;
  if (v.startsWith(LIBRARY_MARKER)) return libraryFile(v, key === 'captionsVtt' ? 'vtt' : 'mp4');
  if (isAbsolute(v)) return null;
  const root = resolve(ctx.config.videoDir);
  const full = resolve(root, v);
  return full.startsWith(root + sep) ? full : null;
}

export const renderDir = (postId: string, revision: number): string => join(postId, String(revision));

// ---- DTOs

const SELECT = `SELECT p.*, u.display_name AS user_name FROM video_posts p LEFT JOIN users u ON u.id = p.origin_user_id`;

function renderDto(r: Row): VideoRender {
  const a = (r.artifacts ?? {}) as Record<string, unknown>;
  return {
    id: r.id,
    revision: r.revision,
    status: r.status,
    attempts: r.attempts,
    error: r.error ?? null,
    durationSeconds: r.duration_s ?? null,
    bytes: r.bytes === null || r.bytes === undefined ? null : Number(r.bytes),
    createdAt: iso(r.created_at) as string,
    finishedAt: iso(r.finished_at),
    files: FILE_KEYS.filter((k) => typeof a[k] === 'string' && a[k]),
    purged: !!r.purged_at,
    library: !!r.library,
  };
}

function uploadDto(r: Row): VideoUpload {
  const d = (r.detail ?? {}) as Record<string, any>;
  return {
    status: r.status === 'posting' ? 'posting' : r.status,
    attempts: r.attempts,
    videoId: r.external_id ?? null,
    url: r.url ?? null,
    error: r.error ?? null,
    nextAttemptAt: iso(r.next_attempt_at),
    publishAt: d.publishAt ?? null,
    privacy: d.privacy ?? null,
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
  };
}

async function toDtos(ctx: Ctx, ps: Row[]): Promise<VideoPost[]> {
  if (!ps.length) return [];
  const ids = ps.map((p) => p.id as string);
  const [renders, shares, kids, crossPosts] = await Promise.all([
    rows(ctx.pool, `SELECT * FROM video_renders WHERE post_id = ANY($1::uuid[]) ORDER BY revision`, [ids]),
    rows(ctx.pool, `SELECT * FROM social_shares WHERE source='video' AND post_id = ANY($1::uuid[])`, [ids]),
    rows(ctx.pool, `SELECT id, parent_id FROM video_posts WHERE parent_id = ANY($1::uuid[])`, [ids]),
    rows(ctx.pool, `SELECT * FROM social_posts WHERE kind='video' AND ref = ANY($1::text[])`, [ids]),
  ]);
  const cpShares = crossPosts.length
    ? await rows(
        ctx.pool,
        `SELECT * FROM social_shares WHERE source='social' AND post_id = ANY($1::uuid[])`,
        [crossPosts.map((c) => c.id)],
      )
    : [];
  return ps.map((p) => {
    const mine = renders.filter((r) => r.post_id === p.id);
    const current = mine.find((r) => r.revision === p.revision) ?? null;
    const share = shares.find((s) => s.post_id === p.id && s.network === 'youtube');
    const cp = crossPosts.find((c) => c.ref === p.id);
    const crossPost: VideoCrossPost | null = cp
      ? {
          id: cp.id,
          status: cp.status,
          title: cp.title,
          content: cp.content,
          rejectionReason: cp.rejection_reason ?? null,
          approvedAt: iso(cp.approved_at),
          shares: cpShares
            .filter((s) => s.post_id === cp.id)
            .map((s) => ({
              network: s.network,
              status: s.status,
              url: s.url ?? null,
              error: s.error ?? null,
            })),
        }
      : null;
    return {
      id: p.id,
      kind: p.kind,
      format: p.format,
      ref: p.ref,
      parentId: p.parent_id ?? null,
      status: p.status as VideoPostStatus,
      title: p.title,
      revision: p.revision,
      script: (p.script as VideoScript | null) ?? null,
      meta: p.meta as VideoPostMeta,
      rejectionReason: p.rejection_reason ?? null,
      origin: p.user_name ?? (p.origin_system === 'blog-writer' ? 'Blog writer' : null),
      reviewSince: iso(p.review_since),
      approvedAt: iso(p.approved_at),
      approvedRenderId: p.approved_render_id ?? null,
      createdAt: iso(p.created_at) as string,
      updatedAt: iso(p.updated_at) as string,
      render: current ? renderDto(current) : null,
      rendersUsed: mine.filter((r) => !r.library).length,
      library: isLibraryRef(p.ref),
      shortId: kids.find((k) => k.parent_id === p.id)?.id ?? null,
      upload: share ? uploadDto(share) : null,
      crossPost,
    };
  });
}

export async function getVideoPost(ctx: Ctx, id: string): Promise<VideoPost> {
  const r = await one(ctx.pool, `${SELECT} WHERE p.id = $1`, [id]);
  if (!r) throw notFound('video post not found', 'video_post_not_found');
  return (await toDtos(ctx, [r]))[0] as VideoPost;
}

export async function listVideoPosts(
  ctx: Ctx,
  opts: { status?: VideoPostStatus } = {},
): Promise<VideoPostList> {
  const rs = await rows(
    ctx.pool,
    `${SELECT} ${opts.status ? 'WHERE p.status = $1' : ''} ORDER BY p.updated_at DESC LIMIT 300`,
    opts.status ? [opts.status] : [],
  );
  return { posts: await toDtos(ctx, rs), status: await videoStatus(ctx) };
}

/** Writer posts of the last 7 days against the weekly caps (rejected ones do not count; the owner turned them down). */
export async function videoCapacity(ctx: Ctx): Promise<VideoCapacity> {
  const s = await videoSettings(ctx);
  const since = new Date(ctx.clock.now().getTime() - 7 * DAY);
  const r = await rows(
    ctx.pool,
    `SELECT format, count(*)::int AS n FROM video_posts
      WHERE origin_system IS NOT NULL AND status <> 'rejected' AND created_at >= $1 GROUP BY format`,
    [since],
  );
  const n = (f: string) => r.find((x) => x.format === f)?.n ?? 0;
  return {
    long: { used: n('long'), limit: s.perWeek },
    short: { used: n('short'), limit: s.shortsPerWeek },
  };
}

export async function videoStatus(ctx: Ctx): Promise<VideoStatus> {
  const [settings, channel, worker, capacity, slot, pending, locked] = await Promise.all([
    videoSettings(ctx),
    youtubeChannel(ctx),
    workerHeartbeat(ctx),
    videoCapacity(ctx),
    nextUploadSlot(ctx),
    one(ctx.pool, `SELECT count(*)::int AS n FROM video_posts WHERE status='in_review'`),
    one(
      ctx.pool,
      `SELECT count(*)::int AS n FROM social_shares WHERE source='video' AND status='locked_private'`,
    ),
  ]);
  return {
    settings,
    channel: {
      connected: !!channel,
      status: channel?.status ?? 'disconnected',
      accountName: channel?.accountName ?? null,
    },
    active: settings.enabled && channel?.status === 'ok',
    worker,
    capacity,
    nextSlot: slot.toISOString(),
    pending: pending?.n ?? 0,
    lockedPrivate: locked?.n ?? 0,
    auditFormUrl: YOUTUBE_AUDIT_FORM_URL,
  };
}

export async function pendingVideoPosts(ctx: Ctx): Promise<number> {
  return (await one(ctx.pool, `SELECT count(*)::int AS n FROM video_posts WHERE status='in_review'`))?.n ?? 0;
}

// ---- validation

function checkScript(script: VideoScript, expect?: { kind?: VideoKind; format?: VideoFormat }): void {
  if (expect?.kind && script.kind !== expect.kind)
    throw badRequest('validation_error', `the script is for a ${script.kind} video, not ${expect.kind}`);
  if (expect?.format && script.format !== expect.format)
    throw badRequest('validation_error', `the script is a ${script.format} script, not ${expect.format}`);
  // the app's catalog is the library manifest: a script with clips can only be checked against it
  const catalog = libraryCatalog();
  if (!catalog.length && script.cues.some((c) => c.scene.type === 'clip'))
    throw conflict(
      'no_media_catalog',
      'this server has no catalog of the help videos, so clip scenes cannot be checked',
    );
  const slugs = catalog.map((c) => c.slug);
  const issues = videoScriptIssues(script, { clipSlugs: slugs });
  if (issues.length) throw badRequest('invalid_script', 'the script has problems', issues);
}

const metaOf = (script: VideoScript, privacy?: VideoPostMeta['privacy']): VideoPostMeta => ({
  ...script.meta,
  ...(privacy ? { privacy } : {}),
});

async function withLock<T>(ctx: Ctx, key: string, fn: () => Promise<T>): Promise<T> {
  const lock = await ctx.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await fn();
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    } finally {
      lock.release();
    }
  }
}

async function queueRender(ctx: Ctx, postId: string, revision: number): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO video_renders (id, post_id, revision, status, attempts, created_at)
     VALUES ($1,$2,$3,'queued',0,$4) ON CONFLICT (post_id, revision) DO NOTHING`,
    [randomUUID(), postId, revision, ctx.clock.now()],
  );
}

// ---- submit / revise / approve / reject

/**
 * Creates the video post for (kind, ref, format) and queues render 1. Idempotent: a post that exists returns itself
 * (`created: false`) whatever the script. `status` is `draft` for the super admin's own start and `in_review` for a
 * writer's finished script. The hosted blog writer and the platform route both come through here.
 *
 * Needs `videoPosts.enabled` (503 `video_disabled`). A writer's post (`origin.system`) also respects the per-kind switches
 * and the weekly caps (409 `kind_off`, `weekly_cap`); a person's own submit does not.
 */
export async function submitVideoPost(
  ctx: Ctx,
  input: SubmitVideoPostRequest,
  origin: Origin,
  status: 'draft' | 'in_review',
): Promise<{ post: VideoPost; created: boolean }> {
  const settings = await videoSettings(ctx);
  assertVideoEnabled(settings);
  const script = VideoScriptSchema.parse(input.script);
  checkScript(script, { kind: input.kind, format: input.format });
  // writer submissions share one lock for the weekly caps: concurrent submits cannot both pass the count
  const guarded = <T>(fn: () => Promise<T>): Promise<T> =>
    origin.system ? withLock(ctx, 'video-writer-cap', fn) : fn();
  return guarded(() =>
    withLock(ctx, `video-post:${input.kind}:${input.ref}:${input.format}`, async () => {
      const existing = await one(
        ctx.pool,
        'SELECT id FROM video_posts WHERE kind=$1 AND ref=$2 AND format=$3',
        [input.kind, input.ref, input.format],
      );
      if (existing) return { post: await getVideoPost(ctx, existing.id), created: false };
      if (origin.system) {
        const on = {
          article: settings.articleVideos,
          release: settings.releaseVideos,
          tutorial: settings.tutorials,
        }[input.kind];
        if (!on || (input.format === 'short' && !settings.shorts))
          throw conflict(
            'kind_off',
            `${input.format === 'short' ? 'Shorts are' : `${input.kind} videos are`} switched off`,
          );
        const cap = await videoCapacity(ctx);
        const c = cap[input.format];
        if (c.used >= c.limit)
          throw conflict('weekly_cap', `the weekly limit of ${c.limit} ${input.format} videos is reached`);
      }
      if (input.parentId) {
        const parent = await one(ctx.pool, 'SELECT format FROM video_posts WHERE id=$1', [input.parentId]);
        if (!parent) throw badRequest('unknown_parent', 'the long video of this Short does not exist');
        if (input.format !== 'short' || parent.format !== 'long')
          throw badRequest('validation_error', 'only a Short can point at a long video');
      }
      const postId = randomUUID();
      const stored: VideoScript = { ...script, ref: script.ref ?? input.ref };
      await ctx.store.append([
        {
          streamId: videoPostStream(postId),
          event: {
            type: 'VideoPostSubmitted',
            payload: {
              postId,
              kind: input.kind,
              format: input.format,
              ref: input.ref,
              ...(input.parentId ? { parentId: input.parentId } : {}),
              script: stored,
              meta: metaOf(stored),
              origin,
              status,
            },
          },
          actor: origin.userId ? userActor(origin.userId) : SYSTEM_ACTOR,
          scope: adminScope,
        },
      ]);
      await queueRender(ctx, postId, 1);
      return { post: await getVideoPost(ctx, postId), created: true };
    }),
  );
}

const withoutTags = (s: VideoScript) => JSON.stringify({ ...s, meta: { ...s.meta, tags: [] } });

/**
 * Edits a post that is not approved. A change to the script, title, description or hashtags re-renders (a new revision and
 * render, at most 3 renders a post: 409 `render_limit`); tags and privacy change in place. A library video has no script:
 * only its metadata can change, never a render.
 */
export function reviseVideoPost(
  ctx: Ctx,
  postId: string,
  patch: EditVideoPostRequest,
  by: Origin,
): Promise<VideoPost> {
  // the same lock as approve: an approval and an edit of one post cannot interleave (an edit that lost queues no render)
  return withLock(ctx, `video-post-edit:${postId}`, () => reviseLocked(ctx, postId, patch, by));
}

async function reviseLocked(
  ctx: Ctx,
  postId: string,
  patch: EditVideoPostRequest,
  by: Origin,
): Promise<VideoPost> {
  const r = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [postId]);
  if (!r) throw notFound('video post not found', 'video_post_not_found');
  if (r.status === 'approved') throw conflict('already_approved', 'an approved video cannot be edited');
  const oldScript = r.script as VideoScript | null;
  const oldMeta = r.meta as VideoPostMeta;
  let script = oldScript;
  let meta: VideoPostMeta;
  if (!oldScript) {
    if (patch.script) throw badRequest('library_video', 'a library video has no script; edit its metadata');
    meta = { ...oldMeta, ...stripUndefined(patch.meta ?? {}) } as VideoPostMeta;
  } else {
    script = patch.script ? VideoScriptSchema.parse(patch.script) : oldScript;
    if (patch.meta)
      script = {
        ...script,
        ...(patch.meta.title ? { title: patch.meta.title } : {}),
        meta: { ...script.meta, ...stripUndefined(patch.meta) },
      };
    checkScript(script, { kind: r.kind, format: r.format });
    meta = metaOf(script, oldMeta.privacy);
  }
  if (patch.privacy !== undefined) {
    const { privacy: _drop, ...rest } = meta;
    meta = patch.privacy ? { ...rest, privacy: patch.privacy } : rest;
  }
  const rerender = !!script && !!oldScript && withoutTags(script) !== withoutTags(oldScript);
  if (
    !rerender &&
    JSON.stringify(meta) === JSON.stringify(oldMeta) &&
    JSON.stringify(script) === JSON.stringify(oldScript)
  )
    return getVideoPost(ctx, postId);
  if (script && !oldScript) throw badRequest('library_video', 'a library video has no script');
  if (rerender) {
    const used = await one(
      ctx.pool,
      `SELECT count(*)::int AS n FROM video_renders WHERE post_id=$1 AND NOT library`,
      [postId],
    );
    if ((used?.n ?? 0) >= VIDEO_POST_LIMITS.maxRenders)
      throw conflict(
        'render_limit',
        `this video was rendered ${VIDEO_POST_LIMITS.maxRenders} times already; approve it, reject it or edit only the tags and privacy`,
      );
  }
  const revision = rerender ? (r.revision as number) + 1 : (r.revision as number);
  await ctx.store.append([
    {
      streamId: videoPostStream(postId),
      event: { type: 'VideoPostRevised', payload: { postId, script, meta, revision, rerender, by } },
      actor: by.userId ? userActor(by.userId) : SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
  if (rerender) await queueRender(ctx, postId, revision);
  return getVideoPost(ctx, postId);
}

/**
 * The owner's go-ahead for the rendered video: pins the current revision's render. Needs a connected YouTube channel
 * (409 `no_channel`) and a finished render of the current revision (409 `not_rendered`). The worker uploads it at the
 * next free daily slot.
 */
export function approveVideoPost(ctx: Ctx, by: AuthSession['user'], postId: string): Promise<VideoPost> {
  return withLock(ctx, `video-post-edit:${postId}`, () => approveLocked(ctx, by, postId));
}

async function approveLocked(ctx: Ctx, by: AuthSession['user'], postId: string): Promise<VideoPost> {
  const r = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [postId]);
  if (!r) throw notFound('video post not found', 'video_post_not_found');
  if (r.status === 'approved') return getVideoPost(ctx, postId);
  if (r.status === 'rejected')
    throw conflict('post_rejected', 'a rejected video must be edited (it then returns to review) first');
  if (!(await youtubeChannel(ctx)))
    throw conflict('no_channel', 'connect a YouTube channel first: nothing would be uploaded');
  const render = await one(ctx.pool, 'SELECT * FROM video_renders WHERE post_id=$1 AND revision=$2', [
    postId,
    r.revision,
  ]);
  if (!render || render.status !== 'rendered')
    throw conflict('not_rendered', 'the video of this revision is not rendered yet');
  await ctx.store.append([
    {
      streamId: videoPostStream(postId),
      event: { type: 'VideoPostApproved', payload: { postId, renderId: render.id, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getVideoPost(ctx, postId);
}

export async function rejectVideoPost(
  ctx: Ctx,
  by: AuthSession['user'],
  postId: string,
  reason: string,
): Promise<VideoPost> {
  const r = await one(ctx.pool, 'SELECT status FROM video_posts WHERE id=$1', [postId]);
  if (!r) throw notFound('video post not found', 'video_post_not_found');
  if (r.status === 'approved') throw conflict('already_approved', 'an approved video cannot be rejected');
  await ctx.store.append([
    {
      streamId: videoPostStream(postId),
      event: { type: 'VideoPostRejected', payload: { postId, reason, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getVideoPost(ctx, postId);
}

async function auditRetry(
  ctx: Ctx,
  postId: string,
  what: 'render' | 'upload' | 'resolve-locked',
  by: string,
): Promise<void> {
  await ctx.store.append([
    {
      streamId: videoPostStream(postId),
      event: { type: 'VideoRetryRequested', payload: { postId, what, by } },
      actor: userActor(by),
      scope: adminScope,
    },
  ]);
}

/** A render that failed three times is tried again on request (the same revision, no new render is used). */
export async function retryRender(ctx: Ctx, by: string, postId: string): Promise<VideoPost> {
  const r = await one(ctx.pool, 'SELECT revision FROM video_posts WHERE id=$1', [postId]);
  if (!r) throw notFound('video post not found', 'video_post_not_found');
  const n = await exec(
    ctx.pool,
    `UPDATE video_renders SET status='queued', attempts=0, error=NULL, lease_until=NULL
      WHERE post_id=$1 AND revision=$2 AND status='failed' AND NOT library`,
    [postId, r.revision],
  );
  if (!n) throw conflict('not_failed', 'only a failed render can be tried again');
  await auditRetry(ctx, postId, 'render', by);
  return getVideoPost(ctx, postId);
}

/** A failed upload is tried again on request. 409 `video_purged` when the cleanup already removed the MP4. */
export async function retryUpload(ctx: Ctx, by: string, postId: string): Promise<VideoPost> {
  const now = ctx.clock.now();
  const share = await one(
    ctx.pool,
    `SELECT s.detail, r.artifacts FROM social_shares s
       JOIN video_posts p ON p.id = s.post_id LEFT JOIN video_renders r ON r.id = p.approved_render_id
      WHERE s.post_id=$1 AND s.network='youtube' AND s.source='video' AND s.status IN ('failed','skipped')`,
    [postId],
  );
  if (!share) throw conflict('not_failed', 'only a failed upload can be tried again');
  const uploaded = !!(share.detail as { videoId?: string } | null)?.videoId;
  const art = (share.artifacts ?? {}) as Record<string, unknown>;
  if (!uploaded && !art.video)
    throw conflict(
      'video_purged',
      'the video file was removed by the clean-up; it cannot be uploaded any more',
    );
  await exec(
    ctx.pool,
    `UPDATE social_shares SET status='pending', attempts=0, next_attempt_at=$2, error=NULL, updated_at=$2
      WHERE post_id=$1 AND network='youtube' AND source='video' AND status IN ('failed','skipped')`,
    [postId, now],
  );
  await auditRetry(ctx, postId, 'upload', by);
  return getVideoPost(ctx, postId);
}

/** The owner dealt with a video YouTube kept private (made it public by hand, or asked for the audit): uploads go on. */
export async function resolveLockedUpload(ctx: Ctx, by: string, postId: string): Promise<VideoPost> {
  const now = ctx.clock.now();
  const n = await exec(
    ctx.pool,
    `UPDATE social_shares SET status='sent', updated_at=$2,
            detail = COALESCE(detail,'{}'::jsonb) || jsonb_build_object('verifiedAt', $3::text)
      WHERE post_id=$1 AND network='youtube' AND source='video' AND status='locked_private'`,
    [postId, now, now.toISOString()],
  );
  if (!n) throw conflict('not_locked', 'this upload is not waiting on YouTube');
  await auditRetry(ctx, postId, 'resolve-locked', by);
  return getVideoPost(ctx, postId);
}

// ---- library import (existing help videos; their MP4 is the artifact, metadata only)

function libraryMeta(title: string, chapters: string[]): VideoPostMeta {
  const t = fitCaption(`${title} | Guildwise HQ`, 100).replace(/[<>]/g, '');
  const topics = chapters.slice(0, 5).join(', ');
  return {
    title: t,
    description: fitCaption(
      `${title}: a walkthrough of Guildwise HQ, the workspace where AI agents do the work and you stay in charge.${topics ? ` In this video: ${topics}.` : ''}`,
      600,
    ).replace(/[<>]/g, ''),
    tags: ['Guildwise HQ', 'AI agents', 'tutorial', 'automation'],
    hashtags: ['#GuildwiseHQ', '#AIAgents', '#Tutorial'],
  };
}

/**
 * The render row of a library post: born `rendered`, the artifact is the marker `lib:<slug>` (the worker resolves it to the
 * recorded MP4 and its captions in its own media folder; the app never has the file). Idempotent.
 */
export async function insertLibraryRender(
  ctx: Ctx,
  postId: string,
  e: LibraryEntry,
  revision = 1,
): Promise<void> {
  const marker = `${LIBRARY_MARKER}${e.slug}`;
  await exec(
    ctx.pool,
    `INSERT INTO video_renders (id, post_id, revision, status, attempts, duration_s, artifacts, library, created_at, finished_at)
     VALUES ($1,$2,$3,'rendered',0,$4,$5::jsonb,true,$6,$6) ON CONFLICT (post_id, revision) DO NOTHING`,
    [
      randomUUID(),
      postId,
      revision,
      e.duration,
      JSON.stringify({
        video: marker,
        ...(e.vtt ? { captionsVtt: marker } : {}),
        chapters: e.chapters.map((c) => ({ title: c.title, start: Math.round(c.t0) })),
      }),
      ctx.clock.now(),
    ],
  );
}

/** The recorded help videos and whether each is imported. Empty when neither the manifest nor the media folder exists. Empty when the server has no media folder. */
export async function listLibrary(ctx: Ctx): Promise<VideoLibraryEntry[]> {
  const catalog = libraryCatalog();
  const have = new Set(
    (await rows(ctx.pool, `SELECT ref FROM video_posts WHERE kind='tutorial' AND format='long'`)).map(
      (x) => x.ref as string,
    ),
  );
  return catalog.map((e) => ({
    slug: e.slug,
    title: e.title,
    durationSeconds: e.duration,
    chapters: e.chapters.length,
    imported: have.has(`${VIDEO_LIBRARY_PREFIX}${e.slug}`),
  }));
}

/**
 * "Library": makes a draft `tutorial` / `lib:<slug>` post of each help video that is not imported yet (all, or `slugs`).
 * Nothing is rendered: the recorded MP4 and its captions are the artifact, the render row is born `rendered`. The metadata
 * is a plain default for the owner (or the cloud writer) to edit. Returns the posts created.
 */
export async function importLibrary(
  ctx: Ctx,
  by: Origin,
  slugs?: string[],
): Promise<{ created: VideoPost[]; skipped: string[] }> {
  assertVideoEnabled(await videoSettings(ctx));
  const catalog = libraryCatalog();
  if (!catalog.length)
    throw conflict(
      'no_media',
      'this server has no catalog of the help videos (media/videos or dist/video-library.json)',
    );
  const wanted = slugs ? catalog.filter((e) => slugs.includes(e.slug)) : catalog;
  if (slugs) {
    const unknown = slugs.filter((s) => !catalog.some((e) => e.slug === s));
    if (unknown.length) throw badRequest('unknown_video', `no help video ${unknown.join(', ')}`);
  }
  const created: VideoPost[] = [];
  const skipped: string[] = [];
  for (const e of wanted) {
    const ref = `${VIDEO_LIBRARY_PREFIX}${e.slug}`;
    const made = await withLock(ctx, `video-post:tutorial:${ref}:long`, async () => {
      if (
        await one(
          ctx.pool,
          `SELECT 1 AS x FROM video_posts WHERE kind='tutorial' AND ref=$1 AND format='long'`,
          [ref],
        )
      )
        return null;
      const postId = randomUUID();
      await ctx.store.append([
        {
          streamId: videoPostStream(postId),
          event: {
            type: 'VideoPostSubmitted',
            payload: {
              postId,
              kind: 'tutorial',
              format: 'long',
              ref,
              script: null,
              meta: libraryMeta(
                e.title,
                e.chapters.map((c) => c.title),
              ),
              origin: by,
              status: 'in_review',
            },
          },
          actor: by.userId ? userActor(by.userId) : SYSTEM_ACTOR,
          scope: adminScope,
        },
      ]);
      await insertLibraryRender(ctx, postId, e);
      return postId;
    });
    if (made) created.push(await getVideoPost(ctx, made));
    else skipped.push(e.slug);
  }
  return { created, skipped };
}

// ---- what the writer should make a video of

/** A published article within `maxAgeDays` that has no long video post yet. Empty unless videos are active and on for articles. */
export async function articlesNeedingVideo(
  ctx: Ctx,
  maxAgeDays = 7,
): Promise<
  Array<{
    slug: string;
    title: string;
    summary: string;
    tags: string[];
    publishedAt: string;
    content: BlogContent;
  }>
> {
  const [settings, channel] = await Promise.all([videoSettings(ctx), youtubeChannel(ctx)]);
  if (!settings.enabled || !settings.articleVideos || channel?.status !== 'ok') return [];
  const since = new Date(ctx.clock.now().getTime() - maxAgeDays * DAY);
  const rs = await rows(
    ctx.pool,
    `SELECT p.* FROM blog_posts p
      WHERE p.status='published' AND NOT p.launch AND p.published_at >= $1 AND p.published_at >= $2
        AND NOT EXISTS (SELECT 1 FROM video_posts v WHERE v.kind='article' AND v.ref = p.slug AND v.format='long')
      ORDER BY p.published_at DESC`,
    [since, channel.connectedAt],
  );
  return rs.map((p) => ({
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    tags: p.tags,
    publishedAt: iso(p.published_at) as string,
    content: p.content as BlogContent,
  }));
}

/** Releases of the last `maxAgeDays` with no long video post yet. Empty unless videos are active and on for releases. */
export async function releasesNeedingVideo(ctx: Ctx, maxAgeDays = 7): Promise<Release[]> {
  const [settings, channel] = await Promise.all([videoSettings(ctx), youtubeChannel(ctx)]);
  if (!settings.enabled || !settings.releaseVideos || channel?.status !== 'ok') return [];
  const now = ctx.clock.now().getTime();
  const taken = new Set(
    (await rows(ctx.pool, `SELECT ref FROM video_posts WHERE kind='release' AND format='long'`)).map(
      (x) => x.ref as string,
    ),
  );
  return loadReleases(ctx).filter((r) => {
    const age = now - Date.parse(`${r.date}T00:00:00Z`);
    return !taken.has(r.version) && Number.isFinite(age) && age <= maxAgeDays * DAY;
  });
}

// ---- Video topics (like Blog Topics: new "showcase" videos of what you can do with Guildwise HQ)

export const VIDEO_TOPICS_STREAM = 'video-topics';

function topicDto(r: Row): VideoTopic {
  return {
    id: r.id,
    title: r.title,
    brief: r.brief,
    origin: r.origin,
    status: r.status,
    reason: r.reason ?? null,
    attempts: r.attempts,
    postId: r.post_id ?? null,
    queuedAt: iso(r.queued_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

export async function listVideoTopics(ctx: Ctx, limit = 200): Promise<VideoTopicList> {
  const list = await rows(
    ctx.pool,
    `SELECT * FROM video_topics
      ORDER BY (status = 'queued') DESC, CASE WHEN status = 'queued' THEN sort_at END ASC, updated_at DESC, id LIMIT $1`,
    [limit],
  );
  const q = await one(ctx.pool, `SELECT count(*)::int AS n FROM video_topics WHERE status='queued'`);
  return { topics: list.map(topicDto), queued: q?.n ?? 0 };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Adds a topic to the queue: the owner's own idea (`platform`) or one the writer proposes (`writer`). A title that is
 * already queued, being written or drafted is not added again (`duplicate: true`, the existing topic is returned).
 */
export async function queueVideoTopic(
  ctx: Ctx,
  input: { title: string; brief?: string },
  origin: 'platform' | 'writer',
  by?: string,
): Promise<{ topic: VideoTopic; duplicate: boolean }> {
  const title = input.title.trim();
  if (title.length < VIDEO_TOPIC_LIMITS.titleMin || title.length > VIDEO_TOPIC_LIMITS.titleMax)
    throw badRequest('validation_error', 'the topic title has a wrong length');
  return withLock(ctx, 'video-topics', async () => {
    const same = (
      await rows(ctx.pool, `SELECT * FROM video_topics WHERE status IN ('queued','writing','drafted')`)
    ).find((t) => norm(t.title) === norm(title));
    if (same) return { topic: topicDto(same), duplicate: true };
    const topicId = randomUUID();
    await ctx.store.append([
      {
        streamId: VIDEO_TOPICS_STREAM,
        event: {
          type: 'VideoTopicQueued',
          payload: {
            topicId,
            title,
            brief: (input.brief ?? '').trim().slice(0, VIDEO_TOPIC_LIMITS.briefMax),
            origin,
            by: by ?? null,
          },
        },
        actor: by ? userActor(by) : SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
    const r = await one(ctx.pool, 'SELECT * FROM video_topics WHERE id=$1', [topicId]);
    return { topic: topicDto(r as Row), duplicate: false };
  });
}

async function topicOrThrow(ctx: Ctx, id: string, statuses: string[]): Promise<Row> {
  const r = await one(ctx.pool, 'SELECT * FROM video_topics WHERE id=$1', [id]);
  if (!r) throw notFound('topic not found', 'topic_not_found');
  if (!statuses.includes(r.status)) throw conflict('not_queued', `the topic is ${r.status}`);
  return r;
}

export async function rejectVideoTopic(ctx: Ctx, id: string, reason: string, by: string): Promise<void> {
  await topicOrThrow(ctx, id, ['queued', 'writing']);
  await ctx.store.append([
    {
      streamId: VIDEO_TOPICS_STREAM,
      event: { type: 'VideoTopicRejected', payload: { topicId: id, reason, by } },
      actor: userActor(by),
      scope: adminScope,
    },
  ]);
}

export async function moveVideoTopicUp(ctx: Ctx, id: string, by: string): Promise<void> {
  await topicOrThrow(ctx, id, ['queued']);
  await ctx.store.append([
    {
      streamId: VIDEO_TOPICS_STREAM,
      event: { type: 'VideoTopicMoved', payload: { topicId: id, by } },
      actor: userActor(by),
      scope: adminScope,
    },
  ]);
}

/**
 * The writer takes the oldest queued topic (it becomes `writing`). Null when there is none, or unless videos are active
 * and tutorials are on. The writer then calls `submitVideoPost({kind: 'tutorial', ref: topic.id, ...})`, which marks the
 * topic drafted, or `releaseVideoTopic` when it fails (the topic returns to the queue; after two takes it is rejected).
 */
export async function claimVideoTopic(ctx: Ctx): Promise<VideoTopic | null> {
  const [settings, channel] = await Promise.all([videoSettings(ctx), youtubeChannel(ctx)]);
  if (!settings.enabled || !settings.tutorials || channel?.status !== 'ok') return null;
  return withLock(ctx, 'video-topics', async () => {
    const t = await one(
      ctx.pool,
      `SELECT * FROM video_topics WHERE status='queued' ORDER BY sort_at, id LIMIT 1`,
    );
    if (!t) return null;
    await ctx.store.append([
      {
        streamId: VIDEO_TOPICS_STREAM,
        event: { type: 'VideoTopicTaken', payload: { topicId: t.id } },
        actor: SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
    return topicDto((await one(ctx.pool, 'SELECT * FROM video_topics WHERE id=$1', [t.id])) as Row);
  });
}

export async function releaseVideoTopic(ctx: Ctx, topicId: string, reason?: string): Promise<void> {
  await topicOrThrow(ctx, topicId, ['writing']);
  await ctx.store.append([
    {
      streamId: VIDEO_TOPICS_STREAM,
      event: {
        type: 'VideoTopicReleased',
        payload: { topicId, ...(reason ? { reason: reason.slice(0, 500) } : {}) },
      },
      actor: SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
}

// ---- the public embed

/**
 * The YouTube video to embed on the article or release page: the long video of (kind, ref) once it is on YouTube and
 * visible (not private, and past its scheduled publish time). Null otherwise: a page never embeds a video nobody can watch.
 */
export async function publicVideoEmbed(
  ctx: Ctx,
  kind: 'article' | 'release',
  ref: string,
): Promise<{ videoId: string; title: string } | null> {
  const r = await one(
    ctx.pool,
    `SELECT s.external_id, s.detail, p.title FROM video_posts p
       JOIN social_shares s ON s.post_id = p.id AND s.network='youtube' AND s.source='video' AND s.status='sent'
      WHERE p.kind=$1 AND p.ref=$2 AND p.format='long' AND s.external_id IS NOT NULL`,
    [kind, ref],
  );
  if (!r) return null;
  const d = (r.detail ?? {}) as { privacy?: string; publishAt?: string | null; verifiedAt?: string };
  if (d.privacy === 'private') return null;
  // a public video is embedded only once the worker saw it public after its slot (a locked one stays private)
  if (d.privacy !== 'unlisted' && !d.verifiedAt) return null;
  if (d.publishAt && Date.parse(d.publishAt) > ctx.clock.now().getTime()) return null;
  return { videoId: r.external_id, title: r.title };
}

/** Changes whenever an embed appears or goes away (the public page cache key). */
export async function embedsVersion(ctx: Ctx): Promise<string> {
  const r = await one(
    ctx.pool,
    `SELECT count(*)::int AS n, max(updated_at) AS t FROM social_shares WHERE source='video' AND network='youtube' AND status='sent'`,
  );
  const slot = Math.floor(ctx.clock.now().getTime() / 600_000); // a scheduled video becomes embeddable within ten minutes
  return `${r?.n ?? 0}:${r?.t ? new Date(r.t).getTime() : 0}:${slot}`;
}

// ---- the description the worker uploads

/**
 * The YouTube description of the approved render: the rendered `description.txt` for a rendered video; for a library
 * video built from its metadata and the chapters of the help video.
 */
export function libraryDescription(
  meta: VideoPostMeta,
  ref: string,
  artifacts: Record<string, any>,
  durationSeconds: number,
): string {
  const chapters = Array.isArray(artifacts.chapters)
    ? (artifacts.chapters as Array<{ title: string; start: number }>)
    : [];
  return buildDescription(
    { kind: 'tutorial', ref, meta },
    chapters.length ? [{ title: 'Introduction', start: 0 }, ...chapters.filter((c) => c.start > 0)] : [],
    durationSeconds,
  );
}

// ---- tutorial cross-post (social_posts kind 'video'), approved separately from the video

function crossPostCaptions(meta: VideoPostMeta): SocialCaptions {
  const tags = meta.hashtags.map((h) => h.replace(/^#/, ''));
  const lead = `New video: ${meta.title}`;
  return {
    facebookText: fitCaption(`${lead}. ${meta.description}`, SOCIAL_LIMITS.facebook.text),
    linkedinText: fitCaption(`${lead}\n\n${meta.description}`, SOCIAL_LIMITS.linkedin.text),
    xText: fitCaption(lead, 200),
    blueskyText: fitCaption(lead, 240),
    hashtags: {
      facebook: tags.slice(0, SOCIAL_LIMITS.facebook.tags[1]),
      linkedin: tags.slice(0, SOCIAL_LIMITS.linkedin.tags[1]),
      x: tags.slice(0, SOCIAL_LIMITS.x.tags[1]),
      bluesky: tags.slice(0, SOCIAL_LIMITS.bluesky.tags[1]),
    },
  };
}

/**
 * Starts the optional cross-post of a tutorial video to the other networks: a draft `social_posts` row of kind `video`
 * (ref = the video post id) whose link is the YouTube URL. It is edited and approved through the social post routes,
 * separately from the video, and shared by the usual sweep once approved. Only a tutorial that is on YouTube.
 */
export async function createVideoCrossPost(ctx: Ctx, postId: string, by: Origin): Promise<VideoPost> {
  const p = await one(ctx.pool, 'SELECT * FROM video_posts WHERE id=$1', [postId]);
  if (!p) throw notFound('video post not found', 'video_post_not_found');
  if (p.kind !== 'tutorial' || p.format !== 'long')
    throw badRequest('not_a_tutorial', 'only a tutorial video has a cross-post');
  const share = await one(
    ctx.pool,
    `SELECT url FROM social_shares WHERE post_id=$1 AND network='youtube' AND source='video' AND status='sent'`,
    [postId],
  );
  if (!share?.url) throw conflict('not_on_youtube', 'the video is not on YouTube yet');
  await withLock(ctx, `social-post:video:${postId}`, async () => {
    if (await one(ctx.pool, `SELECT 1 AS x FROM social_posts WHERE kind='video' AND ref=$1`, [postId]))
      return;
    const meta = p.meta as VideoPostMeta;
    const socialId = randomUUID();
    const summary = fitCaption(
      meta.description.length >= 40
        ? meta.description
        : `${meta.description} Watch it on YouTube.`.padEnd(40, '.'),
      300,
    );
    await ctx.store.append([
      {
        streamId: `social-post-${socialId}`,
        event: {
          type: 'SocialPostSubmitted',
          payload: {
            postId: socialId,
            kind: 'video',
            ref: postId,
            content: {
              videoPostId: postId,
              title: fitCaption(
                meta.title.length >= 10 ? meta.title : `${meta.title} (video)`.padEnd(10, '.'),
                110,
              ),
              summary,
              coverKey: 'how-to',
              captions: crossPostCaptions(meta),
            },
            origin: by,
            status: 'draft',
          },
        },
        actor: by.userId ? userActor(by.userId) : SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
  });
  return getVideoPost(ctx, postId);
}

export { watchUrl };
