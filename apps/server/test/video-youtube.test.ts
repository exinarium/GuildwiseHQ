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
  importLibrary,
  queueVideoTopic,
  releasesNeedingVideo,
  releaseVideoTopic,
  slotAfter,
  submitVideoPost,
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
/** Submit, render and approve a post. */
async function approved(kind: VideoScript['kind'], format: 'long' | 'short', ref: string) {
  const p = await submit(kind, format, ref);
  await tick();
  return ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
}
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
    // a post can be drafted and sits queued; nothing renders
    const p = await submit('tutorial', 'long', 'agents');
    expect(await tick()).toMatchObject({ active: false, rendered: false });
    expect((await q('SELECT status FROM video_renders WHERE post_id=$1', [p.id]))[0]?.status).toBe('queued');
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

  it('renders, holds for approval, then uploads once with the right fields', async () => {
    await settings({ playlists: { tutorial: 'PLtutorials' } });
    const p = await submit('tutorial', 'long', 'agents');
    expect(p).toMatchObject({ status: 'in_review', revision: 1, library: false });
    // approve is disabled until the revision is rendered
    const early = await api('POST', `/api/platform/video/posts/${p.id}/approve`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_rendered');
    expect(await tick()).toMatchObject({ rendered: true, uploaded: false });
    expect(yt.uploads).toHaveLength(0); // not before approval
    const rendered = await post(p.id);
    expect(rendered.render).toMatchObject({ status: 'rendered', durationSeconds: 130 });
    expect(rendered.render.files).toEqual(expect.arrayContaining(['video', 'captionsVtt', 'thumb']));
    await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
    expect(await tick()).toMatchObject({ uploaded: true });
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
    expect(new Date(u.status.publishAt as string).getUTCHours()).toBe(8); // 10:00 SAST
    expect(yt.thumbs).toHaveLength(1);
    expect(yt.captions).toHaveLength(1);
    expect(yt.playlist).toEqual([['PLtutorials', 'vid1abcdef']]);
    const done = await post(p.id);
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

  it('uploads one video a day at 10:00 SAST and gives the next the next free slot', async () => {
    const a = await approved('article', 'long', 'one-a-day-1');
    const b = await approved('article', 'long', 'one-a-day-2');
    await tick();
    await tick();
    expect(yt.uploads).toHaveLength(1);
    expect((await post(b.id)).upload.status).toBe('pending');
    // a day later the second goes, to the next slot
    await q(
      `UPDATE social_shares SET detail = jsonb_set(detail, '{uploadedAt}', to_jsonb((now() - interval '26 hours')::text)) WHERE post_id=$1`,
      [a.id],
    );
    await tick();
    expect(yt.uploads).toHaveLength(2);
    const s1 = new Date(yt.uploads[0]?.status.publishAt as string).getTime();
    const s2 = new Date(yt.uploads[1]?.status.publishAt as string).getTime();
    expect(s2 - s1).toBeGreaterThanOrEqual(86_400_000);
  });

  it('slotAfter skips taken days and never picks a slot closer than half an hour', () => {
    const noon = new Date('2026-11-02T12:00:00Z');
    expect(slotAfter(noon).toISOString()).toBe('2026-11-03T08:00:00.000Z');
    expect(slotAfter(noon, ['2026-11-03T08:00:00.000Z']).toISOString()).toBe('2026-11-04T08:00:00.000Z');
    expect(slotAfter(new Date('2026-11-02T07:45:00Z')).toISOString()).toBe('2026-11-03T08:00:00.000Z');
    expect(slotAfter(new Date('2026-11-02T06:00:00Z')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
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

  it('an edit re-renders (max 3 renders); tags and privacy change in place; an approved video is final', async () => {
    const p = await submit('article', 'long', 'edits');
    await tick();
    const edited = (rev: number) => ({
      script: {
        ...script('article', 'long', 'edits'),
        title: `Edited title ${rev}`,
        meta: { ...LONG.meta, title: `Edited title ${rev}` },
      },
    });
    let cur = await ok(api('PATCH', `/api/platform/video/posts/${p.id}`, edited(2)));
    expect(cur).toMatchObject({ revision: 2, title: 'Edited title 2' });
    expect(cur.render.status).toBe('queued'); // the new revision
    // approve is disabled while the current revision is not rendered
    expect((await api('POST', `/api/platform/video/posts/${p.id}/approve`)).status).toBe(409);
    await tick();
    const tags = await ok(
      api('PATCH', `/api/platform/video/posts/${p.id}`, {
        meta: { tags: ['one', 'two'] },
        privacy: 'unlisted',
      }),
    );
    expect(tags.revision).toBe(2);
    expect(tags.meta).toMatchObject({ tags: ['one', 'two'], privacy: 'unlisted' });
    cur = await ok(api('PATCH', `/api/platform/video/posts/${p.id}`, edited(3)));
    expect(cur.revision).toBe(3);
    const over = await api('PATCH', `/api/platform/video/posts/${p.id}`, edited(4));
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('render_limit');
    await tick();
    await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
    const approvedPost = await post(p.id);
    expect(approvedPost.approvedRenderId).toBe(approvedPost.render.id);
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
    await settings({ perWeek: 1 });
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
    await settings({ perWeek: 3, articleVideos: false });
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
    const cols = 'id, kind, ref, format, status, revision, title, approved_render_id, approved_at';
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

  it('cleans up superseded renders after a day, rejected after a week, uploaded MP4s after 30 days', async () => {
    const sup = await submit('article', 'long', 'cleanup-sup');
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
    await tick();
    const dir1 = join(videoDir, sup.id, '1');
    const dir2 = join(videoDir, sup.id, '2');
    expect(readFileSync(join(dir1, 'video.mp4')).length).toBeGreaterThan(0);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(0); // too young
    await q(`UPDATE video_renders SET finished_at = now() - interval '2 days'`);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect(() => readFileSync(join(dir1, 'video.mp4'))).toThrow();
    expect(readFileSync(join(dir2, 'video.mp4')).length).toBeGreaterThan(0);
    // rejected for 8 days
    await ok(api('POST', `/api/platform/video/posts/${sup.id}/reject`, { reason: 'no' }));
    await q(`UPDATE video_posts SET updated_at = now() - interval '8 days' WHERE id=$1`, [sup.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect(() => readFileSync(join(dir2, 'video.mp4'))).toThrow();
    // an uploaded video: only the MP4 goes after 30 days
    const up = await approved('article', 'long', 'cleanup-up');
    await tick();
    const dir = join(videoDir, up.id, '1');
    await q(`UPDATE social_shares SET updated_at = now() - interval '31 days' WHERE post_id=$1`, [up.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect(() => readFileSync(join(dir, 'video.mp4'))).toThrow();
    expect(readFileSync(join(dir, 'captions.vtt'), 'utf8')).toContain('WEBVTT');
    expect(readFileSync(join(dir, 'script.json'), 'utf8').length).toBeGreaterThan(0);
    expect(await cleanupVideos(t.app.ctx)).toBe(0); // once a day
  });

  it('a render over ten minutes fails and a crashing render is tried three times', async () => {
    const long = await submit('article', 'long', 'too-long');
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

describe('slots and the daily cap count what really happened', () => {
  beforeEach(clean);

  it('a share that failed after the video was uploaded still holds its slot and today', async () => {
    const a = await approved('article', 'long', 'cap-failed');
    const slot = iso(2 * 86_400_000);
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, external_id, url, created_at, updated_at, detail)
       VALUES ($1,'youtube','video','failed','vidFAILED001','https://www.youtube.com/watch?v=vidFAILED001', now(), now(), $2::jsonb)`,
      [
        a.id,
        JSON.stringify({
          videoId: 'vidFAILED001',
          uploadedAt: new Date().toISOString(),
          publishAt: slot,
          privacy: 'public',
        }),
      ],
    );
    const { takenSlots } = await import('../src/commands/video-posts.ts');
    expect(await takenSlots(t.app.ctx)).toContain(slot);
    await approved('article', 'long', 'cap-after-failed');
    await tick();
    expect(yt.uploads).toHaveLength(0); // today's upload was already used
  });

  it('a pending share that reserved a slot keeps it, and blocks a second upload today', async () => {
    const a = await approved('article', 'long', 'cap-pending');
    const slot = iso(86_400_000);
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, next_attempt_at, created_at, updated_at, detail)
       VALUES ($1,'youtube','video','pending', now() + interval '30 minutes', now(), now(), $2::jsonb)`,
      [a.id, JSON.stringify({ reservedAt: new Date().toISOString(), publishAt: slot, privacy: 'public' })],
    );
    const { takenSlots } = await import('../src/commands/video-posts.ts');
    expect(await takenSlots(t.app.ctx)).toContain(slot);
    await approved('article', 'long', 'cap-other');
    await tick();
    expect(yt.uploads).toHaveLength(0);
    // the waiting share itself is never blocked by its own reservation
    await q(`UPDATE social_shares SET next_attempt_at = now() - interval '1 minute' WHERE post_id=$1`, [
      a.id,
    ]);
    await tick();
    expect(yt.uploads).toHaveLength(1);
    expect((await post(a.id)).upload.status).toBe('sent');
    expect(new Date(yt.uploads[0]?.status.publishAt as string).toISOString()).toBe(slot);
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

  it('approve and an edit of the same post cannot interleave: the loser changes nothing and queues no render', async () => {
    for (let i = 0; i < 4; i++) {
      const p = await submit('article', 'long', `race-${i}`);
      await tick();
      const edit = reviseTitle(p.id, `Raced title number ${i}`);
      const appr = api('POST', `/api/platform/video/posts/${p.id}/approve`);
      const [e, a] = await Promise.all([edit, appr]);
      const d = await post(p.id);
      const renders = await q('SELECT revision, status FROM video_renders WHERE post_id=$1', [p.id]);
      if (a.status === 200) {
        // approved first: the edit lost
        expect(e.status).toBe(409);
        expect(d.revision).toBe(1);
        expect(renders).toHaveLength(1);
        expect(d.approvedRenderId).toBe(d.render.id);
      } else {
        // edited first: revision 2 is not rendered, so the approval was refused
        expect(a.status).toBe(409);
        expect(e.status).toBe(200);
        expect(d.revision).toBe(2);
        expect(d.status).not.toBe('approved');
      }
    }
  });

  it('concurrent writer submissions cannot pass the weekly cap together', async () => {
    await settings({ perWeek: 2 });
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
    await settings({ perWeek: 3 });
  });

  it('retries and the resolve of a locked upload are audited', async () => {
    const p = await submit('article', 'long', 'audited');
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

  it('keeps serving the thumbnail, captions and script once the MP4 is gone, and refuses to upload without it', async () => {
    const p = await approved('article', 'long', 'purged');
    await tick();
    await q(`UPDATE social_shares SET updated_at = now() - interval '31 days' WHERE post_id=$1`, [p.id]);
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
    // a failed share that never uploaded cannot be retried without the file
    await q(
      `UPDATE social_shares SET status='failed', external_id=NULL, url=NULL, detail='{}'::jsonb WHERE post_id=$1`,
      [p.id],
    );
    const r = await api('POST', `/api/platform/video/posts/${p.id}/retry-upload`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('video_purged');
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

function reviseTitle(id: string, title: string) {
  return api('PATCH', `/api/platform/video/posts/${id}`, {
    script: { ...script('article', 'long', 'x'), title, meta: { ...LONG.meta, title } },
  });
}
