import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VideoScript } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useReleaseSource } from '../src/blog/releases.ts';
import { publishPost, submitPost } from '../src/commands/blog.ts';
import { socialTick } from '../src/commands/social.ts';
import {
  articlesNeedingVideo,
  claimVideoTopic,
  getVideoPost,
  queueVideoTopic,
  releasesNeedingVideo,
  releaseVideoTopic,
  submitVideoPost,
  videoCapacity,
} from '../src/commands/video-posts.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { cleanupVideos, type RenderFn, videoTick } from '../src/video/sweep.ts';
import {
  type UploadSpec,
  type YouTubeChannelInfo,
  type YouTubeClient,
  YouTubeError,
  type YouTubeVideoStatus,
} from '../src/video/youtube.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { blogContent, CaptureMailer, FakeSocial } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

const defaultStatus = (_id: string, spec: UploadSpec | undefined): YouTubeVideoStatus => ({
  privacyStatus: spec?.status.privacyStatus ?? 'private',
  uploadStatus: 'uploaded',
  publishAt: spec?.status.publishAt ?? (spec ? null : '2099-01-01T00:00:00Z'),
  rejectionReason: null,
  failureReason: null,
});

/** A YouTube that never touches Google: records every call, `fail` scripts the next answers. */
class FakeYouTube implements YouTubeClient {
  calls: string[] = [];
  uploads: UploadSpec[] = [];
  thumbs: string[] = [];
  captions: string[] = [];
  playlist: Array<[string, string]> = [];
  channel: YouTubeChannelInfo = { id: 'UC123', title: 'Guildwise HQ', verified: true };
  tokenError: YouTubeError | null = null;
  status: (id: string, spec: UploadSpec | undefined) => YouTubeVideoStatus | null = defaultStatus;
  uploadError: YouTubeError | null = null;
  uploadErrors: YouTubeError[] = [];
  recent: string | null = null;
  deadSession = false;
  progressAdvanceMs = 0;
  thumbError: YouTubeError | null = null;
  async accessToken() {
    this.calls.push('accessToken');
    if (this.tokenError) throw this.tokenError;
    return 'access-token';
  }
  async channelMine() {
    this.calls.push('channelMine');
    return this.channel;
  }
  async upload(_t: string, spec: UploadSpec) {
    this.calls.push('upload');
    if (this.deadSession && spec.sessionUri)
      throw new YouTubeError('retry', 'the upload session expired', 404);
    const e = this.uploadErrors.shift();
    if (e) throw e;
    if (this.uploadError) throw this.uploadError;
    this.uploads.push(spec);
    await spec.onSession?.('https://upload.test/session');
    if (this.progressAdvanceMs) t.clock.advance(this.progressAdvanceMs);
    await spec.onProgress?.();
    return { videoId: `vid${this.uploads.length}abcdef` };
  }
  async findRecentUpload() {
    this.calls.push('findRecent');
    return this.recent;
  }
  async setThumbnail(_t: string, id: string) {
    this.calls.push('thumb');
    if (this.thumbError) throw this.thumbError;
    this.thumbs.push(id);
  }
  async insertCaption(_t: string, id: string) {
    this.calls.push('caption');
    this.captions.push(id);
  }
  async addToPlaylist(_t: string, pl: string, id: string) {
    this.calls.push('playlist');
    this.playlist.push([pl, id]);
  }
  async videoStatus(_t: string, id: string) {
    this.calls.push('status');
    const n = Number(/^vid(\d+)/.exec(id)?.[1] ?? 0);
    return this.status(id, this.uploads[n - 1]);
  }
  reset() {
    this.calls = [];
    this.uploads = [];
    this.thumbs = [];
    this.captions = [];
    this.playlist = [];
    this.tokenError = null;
    this.uploadError = null;
    this.channel = { id: 'UC123', title: 'Guildwise HQ', verified: true };
    this.status = defaultStatus;
    this.recent = null;
    this.deadSession = false;
    this.uploadErrors = [];
    this.progressAdvanceMs = 0;
    this.thumbError = null;
  }
}

const LONG: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/video/test/fixtures/agents-long.json'),
    'utf8',
  ),
);
const SHORT: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/video/test/fixtures/agents-short.json'),
    'utf8',
  ),
);
const script = (kind: VideoScript['kind'], format: 'long' | 'short', ref: string): VideoScript => ({
  ...(format === 'long' ? LONG : SHORT),
  kind,
  ref,
});

/** A render that writes the files a real one would, without ffmpeg. */
const fakeRender: RenderFn = async (s, { outDir }) => {
  mkdirSync(outDir, { recursive: true });
  const f = (name: string, body: string) => {
    const p = join(outDir, name);
    writeFileSync(p, body);
    return p;
  };
  return {
    artifacts: {
      video: f(s.format === 'short' ? 'short.mp4' : 'video.mp4', 'fake mp4 bytes'.repeat(100)),
      captionsVtt: f('captions.vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n'),
      captionsSrt: f('captions.srt', '1\n00:00:00,000 --> 00:00:02,000\nHello\n'),
      thumb: s.format === 'long' ? f('thumb.png', 'png') : null,
      script: f('script.json', JSON.stringify(s)),
      description: f(
        'description.txt',
        `${s.meta.description}\n\nNarrated with a synthetic voice.\n${s.meta.hashtags.join(' ')}`,
      ),
      log: f('render.log', 'ok'),
    },
    durationSeconds: s.format === 'short' ? 45 : 130,
    bytes: 1400,
  };
};

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
let videoDir: string;
const yt = new FakeYouTube();
const mail = new CaptureMailer();
const social = new FakeSocial();
const api = (method: string, url: string, body?: unknown, cookie = sa.cookie) =>
  t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const connectYoutube = () =>
  ok(api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }));
const settings = (patch: Record<string, unknown>) => ok(api('PATCH', '/api/platform/video/settings', patch));
const submit = async (kind: VideoScript['kind'], format: 'long' | 'short', ref: string, extra = {}) =>
  ok(
    api('POST', '/api/platform/video/posts', {
      kind,
      format,
      ref,
      script: script(kind, format, ref),
      ...extra,
    }),
    201,
  );
const tick = () => videoTick(t.app.ctx, { render: fakeRender });
const post = (id: string) => ok(api('GET', `/api/platform/video/posts/${id}`));
/** Submit and schedule a post (next free slot). Nothing is rendered until the worker ticks. */
async function approved(kind: VideoScript['kind'], format: 'long' | 'short', ref: string) {
  const p = await submit(kind, format, ref);
  return ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
}
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
/** Tick the days of the schedule: `long` and `short` days a week. */
const days = (long: number, short = long) =>
  settings({
    schedule: { long: { days: ALL_DAYS.slice(0, long) }, short: { days: ALL_DAYS.slice(0, short) } },
  });
const preview = (id: string) => ok(api('POST', `/api/platform/video/posts/${id}/preview`));
const softClean = async () => {
  await q(
    `UPDATE blog_posts SET published_at = published_at - interval '5 days' WHERE published_at > now() - interval '4 days'`,
  );
  await q('DELETE FROM social_shares WHERE source <> $1 OR network = $2', ['social', 'youtube']);
  await q(`UPDATE social_channels SET status='ok', alerted_at=NULL`);
  await q(`DELETE FROM platform_settings WHERE key='video_cleanup_at'`);
  mail.sent = [];
  yt.reset();
  social.calls = [];
};
const clean = async () => {
  await q('DELETE FROM social_shares');
  await q('DELETE FROM video_renders');
  await q('DELETE FROM video_posts');
  await q(`DELETE FROM social_posts WHERE kind='video'`);
  await q(`UPDATE social_channels SET status='ok', alerted_at=NULL`);
  await q(`DELETE FROM platform_settings WHERE key='video_cleanup_at'`);
  mail.sent = [];
  yt.reset();
  social.calls = [];
};

beforeAll(async () => {
  videoDir = mkdtempSync(join(tmpdir(), 'video-posts-'));
  t = await createTestApp({
    env: { AOM_VIDEO_DIR: videoDir, AOM_YOUTUBE_CLIENT_ID: 'cid', AOM_YOUTUBE_CLIENT_SECRET: 'csecret' },
  });
  t.app.ctx.youtube = yt;
  t.app.ctx.mailer = mail;
  t.app.ctx.social = social;
  sa = await t.superAdminSession();
  // every day a slot, and the render starts a week ahead: a test's few posts render at once
  await ok(
    api('PATCH', '/api/platform/video/settings', {
      schedule: {
        long: { days: ALL_DAYS, renderLeadHours: 168 },
        short: { days: ALL_DAYS, renderLeadHours: 168 },
      },
    }),
  );
});
afterAll(async () => {
  useReleaseSource(null);
  rmSync(videoDir, { recursive: true, force: true });
  await t.close();
  await closeAdminPool();
});

describe('nothing happens without a channel and the setting', () => {
  it('refuses a submit while the setting is off, and the worker only beats its heart', async () => {
    const r = await api('POST', '/api/platform/video/posts', {
      kind: 'tutorial',
      format: 'long',
      ref: 'agents',
      script: LONG,
    });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('video_disabled');
    const out = await tick();
    expect(out).toMatchObject({ active: false, rendered: false, uploaded: false });
    const st = await ok(api('GET', '/api/platform/video/status'));
    expect(st.worker.running).toBe(true); // the heartbeat
    expect(st.active).toBe(false);
  });

  it('enabled but no channel: still inactive, nothing is offered to the writer', async () => {
    await settings({ enabled: true });
    expect(await tick()).toMatchObject({ active: false });
    expect(await articlesNeedingVideo(t.app.ctx)).toEqual([]);
    expect(await releasesNeedingVideo(t.app.ctx)).toEqual([]);
    await queueVideoTopic(t.app.ctx, { title: 'Run a night shift of agents' }, 'platform');
    expect(await claimVideoTopic(t.app.ctx)).toBeNull();
    // a post can be drafted; nothing is rendered, not even queued
    const p = await submit('tutorial', 'long', 'agents');
    expect(await tick()).toMatchObject({ active: false, rendered: false });
    expect(await q('SELECT 1 FROM video_renders WHERE post_id=$1', [p.id])).toHaveLength(0);
    expect(yt.calls).toEqual([]);
    // approving needs a channel
    const a = await api('POST', `/api/platform/video/posts/${p.id}/approve`);
    expect(a.status).toBe(409);
  });

  it('the heartbeat is stale after a few minutes: "video worker not running"', async () => {
    await tick();
    t.clock.advance(10 * 60_000);
    expect((await ok(api('GET', '/api/platform/video/status'))).worker.running).toBe(false);
    t.clock.advance(-10 * 60_000);
  });
});

