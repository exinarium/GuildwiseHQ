import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VideoScript } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret, signingKey } from '../src/auth/secrets.ts';
import { slipVideoPost } from '../src/commands/video-posts.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import {
  DestinationError,
  type DestinationIO,
  type DestinationOutcome,
  type DestinationPayload,
  type TikTokCreatorInfo,
  type TikTokTokens,
  type VideoDestinationClient,
} from '../src/video/destinations.ts';
import { signedMediaUrl } from '../src/video/media-url.ts';
import { cleanupVideos, type RenderFn, videoTick, videoWatch } from '../src/video/sweep.ts';
import type { YouTubeClient } from '../src/video/youtube.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

type Step = 'ok' | 'auth' | 'retry' | 'final' | 'processing';

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
  videoDir = mkdtempSync(join(tmpdir(), 'video-dest-'));
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

describe('channels', () => {
  it('lists Instagram and TikTok as channels but keeps them out of the blog networks', async () => {
    const { SOCIAL_NETWORKS, SOCIAL_CHANNEL_NETWORKS } = await import('@aom/shared');
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('instagram');
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('tiktok');
    expect(SOCIAL_CHANNEL_NETWORKS as readonly string[]).toEqual(
      expect.arrayContaining(['instagram', 'tiktok']),
    );
    const list = await ok(api('GET', '/api/platform/social/channels'));
    const ig = list.channels.find((c: { network: string }) => c.network === 'instagram');
    expect(ig).toMatchObject({ connected: true, status: 'ok' });
    const row = (await q(`SELECT * FROM social_channels WHERE network='instagram'`))[0];
    expect(row?.access_token).not.toContain('secret-token');
  });

  it('checks the Instagram account with Instagram and refuses a pasted TikTok token', async () => {
    dest.igError = true;
    const bad = await api('PUT', '/api/platform/social/channels/instagram', {
      accountId: 'nope',
      accountName: '',
      accessToken: 'token-token-token-1',
    });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'bad_credentials']);
    const tt = await api('PUT', '/api/platform/social/channels/tiktok', {
      accountId: 'x',
      accountName: '',
      accessToken: 'token-token-token-1',
    });
    expect([tt.status, tt.body.error.code]).toEqual([400, 'use_oauth']);
  });

  it('the blog sweep never creates a share for Instagram or TikTok', async () => {
    const { socialTick } = await import('../src/commands/social.ts');
    await socialTick(t.app.ctx);
    const nets = (await q(`SELECT DISTINCT network FROM social_shares WHERE source <> 'video'`)).map(
      (r) => r.network,
    );
    expect(nets).not.toContain('instagram');
    expect(nets).not.toContain('tiktok');
  });
});

