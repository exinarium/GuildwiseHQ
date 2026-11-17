import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HASHTAG_POOLS, type VideoScript } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/auth/secrets.ts';
import { withTx } from '../src/db/tx.ts';
import { videoPostProjectors } from '../src/projections/video-posts.ts';
import {
  DestinationError,
  type DestinationIO,
  type DestinationOutcome,
  type DestinationPayload,
  IG_PROCESSING_ATTEMPTS,
  type TikTokCreatorInfo,
  type TikTokTokens,
  type VideoDestinationClient,
} from '../src/video/destinations.ts';
import { cleanupVideos, type RenderFn, resumeRerenders, videoTick, videoWatch } from '../src/video/sweep.ts';
import type { YouTubeClient } from '../src/video/youtube.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

type Step = 'ok' | 'auth' | 'retry' | 'final' | 'processing' | 'igfail';

/** Every destination at once, scripted per network. Nothing here reaches a real network. */
class FakeDestinations implements VideoDestinationClient {
  payloads: DestinationPayload[] = [];
  script: Record<string, Step[]> = {};
  resumed: Array<Record<string, unknown>> = [];
  exchanges: Array<{ code: string; redirectUri: string }> = [];
  refreshes: string[] = [];
  creator: TikTokCreatorInfo = {
    nickname: 'Guildwise',
    username: 'guildwisehq',
    avatarUrl: 'https://p16.tiktokcdn.test/a.jpg',
    privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    commentDisabled: false,
    duetDisabled: true,
    stitchDisabled: false,
    maxVideoPostDurationSec: 600,
  };
  igError = false;
  async publish(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
    this.payloads.push(p);
    this.resumed.push({ ...io.state });
    const step = this.script[p.network]?.shift() ?? 'ok';
    if (step === 'auth') throw new DestinationError('auth', 'HTTP 401: token expired');
    if (step === 'retry') throw new DestinationError('retry', 'HTTP 503: try later');
    if (step === 'final') throw new DestinationError('final', 'HTTP 400: the video is not acceptable');
    if (step === 'igfail')
      throw new DestinationError(
        'retry',
        'Instagram upload: HTTP 400: ProcessingFailedError',
        'ig_processing',
        IG_PROCESSING_ATTEMPTS,
      );
    if (step === 'processing') {
      io.state.stage = 'uploaded';
      await io.save();
      return { done: false, retryInMs: 60_000, note: `${p.network} is still processing the video` };
    }
    const n = this.payloads.filter((x) => x.network === p.network).length;
    return { done: true, externalId: `${p.network}-${n}`, url: `https://${p.network}.test/v/${n}` };
  }
  async tiktokCreatorInfo() {
    return this.creator;
  }
  async tiktokToken(
    grant: { code: string; redirectUri: string } | { refreshToken: string },
  ): Promise<TikTokTokens> {
    if ('code' in grant) this.exchanges.push(grant);
    else this.refreshes.push(grant.refreshToken);
    return {
      accessToken: `tt-access-${this.exchanges.length + this.refreshes.length}`,
      refreshToken: `tt-refresh-${this.exchanges.length + this.refreshes.length}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      openId: 'open-id-1',
    };
  }
  revoked: string[] = [];
  async tiktokRevoke(accessToken: string) {
    this.revoked.push(accessToken);
  }
  async instagramAccount(accountId: string) {
    if (this.igError) throw new DestinationError('final', 'Graph error 100: no such account');
    return { username: `ig_${accountId}` };
  }
  reset() {
    this.payloads = [];
    this.script = {};
    this.resumed = [];
    this.exchanges = [];
    this.refreshes = [];
    this.revoked = [];
    this.igError = false;
  }
}

/** Just enough YouTube to count as "connected": no test here uploads to it. */
const fakeYoutube = {
  accessToken: async () => 'access',
  channelMine: async () => ({ id: 'UC1', title: 'Guildwise HQ', verified: true }),
} as unknown as YouTubeClient;

const SHORT: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/video/test/fixtures/agents-short.json'),
    'utf8',
  ),
);
const shortScript = (ref: string): VideoScript => ({ ...SHORT, kind: 'article', ref });

const fakeRender: RenderFn = async (s, { outDir }) => {
  mkdirSync(outDir, { recursive: true });
  const f = (name: string, body: string) => {
    const p = join(outDir, name);
    writeFileSync(p, body);
    return p;
  };
  return {
    artifacts: {
      video: f('short.mp4', 'fake mp4 bytes'.repeat(100)),
      captionsVtt: f('captions.vtt', 'WEBVTT\n'),
      captionsSrt: f('captions.srt', '1\n'),
      thumb: null,
      script: f('script.json', JSON.stringify(s)),
      description: f('description.txt', s.meta.description),
      log: f('render.log', 'ok'),
    },
    durationSeconds: 45,
    bytes: 1400,
  };
};

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
let videoDir: string;
const dest = new FakeDestinations();
const mail = new CaptureMailer();
const api = (method: string, url: string, body?: unknown, cookie = sa.cookie) =>
  t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
const tick = () => videoTick(t.app.ctx, { render: fakeRender });
const post = (id: string) => ok(api('GET', `/api/platform/video/posts/${id}`));
const submit = (ref: string, extra: Record<string, unknown> = {}) =>
  ok(
    api('POST', '/api/platform/video/posts', {
      kind: 'article',
      format: 'short',
      ref,
      script: shortScript(ref),
      ...extra,
    }),
    201,
  );
const sched = (id: string, body: Record<string, unknown> = {}) =>
  api('POST', `/api/platform/video/posts/${id}/schedule`, body);
const TIKTOK_PRIVATE = {
  privacy: 'SELF_ONLY',
  allowComment: true,
  allowDuet: false,
  allowStitch: false,
  commercial: { on: false, yourBrand: false, brandedContent: false },
  consent: true,
};
/** The slot of the post has come (without moving the clock, which would end the test session). */
const slotComes = async (id: string) => {
  await q(`UPDATE video_posts SET slot_at = now() - interval '5 seconds' WHERE id=$1`, [id]);
  await q(
    `UPDATE social_shares SET next_attempt_at = now() - interval '5 seconds' WHERE post_id=$1 AND status='pending'`,
    [id],
  );
};
const shares = async (id: string) =>
  (await q('SELECT * FROM social_shares WHERE post_id=$1 ORDER BY network', [id])) as Array<
    Record<string, any>
  >;
const share = async (id: string, network: string) => (await shares(id)).find((s) => s.network === network);
const shortSettings = (over: Record<string, unknown> = {}) =>
  ok(
    api('PATCH', '/api/platform/video/settings', {
      enabled: true,
      schedule: {
        short: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], renderLeadHours: 168 },
        long: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], renderLeadHours: 168 },
      },
      ...over,
    }),
  );

const clean = async () => {
  await q('DELETE FROM social_shares');
  await q('DELETE FROM video_renders');
  await q('DELETE FROM video_posts');
  await q(`UPDATE social_channels SET status='ok', alerted_at=NULL`);
  await q(`DELETE FROM platform_settings WHERE key LIKE 'video_alert:%' OR key='video_cleanup_at'`);
  t.clock.setOffset(0);
  mail.sent = [];
  dest.reset();
  await shortSettings({ tiktokAudited: false });
};

beforeAll(async () => {
  videoDir = mkdtempSync(join(tmpdir(), 'video-rerender-'));
  t = await createTestApp({
    env: {
      AOM_VIDEO_DIR: videoDir,
      AOM_YOUTUBE_CLIENT_ID: 'cid',
      AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
      AOM_TIKTOK_CLIENT_KEY: 'tt-key',
      AOM_TIKTOK_CLIENT_SECRET: 'tt-secret',
    },
  });
  t.app.ctx.youtube = fakeYoutube;
  t.app.ctx.videoDestinations = dest;
  t.app.ctx.mailer = mail;
  sa = await t.superAdminSession();
  await shortSettings();
  await ok(
    api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }),
  );
  for (const [n, id] of [
    ['facebook', 'page-1'],
    ['linkedin', '5515715'],
    ['instagram', 'ig-17841'],
  ] as const)
    await ok(
      api('PUT', `/api/platform/social/channels/${n}`, {
        accountId: id,
        accountName: n,
        accessToken: `${n}-secret-token-0123456789`,
      }),
    );
  await ok(
    api('PUT', '/api/platform/social/channels/x', {
      apiKey: 'key12345',
      apiSecret: 'sssss12345',
      accessToken: 'atoken-12345',
      accessSecret: 'asecret',
      accountName: 'X',
    }),
  );
  await ok(
    api('PUT', '/api/platform/social/channels/bluesky', {
      handle: 'gw.bsky.social',
      appPassword: 'abcd-efgh-ijkl',
    }),
  );
  await q(
    `INSERT INTO social_channels (network, account_id, account_name, access_token, refresh_token, expires_at, status, connected_by, connected_at)
     VALUES ('tiktok','open-id-1','@guildwisehq',$1,$2,$3,'ok',$4,now())`,
    [
      await encryptSecret(t.app.ctx, 'tt-access-0'),
      await encryptSecret(t.app.ctx, 'tt-refresh-0'),
      new Date(Date.now() + 86_400_000),
      sa.id,
    ],
  );
});
afterAll(async () => {
  rmSync(videoDir, { recursive: true, force: true });
  await t.close();
  await closeAdminPool();
});
beforeEach(clean);

const rr = (id: string, network: string, cookie = sa.cookie) =>
  api('POST', `/api/platform/video/posts/${id}/shares/${network}/rerender`, undefined, cookie);
const renders = async (id: string) =>
  (await q('SELECT * FROM video_renders WHERE post_id=$1 ORDER BY revision', [id])) as Array<
    Record<string, any>
  >;
const instagramFiles = () => dest.payloads.filter((x) => x.network === 'instagram').map((x) => x.filePath);

/** A post posted to Facebook and Instagram; Instagram is refused by the network (failed). */
const refused = async (ref: string, step: 'igfail' | 'final' = 'igfail') => {
  dest.script.instagram = ['final'];
  const p = await submit(ref);
  await ok(sched(p.id, { destinations: ['facebook', 'instagram'], mode: 'now' }));
  await tick();
  if (step === 'igfail')
    await q(
      `UPDATE social_shares SET error='gave up after 5 attempts: Instagram upload: ProcessingFailedError' WHERE post_id=$1 AND network='instagram'`,
      [p.id],
    );
  expect((await share(p.id, 'instagram'))?.status).toBe('failed');
  expect((await share(p.id, 'facebook'))?.status).toBe('sent');
  dest.script.instagram = [];
  return p;
};

describe('render again and retry', () => {
  it('renders a new revision and retries only the refused destination with the new file', async () => {
    const p = await refused('rr-ok');
    const fb = await share(p.id, 'facebook');
    const fbCount = dest.payloads.filter((x) => x.network === 'facebook').length;
    const first = instagramFiles()[0];

    const res = await ok(rr(p.id, 'instagram'));
    expect(res.revision).toBe(2);
    expect(res.shares.find((s: { network: string }) => s.network === 'facebook').status).toBe('sent');
    expect((await renders(p.id)).map((r) => [r.revision, r.status])).toEqual([
      [1, 'rendered'],
      [2, 'queued'],
    ]);
    const marked = await share(p.id, 'instagram');
    expect(marked?.status).toBe('failed');
    expect(marked?.detail.rerender.revision).toBe(2);
    expect(await post(p.id)).toMatchObject({ shares: expect.any(Array) });

    await tick(); // renders revision 2 and resumes the destination
    await tick();
    const ig = await share(p.id, 'instagram');
    expect(ig?.status).toBe('sent');
    expect(ig?.detail.rerender).toBeUndefined();
    const files = instagramFiles();
    expect(files.at(-1)).toContain(`${p.id}/2/`);
    expect(files.at(-1)).not.toBe(first);
    // the published destination is untouched and was posted once
    const fb2 = await share(p.id, 'facebook');
    expect([fb2?.status, fb2?.url, fb2?.external_id]).toEqual([fb?.status, fb?.url, fb?.external_id]);
    expect(dest.payloads.filter((x) => x.network === 'facebook')).toHaveLength(fbCount);
    // the old render and file are kept
    const old = (await renders(p.id))[0];
    expect(old?.status).toBe('rendered');
    expect(old?.purged_at).toBeNull();
  });

  it('works the same for a destination that failed without a network rejection', async () => {
    const p = await refused('rr-final', 'final');
    await ok(rr(p.id, 'instagram'));
    await tick();
    await tick();
    expect((await share(p.id, 'instagram'))?.status).toBe('sent');
    expect(instagramFiles().at(-1)).toContain(`${p.id}/2/`);
  });

  it('refuses a destination that is not failed with 409 not_failed', async () => {
    const p = await refused('rr-notfailed');
    const sent = await rr(p.id, 'facebook');
    expect([sent.status, sent.body.error.code]).toEqual([409, 'not_failed']);
    const q2 = await submit('rr-pending');
    await ok(sched(q2.id, { destinations: ['x'], mode: 'slot' }));
    await tick();
    const pending = await rr(q2.id, 'x');
    expect([pending.status, pending.body.error.code]).toEqual([409, 'not_failed']);
    await q(`UPDATE social_shares SET status='skipped' WHERE post_id=$1 AND network='x'`, [q2.id]);
    expect((await rr(q2.id, 'x')).body.error.code).toBe('not_failed');
    expect(await renders(p.id)).toHaveLength(1);
  });

  it('refuses while a render is in progress and starts one render for two concurrent calls', async () => {
    const p = await refused('rr-concurrent');
    const both = await Promise.all([rr(p.id, 'instagram'), rr(p.id, 'instagram')]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)?.body.error.code).toBe('render_in_progress');
    expect(await renders(p.id)).toHaveLength(2);
    expect((await rr(p.id, 'instagram')).body.error.code).toBe('render_in_progress');
    expect(await renders(p.id)).toHaveLength(2);
  });

  it('keeps the destination failed with a reason when the new render fails, and Retry render resumes it', async () => {
    const p = await refused('rr-render-fails');
    const before = instagramFiles().length;
    await ok(rr(p.id, 'instagram'));
    await q(
      `UPDATE video_renders SET status='failed', attempts=3, error='the encoder crashed' WHERE post_id=$1 AND revision=2`,
      [p.id],
    );
    await tick();
    const ig = await share(p.id, 'instagram');
    expect(ig?.status).toBe('failed');
    expect(ig?.error).toMatch(/^the new render failed: the encoder crashed/);
    expect(instagramFiles()).toHaveLength(before);
    expect((await post(p.id)).render.status).toBe('failed');

    await ok(api('POST', `/api/platform/video/posts/${p.id}/retry-render`));
    await tick();
    await tick();
    expect((await share(p.id, 'instagram'))?.status).toBe('sent');
    expect(instagramFiles().at(-1)).toContain(`${p.id}/2/`);
  });

  it('is in the audit history and survives a projection rebuild', async () => {
    const p = await refused('rr-audit');
    await ok(rr(p.id, 'instagram'));
    const row = (
      await q(
        `SELECT summary, details FROM platform_audit_log WHERE action='VideoRetryRequested' ORDER BY seq DESC`,
      )
    )[0];
    expect(row?.details).toMatchObject({ what: 'rerender', network: 'instagram', revision: 2 });
    expect(row?.summary).toMatch(/rendered again.*instagram/);
    // a rebuild replays the event: the projector brings the revision back, and replaying it twice changes nothing
    // (the full rebuild is not run here: it refuses on tables of the hosted build that this database also has)
    await q('UPDATE video_posts SET revision=1 WHERE id=$1', [p.id]);
    const e = {
      createdAt: new Date(),
      event: {
        type: 'VideoRetryRequested',
        payload: { postId: p.id, what: 'rerender', by: sa.id, network: 'instagram', revision: 2 },
      },
    };
    for (let i = 0; i < 2; i++)
      await withTx(
        t.app.ctx.pool,
        (tx) => videoPostProjectors.VideoRetryRequested?.(tx, e as never) as Promise<void>,
      );
    expect((await q('SELECT revision FROM video_posts WHERE id=$1', [p.id]))[0]?.revision).toBe(2);
    // other retries never touch the revision
    await withTx(
      t.app.ctx.pool,
      (tx) =>
        videoPostProjectors.VideoRetryRequested?.(tx, {
          ...e,
          event: { ...e.event, payload: { postId: p.id, what: 'render', by: sa.id } },
        } as never) as Promise<void>,
    );
    expect((await q('SELECT revision FROM video_posts WHERE id=$1', [p.id]))[0]?.revision).toBe(2);
  });

  it('keeps the refusal record on the share when it resumes, so the new file is checked before it is sent', async () => {
    const p = await refused('rr-keeps-rejection');
    const old = (await renders(p.id))[0];
    const rejection = {
      kind: 'needs_rerender',
      artifact: { renderId: old?.id, finishedAt: new Date().toISOString(), bytes: 10 },
      rejections: 1,
      at: new Date().toISOString(),
      error: 'ProcessingFailedError',
      check: null,
    };
    await q(
      `UPDATE social_shares SET detail = COALESCE(detail,'{}'::jsonb) || jsonb_build_object('fileRejection', $2::jsonb)
        WHERE post_id=$1 AND network='instagram'`,
      [p.id, JSON.stringify(rejection)],
    );
    await ok(rr(p.id, 'instagram'));
    await q(`UPDATE video_renders SET status='rendered', finished_at=now() WHERE post_id=$1 AND revision=2`, [
      p.id,
    ]);
    await resumeRerenders(t.app.ctx);
    const ig = await share(p.id, 'instagram');
    expect(ig?.status).toBe('pending');
    expect(ig?.detail.rerender).toBeUndefined();
    expect(ig?.detail.fileRejection).toMatchObject({
      kind: 'needs_rerender',
      artifact: { renderId: old?.id },
    });
  });

  it('no longer has the post-level re-render route', async () => {
    const p = await refused('rr-old-route');
    const r = await api('POST', `/api/platform/video/posts/${p.id}/rerender`, undefined, sa.cookie);
    expect(r.status).toBe(404);
  });

  it('ignores an older re-render event that names no revision', async () => {
    const p = await refused('rr-old-event');
    const e = {
      createdAt: new Date(),
      event: { type: 'VideoRetryRequested', payload: { postId: p.id, what: 'rerender', by: sa.id } },
    };
    await withTx(
      t.app.ctx.pool,
      (tx) => videoPostProjectors.VideoRetryRequested?.(tx, e as never) as Promise<void>,
    );
    expect((await q('SELECT revision FROM video_posts WHERE id=$1', [p.id]))[0]?.revision).toBe(1);
  });

  it('keeps the old file while a re-render is waiting, then lets the superseded purge take it', async () => {
    const p = await refused('rr-purge');
    await ok(rr(p.id, 'instagram'));
    await q(
      `UPDATE video_renders SET finished_at = now() - interval '3 days' WHERE post_id=$1 AND revision=1`,
      [p.id],
    );
    await q(
      `UPDATE video_renders SET status='failed', attempts=3, error='x' WHERE post_id=$1 AND revision=2`,
      [p.id],
    );
    await tick();
    await cleanupVideos(t.app.ctx, { force: true });
    expect((await renders(p.id))[0]?.purged_at).toBeNull();
    await ok(api('POST', `/api/platform/video/posts/${p.id}/retry-render`));
    await tick();
    await tick();
    expect((await share(p.id, 'instagram'))?.detail.rerender).toBeUndefined();
    await cleanupVideos(t.app.ctx, { force: true });
    expect((await renders(p.id))[0]?.purged_at).not.toBeNull();
  });

  it('refuses a YouTube upload that is live (409 already_uploaded) but accepts a rejected one', async () => {
    const p = await refused('rr-youtube');
    await q(
      `INSERT INTO social_shares (post_id, network, source, status, attempts, error, detail, external_id, created_at, updated_at)
       VALUES ($1,'youtube','video','failed',3,'HTTP 500', '{"videoId":"abc"}'::jsonb,'abc', now(), now())
       ON CONFLICT DO NOTHING`,
      [p.id],
    );
    await q(
      `UPDATE social_shares SET status='failed', error='HTTP 500', detail='{"videoId":"abc"}'::jsonb WHERE post_id=$1 AND network='youtube'`,
      [p.id],
    );
    const live = await rr(p.id, 'youtube');
    expect([live.status, live.body.error.code]).toEqual([409, 'already_uploaded']);
    await q(
      `UPDATE social_shares SET detail='{"videoId":"abc","rejected":"duplicate"}'::jsonb WHERE post_id=$1 AND network='youtube'`,
      [p.id],
    );
    await ok(rr(p.id, 'youtube'));
    await tick();
    const yt = await share(p.id, 'youtube');
    expect(yt?.detail.videoId).toBeUndefined();
    expect(yt?.detail.rerender).toBeUndefined();
  });

  it('leaves the existing retry on the same revision and file', async () => {
    const p = await refused('rr-regression');
    await ok(api('POST', `/api/platform/video/posts/${p.id}/shares/instagram/retry`));
    await tick();
    expect((await renders(p.id)).map((r) => r.revision)).toEqual([1]);
    expect(instagramFiles().at(-1)).toContain(`${p.id}/1/`);
  });

  // last: the member session it creates would stop a projection rebuild in a later test
  it('answers 404 for an unknown post, destination or network, and for a member or no session', async () => {
    const p = await refused('rr-404');
    const unknownPost = await rr('3f2b8c1e-0000-4000-8000-000000000001', 'instagram');
    expect(unknownPost.status).toBe(404);
    expect((await rr(p.id, 'x')).status).toBe(404); // the post has no X destination
    expect((await rr(p.id, 'myspace')).status).toBe(404);
    const member = await t.userSession('member-rerender@example.com');
    expect((await rr(p.id, 'instagram', member.cookie)).status).toBe(404);
    expect((await rr(p.id, 'instagram', '')).status).toBe(404);
    expect(await renders(p.id)).toHaveLength(1);
  });
});