describe('the YouTube channel', () => {
  it('validates the pasted refresh token with channels.list and stores it encrypted', async () => {
    const channels = await connectYoutube();
    const c = channels.channels.find((x: { network: string }) => x.network === 'youtube');
    expect(c).toMatchObject({ connected: true, accountName: 'Guildwise HQ', status: 'ok' });
    const row = (await q(`SELECT * FROM social_channels WHERE network='youtube'`))[0];
    expect(row?.account_id).toBe('UC123');
    expect(row?.access_token).not.toContain('refresh-token');
    expect(yt.calls).toEqual(['accessToken', 'channelMine']);
  });

  it('rejects a token Google refuses', async () => {
    yt.tokenError = new YouTubeError('auth', 'invalid_grant');
    const r = await api('PUT', '/api/platform/social/channels/youtube', {
      refreshToken: '1//0g-bad-token-value',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_credentials');
    yt.tokenError = null;
  });

  it('is not a share network: the blog and release sweep never create a youtube share', async () => {
    const { SOCIAL_NETWORKS } = await import('@aom/shared');
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('youtube');
    await ok(
      api('PUT', '/api/platform/social/channels/facebook', {
        accountId: '12345',
        accountName: 'FB',
        accessToken: 'EAAB-secret-facebook-token-123456',
      }),
    );
    const c = blogContent('video-sweep-check');
    const { post: p } = await submitPost(t.app.ctx, c, { userId: sa.id }, 'draft');
    await publishPost(t.app.ctx, p.id, { userId: sa.id });
    await socialTick(t.app.ctx);
    const nets = (await q('SELECT DISTINCT network FROM social_shares WHERE source <> $1', ['video'])).map(
      (r) => r.network,
    );
    expect(nets).not.toContain('youtube');
    expect(nets).toContain('facebook');
    expect(await q(`SELECT 1 FROM social_shares WHERE network='youtube'`)).toHaveLength(0);
    expect(social.calls.map((x) => x.network)).not.toContain('youtube');
  });
});

describe('review and upload', () => {
  beforeEach(clean);

  it('submit renders nothing; scheduling queues the render; the worker renders, uploads once with publishAt = the slot', async () => {
    await settings({ playlists: { tutorial: 'PLtutorials' } });
    const p = await submit('tutorial', 'long', 'agents');
    expect(p).toMatchObject({
      status: 'in_review',
      revision: 1,
      library: false,
      phase: 'in_review',
      render: null,
    });
    expect(await q('SELECT 1 FROM video_renders WHERE post_id=$1', [p.id])).toHaveLength(0);
    expect(await tick()).toMatchObject({ rendered: false, uploaded: false }); // nothing to do before scheduling
    expect(yt.uploads).toHaveLength(0);
    const sch = await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
    expect(sch).toMatchObject({
      status: 'approved',
      publishMode: 'slot',
      destinations: ['youtube'],
      phase: 'scheduled',
    });
    expect(sch.approvedRenderId).toBeNull();
    expect(sch.render).toMatchObject({ status: 'queued' });
    expect(await tick()).toMatchObject({ rendered: true, uploaded: true });
    expect(await tick()).toMatchObject({ uploaded: false });
    expect(yt.uploads).toHaveLength(1);
    const u = yt.uploads[0] as UploadSpec;
    expect(u.snippet).toMatchObject({
      title: LONG.meta.title,
      categoryId: '28',
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    });
    expect(u.snippet.description).toContain('Narrated with a synthetic voice.');
    expect(u.status).toMatchObject({
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
      privacyStatus: 'private', // public is requested through publishAt
    });
    expect(u.status.publishAt).toBe(sch.slotAt); // YouTube publishes at the slot itself
    expect(new Date(u.status.publishAt as string).getUTCHours()).toBe(8); // 10:00 SAST
    expect(yt.thumbs).toHaveLength(1);
    expect(yt.captions).toHaveLength(1);
    expect(yt.playlist).toEqual([['PLtutorials', 'vid1abcdef']]);
    const done = await post(p.id);
    expect(done.render).toMatchObject({ status: 'rendered', durationSeconds: 130 });
    expect(done.render.files).toEqual(expect.arrayContaining(['video', 'captionsVtt', 'thumb']));
    expect(done.upload).toMatchObject({ status: 'sent', videoId: 'vid1abcdef', privacy: 'public' });
    expect(done.upload.url).toBe('https://www.youtube.com/watch?v=vid1abcdef');
    // the share is the only one per post and network
    expect(await q(`SELECT 1 FROM social_shares WHERE post_id=$1`, [p.id])).toHaveLength(1);
  });

  it('uses the privacy of the setting (unlisted at once) and a per-video override', async () => {
    await settings({ privacy: 'unlisted' });
    await approved('release', 'long', '9.9.1');
    await tick();
    expect(yt.uploads[0]?.status).toMatchObject({ privacyStatus: 'unlisted' });
    expect(yt.uploads[0]?.status.publishAt).toBeUndefined();
    await settings({ privacy: 'public' });
  });

  it('gives each long video its own slot, uploads them one at a time, all scheduled on YouTube', async () => {
    const a = await approved('article', 'long', 'slots-1');
    const b = await approved('article', 'long', 'slots-2');
    expect(a.slotAt).not.toBe(b.slotAt);
    expect(Date.parse(b.slotAt)).toBeGreaterThan(Date.parse(a.slotAt));
    await tick();
    expect(yt.uploads).toHaveLength(1);
    expect((await post(b.id)).upload).toBeNull(); // not rendered yet: one render a pass
    await tick();
    expect(yt.uploads).toHaveLength(2); // no limit of one a day any more
    expect(yt.uploads.map((u) => u.status.publishAt)).toEqual([a.slotAt, b.slotAt]);
  });

  it('skips the thumbnail with a warning when the channel is not verified', async () => {
    yt.channel = { id: 'UC123', title: 'Guildwise HQ', verified: false };
    const p = await approved('article', 'long', 'unverified');
    await tick();
    expect(yt.thumbs).toHaveLength(0);
    const d = await post(p.id);
    expect(d.upload.status).toBe('sent');
    expect(d.upload.warnings.join(' ')).toMatch(/not phone-verified/);
  });

  it('a Short gets no custom thumbnail and is approved separately on the same page data', async () => {
    const long = await submit('article', 'long', 'with-short');
    const short = await submit('article', 'short', 'with-short', { parentId: long.id });
    expect((await post(long.id)).shortId).toBe(short.id);
    await tick();
    await tick();
    await ok(api('POST', `/api/platform/video/posts/${short.id}/approve`));
    await tick();
    expect(yt.uploads).toHaveLength(1);
    expect(yt.thumbs).toHaveLength(0);
    expect((await post(long.id)).status).toBe('in_review');
  });

  it('an auth failure pauses the channel, mails once and keeps the upload waiting', async () => {
    yt.tokenError = new YouTubeError('auth', 'Google refused the refresh token (invalid_grant)');
    const p = await approved('article', 'long', 'needs-reconnect');
    await tick();
    await tick();
    expect(mail.sent.filter((m) => /YouTube/.test(m.subject))).toHaveLength(1);
    expect((await q(`SELECT status FROM social_channels WHERE network='youtube'`))[0]?.status).toBe(
      'needs_reconnect',
    );
    expect((await post(p.id)).upload.status).toBe('pending');
    // inactive while paused: nothing is tried
    const calls = yt.calls.length;
    await tick();
    expect(yt.calls.length).toBe(calls);
    // a fresh token resumes it
    yt.tokenError = null;
    await connectYoutube();
    await tick();
    expect((await post(p.id)).upload.status).toBe('sent');
  });

  it('a video YouTube kept private is shared as locked_private, the owner is mailed and uploads stop', async () => {
    yt.status = () => ({
      privacyStatus: 'private',
      uploadStatus: 'uploaded',
      publishAt: null,
      rejectionReason: null,
      failureReason: null,
    });
    const p = await approved('article', 'long', 'locked');
    await tick();
    const d = await post(p.id);
    expect(d.upload.status).toBe('locked_private');
    const m = mail.sent.find((x) => /private/.test(x.subject));
    expect(m?.text ?? m?.html).toContain('https://support.google.com/youtube/contact/yt_api_form');
    expect((await ok(api('GET', '/api/platform/video/status'))).lockedPrivate).toBe(1);
    const next = await approved('article', 'long', 'after-locked');
    await tick();
    expect(yt.uploads).toHaveLength(1);
    await ok(api('POST', `/api/platform/video/posts/${p.id}/resolve-locked`));
    await q(
      `UPDATE social_shares SET detail = jsonb_set(detail, '{uploadedAt}', to_jsonb((now() - interval '26 hours')::text)) WHERE post_id=$1`,
      [p.id],
    );
    yt.status = (_i, spec) => ({
      privacyStatus: spec?.status.privacyStatus ?? 'private',
      uploadStatus: 'uploaded',
      publishAt: spec?.status.publishAt ?? null,
      rejectionReason: null,
      failureReason: null,
    });
    await tick();
    expect(yt.uploads).toHaveLength(2);
    expect((await post(next.id)).upload.status).toBe('sent');
  });

  it('retries a network failure with a back-off and finally fails for good', async () => {
    yt.uploadError = new YouTubeError('retry', 'HTTP 503');
    const p = await approved('article', 'long', 'flaky');
    await tick();
    const d = await post(p.id);
    expect(d.upload).toMatchObject({ status: 'pending', attempts: 1 });
    expect(d.upload.nextAttemptAt).not.toBeNull();
    yt.uploadError = new YouTubeError('final', 'HTTP 400 bad');
    await q(`UPDATE social_shares SET next_attempt_at = now() - interval '1 minute' WHERE post_id=$1`, [
      p.id,
    ]);
    await tick();
    expect((await post(p.id)).upload.status).toBe('failed');
    yt.uploadError = null;
    await ok(api('POST', `/api/platform/video/posts/${p.id}/retry-upload`));
    await tick();
    expect((await post(p.id)).upload.status).toBe('sent');
  });

  it('a crash after the upload resumes with the finished steps and never uploads twice', async () => {
    const p = await approved('article', 'long', 'crashed');
    await tick();
    expect(yt.uploads).toHaveLength(1);
    // pretend the process died after the upload but before the share was marked sent
    await q(
      `UPDATE social_shares SET status='posting', updated_at = now() - interval '2 hours' WHERE post_id=$1`,
      [p.id],
    );
    yt.calls = [];
    await q(`UPDATE social_shares SET detail = detail || '{"steps": {}}'::jsonb WHERE post_id=$1`, [p.id]);
    await tick();
    expect(yt.uploads).toHaveLength(1);
    expect(yt.calls).not.toContain('upload');
    expect((await post(p.id)).upload.status).toBe('sent');
  });
});

describe('editing and approval rules', () => {
  beforeEach(clean);

  it('an edit makes a new revision without rendering; previews are limited to 3 renders; an approved video is final', async () => {
    const p = await submit('article', 'long', 'edits');
    const edited = (rev: number) => ({
      script: {
        ...script('article', 'long', 'edits'),
        title: `Edited title ${rev}`,
        meta: { ...LONG.meta, title: `Edited title ${rev}` },
      },
    });
    let cur = await ok(api('PATCH', `/api/platform/video/posts/${p.id}`, edited(2)));
    expect(cur).toMatchObject({ revision: 2, title: 'Edited title 2', render: null });
    expect(await tick()).toMatchObject({ rendered: false }); // an edit renders nothing
    const tags = await ok(
      api('PATCH', `/api/platform/video/posts/${p.id}`, {
        meta: { tags: ['one', 'two'] },
        privacy: 'unlisted',
      }),
    );
    expect(tags.revision).toBe(2);
    expect(tags.meta).toMatchObject({ tags: ['one', 'two'], privacy: 'unlisted' });
    // preview of revision 2 (1 of 3), then revisions 3 and 4 with their own previews
    expect((await preview(p.id)).render).toMatchObject({ revision: 2, status: 'queued', preview: true });
    await tick();
    cur = await ok(api('PATCH', `/api/platform/video/posts/${p.id}`, edited(3)));
    expect(cur.revision).toBe(3);
    await preview(p.id);
    await tick();
    cur = await ok(api('PATCH', `/api/platform/video/posts/${p.id}`, edited(4)));
    expect(cur.revision).toBe(4);
    const third = await preview(p.id);
    expect(third.rendersUsed).toBe(3);
    await tick();
    const over = await api('PATCH', `/api/platform/video/posts/${p.id}`, edited(5));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('render_limit');
    // scheduling reuses the rendered preview of the unchanged script: no new render
    const rendered = await post(p.id);
    const sch = await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
    expect(sch.render).toMatchObject({ id: rendered.render.id, status: 'rendered', preview: false });
    expect(sch.rendersUsed).toBe(3);
    expect((await api('PATCH', `/api/platform/video/posts/${p.id}`, { privacy: 'public' })).status).toBe(409);
    expect((await api('POST', `/api/platform/video/posts/${p.id}/reject`, { reason: 'no' })).status).toBe(
      409,
    );
  });

  it('rejects with a reason and a rejected video comes back to review when edited', async () => {
    const p = await submit('article', 'long', 'rejected');
    expect((await api('POST', `/api/platform/video/posts/${p.id}/reject`, {})).status).toBe(400);
    const r = await ok(api('POST', `/api/platform/video/posts/${p.id}/reject`, { reason: 'too long' }));
    expect(r).toMatchObject({ status: 'rejected', rejectionReason: 'too long' });
    expect((await api('POST', `/api/platform/video/posts/${p.id}/approve`)).status).toBe(409);
    const back = await ok(
      api('PATCH', `/api/platform/video/posts/${p.id}`, {
        meta: { description: 'A better description of what the video shows.' },
      }),
    );
    expect(back.status).toBe('in_review');
  });

  it('a submit is idempotent per kind, ref and format, and a writer respects the weekly cap', async () => {
    const a = await submit('article', 'long', 'idem');
    const again = await ok(
      api('POST', '/api/platform/video/posts', {
        kind: 'article',
        format: 'long',
        ref: 'idem',
        script: script('article', 'long', 'idem'),
      }),
      200,
    );
    expect(again.id).toBe(a.id);
    await q('DELETE FROM video_posts');
    await days(1);
    const writer = { system: 'blog-writer' as const };
    await submitVideoPost(
      t.app.ctx,
      { kind: 'article', format: 'long', ref: 'w1', script: script('article', 'long', 'w1') },
      writer,
      'in_review',
    );
    await expect(
      submitVideoPost(
        t.app.ctx,
        { kind: 'article', format: 'long', ref: 'w2', script: script('article', 'long', 'w2') },
        writer,
        'in_review',
      ),
    ).rejects.toMatchObject({ code: 'weekly_cap' });
    // a person is not capped
    await submit('article', 'long', 'w3');
    await days(3);
    await settings({ articleVideos: false });
    await expect(
      submitVideoPost(
        t.app.ctx,
        { kind: 'article', format: 'long', ref: 'w4', script: script('article', 'long', 'w4') },
        writer,
        'in_review',
      ),
    ).rejects.toMatchObject({ code: 'kind_off' });
    await settings({ articleVideos: true });
  });

  it('a rejected writer draft frees its weekly slot; other statuses still count', async () => {
    await q('DELETE FROM video_posts');
    await days(1, 1);
    await settings({ articleVideos: true, shorts: true });
    const writer = { system: 'blog-writer' as const };
    const draft = (ref: string, format: 'long' | 'short', status: 'draft' | 'in_review' = 'in_review') =>
      submitVideoPost(
        t.app.ctx,
        { kind: 'article', format, ref, script: script('article', format, ref) },
        writer,
        status,
      );
    const a = await draft('cap-a', 'long');
    const s = await draft('cap-a', 'short');
    expect(await videoCapacity(t.app.ctx)).toMatchObject({
      long: { used: 1, limit: 1, backlog: 1, backlogLimit: 2 },
      short: { used: 1, limit: 1, backlog: 1, backlogLimit: 2 },
    });
    await expect(draft('cap-b', 'long')).rejects.toMatchObject({ code: 'weekly_cap' });
    await expect(draft('cap-b', 'short')).rejects.toMatchObject({ code: 'weekly_cap' });
    await ok(api('POST', `/api/platform/video/posts/${a.post.id}/reject`, { reason: 'unwanted' }));
    await ok(api('POST', `/api/platform/video/posts/${s.post.id}/reject`, { reason: 'unwanted' }));
    expect(await videoCapacity(t.app.ctx)).toMatchObject({ long: { used: 0 }, short: { used: 0 } });
    const b = await draft('cap-b', 'long');
    expect(b.created).toBe(true);
    await draft('cap-b', 'short');
    expect(await videoCapacity(t.app.ctx)).toMatchObject({ long: { used: 1 }, short: { used: 1 } });
    // every non-rejected status counts (draft, in_review, approved)
    for (const st of ['draft', 'in_review', 'approved']) {
      await q('UPDATE video_posts SET status=$1 WHERE id=$2', [st, b.post.id]);
      expect((await videoCapacity(t.app.ctx)).long.used).toBe(1);
    }
    await q("UPDATE video_posts SET status='rejected' WHERE id=$1", [b.post.id]);
    expect((await videoCapacity(t.app.ctx)).long.used).toBe(0);
    await days(7);
  });

  it('the writer stops when the backlog reaches twice the weekly slots, library imports excluded', async () => {
    await q('DELETE FROM video_posts');
    await days(1, 1); // limit 1 a week, backlog limit 2
    const writer = { system: 'blog-writer' as const };
    const draft = (ref: string) =>
      submitVideoPost(
        t.app.ctx,
        { kind: 'article', format: 'long', ref, script: script('article', 'long', ref) },
        writer,
        'in_review',
      );
    await draft('bl-1');
    // older drafts of the owner wait too: the rolling week is empty but the review queue is not
    await q(`UPDATE video_posts SET created_at = now() - interval '9 days'`);
    await submit('article', 'long', 'bl-2');
    await expect(draft('bl-3')).rejects.toMatchObject({ code: 'backlog_full' });
    expect((await videoCapacity(t.app.ctx)).long).toMatchObject({
      used: 0,
      limit: 1,
      backlog: 2,
      backlogLimit: 2,
    });
    // a recorded help video in review is not a script waiting for you
    await q(`UPDATE video_posts SET ref='lib:x' WHERE ref='bl-2'`);
    expect((await videoCapacity(t.app.ctx)).long.backlog).toBe(1);
    await q(`UPDATE video_posts SET ref='bl-2' WHERE ref='lib:x'`);
    // a scheduled video counts until it is published
    const second = (await q(`SELECT id FROM video_posts WHERE ref='bl-2'`))[0];
    await ok(api('POST', `/api/platform/video/posts/${second?.id}/approve`));
    expect((await videoCapacity(t.app.ctx)).long.backlog).toBe(2);
    await tick();
    expect((await videoCapacity(t.app.ctx)).long.backlog).toBe(1);
    await days(7);
  });

  it('refuses an invalid script', async () => {
    const r = await api('POST', '/api/platform/video/posts', {
      kind: 'article',
      format: 'long',
      ref: 'bad',
      script: { ...LONG, cues: [] },
    });
    expect(r.status).toBe(400);
  });
});

describe('the writer helpers', () => {
  beforeEach(clean);

  it('lists published articles without a video and releases without one', async () => {
    const c = blogContent('video-article-needed');
    const { post: p } = await submitPost(t.app.ctx, c, { userId: sa.id }, 'draft');
    await publishPost(t.app.ctx, p.id, { userId: sa.id });
    const need = await articlesNeedingVideo(t.app.ctx);
    expect(need.map((a) => a.slug)).toContain('video-article-needed');
    await submit('article', 'long', 'video-article-needed');
    expect((await articlesNeedingVideo(t.app.ctx)).map((a) => a.slug)).not.toContain('video-article-needed');
    // before the channel was connected: not offered
    await q(`UPDATE social_channels SET connected_at = now() + interval '1 day' WHERE network='youtube'`);
    await q(`DELETE FROM video_posts`);
    expect(await articlesNeedingVideo(t.app.ctx)).toEqual([]);
    await q(`UPDATE social_channels SET connected_at = now() - interval '1 day' WHERE network='youtube'`);
    const dir = mkdtempSync(join(tmpdir(), 'rel-'));
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      `# Changelog\n\n## [8.8.0] - ${today}\n\n### Added\n\n- A new thing.\n`,
    );
    useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'none') });
    expect((await releasesNeedingVideo(t.app.ctx)).map((r) => r.version)).toEqual(['8.8.0']);
    await submit('release', 'long', '8.8.0');
    expect(await releasesNeedingVideo(t.app.ctx)).toEqual([]);
    useReleaseSource(null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('library import (existing help videos)', () => {
  beforeEach(softClean);
  let lib: string;
  beforeAll(async () => {
    await clean();
    lib = mkdtempSync(join(tmpdir(), 'lib-'));
    for (const [slug, title] of [
      ['agents', 'Your agents'],
      ['board', 'The Board'],
    ] as const) {
      writeFileSync(join(lib, `${slug}.mp4`), 'mp4 bytes');
      writeFileSync(join(lib, `${slug}.vtt`), 'WEBVTT\n');
      writeFileSync(
        join(lib, `${slug}.json`),
        JSON.stringify({
          title,
          duration: 80,
          chapters: [
            { t: 10, title: 'First' },
            { t: 30, title: 'Second' },
            { t: 50, title: 'Third' },
          ],
        }),
      );
    }
    process.env.AOM_MEDIA_VIDEOS_DIR = lib;
  });
  afterAll(() => {
    delete process.env.AOM_MEDIA_VIDEOS_DIR;
    rmSync(lib, { recursive: true, force: true });
  });

  it('imports each as a tutorial lib:<slug> draft, once, rendered without rendering', async () => {
    const list = await ok(api('GET', '/api/platform/video/library'));
    expect(list.videos.map((v: { slug: string }) => v.slug)).toEqual(['agents', 'board']);
    const r = await ok(api('POST', '/api/platform/video/library/import', {}));
    expect(r.created).toBe(2);
    const p = r.posts.find((x: { ref: string }) => x.ref === 'lib:agents');
    expect(p).toMatchObject({
      kind: 'tutorial',
      format: 'long',
      library: true,
      script: null,
      status: 'in_review',
    });
    expect(p.render).toMatchObject({ status: 'rendered', library: true });
    expect(p.meta.hashtags.length).toBeGreaterThanOrEqual(3);
    const again = await ok(api('POST', '/api/platform/video/library/import', {}));
    expect(again.created).toBe(0);
    expect(again.skipped).toEqual(['agents', 'board']);
    // the worker never renders it
    expect(await tick()).toMatchObject({ rendered: false });
  });

  it('edits metadata without a render, uploads the recorded MP4 with a description built from its chapters', async () => {
    const p = (await q(`SELECT id FROM video_posts WHERE ref='lib:agents'`))[0];
    const e = await ok(
      api('PATCH', `/api/platform/video/posts/${p?.id}`, { meta: { title: 'Hire agents in Guildwise HQ' } }),
    );
    expect(e).toMatchObject({ revision: 1, title: 'Hire agents in Guildwise HQ' });
    expect((await api('PATCH', `/api/platform/video/posts/${p?.id}`, { script: LONG })).status).toBe(400);
    await ok(api('POST', `/api/platform/video/posts/${p?.id}/approve`));
    await tick();
    const u = yt.uploads[0] as UploadSpec;
    expect(u.filePath).toBe(join(lib, 'agents.mp4'));
    expect(u.snippet.title).toBe('Hire agents in Guildwise HQ');
    expect(u.snippet.description).toMatch(/00:00 Introduction/);
    expect(u.snippet.description).toContain('Narrated with a synthetic voice.');
    expect(yt.captions).toHaveLength(1);
    expect(yt.thumbs).toHaveLength(0); // no rendered thumbnail
    // cleanup never touches the help video
    await q(`UPDATE social_shares SET updated_at = now() - interval '40 days' WHERE post_id=$1`, [p?.id]);
    await cleanupVideos(t.app.ctx, { force: true });
    expect(readFileSync(join(lib, 'agents.mp4'), 'utf8')).toBe('mp4 bytes');
  });

  it('cross-posts a tutorial to the other networks only as a separate, approved post', async () => {
    const p = (await q(`SELECT id FROM video_posts WHERE ref='lib:agents'`))[0];
    const noCross = await api('POST', `/api/platform/video/posts/${p?.id}/crosspost`);
    expect(noCross.status).toBe(409); // not sent yet in this test (clean() removed the share)
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, external_id, url, created_at, updated_at, detail)
             VALUES ($1,'youtube','video','sent','vidXYZ12345','https://www.youtube.com/watch?v=vidXYZ12345', now(), now(), '{"privacy":"public"}')`,
      [p?.id],
    );
    const cp = await ok(api('POST', `/api/platform/video/posts/${p?.id}/crosspost`));
    expect(cp.crossPost).toMatchObject({ status: 'draft' });
    expect(cp.crossPost.content.videoPostId).toBe(p?.id);
    await socialTick(t.app.ctx);
    expect(social.calls).toHaveLength(0); // nothing before approval
    const id = cp.crossPost.id as string;
    await ok(api('POST', `/api/platform/social/posts/${id}/approve`));
    await socialTick(t.app.ctx);
    expect(social.calls.length).toBeGreaterThan(0);
    for (const c of social.calls) {
      expect(c.network).not.toBe('youtube');
      expect(c.p.link).toBe('https://www.youtube.com/watch?v=vidXYZ12345');
    }
    // an edit of its captions works through the social post route
    const e = await api('PATCH', `/api/platform/social/posts/${id}`, {
      title: 'A new tutorial video is live',
    });
    expect([200, 409]).toContain(e.status);
  });
});

describe('Video topics', () => {
  beforeEach(clean);

  it('queues, de-duplicates, moves, rejects, and the writer claims one and drafts a tutorial for it', async () => {
    await q('DELETE FROM video_topics');
    const a = await ok(api('POST', '/api/platform/video/topics', { title: 'Run a night shift of agents' }));
    expect(a.duplicate).toBe(false);
    const dup = await ok(
      api('POST', '/api/platform/video/topics', { title: 'run a NIGHT shift of agents!' }),
    );
    expect(dup.duplicate).toBe(true);
    const b = await ok(
      api('POST', '/api/platform/video/topics', {
        title: 'Turn a spec into a board of cards',
        brief: 'show the BA agent',
      }),
    );
    await ok(api('POST', `/api/platform/video/topics/${b.topic.id}/move`));
    const list = await ok(api('GET', '/api/platform/video/topics'));
    expect(list.topics.map((x: { id: string }) => x.id)[0]).toBe(b.topic.id);
    expect(list.queued).toBe(2);
    await ok(api('POST', `/api/platform/video/topics/${a.topic.id}/reject`, { reason: 'covered' }));
    const claimed = await claimVideoTopic(t.app.ctx);
    expect(claimed).toMatchObject({ id: b.topic.id, status: 'writing', attempts: 1 });
    expect(await claimVideoTopic(t.app.ctx)).toBeNull();
    const made = await submitVideoPost(
      t.app.ctx,
      { kind: 'tutorial', format: 'long', ref: b.topic.id, script: script('tutorial', 'long', b.topic.id) },
      { system: 'blog-writer' },
      'in_review',
    );
    expect(made.created).toBe(true);
    const after = await ok(api('GET', '/api/platform/video/topics'));
    expect(after.topics.find((x: { id: string }) => x.id === b.topic.id)).toMatchObject({
      status: 'drafted',
      postId: made.post.id,
    });
  });

  it('a failed run releases the topic; after two takes it is rejected', async () => {
    const q1 = await queueVideoTopic(t.app.ctx, { title: 'Show the failing topic video' }, 'writer');
    await q("UPDATE video_topics SET sort_at = sort_at - interval '1 day' WHERE id=$1", [q1.topic.id]);
    const c1 = await claimVideoTopic(t.app.ctx);
    expect(c1?.id).toBe(q1.topic.id);
    await releaseVideoTopic(t.app.ctx, q1.topic.id, 'render failed');
    const c2 = await claimVideoTopic(t.app.ctx);
    expect(c2?.id).toBe(q1.topic.id);
    await releaseVideoTopic(t.app.ctx, q1.topic.id, 'again');
    const row = (await q('SELECT status, reason FROM video_topics WHERE id=$1', [q1.topic.id]))[0];
    expect(row).toMatchObject({ status: 'rejected', reason: 'again' });
  });
});

describe('files, projection and cleanup', () => {
  beforeEach(clean);

  it('serves the preview with Range, no-store, to a super admin only', async () => {
    const p = await submit('article', 'long', 'preview');
    await preview(p.id);
    await tick();
    const url = `/api/platform/video/posts/${p.id}/files/video.mp4`;
    const full = await t.app.inject({ method: 'GET', url, headers: { cookie: sa.cookie } });
    expect(full.statusCode).toBe(200);
    expect(full.headers['cache-control']).toBe('no-store');
    expect(full.headers['accept-ranges']).toBe('bytes');
    const size = Number(full.headers['content-length']);
    const part = await t.app.inject({
      method: 'GET',
      url,
      headers: { cookie: sa.cookie, range: 'bytes=2-9' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 2-9/${size}`);
    expect(part.rawPayload.length).toBe(8);
    const bad = await t.app.inject({
      method: 'GET',
      url,
      headers: { cookie: sa.cookie, range: `bytes=${size + 5}-` },
    });
    expect(bad.statusCode).toBe(416);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/platform/video/posts/${p.id}/files/captions.vtt`,
          headers: { cookie: sa.cookie },
        })
      ).body,
    ).toContain('WEBVTT');
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/platform/video/posts/${p.id}/files/..%2Fsecret`,
          headers: { cookie: sa.cookie },
        })
      ).statusCode,
    ).toBe(404);
    // nobody else
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBeGreaterThanOrEqual(401);
    const member = await t.userSession('member-video@example.com');
    const r = await t.app.inject({ method: 'GET', url, headers: { cookie: member.cookie } });
    expect(r.statusCode).toBe(404);
    expect((await api('GET', '/api/platform/video', undefined, member.cookie)).status).toBe(404);
  });

  it('a projection rebuild restores the posts and keeps the renders and uploads', async () => {
    const p = await approved('article', 'long', 'rebuild');
    await tick();
    const cols =
      'id, kind, ref, format, status, revision, title, approved_render_id, approved_at, slot_at, publish_mode, destinations, captions';
    const before = await q(`SELECT ${cols} FROM video_posts WHERE id=$1`, [p.id]);
    const renders = await q('SELECT id FROM video_renders WHERE post_id=$1', [p.id]);
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    const after = await q(`SELECT ${cols} FROM video_posts WHERE id=$1`, [p.id]);
    expect(after).toEqual(before);
    expect(before).toHaveLength(1);
    expect(await q('SELECT id FROM video_renders WHERE post_id=$1', [p.id])).toEqual(renders);
    expect((await post(p.id)).upload.status).toBe('sent');
    expect((await q('SELECT count(*)::int AS n FROM video_topics'))[0]?.n).toBeGreaterThanOrEqual(0);
  });

  it('cleans up: superseded after a day, rejected after a day, a published video once everything is sent', async () => {
    const sup = await submit('article', 'long', 'cleanup-sup');
    await preview(sup.id);
    await tick();
    await ok(
      api('PATCH', `/api/platform/video/posts/${sup.id}`, {
        script: {
          ...script('article', 'long', 'cleanup-sup'),
          title: 'Newer title here',
          meta: { ...LONG.meta, title: 'Newer title here' },
        },
      }),
    );
    await preview(sup.id);
    await tick();
    const dir1 = join(videoDir, sup.id, '1');
    const dir2 = join(videoDir, sup.id, '2');
    expect(readFileSync(join(dir1, 'video.mp4')).length).toBeGreaterThan(0);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(0); // too young
    await q(`UPDATE video_renders SET finished_at = now() - interval '2 days'`);
    await q(`UPDATE video_posts SET updated_at = now() WHERE id=$1`, [sup.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect(() => readFileSync(join(dir1, 'video.mp4'))).toThrow();
    expect(readFileSync(join(dir2, 'video.mp4')).length).toBeGreaterThan(0);
    // rejected for 2 days: all files go after one
    await ok(api('POST', `/api/platform/video/posts/${sup.id}/reject`, { reason: 'no' }));
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(0); // rejected just now
    await q(`UPDATE video_posts SET updated_at = now() - interval '2 days' WHERE id=$1`, [sup.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect(() => readFileSync(join(dir2, 'video.mp4'))).toThrow();
    // a published video: scheduled on YouTube (sent) but its slot is ahead: the MP4 stays
    const up = await approved('article', 'long', 'cleanup-up');
    await tick();
    const dir = join(videoDir, up.id, '1');
    expect((await post(up.id)).upload.status).toBe('sent');
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(0);
    // YouTube confirmed it public: the MP4 goes (thumbnail, captions and script stay)
    await q(
      `UPDATE social_shares SET detail = detail || jsonb_build_object('verifiedAt', now()::text) WHERE post_id=$1`,
      [up.id],
    );
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect(() => readFileSync(join(dir, 'video.mp4'))).toThrow();
    expect(readFileSync(join(dir, 'captions.vtt'), 'utf8')).toContain('WEBVTT');
    expect(readFileSync(join(dir, 'script.json'), 'utf8').length).toBeGreaterThan(0);
    expect(await cleanupVideos(t.app.ctx)).toBe(0); // once a day
  });

  it('a render over ten minutes fails and a crashing render is tried three times', async () => {
    const long = await submit('article', 'long', 'too-long');
    await preview(long.id);
    await videoTick(t.app.ctx, {
      render: async (s, o) => ({ ...(await fakeRender(s, o)), durationSeconds: 700 }),
    });
    const r = await post(long.id);
    expect(r.render.status).toBe('failed');
    expect(r.render.error).toMatch(/limit is 600/);
    await ok(api('POST', `/api/platform/video/posts/${long.id}/retry-render`));
    const boom: RenderFn = async () => {
      throw new Error('ffmpeg exploded');
    };
    for (let i = 0; i < 3; i++) {
      await videoTick(t.app.ctx, { render: boom });
      t.clock.advance(5 * 60_000); // a failed attempt waits a minute per attempt
    }
    t.clock.advance(-15 * 60_000);
    const f = await post(long.id);
    expect(f.render).toMatchObject({ status: 'failed', attempts: 3 });
    expect(f.render.error).toContain('ffmpeg exploded');
  });

  it('embeds the video on the article page once it is public, and widens frame-src for that page only', async () => {
    await settings({ privacy: 'unlisted' });
    const c = blogContent('video-embed-article');
    const { post: bp } = await submitPost(t.app.ctx, c, { userId: sa.id }, 'draft');
    await publishPost(t.app.ctx, bp.id, { userId: sa.id });
    const before = await t.app.inject({ method: 'GET', url: '/blog/video-embed-article' });
    expect(before.body).not.toContain('youtube-nocookie');
    expect(before.headers['content-security-policy']).not.toContain('frame-src');
    await approved('article', 'long', 'video-embed-article');
    await tick();
    const page = await t.app.inject({ method: 'GET', url: '/blog/video-embed-article' });
    expect(page.body).toContain('https://www.youtube-nocookie.com/embed/vid1abcdef');
    expect(page.headers['content-security-policy']).toContain('frame-src https://www.youtube-nocookie.com');
    await settings({ privacy: 'public' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Review round 2: library across app and worker, dead sessions, re-checks, heartbeat, bookkeeping, error classes, races.

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const shareOf = async (id: string) => (await q('SELECT * FROM social_shares WHERE post_id=$1', [id]))[0];

describe('library: the app has no MP4s, the worker has the media folder', () => {
  let appDir: string;
  let workerDir: string;
  beforeAll(async () => {
    await clean();
    appDir = mkdtempSync(join(tmpdir(), 'lib-app-'));
    workerDir = mkdtempSync(join(tmpdir(), 'lib-worker-'));
    // what the APP knows: the manifest generated at build (no MP4 anywhere near it)
    writeFileSync(
      join(appDir, 'video-library.json'),
      JSON.stringify({
        videos: [
          {
            slug: 'agents',
            title: 'Your agents',
            duration: 80,
            vtt: true,
            chapters: [
              { t: 10, title: 'Hire' },
              { t: 30, title: 'Pause' },
              { t: 50, title: 'Filter' },
            ],
          },
        ],
      }),
    );
    // what the WORKER has: the recorded files
    writeFileSync(join(workerDir, 'agents.mp4'), 'worker mp4');
    writeFileSync(join(workerDir, 'agents.vtt'), 'WEBVTT\n');
    writeFileSync(
      join(workerDir, 'agents.json'),
      JSON.stringify({ title: 'Your agents', duration: 80, chapters: [] }),
    );
    process.env.AOM_VIDEO_LIBRARY_MANIFEST = join(appDir, 'video-library.json');
    process.env.AOM_MEDIA_VIDEOS_DIR = join(appDir, 'no-media-here');
  });
  afterAll(() => {
    delete process.env.AOM_VIDEO_LIBRARY_MANIFEST;
    delete process.env.AOM_MEDIA_VIDEOS_DIR;
    rmSync(appDir, { recursive: true, force: true });
    rmSync(workerDir, { recursive: true, force: true });
  });
  beforeEach(softClean);

  it('lists and imports from the manifest, stores a marker (no path), and the worker resolves it in its own folder', async () => {
    expect((await ok(api('GET', '/api/platform/video/library'))).videos).toMatchObject([
      { slug: 'agents', imported: false, chapters: 3 },
    ]);
    const r = await ok(api('POST', '/api/platform/video/library/import', {}));
    expect(r.created).toBe(1);
    const p = r.posts[0];
    expect(p.render).toMatchObject({ status: 'rendered', library: true, files: ['video', 'captionsVtt'] });
    const art = (await q('SELECT artifacts FROM video_renders WHERE post_id=$1', [p.id]))[0]?.artifacts;
    expect(art.video).toBe('lib:agents');
    expect(JSON.stringify(art)).not.toContain(appDir);
    await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
    // the worker: a different folder than the app's, found through the marker
    process.env.AOM_MEDIA_VIDEOS_DIR = workerDir;
    await tick();
    process.env.AOM_MEDIA_VIDEOS_DIR = join(appDir, 'no-media-here');
    expect(yt.uploads[0]?.filePath).toBe(join(workerDir, 'agents.mp4'));
    expect(yt.captions).toHaveLength(1);
    expect((await post(p.id)).upload.status).toBe('sent');
  });

  it('without any catalog a script with clips is refused, never silently unchecked', async () => {
    const empty = join(appDir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ videos: [] }));
    process.env.AOM_VIDEO_LIBRARY_MANIFEST = empty;
    const r = await api('POST', '/api/platform/video/posts', {
      kind: 'article',
      format: 'long',
      ref: 'no-catalog',
      script: script('article', 'long', 'no-catalog'),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_media_catalog');
    process.env.AOM_VIDEO_LIBRARY_MANIFEST = join(appDir, 'video-library.json');
  });

  it('a library post whose render row was lost is healed by the worker', async () => {
    await clean();
    await ok(api('POST', '/api/platform/video/library/import', {}));
    const p = (await q(`SELECT id FROM video_posts WHERE ref='lib:agents'`))[0];
    await q('DELETE FROM video_renders WHERE post_id=$1', [p?.id]);
    await tick();
    expect((await post(p?.id)).render).toMatchObject({ status: 'rendered', library: true });
  });
});

describe('upload recovery and re-checks', () => {
  beforeEach(clean);

  /** An approved post whose share already holds a (dead) upload session. */
  async function withSession(ref: string) {
    const p = await approved('article', 'long', ref);
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, next_attempt_at, created_at, updated_at, detail)
       VALUES ($1,'youtube','video','pending', NULL, now(), now(), $2::jsonb)`,
      [
        p.id,
        JSON.stringify({
          sessionUri: 'https://upload.test/dead',
          sessionStartedAt: iso(-3600_000),
          reservedAt: new Date().toISOString(),
          privacy: 'public',
          publishAt: iso(86_400_000),
          steps: {},
          warnings: [],
        }),
      ],
    );
    return p;
  }

  it('a dead session (404) that actually finished is adopted, not uploaded again', async () => {
    yt.deadSession = true;
    yt.recent = 'recovered01';
    const p = await withSession('dead-done');
    await tick();
    expect(yt.calls).toContain('findRecent');
    expect(yt.uploads).toHaveLength(0);
    const d = await post(p.id);
    expect(d.upload).toMatchObject({ status: 'sent', videoId: 'recovered01' });
    expect((await shareOf(p.id))?.detail.sessionUri).toBeUndefined();
  });

  it('a dead session with no finished upload starts over with a fresh one', async () => {
    yt.deadSession = true;
    const p = await withSession('dead-fresh');
    await tick();
    expect(yt.calls).toContain('findRecent');
    expect(yt.uploads).toHaveLength(1);
    expect(yt.uploads[0]?.sessionUri).toBeUndefined();
    expect((await post(p.id)).upload.status).toBe('sent');
  });

  it('after the slot passes a scheduled video is confirmed public (and only then embedded)', async () => {
    const c = blogContent('video-confirm-public');
    const { post: bp } = await submitPost(t.app.ctx, c, { userId: sa.id }, 'draft');
    await publishPost(t.app.ctx, bp.id, { userId: sa.id });
    const p = await approved('article', 'long', 'video-confirm-public');
    await tick();
    expect((await shareOf(p.id))?.detail.verifiedAt).toBeUndefined();
    // scheduled: the page does not embed a video nobody can watch yet
    expect((await t.app.inject({ method: 'GET', url: '/blog/video-confirm-public' })).body).not.toContain(
      'youtube-nocookie',
    );
    t.clock.advance(3 * 86_400_000);
    yt.status = () => ({
      privacyStatus: 'public',
      uploadStatus: 'processed',
      publishAt: null,
      rejectionReason: null,
      failureReason: null,
    });
    await tick();
    expect((await shareOf(p.id))?.detail.verifiedAt).toBeTruthy();
    expect((await shareOf(p.id))?.status).toBe('sent');
    expect((await t.app.inject({ method: 'GET', url: '/blog/video-confirm-public' })).body).toContain(
      'youtube-nocookie.com/embed/vid1abcdef',
    );
    t.clock.advance(-3 * 86_400_000);
  });

  it('a scheduled video that is still private after its slot becomes locked_private: mail, pause, no embed', async () => {
    const p = await approved('article', 'long', 'locked-later');
    await tick();
    expect((await post(p.id)).upload.status).toBe('sent');
    t.clock.advance(3 * 86_400_000);
    yt.status = () => ({
      privacyStatus: 'private',
      uploadStatus: 'processed',
      publishAt: null,
      rejectionReason: null,
      failureReason: null,
    });
    await tick();
    await tick(); // looked at once, not every pass
    t.clock.advance(-3 * 86_400_000);
    expect((await post(p.id)).upload.status).toBe('locked_private');
    expect(mail.sent.filter((m) => /private/.test(m.subject))).toHaveLength(1);
    expect(yt.calls.filter((c) => c === 'status').length).toBe(2); // the upload read-back and one re-check
    expect((await q(`SELECT 1 FROM events WHERE type='VideoUploadLockedPrivate'`)).length).toBeGreaterThan(0);
    const next = await approved('article', 'long', 'blocked-by-lock');
    await tick();
    expect(yt.uploads).toHaveLength(1);
    expect((await post(next.id)).upload.status).toBe('pending');
  });

  it('keeps the heartbeat fresh while a big upload runs', async () => {
    yt.progressAdvanceMs = 5 * 60_000;
    await approved('article', 'long', 'long-upload');
    const t0 = t.clock.now().getTime();
    await tick();
    t.clock.advance(-5 * 60_000);
    const hb = await ok(api('GET', '/api/platform/video/status'));
    // the beat after the chunk carries the advanced time, so the worker never looked dead mid-upload
    expect(Date.parse(hb.worker.lastSeen)).toBeGreaterThanOrEqual(t0 + 5 * 60_000);
  });
});

describe('slots and the upload gate', () => {
  beforeEach(clean);

  it('takenSlots holds the slots of approved posts of a format, published ones included', async () => {
    const { takenSlots } = await import('../src/commands/video-posts.ts');
    const a = await approved('article', 'long', 'taken-a');
    const s = await approved('article', 'short', 'taken-s');
    expect([...(await takenSlots(t.app.ctx, 'long'))]).toEqual([Date.parse(a.slotAt)]);
    expect([...(await takenSlots(t.app.ctx, 'short'))]).toEqual([Date.parse(s.slotAt)]);
    expect((await takenSlots(t.app.ctx, 'long', a.id)).size).toBe(0);
    await tick();
    expect((await takenSlots(t.app.ctx, 'long')).size).toBe(1); // sent: still taken
  });

  it('one upload runs at a time, and a video YouTube kept private pauses the next', async () => {
    const a = await approved('article', 'long', 'gate-a');
    const b = await approved('article', 'long', 'gate-b');
    await tick(); // a: rendered and uploaded
    await tick(); // b: rendered and uploaded: no limit of one a day
    expect(yt.uploads).toHaveLength(2);
    expect((await post(a.id)).upload.status).toBe('sent');
    expect((await post(b.id)).upload.status).toBe('sent');
    // an upload in progress elsewhere holds the next back
    const c = await approved('article', 'long', 'gate-c');
    await tick(); // renders c, uploads it
    await q(`UPDATE social_shares SET status='posting', updated_at = now() WHERE post_id=$1`, [c.id]);
    const d = await approved('article', 'long', 'gate-d');
    await tick();
    expect((await post(d.id)).upload.status).toBe('pending');
    expect(yt.uploads).toHaveLength(3);
  });

  it('a share that failed after the video was uploaded keeps the slot', async () => {
    const { takenSlots } = await import('../src/commands/video-posts.ts');
    const a = await approved('article', 'long', 'slot-failed');
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, external_id, url, created_at, updated_at, detail)
       VALUES ($1,'youtube','video','failed','vidFAILED001','https://www.youtube.com/watch?v=vidFAILED001', now(), now(), $2::jsonb)`,
      [a.id, JSON.stringify({ videoId: 'vidFAILED001', uploadedAt: new Date().toISOString() })],
    );
    expect((await takenSlots(t.app.ctx, 'long')).has(Date.parse(a.slotAt))).toBe(true);
    const b = await approved('article', 'long', 'slot-after-failed');
    expect(b.slotAt).not.toBe(a.slotAt);
  });
});

describe('what an error means', () => {
  beforeEach(clean);

  it('a 401 mid-upload mints a new access token and repeats the call; the channel stays connected', async () => {
    yt.uploadErrors = [new YouTubeError('unauthorized', 'HTTP 401', 401)];
    const p = await approved('article', 'long', 'token-expired');
    await tick();
    expect((await post(p.id)).upload.status).toBe('sent');
    expect(yt.calls.filter((c) => c === 'accessToken').length).toBe(2);
    expect((await q(`SELECT status FROM social_channels WHERE network='youtube'`))[0]?.status).toBe('ok');
    expect(mail.sent.filter((m) => /YouTube/.test(m.subject))).toHaveLength(0);
  });

  it('a 401 that survives a fresh token is retried later, not a reconnect', async () => {
    yt.uploadErrors = [
      new YouTubeError('unauthorized', 'HTTP 401', 401),
      new YouTubeError('unauthorized', 'HTTP 401', 401),
    ];
    const p = await approved('article', 'long', 'still-401');
    await tick();
    expect((await post(p.id)).upload).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await q(`SELECT status FROM social_channels WHERE network='youtube'`))[0]?.status).toBe('ok');
  });

  it('a wrong OAuth client is a configuration error: mail once, no reconnect, the upload waits', async () => {
    yt.tokenError = new YouTubeError(
      'config',
      'Google refused the OAuth client (invalid_client): check AOM_YOUTUBE_CLIENT_ID and AOM_YOUTUBE_CLIENT_SECRET',
    );
    const p = await approved('article', 'long', 'bad-client');
    await tick();
    const d = await post(p.id);
    expect(d.upload.status).toBe('pending');
    expect(d.upload.error).toContain('invalid_client');
    expect((await q(`SELECT status FROM social_channels WHERE network='youtube'`))[0]?.status).toBe('ok');
    expect(mail.sent.filter((m) => /YouTube/.test(m.subject))).toHaveLength(1);
  });

  it('a 403 without a reason is a final failure of that upload, not a reconnect', async () => {
    yt.uploadError = new YouTubeError('forbidden', 'HTTP 403: ', 403);
    const p = await approved('article', 'long', 'plain-403');
    await tick();
    expect((await post(p.id)).upload.status).toBe('failed');
    expect((await q(`SELECT status FROM social_channels WHERE network='youtube'`))[0]?.status).toBe('ok');
  });

  it('a refused thumbnail is a warning and the upload still completes', async () => {
    yt.thumbError = new YouTubeError('forbidden', 'HTTP 403: forbidden', 403);
    const p = await approved('article', 'long', 'thumb-403');
    await tick();
    const d = await post(p.id);
    expect(d.upload.status).toBe('sent');
    expect(d.upload.warnings.join(' ')).toMatch(/thumbnail/);
  });
});

describe('the app and the editing rules', () => {
  beforeEach(clean);

  it('a YouTube-only setup cannot approve a release social post (409 no_channel)', async () => {
    await q(`DELETE FROM social_channels WHERE network <> 'youtube'`);
    const dir = mkdtempSync(join(tmpdir(), 'rel-yt-'));
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      `# Changelog\n\n## [7.7.0] - ${today}\n\n### Added\n\n- A brand new thing that is good.\n`,
    );
    useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'none') });
    try {
      const d = await ok(api('POST', '/api/platform/social/posts', { kind: 'release', ref: '7.7.0' }), 201);
      const r = await api('POST', `/api/platform/social/posts/${d.id}/approve`);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('no_channel');
    } finally {
      useReleaseSource(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('approve and an edit of the same post cannot interleave: the loser changes nothing', async () => {
    for (let i = 0; i < 4; i++) {
      const p = await submit('article', 'long', `race-${i}`);
      const edit = reviseTitle(p.id, `Raced title number ${i}`);
      const appr = api('POST', `/api/platform/video/posts/${p.id}/approve`);
      const [e, a] = await Promise.all([edit, appr]);
      const d = await post(p.id);
      expect(a.status).toBe(200); // scheduling needs no render, so it never loses
      expect(d.status).toBe('approved');
      if (e.status === 200)
        expect(d.revision).toBe(2); // edited first: the new revision is what was scheduled
      else {
        expect(e.status).toBe(409); // approved first: the edit lost
        expect(d.revision).toBe(1);
      }
      expect(
        await q('SELECT 1 FROM video_renders WHERE post_id=$1 AND revision <> $2', [p.id, d.revision]),
      ).toHaveLength(0);
    }
  });

  it('concurrent writer submissions cannot pass the weekly cap together', async () => {
    await days(2, 2);
    const writer = { system: 'blog-writer' as const };
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) =>
        submitVideoPost(
          t.app.ctx,
          { kind: 'article', format: 'long', ref: `cap-${i}`, script: script('article', 'long', `cap-${i}`) },
          writer,
          'in_review',
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(
      (await q(`SELECT count(*)::int AS n FROM video_posts WHERE origin_system IS NOT NULL`))[0]?.n,
    ).toBe(2);
    await days(7);
  });

  it('retries and the resolve of a locked upload are audited', async () => {
    const p = await submit('article', 'long', 'audited');
    await preview(p.id);
    await videoTick(t.app.ctx, {
      render: async () => {
        throw new Error('boom');
      },
    });
    t.clock.advance(5 * 60_000);
    await videoTick(t.app.ctx, {
      render: async () => {
        throw new Error('boom');
      },
    });
    t.clock.advance(5 * 60_000);
    await videoTick(t.app.ctx, {
      render: async () => {
        throw new Error('boom');
      },
    });
    t.clock.advance(-10 * 60_000);
    await ok(api('POST', `/api/platform/video/posts/${p.id}/retry-render`));
    const rows = await q(
      `SELECT summary FROM platform_audit_log WHERE action='VideoRetryRequested' ORDER BY seq DESC`,
    );
    expect(rows[0]?.summary).toContain('render tried again');
    expect(rows.some((r) => /dealt with/.test(r.summary))).toBe(true); // the locked upload of an earlier test
    expect(rows.some((r) => /upload tried again/.test(r.summary))).toBe(true);
  });
});

describe('files after the clean-up', () => {
  beforeEach(clean);

  it('keeps serving the thumbnail, captions and script once the MP4 is gone, and renders again for a retry', async () => {
    const p = await approved('article', 'long', 'purged');
    await tick();
    // the slot was 7 hours ago: published long enough, the MP4 goes
    await q(`UPDATE video_posts SET slot_at = now() - interval '7 hours' WHERE id=$1`, [p.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    const d = await post(p.id);
    expect(d.render.purged).toBe(true);
    expect(d.render.files).not.toContain('video');
    expect(d.render.files).toEqual(expect.arrayContaining(['captionsVtt', 'thumb', 'script']));
    const get = (name: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/platform/video/posts/${p.id}/files/${name}`,
        headers: { cookie: sa.cookie },
      });
    expect((await get('captions.vtt')).statusCode).toBe(200);
    expect((await get('thumb.png')).statusCode).toBe(200);
    expect((await get('video.mp4')).statusCode).toBe(404);
    // a failed share that never uploaded: the retry renders the same revision again, then uploads
    await q(
      `UPDATE social_shares SET status='failed', external_id=NULL, url=NULL, detail='{}'::jsonb WHERE post_id=$1`,
      [p.id],
    );
    const r = await ok(api('POST', `/api/platform/video/posts/${p.id}/retry-upload`));
    expect(r.render).toMatchObject({ status: 'queued', purged: false });
    expect(r.rendersUsed).toBe(1); // a re-render of the same revision is not a new render
    expect(await tick()).toMatchObject({ rendered: true, uploaded: true });
    expect((await post(p.id)).upload.status).toBe('sent');
  });

  it('only real file names are served (no inherited object properties)', async () => {
    const p = await submit('article', 'long', 'names');
    await tick();
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = await t.app.inject({
        method: 'GET',
        url: `/api/platform/video/posts/${p.id}/files/${name}`,
        headers: { cookie: sa.cookie },
      });
      expect(r.statusCode).toBe(404);
    }
  });
});

describe('render ownership and back-off', () => {
  beforeEach(clean);

  it('a worker whose lease was taken over cannot overwrite the render', async () => {
    const p = await submit('article', 'long', 'stale-worker');
    await preview(p.id);
    const slow: RenderFn = async (s, o) => {
      // while this worker renders, its lease expires and another worker claims the render (attempts + 1)
      await q(`UPDATE video_renders SET attempts = attempts + 1 WHERE post_id=$1`, [p.id]);
      return fakeRender(s, o);
    };
    await videoTick(t.app.ctx, { render: slow });
    const r = (await q('SELECT status, attempts FROM video_renders WHERE post_id=$1', [p.id]))[0];
    expect(r).toMatchObject({ status: 'rendering', attempts: 2 }); // the stale write was ignored
  });

  it('a failed render waits before it is tried again', async () => {
    const p = await submit('article', 'long', 'backoff');
    await preview(p.id);
    let n = 0;
    const flaky: RenderFn = async (s, o) => {
      n++;
      if (n === 1) throw new Error('first try fails');
      return fakeRender(s, o);
    };
    await videoTick(t.app.ctx, { render: flaky });
    expect(n).toBe(1);
    await videoTick(t.app.ctx, { render: flaky });
    expect(n).toBe(1); // still backing off
    t.clock.advance(2 * 60_000);
    await videoTick(t.app.ctx, { render: flaky });
    t.clock.advance(-2 * 60_000);
    expect(n).toBe(2);
    expect((await post(p.id)).render.status).toBe('rendered');
  });
});

describe('scheduling: slots, render timing, destinations', () => {
  beforeEach(clean);
  const H = 3_600_000;
  const slots = (format: 'long' | 'short', count = 14) =>
    ok(api('GET', `/api/platform/video/slots?format=${format}&count=${count}`));
  const sched = (id: string, body: Record<string, unknown> = {}) =>
    api('POST', `/api/platform/video/posts/${id}/schedule`, body);

  it('Schedule takes the next free slot of the schedule; a picked slot must be a free slot of it', async () => {
    await settings({ schedule: { long: { days: ['mon', 'wed', 'fri'] } } });
    const list = await slots('long');
    expect(list.timezone).toBe('Africa/Johannesburg');
    for (const sl of list.slots) {
      const d = new Date(sl.at);
      expect(d.getUTCHours()).toBe(8); // 10:00 SAST
      expect([1, 3, 5]).toContain(d.getUTCDay());
    }
    const a = await submit('article', 'long', 'sched-a');
    const b = await submit('article', 'long', 'sched-b');
    const first = await ok(sched(a.id));
    expect(first.slotAt).toBe(
      list.slots.find((x: { at: string }) => Date.parse(x.at) >= Date.now() + 3 * H)?.at,
    );
    const second = await ok(sched(b.id));
    expect(Date.parse(second.slotAt)).toBeGreaterThan(Date.parse(first.slotAt));
    // errors: not a slot, taken, too soon
    const c = await submit('article', 'long', 'sched-c');
    const odd = await sched(c.id, { slotAt: new Date(Date.parse(first.slotAt) + H).toISOString() });
    expect([odd.status, odd.body.error.code]).toEqual([409, 'not_a_slot']);
    const taken = await sched(c.id, { slotAt: first.slotAt });
    expect([taken.status, taken.body.error.code]).toEqual([409, 'slot_taken']);
    const soon = list.slots.find(
      (x: { at: string }) => Date.parse(x.at) < Date.now() + 3 * H && Date.parse(x.at) > Date.now(),
    );
    if (soon) expect((await sched(c.id, { slotAt: soon.at })).body.error.code).toBe('slot_too_soon');
    const view = await slots('long');
    expect(
      view.slots.filter((x: { postId: string | null }) => x.postId).map((x: { postId: string }) => x.postId),
    ).toEqual([a.id, b.id]);
    await days(7);
  });

  it('two requests for the same slot: exactly one wins, the other gets 409 slot_taken', async () => {
    const [a, b] = [
      await submit('article', 'long', 'race-slot-a'),
      await submit('article', 'long', 'race-slot-b'),
    ];
    const target = (await slots('long')).slots.find(
      (x: { at: string; free: boolean }) => x.free && Date.parse(x.at) > Date.now() + 4 * H,
    ).at;
    const [ra, rb] = await Promise.all([sched(a.id, { slotAt: target }), sched(b.id, { slotAt: target })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect([ra, rb].find((r) => r.status === 409)?.body.error.code).toBe('slot_taken');
    // without a slot, concurrent schedules get different free slots
    const [c, d] = [
      await submit('article', 'long', 'race-slot-c'),
      await submit('article', 'long', 'race-slot-d'),
    ];
    const [rc, rd] = await Promise.all([sched(c.id), sched(d.id)]);
    expect(rc.status).toBe(200);
    expect(rd.status).toBe(200);
    expect(rc.body.slotAt).not.toBe(rd.body.slotAt);
  });

  it('the render is not claimed before slot minus the render lead, then starts', async () => {
    await settings({ schedule: { long: { renderLeadHours: 48 } } });
    const p = await submit('article', 'long', 'lead');
    const far = (await slots('long')).slots[5].at as string; // five days ahead
    const sch = await ok(sched(p.id, { slotAt: far }));
    expect(sch.render.notBefore).toBe(new Date(Date.parse(far) - 48 * H).toISOString());
    expect(await tick()).toMatchObject({ rendered: false, uploaded: false });
    expect((await post(p.id)).render.status).toBe('queued');
    t.clock.advance(Date.parse(far) - 48 * H - Date.now() + 60_000);
    expect(await tick()).toMatchObject({ rendered: true, uploaded: true });
    t.clock.advance(-(Date.parse(far) - 48 * H - Date.now() + 60_000) - 0);
    expect(yt.uploads[0]?.status.publishAt).toBe(far);
    await settings({ schedule: { long: { renderLeadHours: 168 } } });
  });

  it('a purged preview is queued again at scheduling without using another render', async () => {
    const p = await submit('article', 'long', 'repurge');
    await preview(p.id);
    await tick();
    await q(`UPDATE video_renders SET finished_at = now() - interval '8 days' WHERE post_id=$1`, [p.id]);
    await q(`UPDATE video_posts SET updated_at = now() - interval '8 days' WHERE id=$1`, [p.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1); // a preview idle for 7 days
    expect((await post(p.id)).render.purged).toBe(true);
    const sch = await ok(sched(p.id));
    expect(sch.render).toMatchObject({ status: 'queued', purged: false, preview: false });
    expect(sch.rendersUsed).toBe(1);
    expect(await tick()).toMatchObject({ rendered: true, uploaded: true });
  });

  it('unschedule: back to review while nothing started (the render becomes a preview); refused once on YouTube', async () => {
    const p = await approved('article', 'long', 'unsched');
    await tick(); // rendered and uploaded already
    const gone = await api('POST', `/api/platform/video/posts/${p.id}/unschedule`, {});
    expect([gone.status, gone.body.error.code]).toEqual([409, 'already_started']);
    const q1 = await approved('article', 'long', 'unsched-2');
    await q(`UPDATE video_renders SET not_before = now() + interval '1 day' WHERE post_id=$1`, [q1.id]);
    const back = await ok(api('POST', `/api/platform/video/posts/${q1.id}/unschedule`)); // no body, like the web app
    expect(back).toMatchObject({
      status: 'in_review',
      slotAt: null,
      publishMode: null,
      approvedAt: null,
      phase: 'in_review',
    });
    expect(await tick()).toMatchObject({ rendered: false }); // a queued render of a post in review waits
    // it can be scheduled again
    const again = await ok(sched(q1.id));
    expect(again.status).toBe('approved');
    expect(await tick()).toMatchObject({ rendered: true });
  });

  it('move and swap trade free slots until a destination has the video', async () => {
    const a = await approved('article', 'long', 'mv-a');
    const b = await approved('article', 'long', 'mv-b');
    // move a to a free slot further out
    const free = (await slots('long')).slots.find(
      (x: { free: boolean; at: string }) => x.free && Date.parse(x.at) > Date.parse(b.slotAt),
    ).at;
    const moved = await ok(api('POST', `/api/platform/video/posts/${a.id}/move`, { slotAt: free }));
    expect(moved.slotAt).toBe(free);
    const clash = await api('POST', `/api/platform/video/posts/${a.id}/move`, { slotAt: b.slotAt });
    expect(clash.body.error.code).toBe('slot_taken');
    const swapped = await ok(api('POST', `/api/platform/video/posts/${a.id}/swap`, { withId: b.id }));
    expect(swapped.a.slotAt).toBe(b.slotAt);
    expect(swapped.b.slotAt).toBe(free);
    await tick(); // one of them is rendered and on YouTube
    // the projection and a rebuild agree
    const cols = 'id, slot_at, publish_mode, destinations, status';
    const mine = `SELECT ${cols} FROM video_posts WHERE id = ANY($1::uuid[]) ORDER BY id`;
    const before = await q(mine, [[a.id, b.id]]);
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await q(mine, [[a.id, b.id]])).toEqual(before);
    expect(before).toHaveLength(2);
    const started = await api('POST', `/api/platform/video/posts/${a.id}/swap`, { withId: b.id });
    expect([started.status, started.body.error?.code]).toEqual([409, 'already_started']);
    expect((await api('POST', `/api/platform/video/posts/${a.id}/move`, { slotAt: free })).status).toBe(409);
  });

  it('a Short that belongs to a long video takes the first Short slot at or after the long slot', async () => {
    const long = await approved('article', 'long', 'pair');
    const short = await submit('article', 'short', 'pair', { parentId: long.id });
    const sch = await ok(sched(short.id));
    expect(Date.parse(sch.slotAt)).toBeGreaterThanOrEqual(Date.parse(long.slotAt));
    const earlier = (await slots('short')).slots.find(
      (x: { at: string }) => Date.parse(x.at) >= Date.now() + H,
    );
    expect(Date.parse(sch.slotAt)).toBeGreaterThanOrEqual(Date.parse(earlier.at));
    expect(new Date(sch.slotAt).getUTCHours()).toBe(14); // 16:00 SAST
  });

  it('"publish now": Shorts and public long videos upload public at once, a private long one may not', async () => {
    const s = await submit('article', 'short', 'now-short');
    const sn = await ok(sched(s.id, { mode: 'now' }));
    expect(sn).toMatchObject({ publishMode: 'now' });
    expect(sn.render.notBefore).toBeNull();
    await tick();
    expect(yt.uploads[0]?.status).toMatchObject({ privacyStatus: 'public' });
    expect(yt.uploads[0]?.status.publishAt).toBeUndefined();
    const d = await post(s.id);
    expect(d.upload).toMatchObject({ status: 'sent', publishAt: null });
    expect((await shareOf(s.id))?.detail.verifiedAt).toBeTruthy(); // YouTube showed it public
    const long = await submit('article', 'long', 'now-long');
    await ok(api('PATCH', `/api/platform/video/posts/${long.id}`, { privacy: 'unlisted' }));
    const refused = await sched(long.id, { mode: 'now' });
    expect([refused.status, refused.body.error.code]).toEqual([400, 'mode_not_allowed']);
    await ok(api('PATCH', `/api/platform/video/posts/${long.id}`, { privacy: 'public' }));
    expect((await ok(sched(long.id, { mode: 'now' }))).publishMode).toBe('now');
  });

  it('other destinations get a skipped share "not available yet"; a long video is YouTube only', async () => {
    const long = await submit('article', 'long', 'dest-long');
    const bad = await sched(long.id, { destinations: ['youtube', 'x'] });
    expect(bad.status).toBe(400);
    const short = await submit('article', 'short', 'dest-short');
    const sch = await ok(
      sched(short.id, {
        destinations: ['youtube', 'instagram', 'x', 'tiktok'],
        captions: { instagram: { text: 'Look at this', tags: ['agents'] } },
      }),
    );
    expect(sch.destinations).toEqual(['youtube', 'instagram', 'x', 'tiktok']);
    expect(sch.captions).toEqual({ instagram: { text: 'Look at this', tags: ['agents'] } });
    const stray = await sched((await submit('article', 'short', 'dest-short-2')).id, {
      destinations: ['youtube'],
      captions: { x: { text: 'no', tags: [] } },
    });
    expect(stray.status).toBe(400);
    await tick();
    const d = await post(short.id);
    expect(d.upload.status).toBe('sent');
    expect(d.shares.map((x: { network: string; status: string }) => [x.network, x.status]).sort()).toEqual([
      ['instagram', 'skipped'],
      ['tiktok', 'skipped'],
      ['x', 'skipped'],
    ]);
    expect(d.shares[0].error).toMatch(/not available yet/);
    // the YouTube video is confirmed public: every share is sent or skipped, so the MP4 goes
    await q(
      `UPDATE social_shares SET detail = detail || jsonb_build_object('verifiedAt', now()::text) WHERE post_id=$1 AND network='youtube'`,
      [short.id],
    );
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect((await post(short.id)).render.files).not.toContain('video');
    // the blog sweep never sees these networks
    const { SOCIAL_NETWORKS } = await import('@aom/shared');
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('instagram');
  });

  it('a failed destination keeps the MP4 for 3 days; a rejected post loses its files after one', async () => {
    const p = await approved('article', 'long', 'failkeep');
    await tick();
    await q(
      `UPDATE social_shares SET status='failed', updated_at = now() - interval '2 days' WHERE post_id=$1`,
      [p.id],
    );
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(0);
    await q(`UPDATE social_shares SET updated_at = now() - interval '4 days' WHERE post_id=$1`, [p.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
  });

  it('the disk budget stops new renders and mails once', async () => {
    const p = await approved('article', 'long', 'budget');
    const cfg = t.app.ctx.config as { videoMaxBytes: number };
    const keep = cfg.videoMaxBytes;
    cfg.videoMaxBytes = 100_000_000;
    try {
      expect(await tick()).toMatchObject({ rendered: false });
      await tick();
      expect((await post(p.id)).render.status).toBe('queued');
      expect(mail.sent.filter((m) => /disk is full/.test(m.subject))).toHaveLength(1);
    } finally {
      cfg.videoMaxBytes = keep;
    }
    await q(`DELETE FROM platform_settings WHERE key LIKE 'video_alert:%'`);
    expect(await tick()).toMatchObject({ rendered: true });
  });

  it('slips at slot minus 30 minutes when not rendered, once, without cascading; a started post stays', async () => {
    const { videoWatch } = await import('../src/video/sweep.ts');
    const a = await approved('article', 'long', 'slip-a');
    const b = await approved('article', 'long', 'slip-b');
    const c = await approved('article', 'long', 'slip-c');
    const slotA = Date.parse(a.slotAt);
    // nothing is rendered (the worker never ticked); 29 minutes before a's slot
    const jump = slotA - 29 * 60_000 - Date.now();
    t.clock.advance(jump);
    try {
      const out = await videoWatch(t.app.ctx);
      expect(out.slipped).toBe(1);
      const read = (id: string) => getVideoPost(t.app.ctx, id); // no API call while the clock is ahead: sessions expire
      const after = await read(a.id);
      expect(Date.parse(after.slotAt as string)).toBeGreaterThan(Date.parse(c.slotAt)); // the next FREE slot: b and c stay
      expect((await read(b.id)).slotAt).toBe(b.slotAt);
      expect((await read(c.id)).slotAt).toBe(c.slotAt);
      expect(after.render?.notBefore).toBe(
        new Date(Date.parse(after.slotAt as string) - 168 * H).toISOString(),
      );
      expect(mail.sent.filter((m) => /missed its slot/.test(m.subject))).toHaveLength(1);
      const ev = await q(
        `SELECT payload FROM events WHERE type='VideoPostScheduled' AND payload->>'postId'=$1 ORDER BY seq DESC LIMIT 1`,
        [a.id],
      );
      expect(ev[0]?.payload).toMatchObject({ reason: 'slipped', by: 'system' });
      expect((await videoWatch(t.app.ctx)).slipped).toBe(0); // not again
    } finally {
      t.clock.advance(-jump);
    }
  });

  it('alerts when the render worker is offline near a slot, and when a render failed for good', async () => {
    const { videoWatch } = await import('../src/video/sweep.ts');
    const p = await approved('article', 'long', 'alerts');
    await q(`DELETE FROM platform_settings WHERE key='video_worker_heartbeat'`);
    await q(`UPDATE video_posts SET slot_at = now() + interval '20 hours' WHERE id=$1`, [p.id]);
    await videoWatch(t.app.ctx);
    expect(mail.sent.filter((m) => /render worker is offline/.test(m.subject))).toHaveLength(1);
    await videoWatch(t.app.ctx);
    expect(mail.sent.filter((m) => /render worker is offline/.test(m.subject))).toHaveLength(1);
    await q(`UPDATE video_posts SET slot_at = now() + interval '5 hours' WHERE id=$1`, [p.id]);
    await q(
      `UPDATE video_renders SET status='failed', error='ffmpeg exploded', attempts=3 WHERE post_id=$1`,
      [p.id],
    );
    await videoWatch(t.app.ctx);
    expect(mail.sent.filter((m) => /failed to render/.test(m.subject))).toHaveLength(1);
    expect((await post(p.id)).phase).toBe('failed');
  });

  it('an empty slot with scripts waiting in review is mailed once, 24 hours before', async () => {
    const { videoWatch } = await import('../src/video/sweep.ts');
    await submit('article', 'long', 'empty-slot');
    await videoWatch(t.app.ctx);
    expect(mail.sent.filter((m) => /slot is still empty/.test(m.subject))).toHaveLength(1);
    await videoWatch(t.app.ctx);
    expect(mail.sent.filter((m) => /slot is still empty/.test(m.subject))).toHaveLength(1);
  });

  it('the status carries the capacity from the days ticked and the next slot per format', async () => {
    await days(4, 2);
    const st = await ok(api('GET', '/api/platform/video/status'));
    expect(st.capacity.long).toMatchObject({ limit: 4, backlogLimit: 8 });
    expect(st.capacity.short).toMatchObject({ limit: 2, backlogLimit: 4 });
    expect(st.nextSlot.long).toBeTruthy();
    expect(st.nextSlot.short).toBeTruthy();
    expect(st.storage.maxBytes).toBe(5 * 1024 ** 3);
    await days(0, 0);
    const none = await ok(api('GET', '/api/platform/video/status'));
    expect(none.nextSlot).toEqual({ long: null, short: null });
    expect(none.capacity.long.limit).toBe(0);
    const p = await submit('article', 'long', 'no-days');
    expect((await sched(p.id)).body.error.code).toBe('no_slots');
    await days(7);
  });

  it('settings: the schedule is validated, patched in parts, and derived from the old counts until one is saved', async () => {
    expect(
      (await api('PATCH', '/api/platform/video/settings', { schedule: { timezone: 'Mars/Olympus' } })).status,
    ).toBe(400);
    expect(
      (
        await api('PATCH', '/api/platform/video/settings', {
          schedule: { long: { destinations: ['youtube', 'x'] } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api('PATCH', '/api/platform/video/settings', { schedule: { long: { days: ['mon', 'mon'] } } }))
        .status,
    ).toBe(400);
    expect(
      (await api('PATCH', '/api/platform/video/settings', { schedule: { short: { time: '25:00' } } })).status,
    ).toBe(400);
    const tz = await settings({
      schedule: {
        timezone: 'Europe/Amsterdam',
        short: { time: '09:30', destinations: ['youtube', 'bluesky'] },
      },
    });
    expect(tz.schedule).toMatchObject({
      timezone: 'Europe/Amsterdam',
      short: { time: '09:30', destinations: ['youtube', 'bluesky'] },
    });
    expect(tz.schedule.long.days).toEqual(ALL_DAYS); // untouched
    // slots follow the zone (09:30 Amsterdam is 08:30 UTC in winter, 07:30 in summer)
    const hours = (await slots('short', 40)).slots.map(
      (x: { at: string }) => new Date(x.at).getUTCHours() * 60 + new Date(x.at).getUTCMinutes(),
    );
    expect(new Set(hours).size).toBeLessThanOrEqual(2);
    expect(hours.every((m: number) => m === 450 || m === 510)).toBe(true);
    // derived from perWeek / shortsPerWeek while nothing was saved
    const saved = (await q(`SELECT value FROM platform_settings WHERE key='video_posts'`))[0]?.value;
    const { schedule: _drop, ...rest } = saved;
    await q(`UPDATE platform_settings SET value=$1::jsonb WHERE key='video_posts'`, [
      JSON.stringify({ ...rest, perWeek: 3, shortsPerWeek: 2 }),
    ]);
    const derived = await ok(api('GET', '/api/platform/video/settings'));
    expect(derived.schedule).toMatchObject({
      timezone: 'Africa/Johannesburg',
      long: { days: ['mon', 'wed', 'fri'], time: '10:00', destinations: ['youtube'], renderLeadHours: 48 },
      short: { days: ['tue', 'thu'], time: '16:00', destinations: ['youtube'], renderLeadHours: 24 },
    });
    expect((await settings({ perWeek: 5 })).schedule.long.days).toHaveLength(5);
    await q(`UPDATE platform_settings SET value=$1::jsonb WHERE key='video_posts'`, [JSON.stringify(saved)]);
  });

  it('the schedule routes are 404 for everyone but a super admin', async () => {
    const member = await t.userSession('member-schedule@example.com');
    const p = await submit('article', 'long', 'routes-404');
    for (const [method, url, body] of [
      ['GET', '/api/platform/video/slots?format=long', undefined],
      ['POST', `/api/platform/video/posts/${p.id}/schedule`, {}],
      ['POST', `/api/platform/video/posts/${p.id}/unschedule`, {}],
      ['POST', `/api/platform/video/posts/${p.id}/move`, { slotAt: new Date().toISOString() }],
      ['POST', `/api/platform/video/posts/${p.id}/swap`, { withId: p.id }],
      ['POST', `/api/platform/video/posts/${p.id}/preview`, {}],
    ] as const)
      expect((await api(method, url, body, member.cookie)).status).toBe(404);
  });
});

function reviseTitle(id: string, title: string) {
  return api('PATCH', `/api/platform/video/posts/${id}`, {
    script: { ...script('article', 'long', 'x'), title, meta: { ...LONG.meta, title } },
  });
}