describe('posting at the slot', () => {
  it('creates a share per destination due at the slot, posts nothing before it and everything at it', async () => {
    const p = await submit('slot-timing');
    const s = await ok(
      sched(p.id, {
        destinations: ['facebook', 'instagram', 'x', 'linkedin', 'bluesky'],
        captions: { x: { text: 'Own X words', tags: ['agents'] } },
      }),
    );
    await tick();
    const rows0 = await shares(p.id);
    expect(rows0.map((r) => [r.network, r.status]).sort()).toEqual([
      ['bluesky', 'pending'],
      ['facebook', 'pending'],
      ['instagram', 'pending'],
      ['linkedin', 'pending'],
      ['x', 'pending'],
    ]);
    for (const r of rows0) expect(new Date(r.next_attempt_at).toISOString()).toBe(s.slotAt);
    await tick();
    expect(dest.payloads).toHaveLength(0); // the slot has not come
    expect((await post(p.id)).phase).toBe('rendered');

    await slotComes(p.id);
    await tick();
    await tick();
    expect(dest.payloads.map((x) => x.network).sort()).toEqual([
      'bluesky',
      'facebook',
      'instagram',
      'linkedin',
      'x',
    ]);
    const d = await post(p.id);
    expect(d.phase).toBe('published');
    expect(d.shares.map((x: { status: string }) => x.status)).toEqual(Array(5).fill('sent'));
    // the owner's X caption, no link; the others start from the defaults; nobody got a link
    const x = dest.payloads.find((a) => a.network === 'x');
    expect(x?.text).toContain('Own X words');
    for (const pl of dest.payloads) expect(pl.text).not.toMatch(/https?:\/\//);
    expect(dest.payloads.find((a) => a.network === 'facebook')?.text).toContain(SHORT.meta.title);
    // every destination sent: the MP4 goes (YouTube is not a destination here; the slot is not 6 h past, so verify via force)
    await q(`UPDATE video_posts SET slot_at = slot_at - interval '7 hours' WHERE id=$1`, [p.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(1);
    expect((await post(p.id)).render.files).not.toContain('video');
  });

  it('"publish now" posts as soon as the file exists', async () => {
    const p = await submit('publish-now');
    await ok(sched(p.id, { mode: 'now', destinations: ['facebook'] }));
    await tick();
    await tick();
    expect(dest.payloads.map((x) => x.network)).toEqual(['facebook']);
    expect((await share(p.id, 'facebook'))?.status).toBe('sent');
  });

  it("the caption chain: schedule edit over the drafter's submit caption over the default; unscheduling drops the edits", async () => {
    const p = await submit('captions-chain', {
      captions: {
        facebook: { text: 'Drafter Facebook', tags: ['ai'] },
        bluesky: { text: 'Drafter Bluesky', tags: [] },
      },
    });
    expect(p.captions).toMatchObject({ facebook: { text: 'Drafter Facebook' } });
    await ok(
      sched(p.id, {
        mode: 'now',
        destinations: ['facebook', 'bluesky', 'x'],
        captions: { bluesky: { text: 'Owner Bluesky', tags: [] } },
      }),
    );
    await tick();
    await tick();
    const text = (n: string) => dest.payloads.find((x) => x.network === n)?.text;
    expect(text('facebook')).toContain('Drafter Facebook');
    expect(text('bluesky')).toBe('Owner Bluesky');
    expect(text('x')).toContain(SHORT.meta.title);
    // a rebuild from the events gives the same captions and options
    const cols = 'id, captions, submit_captions, destination_options, destinations, slot_at';
    const before = await q(`SELECT ${cols} FROM video_posts WHERE id=$1`, [p.id]);
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await q(`SELECT ${cols} FROM video_posts WHERE id=$1`, [p.id])).toEqual(before);
  });

  it("unscheduling clears the schedule edits and the TikTok options; the drafter's captions stay", async () => {
    const p = await submit('unschedule-clears', { captions: { x: { text: 'Drafter X', tags: [] } } });
    await ok(
      sched(p.id, {
        destinations: ['x', 'tiktok'],
        captions: { x: { text: 'Owner X', tags: [] } },
        destinationOptions: { tiktok: TIKTOK_PRIVATE },
      }),
    );
    await ok(api('POST', `/api/platform/video/posts/${p.id}/unschedule`, {}));
    const back = await post(p.id);
    expect(back.status).toBe('in_review');
    expect(back.destinationOptions).toBeNull();
    expect(back.destinations).toEqual([]);
    expect(back.captions).toEqual({ x: { text: 'Drafter X', tags: [] } });
    // scheduling again without fresh TikTok consent is refused
    const again = await sched(p.id, { destinations: ['x', 'tiktok'] });
    expect([again.status, again.body.error.code]).toEqual([400, 'tiktok_options_required']);
    const rebuilt = await q('SELECT destination_options FROM video_posts WHERE id=$1', [p.id]);
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await q('SELECT destination_options FROM video_posts WHERE id=$1', [p.id])).toEqual(rebuilt);
  });

  it('moving a post moves the destinations that wait for the slot', async () => {
    const p = await submit('move-follows');
    const s = await ok(sched(p.id, { destinations: ['facebook'] }));
    await tick();
    const list = await ok(api('GET', '/api/platform/video/slots?format=short&count=20'));
    const other = list.slots.find(
      (x: { free: boolean; at: string }) => x.free && Date.parse(x.at) > Date.parse(s.slotAt) + 86_400_000,
    );
    await ok(api('POST', `/api/platform/video/posts/${p.id}/move`, { slotAt: other.at }));
    expect(new Date((await share(p.id, 'facebook'))?.next_attempt_at).toISOString()).toBe(other.at);
  });
});

describe('errors', () => {
  const setup = async (ref: string, destinations: string[]) => {
    const p = await submit(ref);
    const s = await ok(sched(p.id, { destinations, mode: 'now' }));
    await tick();
    return { p, s };
  };

  it('an auth error pauses the channel (needs_reconnect), mails once and posts after the reconnect', async () => {
    dest.script.x = ['auth'];
    const { p } = await setup('auth-error', ['x']);
    await tick();
    expect((await share(p.id, 'x'))?.status).toBe('pending');
    expect((await share(p.id, 'x'))?.error).toMatch(/token expired/);
    expect((await q(`SELECT status FROM social_channels WHERE network='x'`))[0]?.status).toBe(
      'needs_reconnect',
    );
    expect(mail.sent.filter((m) => /Posting videos to X/.test(m.subject))).toHaveLength(1);
    await tick(); // paused: not tried again
    expect(dest.payloads).toHaveLength(1);
    await ok(
      api('PUT', '/api/platform/social/channels/x', {
        apiKey: 'key12345',
        apiSecret: 'sssss12345',
        accessToken: 'atoken-new-1',
        accessSecret: 'asecret',
        accountName: 'X',
      }),
    );
    await tick();
    expect((await share(p.id, 'x'))?.status).toBe('sent');
  });

  it('a rate limit or 5xx backs off and retries; it gives up 6 hours after the slot with an alert', async () => {
    dest.script.linkedin = ['retry'];
    const { p, s } = await setup('retry-then-ok', ['linkedin']);
    await tick();
    const r1 = await share(p.id, 'linkedin');
    expect([r1?.status, r1?.attempts]).toEqual(['pending', 1]);
    expect(Date.parse(r1?.next_attempt_at) - Date.now()).toBeGreaterThan(30_000);
    await tick();
    expect(dest.payloads).toHaveLength(1); // the back-off holds
    t.clock.advance(61_000);
    await tick();
    expect((await share(p.id, 'linkedin'))?.status).toBe('sent');

    // a destination that never recovers: back-off up to slot + 6 h, then failed + an alert
    dest.script.bluesky = Array(30).fill('retry');
    const q2 = await submit('retry-forever');
    const s2 = await ok(sched(q2.id, { destinations: ['bluesky'], mode: 'now' }));
    await tick();
    for (let i = 0; i < 12; i++) {
      t.clock.advance(3_600_000);
      await tick();
      if ((await share(q2.id, 'bluesky'))?.status === 'failed') break;
    }
    const f = await share(q2.id, 'bluesky');
    expect(f?.status).toBe('failed');
    expect(f?.error).toMatch(/gave up 6 hours after the slot/);
    expect(mail.sent.filter((m) => /Posting videos to Bluesky/.test(m.subject))).toHaveLength(1);
    expect(s.id).toBe(p.id);
    expect(s2.id).toBe(q2.id);
  });

  it('a processing destination is polled again later without counting as a failure', async () => {
    dest.script.instagram = ['processing'];
    const { p } = await setup('processing', ['instagram']);
    await tick();
    const mid = await share(p.id, 'instagram');
    expect([mid?.status, mid?.attempts]).toEqual(['pending', 0]);
    expect(mid?.detail.dest).toEqual({ stage: 'uploaded' });
    t.clock.advance(61_000);
    await tick();
    expect(dest.resumed.at(-1)).toEqual({ stage: 'uploaded' }); // resumed, not started again
    expect((await share(p.id, 'instagram'))?.status).toBe('sent');
  });

  it('partial: one destination fails for good, the others are sent; the retry route posts the failed one', async () => {
    dest.script.facebook = ['final'];
    const { p } = await setup('partial', ['facebook', 'x']);
    await tick();
    await tick();
    let d = await post(p.id);
    expect(d.phase).toBe('partial');
    expect(d.shares.find((x: { network: string }) => x.network === 'facebook')).toMatchObject({
      status: 'failed',
    });
    // a failed destination keeps the MP4 (no purge while one is failed)
    await q(`UPDATE video_posts SET slot_at = slot_at - interval '7 hours' WHERE id=$1`, [p.id]);
    expect(await cleanupVideos(t.app.ctx, { force: true })).toBe(0);
    // not for a member, not for a destination that is not failed
    const member = await t.userSession('member-retry@example.com');
    expect(
      (await api('POST', `/api/platform/video/posts/${p.id}/shares/facebook/retry`, undefined, member.cookie))
        .status,
    ).toBe(404);
    const notFailed = await api('POST', `/api/platform/video/posts/${p.id}/shares/x/retry`);
    expect([notFailed.status, notFailed.body.error.code]).toEqual([409, 'not_failed']);
    const noDest = await api('POST', `/api/platform/video/posts/${p.id}/shares/bluesky/retry`);
    expect(noDest.status).toBe(404);
    await ok(api('POST', `/api/platform/video/posts/${p.id}/shares/facebook/retry`));
    await tick();
    d = await post(p.id);
    expect(d.shares.map((x: { status: string }) => x.status)).toEqual(['sent', 'sent']);
    expect(d.phase).toBe('published');
  });

  it('a retry of a destination whose MP4 was cleaned up renders the same revision again', async () => {
    dest.script.facebook = ['final'];
    const { p } = await setup('retry-rerender', ['facebook']);
    await tick();
    await q(`UPDATE video_renders SET artifacts = artifacts - 'video', purged_at = now() WHERE post_id=$1`, [
      p.id,
    ]);
    await ok(api('POST', `/api/platform/video/posts/${p.id}/shares/facebook/retry`));
    expect((await q('SELECT status FROM video_renders WHERE post_id=$1', [p.id]))[0]?.status).toBe('queued');
    await tick();
    await tick();
    expect((await share(p.id, 'facebook'))?.status).toBe('sent');
  });

  it('waits for a missing video file ("waiting for the video file") and then posts', async () => {
    const { p } = await setup('waiting-file', ['facebook']);
    // back to "not posted yet" (the first tick already posted it)
    await q(
      `UPDATE social_shares SET status='pending', next_attempt_at=now(), external_id=NULL, url=NULL WHERE post_id=$1`,
      [p.id],
    );
    const render = (await q('SELECT artifacts FROM video_renders WHERE post_id=$1', [p.id]))[0] as {
      artifacts: { video: string };
    };
    const file = join(videoDir, render.artifacts.video);
    const bytes = readFileSync(file);
    rmSync(file);
    await tick();
    expect((await share(p.id, 'facebook'))?.error).toBe('waiting for the video file');
    writeFileSync(file, bytes);
    t.clock.advance(61_000);
    await tick();
    expect((await share(p.id, 'facebook'))?.status).toBe('sent');
  });
});

describe('TikTok', () => {
  it('refuses to schedule without options, and a public post while the app is not audited', async () => {
    const p = await submit('tt-refuse');
    const none = await sched(p.id, { destinations: ['tiktok'] });
    expect([none.status, none.body.error.code]).toEqual([400, 'tiktok_options_required']);
    // the schedule's own destinations include TikTok by default: omitting `destinations` is refused too
    await ok(
      api('PATCH', '/api/platform/video/settings', {
        schedule: { short: { destinations: ['youtube', 'tiktok'] } },
      }),
    );
    const dflt = await sched(p.id, {});
    expect([dflt.status, dflt.body.error.code]).toEqual([400, 'tiktok_options_required']);
    await ok(
      api('PATCH', '/api/platform/video/settings', { schedule: { short: { destinations: ['youtube'] } } }),
    );
    const pub = await sched(p.id, {
      destinations: ['tiktok'],
      destinationOptions: { tiktok: { ...TIKTOK_PRIVATE, privacy: 'PUBLIC_TO_EVERYONE' } },
    });
    expect([pub.status, pub.body.error.code]).toEqual([400, 'tiktok_not_audited']);
    const noConsent = await sched(p.id, {
      destinations: ['tiktok'],
      destinationOptions: { tiktok: { ...TIKTOK_PRIVATE, consent: false } },
    });
    expect(noConsent.status).toBe(400);
  });

  it('posts SELF_ONLY with the signed media URL and the chosen toggles; a public post once audited', async () => {
    const p = await submit('tt-private');
    await ok(
      sched(p.id, { mode: 'now', destinations: ['tiktok'], destinationOptions: { tiktok: TIKTOK_PRIVATE } }),
    );
    await tick();
    await tick();
    const pl = dest.payloads[0];
    expect(pl?.tiktok?.options).toMatchObject({ privacy: 'SELF_ONLY', allowComment: true });
    expect(pl?.tiktok?.videoUrl).toMatch(
      /^http:\/\/aom\.test\/api\/public\/video-media\/[0-9a-f-]{36}\/\d+\/[\w-]+\/video\.mp4$/,
    );
    expect(pl?.text).not.toMatch(/https?:\/\//);
    expect(pl?.credentials).toBe('tt-access-0');
    expect((await share(p.id, 'tiktok'))?.status).toBe('sent');

    await ok(api('PATCH', '/api/platform/video/settings', { tiktokAudited: true }));
    const p2 = await submit('tt-public');
    await ok(
      sched(p2.id, {
        mode: 'now',
        destinations: ['tiktok'],
        destinationOptions: { tiktok: { ...TIKTOK_PRIVATE, privacy: 'PUBLIC_TO_EVERYONE' } },
      }),
    );
    await tick();
    await tick();
    expect((await share(p2.id, 'tiktok'))?.status).toBe('sent');
  });

  it('the worker itself refuses a TikTok post without options or with a public choice while unaudited', async () => {
    const p = await submit('tt-worker-refuse');
    await ok(
      sched(p.id, { mode: 'now', destinations: ['tiktok'], destinationOptions: { tiktok: TIKTOK_PRIVATE } }),
    );
    await q('UPDATE video_posts SET destination_options = NULL WHERE id=$1', [p.id]);
    await tick();
    await tick();
    const f = await share(p.id, 'tiktok');
    expect(f?.status).toBe('failed');
    expect(f?.error).toMatch(/options the owner chose/);
    expect(dest.payloads).toHaveLength(0);
    expect(mail.sent.filter((m) => /Posting videos to TikTok/.test(m.subject))).toHaveLength(1);

    const p2 = await submit('tt-worker-public');
    await ok(
      sched(p2.id, { mode: 'now', destinations: ['tiktok'], destinationOptions: { tiktok: TIKTOK_PRIVATE } }),
    );
    await q(
      `UPDATE video_posts SET destination_options = jsonb_set(destination_options, '{tiktok,privacy}', '"PUBLIC_TO_EVERYONE"') WHERE id=$1`,
      [p2.id],
    );
    await tick();
    await tick();
    expect((await share(p2.id, 'tiktok'))?.error).toMatch(/not passed its audit/);
    expect(dest.payloads).toHaveLength(0);
  });

  it('renews the access token before it ends and stores the rotated refresh token', async () => {
    await q(`UPDATE social_channels SET expires_at = now() + interval '5 minutes' WHERE network='tiktok'`);
    const p = await submit('tt-refresh');
    await ok(
      sched(p.id, { mode: 'now', destinations: ['tiktok'], destinationOptions: { tiktok: TIKTOK_PRIVATE } }),
    );
    await tick();
    await tick();
    expect(dest.refreshes).toEqual(['tt-refresh-0']);
    expect(dest.payloads[0]?.credentials).toBe('tt-access-1');
    const { decryptSecret } = await import('../src/auth/secrets.ts');
    const row = (await q(`SELECT refresh_token FROM social_channels WHERE network='tiktok'`))[0];
    expect(await decryptSecret(t.app.ctx, row?.refresh_token)).toBe('tt-refresh-1');
  });

  it('creator-info has the shape the web reads; 404 not connected; 400 not configured; unaudited offers only SELF_ONLY', async () => {
    const c = await ok(api('GET', '/api/platform/social/tiktok/creator-info'));
    expect(c).toEqual({
      nickname: 'Guildwise',
      username: 'guildwisehq',
      avatarUrl: 'https://p16.tiktokcdn.test/a.jpg',
      privacyLevelOptions: ['SELF_ONLY'],
      commentDisabled: false,
      duetDisabled: true,
      stitchDisabled: false,
      maxVideoPostDurationSec: 600,
      canPost: true,
      audited: false,
    });
    await ok(api('PATCH', '/api/platform/video/settings', { tiktokAudited: true }));
    expect((await ok(api('GET', '/api/platform/social/tiktok/creator-info'))).privacyLevelOptions).toEqual([
      'PUBLIC_TO_EVERYONE',
      'MUTUAL_FOLLOW_FRIENDS',
      'SELF_ONLY',
    ]);
    const member = await t.userSession('member-creator@example.com');
    expect(
      (await api('GET', '/api/platform/social/tiktok/creator-info', undefined, member.cookie)).status,
    ).toBe(404);
    const saved = (await q(`SELECT * FROM social_channels WHERE network='tiktok'`))[0];
    await q(`DELETE FROM social_channels WHERE network='tiktok'`);
    expect((await api('GET', '/api/platform/social/tiktok/creator-info')).status).toBe(404);
    await q(
      `INSERT INTO social_channels (network, account_id, account_name, access_token, refresh_token, expires_at, status, connected_by, connected_at)
       VALUES ('tiktok',$1,$2,$3,$4,$5,'ok',$6,now())`,
      [
        saved?.account_id,
        saved?.account_name,
        saved?.access_token,
        saved?.refresh_token,
        saved?.expires_at,
        saved?.connected_by,
      ],
    );
  });

  it('connect redirects to TikTok with a server-side state; the callback stores encrypted tokens; a bad state is refused', async () => {
    const r = await api('GET', '/api/platform/social/tiktok/connect');
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.origin + loc.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(loc.searchParams.get('client_key')).toBe('tt-key');
    expect(loc.searchParams.get('scope')).toBe('user.info.basic,video.publish');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://aom.test/api/platform/social/tiktok/callback');
    const state = loc.searchParams.get('state') as string;
    await q(`DELETE FROM social_channels WHERE network='tiktok'`);
    const cb = await api('GET', `/api/platform/social/tiktok/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('tiktok=connected');
    expect(dest.exchanges).toEqual([
      { code: 'abc', redirectUri: 'http://aom.test/api/platform/social/tiktok/callback' },
    ]);
    const row = (await q(`SELECT * FROM social_channels WHERE network='tiktok'`))[0];
    expect(row).toMatchObject({ account_id: 'open-id-1', account_name: '@guildwisehq', status: 'ok' });
    expect(row?.access_token).not.toContain('tt-access');
    // the state is single-use
    const again = await api('GET', `/api/platform/social/tiktok/callback?code=abc&state=${state}`);
    expect(again.headers.location).toContain('tiktok=error');
    const forged = await api('GET', '/api/platform/social/tiktok/callback?code=abc&state=forged');
    expect(forged.headers.location).toContain('tiktok=error');
    const member = await t.userSession('member-tt@example.com');
    expect((await api('GET', '/api/platform/social/tiktok/connect', undefined, member.cookie)).status).toBe(
      404,
    );
  });
});

describe('the signed media URL', () => {
  const ready = async (ref: string) => {
    const p = await submit(ref);
    await ok(sched(p.id, { mode: 'now', destinations: ['facebook'] }));
    await tick();
    const render = (await q('SELECT id FROM video_renders WHERE post_id=$1', [p.id]))[0];
    const url = new URL(await signedMediaUrl(t.app.ctx, render?.id));
    return { p, id: render?.id as string, path: url.pathname };
  };

  it('serves the MP4 with Range, no-store and noindex; HEAD works; no redirects', async () => {
    const { path } = await ready('media-ok');
    const full = await t.req('GET', path);
    expect(full.status).toBe(200);
    expect(full.headers['cache-control']).toBe('no-store');
    expect(full.headers['x-robots-tag']).toMatch(/noindex/);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('video/mp4');
    const part = await t.req('GET', path, { headers: { range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toMatch(/^bytes 0-9\/1400$/);
    const head = await t.req('HEAD', path);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('1400');
  });

  it('is 404 for a bad signature, an expired link, a link that lives too long, a purged render and an unscheduled post', async () => {
    const { p, id, path } = await ready('media-404');
    const parts = path.split('/');
    const bad = [...parts];
    bad[5] = `${parts[5]?.slice(0, -1)}${parts[5]?.endsWith('A') ? 'B' : 'A'}`;
    expect((await t.req('GET', bad.join('/'))).status).toBe(404);
    const other = [...parts];
    other[4] = String(Number(parts[4]) + 1);
    expect((await t.req('GET', other.join('/'))).status).toBe(404); // another exp, same signature
    // a correctly signed link that would live 3 hours is refused
    const exp = Math.floor(Date.now() / 1000) + 3 * 3600;
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', await signingKey(t.app.ctx, 'video-media'))
      .update(`video-media|${id}|${exp}`)
      .digest('base64url');
    expect((await t.req('GET', `/api/public/video-media/${id}/${exp}/${sig}/video.mp4`)).status).toBe(404);
    // expired
    t.clock.advance(3 * 3600_000);
    expect((await t.req('GET', path)).status).toBe(404);
    t.clock.setOffset(0);
    expect((await t.req('GET', path)).status).toBe(200);
    // purged
    await q(`UPDATE video_renders SET purged_at = now() WHERE id=$1`, [id]);
    expect((await t.req('GET', path)).status).toBe(404);
    await q(`UPDATE video_renders SET purged_at = NULL WHERE id=$1`, [id]);
    // not approved any more
    await q(`UPDATE video_posts SET status='in_review' WHERE id=$1`, [p.id]);
    expect((await t.req('GET', path)).status).toBe(404);
  });
});

describe('review fixes', () => {
  it('two concurrent slips of one post move it once and alert once', async () => {
    const p = await submit('double-slip');
    const s = await ok(sched(p.id, {}));
    // the slot is 20 minutes away and the post is not rendered
    await q(`UPDATE video_posts SET slot_at = now() + interval '20 minutes' WHERE id=$1`, [p.id]);
    await q(`DELETE FROM video_renders WHERE post_id=$1`, [p.id]);
    const [a, b] = await Promise.all([videoWatch(t.app.ctx), videoWatch(t.app.ctx)]);
    expect(a.slipped + b.slipped).toBe(1);
    expect(mail.sent.filter((m) => /missed its slot/.test(m.subject))).toHaveLength(1);
    const events = await q(
      `SELECT count(*)::int AS n FROM events WHERE stream_id=$1 AND type='VideoPostScheduled' AND payload->>'reason'='slipped'`,
      [`video-${p.id}`],
    );
    expect(events[0]?.n).toBe(1);
    // slipping again right away does nothing: the new slot is not due
    expect(await slipVideoPost(t.app.ctx, p.id)).toBeNull();
    expect(s.id).toBe(p.id);
  });

  it('a TikTok post of a re-flowed schedule keeps its options (the move events carry none)', async () => {
    const p = await submit('options-kept');
    const s = await ok(
      sched(p.id, { destinations: ['tiktok'], destinationOptions: { tiktok: TIKTOK_PRIVATE } }),
    );
    const list = await ok(api('GET', '/api/platform/video/slots?format=short&count=20'));
    const other = list.slots.find(
      (x: { free: boolean; at: string }) => x.free && Date.parse(x.at) > Date.parse(s.slotAt) + 86_400_000,
    );
    await ok(api('POST', `/api/platform/video/posts/${p.id}/move`, { slotAt: other.at }));
    expect((await post(p.id)).destinationOptions?.tiktok?.privacy).toBe('SELF_ONLY');
  });

  it('re-flow does not move posts that are on a slot of the schedule (no compacting of gaps)', async () => {
    const a = await submit('rf-a');
    const b = await submit('rf-b');
    const sa1 = await ok(sched(a.id, { destinations: ['facebook'] }));
    const list = await ok(api('GET', '/api/platform/video/slots?format=short&count=30'));
    const later = list.slots.find(
      (x: { free: boolean; at: string }) =>
        x.free && Date.parse(x.at) > Date.parse(sa1.slotAt) + 3 * 86_400_000,
    );
    await ok(sched(b.id, { destinations: ['facebook'], slotAt: later.at }));
    await ok(api('PATCH', '/api/platform/video/settings', { schedule: { short: { renderLeadHours: 1 } } }));
    const out = await ok(api('POST', '/api/platform/video/reflow'));
    expect(out.moved).toBe(0);
    expect((await post(b.id)).slotAt).toBe(later.at);
  });

  it('move uses the normal minimum lead time', async () => {
    const p = await submit('move-lead');
    await ok(sched(p.id, { destinations: ['facebook'] }));
    const soon = (await ok(api('GET', '/api/platform/video/slots?format=short&count=20'))).slots.find(
      (x: { free: boolean; at: string }) =>
        x.free && Date.parse(x.at) > Date.now() && Date.parse(x.at) < Date.now() + 3_300_000,
    );
    if (soon) {
      const r = await api('POST', `/api/platform/video/posts/${p.id}/move`, { slotAt: soon.at });
      expect([r.status, r.body.error.code]).toEqual([409, 'slot_too_soon']);
    }
  });
});

describe('a destination with saved progress has started', () => {
  const started = async (ref: string, network = 'x') => {
    dest.script[network] = ['processing'];
    const p = await submit(ref);
    const s = await ok(sched(p.id, { mode: 'now', destinations: [network] }));
    await tick();
    await tick();
    return { p, s };
  };

  it('unschedule, move and slip are refused while a pending share holds progress (no duplicate on reschedule)', async () => {
    const { p } = await started('progress-pending');
    const sh = await share(p.id, 'x');
    expect([sh?.status, sh?.detail.dest]).toEqual(['pending', { stage: 'uploaded' }]);
    const un = await api('POST', `/api/platform/video/posts/${p.id}/unschedule`, {});
    expect([un.status, un.body.error.code]).toEqual([409, 'already_started']);
    expect((await share(p.id, 'x'))?.detail.dest).toEqual({ stage: 'uploaded' }); // the share was not deleted
    // a Move would lose the progress too (mode "now" cannot move; a slotted post is checked through the same test)
    await q(
      `UPDATE video_posts SET publish_mode='slot', slot_at = now() + interval '10 minutes' WHERE id=$1`,
      [p.id],
    );
    const list = await ok(api('GET', '/api/platform/video/slots?format=short&count=20'));
    const free = list.slots.find(
      (x: { free: boolean; at: string }) => x.free && Date.parse(x.at) > Date.now() + 86_400_000,
    );
    const mv = await api('POST', `/api/platform/video/posts/${p.id}/move`, { slotAt: free.at });
    expect([mv.status, mv.body.error.code]).toEqual([409, 'already_started']);
    // not slipped either
    expect(await slipVideoPost(t.app.ctx, p.id)).toBeNull();
    // and a re-flow leaves it
    await ok(
      api('PATCH', '/api/platform/video/settings', {
        schedule: { short: { days: ['mon'], renderLeadHours: 1 } },
      }),
    );
    expect((await ok(api('POST', '/api/platform/video/reflow'))).moved).toBe(0);
  });

  it('the same after the stale-posting reset', async () => {
    const { p } = await started('progress-stale');
    await q(
      `UPDATE social_shares SET status='posting', updated_at = now() - interval '2 hours' WHERE post_id=$1`,
      [p.id],
    );
    await tick(); // the stale claim goes back to pending
    const un = await api('POST', `/api/platform/video/posts/${p.id}/unschedule`, {});
    expect([un.status, un.body.error.code]).toEqual([409, 'already_started']);
  });

  it('an unscheduled post whose share had no progress still goes back to review', async () => {
    const p = await submit('no-progress');
    await ok(sched(p.id, { destinations: ['x'] }));
    await tick();
    expect((await share(p.id, 'x'))?.status).toBe('pending');
    expect((await ok(api('POST', `/api/platform/video/posts/${p.id}/unschedule`, {}))).status).toBe(
      'in_review',
    );
  });

  it("a retry keeps TikTok's publish id and drops the saved progress of the others", async () => {
    const p = await submit('retry-progress');
    await ok(
      sched(p.id, {
        mode: 'now',
        destinations: ['tiktok', 'facebook'],
        destinationOptions: { tiktok: TIKTOK_PRIVATE },
      }),
    );
    await tick();
    await q(
      `UPDATE social_shares SET status='failed', detail = '{"dest":{"ttPublishId":"p-old","finalAttemptAt":"x"}}'::jsonb WHERE post_id=$1 AND network='tiktok'`,
      [p.id],
    );
    await q(
      `UPDATE social_shares SET status='failed', detail = '{"dest":{"fbVideoId":"v1"}}'::jsonb WHERE post_id=$1 AND network='facebook'`,
      [p.id],
    );
    await ok(api('POST', `/api/platform/video/posts/${p.id}/shares/tiktok/retry`));
    await ok(api('POST', `/api/platform/video/posts/${p.id}/shares/facebook/retry`));
    expect((await share(p.id, 'tiktok'))?.detail.dest).toEqual({ ttPublishId: 'p-old' }); // the ambiguity marker is cleared
    expect((await share(p.id, 'facebook'))?.detail.dest).toBeUndefined();
  });
});

describe('TikTok token, state and disconnect', () => {
  it('two renewals at once spend the refresh token once', async () => {
    const { freshTiktokToken } = await import('../src/commands/tiktok.ts');
    await q(`UPDATE social_channels SET expires_at = now() + interval '1 minute' WHERE network='tiktok'`);
    const row = (await q(`SELECT * FROM social_channels WHERE network='tiktok'`))[0];
    const [a, b] = await Promise.all([
      freshTiktokToken(t.app.ctx, row as never),
      freshTiktokToken(t.app.ctx, row as never),
    ]);
    expect(dest.refreshes).toHaveLength(1);
    expect(a).toBe(b);
    expect((await q(`SELECT status FROM social_channels WHERE network='tiktok'`))[0]?.status).toBe('ok');
  });

  it('a callback state works once, also when two callbacks arrive together; old states are purged', async () => {
    const loc = new URL((await api('GET', '/api/platform/social/tiktok/connect')).headers.location);
    const state = loc.searchParams.get('state') as string;
    const [x, y] = await Promise.all([
      api('GET', `/api/platform/social/tiktok/callback?code=a&state=${state}`),
      api('GET', `/api/platform/social/tiktok/callback?code=b&state=${state}`),
    ]);
    const results = [x.headers.location, y.headers.location].map((l) =>
      new URL(l).searchParams.get('tiktok'),
    );
    expect(results.sort()).toEqual(['connected', 'error']);
    expect(dest.exchanges).toHaveLength(1);
    // a state nobody came back with is removed by the next connect
    await q(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('tiktok_oauth_state:old','{}'::jsonb,NULL, now() - interval '1 hour')`,
    );
    await api('GET', '/api/platform/social/tiktok/connect');
    expect(await q(`SELECT 1 FROM platform_settings WHERE key='tiktok_oauth_state:old'`)).toHaveLength(0);
  });

  it('disconnecting TikTok revokes the token', async () => {
    const saved = (await q(`SELECT * FROM social_channels WHERE network='tiktok'`))[0];
    await ok(api('DELETE', '/api/platform/social/channels/tiktok'));
    expect(dest.revoked).toHaveLength(1);
    await q(
      `INSERT INTO social_channels (network, account_id, account_name, access_token, refresh_token, expires_at, status, connected_by, connected_at)
       VALUES ('tiktok',$1,$2,$3,$4,$5,'ok',$6,now())`,
      [
        saved?.account_id,
        saved?.account_name,
        saved?.access_token,
        saved?.refresh_token,
        saved?.expires_at,
        saved?.connected_by,
      ],
    );
  });
});

describe('captions', () => {
  it("an empty schedule caption falls through to the drafter's; a link typed into an X or TikTok caption is taken out", async () => {
    const p = await submit('caption-fallthrough', {
      captions: {
        facebook: { text: 'Drafter Facebook', tags: [] },
        x: { text: 'Own words https://evil.example.com/x and www.spam.test more', tags: [] },
      },
    });
    await ok(
      sched(p.id, {
        mode: 'now',
        destinations: ['facebook', 'x'],
        captions: { facebook: { text: '   ', tags: [] } },
      }),
    );
    await tick();
    await tick();
    const text = (n: string) => dest.payloads.find((x) => x.network === n)?.text;
    expect(text('facebook')).toBe('Drafter Facebook');
    expect(text('x')).toBe('Own words and more');
  });
});
