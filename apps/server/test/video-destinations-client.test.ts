import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createVideoDestinationClient,
  DestinationError,
  type DestinationIO,
  type DestinationPayload,
} from '../src/video/destinations.ts';

/**
 * The real destination client against a scripted `fetch`: the order of the calls, the URLs, headers and bodies each
 * network documents, and how errors are classified. Nothing leaves the process.
 */
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; text?: string };
// biome-ignore lint/suspicious/noExplicitAny: a scripted answer per test
let router: (c: Call) => any;
let dir: string;
let file: string;

const headersOf = (h: ConstructorParameters<typeof Headers>[0] | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dest-client-'));
  file = join(dir, 'short.mp4');
  writeFileSync(file, Buffer.alloc(200 * 1024, 7));
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: headersOf(init.headers),
      body: init.body,
    };
    calls.push(call);
    const r = router(call);
    if (!r) return new Response('unexpected call', { status: 599 });
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  calls = [];
});

const client = createVideoDestinationClient();
const io = (state: Record<string, unknown> = {}): DestinationIO & { saved: number } => {
  const o = {
    state,
    saved: 0,
    async save() {
      o.saved++;
    },
    async sleep() {},
  };
  return o;
};
const payload = (
  network: DestinationPayload['network'],
  over: Partial<DestinationPayload> = {},
): DestinationPayload => ({
  network,
  accountId: 'acct-1',
  credentials: 'the-token',
  filePath: file,
  bytes: 200 * 1024,
  durationSeconds: 45,
  text: 'Caption #ai',
  facets: [],
  title: 'A title',
  ...over,
});
const path = (c: Call) => new URL(c.url).pathname;

describe('Facebook Page Reels', () => {
  it('start, binary upload to rupload with the file size, finish PUBLISHED with the caption', async () => {
    router = (c) => {
      if (c.url.includes('/video_reels') && String(c.body).includes('upload_phase=start'))
        return { json: { video_id: 'v1', upload_url: 'u' } };
      if (c.url.startsWith('https://rupload.facebook.com/video-upload/')) return { json: { success: true } };
      if (c.url.includes('/v1?fields=status')) return { json: { status: { video_status: 'ready' } } };
      if (c.url.includes('/video_reels')) return { json: { success: true } };
      return undefined;
    };
    const out = await client.publish(payload('facebook'), io());
    expect(out).toEqual({ done: true, externalId: 'v1', url: 'https://www.facebook.com/reel/v1' });
    const up = calls.find((c) => c.url.startsWith('https://rupload.facebook.com'));
    expect(up?.url).toBe('https://rupload.facebook.com/video-upload/v26.0/v1');
    expect(up?.headers).toMatchObject({
      authorization: 'OAuth the-token',
      offset: '0',
      file_size: String(200 * 1024),
    });
    const fin = calls.at(-1);
    expect(path(fin as Call)).toBe('/v26.0/acct-1/video_reels');
    const form = new URLSearchParams(String(fin?.body));
    expect(Object.fromEntries(form)).toMatchObject({
      video_id: 'v1',
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: 'Caption #ai',
    });
  });

  it('resumes: a saved video id and upload are not repeated', async () => {
    router = (c) =>
      c.url.includes('/video_reels')
        ? { json: { success: true } }
        : { json: { status: { video_status: 'ready' } } };
    await client.publish(payload('facebook'), io({ fbVideoId: 'v9', fbUploaded: true }));
    expect(calls.some((c) => c.url.startsWith('https://rupload'))).toBe(false);
  });

  it('classifies Graph errors: 190 is the token, 613 a rate limit, 100 final', async () => {
    for (const [code, kind] of [
      [190, 'auth'],
      [613, 'retry'],
      [100, 'final'],
    ] as const) {
      router = () => ({ status: 400, json: { error: { code, message: 'x' } } });
      await expect(client.publish(payload('facebook'), io())).rejects.toMatchObject({ kind });
    }
    router = () => ({ status: 503, text: 'down' });
    await expect(client.publish(payload('facebook'), io())).rejects.toMatchObject({ kind: 'retry' });
  });
});

describe('Instagram Reels', () => {
  it('resumable container, binary upload, status poll, media_publish', async () => {
    let polls = 0;
    router = (c) => {
      if (path(c).endsWith('/ig-1/media')) return { json: { id: 'c1' } };
      if (c.url.startsWith('https://rupload.facebook.com/ig-api-upload/v26.0/c1'))
        return { json: { success: true } };
      if (c.url.includes('/c1?fields=status_code'))
        return { json: { status_code: ++polls < 2 ? 'IN_PROGRESS' : 'FINISHED' } };
      if (path(c).endsWith('/ig-1/media_publish')) return { json: { id: 'm1' } };
      if (c.url.includes('/m1?fields=permalink'))
        return { json: { permalink: 'https://www.instagram.com/reel/abc/' } };
      return undefined;
    };
    const out = await client.publish(payload('instagram', { accountId: 'ig-1' }), io());
    expect(out).toEqual({ done: true, externalId: 'm1', url: 'https://www.instagram.com/reel/abc/' });
    const create = new URLSearchParams(String(calls[0]?.body));
    expect(Object.fromEntries(create)).toMatchObject({
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: 'Caption #ai',
    });
  });

  it('still processing after the polls: comes back later; a dead container starts over next time', async () => {
    router = (c) => {
      if (path(c).endsWith('/media')) return { json: { id: 'c2' } };
      if (c.url.startsWith('https://rupload')) return { json: { success: true } };
      return { json: { status_code: 'IN_PROGRESS' } };
    };
    const state = io();
    expect(await client.publish(payload('instagram'), state)).toMatchObject({ done: false });
    expect(state.state.igContainer).toBe('c2');
    router = () => ({ json: { status_code: 'ERROR', status: 'bad codec' } });
    await expect(client.publish(payload('instagram'), state)).rejects.toMatchObject({ kind: 'final' });
    expect(state.state.igContainer).toBeUndefined();
  });

  it('checks an account id', async () => {
    router = () => ({ json: { username: 'guildwise' } });
    expect(await client.instagramAccount('ig-1', 'tok')).toEqual({ username: 'guildwise' });
    router = () => ({ status: 400, json: { error: { code: 190, message: 'bad' } } });
    await expect(client.instagramAccount('ig-1', 'tok')).rejects.toBeInstanceOf(DestinationError);
  });
});

describe('X', () => {
  const creds = JSON.stringify({ apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' });
  it('initialize, append chunks, finalize, then the tweet with the media id (OAuth 1.0a, no link)', async () => {
    router = (c) => {
      if (path(c) === '/2/media/upload/initialize') return { json: { data: { id: 'mid' } } };
      if (path(c) === '/2/media/upload/mid/append') return { json: {} };
      if (path(c) === '/2/media/upload/mid/finalize') return { json: { data: { id: 'mid' } } };
      if (path(c) === '/2/tweets') return { json: { data: { id: 'tw1' } } };
      return undefined;
    };
    const out = await client.publish(payload('x', { credentials: creds, text: 'Words #ai' }), io());
    expect(out).toEqual({ done: true, externalId: 'tw1', url: 'https://x.com/i/web/status/tw1' });
    const init = calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      media_type: 'video/mp4',
      total_bytes: 200 * 1024,
      media_category: 'tweet_video',
    });
    expect(init?.headers.authorization).toMatch(/^OAuth .*oauth_signature=/);
    const tweet = calls.at(-1);
    expect(JSON.parse(String(tweet?.body))).toEqual({ text: 'Words #ai', media: { media_ids: ['mid'] } });
  });

  it('waits for processing and explains a refused OAuth 1.0a call (the OAuth 2 note)', async () => {
    let n = 0;
    router = (c) => {
      if (path(c) === '/2/media/upload/initialize') return { json: { data: { id: 'mid' } } };
      if (path(c).endsWith('/append')) return { json: {} };
      if (path(c).endsWith('/finalize'))
        return { json: { data: { id: 'mid', processing_info: { state: 'pending', check_after_secs: 1 } } } };
      if (path(c) === '/2/media/upload')
        return { json: { data: { processing_info: { state: ++n < 2 ? 'in_progress' : 'succeeded' } } } };
      if (path(c) === '/2/tweets') return { json: { data: { id: 'tw2' } } };
      return undefined;
    };
    expect((await client.publish(payload('x', { credentials: creds }), io())).done).toBe(true);
    router = () => ({ status: 403, text: 'forbidden' });
    await expect(client.publish(payload('x', { credentials: creds }), io())).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringMatching(/OAuth 2\.0 user token with the media\.write scope/),
    });
    router = () => ({ status: 402, text: 'credits' });
    await expect(client.publish(payload('x', { credentials: creds }), io())).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});

describe('LinkedIn', () => {
  it('initializeUpload as the organization, PUT the part, finalize with the ETag, wait for AVAILABLE, post with media', async () => {
    router = (c) => {
      if (c.url.endsWith('/rest/videos?action=initializeUpload'))
        return {
          json: {
            value: {
              video: 'urn:li:video:V1',
              uploadToken: 'tok',
              uploadInstructions: [
                {
                  uploadUrl: 'https://www.linkedin.com/dms-uploads/V1/x',
                  firstByte: 0,
                  lastByte: 200 * 1024 - 1,
                },
              ],
            },
          },
        };
      if (c.url === 'https://www.linkedin.com/dms-uploads/V1/x') return { headers: { etag: '"abc123"' } };
      if (c.url.endsWith('/rest/videos?action=finalizeUpload')) return {};
      if (c.url.includes('/rest/videos/urn%3Ali%3Avideo%3AV1')) return { json: { status: 'AVAILABLE' } };
      if (c.url.endsWith('/rest/posts')) return { headers: { 'x-restli-id': 'urn:li:share:9' } };
      return undefined;
    };
    const out = await client.publish(payload('linkedin', { accountId: '5515715' }), io());
    expect(out.done && out.externalId).toBe('urn:li:share:9');
    const init = calls[0];
    expect(init?.headers['linkedin-version']).toBe('202610');
    expect(JSON.parse(String(init?.body)).initializeUploadRequest).toMatchObject({
      owner: 'urn:li:organization:5515715',
      fileSizeBytes: 200 * 1024,
    });
    const fin = calls.find((c) => c.url.endsWith('finalizeUpload'));
    expect(JSON.parse(String(fin?.body)).finalizeUploadRequest).toEqual({
      video: 'urn:li:video:V1',
      uploadToken: 'tok',
      uploadedPartIds: ['abc123'],
    });
    const posted = JSON.parse(String(calls.at(-1)?.body));
    expect(posted).toMatchObject({
      author: 'urn:li:organization:5515715',
      content: { media: { id: 'urn:li:video:V1' } },
      lifecycleState: 'PUBLISHED',
    });
  });
});

describe('Bluesky', () => {
  const creds = JSON.stringify({ handle: 'gw.bsky.social', appPassword: 'abcd-efgh' });
  it('limits preflight, service auth for the PDS, uploadVideo, job status, post with an embed.video', async () => {
    const blob = { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'video/mp4', size: 1 };
    router = (c) => {
      if (path(c).endsWith('createSession'))
        return {
          json: {
            accessJwt: 'jwt',
            did: 'did:plc:me',
            didDoc: { service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example.com' }] },
          },
        };
      if (path(c).endsWith('getServiceAuth'))
        return { json: { token: `svc-${new URL(c.url).searchParams.get('lxm')}` } };
      if (path(c).endsWith('getUploadLimits'))
        return { json: { canUpload: true, remainingDailyVideos: 9, remainingDailyBytes: 1e9 } };
      if (path(c).endsWith('uploadVideo')) return { json: { jobId: 'job1', state: 'JOB_STATE_CREATED' } };
      if (path(c).endsWith('getJobStatus'))
        return { json: { jobStatus: { jobId: 'job1', state: 'JOB_STATE_COMPLETED', blob } } };
      if (path(c).endsWith('createRecord')) return { json: { uri: 'at://did:plc:me/app.bsky.feed.post/3k' } };
      return undefined;
    };
    const out = await client.publish(payload('bluesky', { credentials: creds, text: 'Words #ai' }), io());
    expect(out).toEqual({
      done: true,
      externalId: 'at://did:plc:me/app.bsky.feed.post/3k',
      url: 'https://bsky.app/profile/gw.bsky.social/post/3k',
    });
    const auths = calls
      .filter((c) => path(c).endsWith('getServiceAuth'))
      .map((c) => Object.fromEntries(new URL(c.url).searchParams));
    expect(auths[0]).toMatchObject({ aud: 'did:web:video.bsky.app', lxm: 'app.bsky.video.getUploadLimits' });
    expect(auths[1]).toMatchObject({ aud: 'did:web:pds.example.com', lxm: 'com.atproto.repo.uploadBlob' });
    const up = calls.find((c) => path(c).endsWith('uploadVideo'));
    expect(up?.url).toContain('did=did%3Aplc%3Ame');
    expect(up?.headers).toMatchObject({
      authorization: 'Bearer svc-com.atproto.repo.uploadBlob',
      'content-type': 'video/mp4',
    });
    const rec = JSON.parse(String(calls.at(-1)?.body));
    expect(rec.record.embed).toMatchObject({ $type: 'app.bsky.embed.video', video: blob });
  });

  it('the daily quota is a retry later, not a failure; a refused login is auth', async () => {
    router = (c) => {
      if (path(c).endsWith('createSession')) return { json: { accessJwt: 'jwt', did: 'did:plc:me' } };
      if (path(c).endsWith('getServiceAuth')) return { json: { token: 't' } };
      return {
        json: { canUpload: false, remainingDailyVideos: 0, remainingDailyBytes: 0, message: 'daily limit' },
      };
    };
    await expect(client.publish(payload('bluesky', { credentials: creds }), io())).rejects.toMatchObject({
      kind: 'retry',
    });
    router = () => ({ status: 401, text: 'no' });
    await expect(client.publish(payload('bluesky', { credentials: creds }), io())).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});

describe('TikTok', () => {
  const options = {
    privacy: 'SELF_ONLY' as const,
    allowComment: true,
    allowDuet: true,
    allowStitch: false,
    commercial: { on: true, yourBrand: true, brandedContent: false },
    consent: true as const,
  };
  const tt = { options, videoUrl: 'https://aom.test/api/public/video-media/r/1/s/video.mp4' };
  const creator = {
    data: {
      creator_username: 'gw',
      creator_nickname: 'GW',
      privacy_level_options: ['SELF_ONLY'],
      duet_disabled: true,
      max_video_post_duration_sec: 600,
    },
    error: { code: 'ok' },
  };

  it('creator info, init PULL_FROM_URL with the toggles, status until PUBLISH_COMPLETE', async () => {
    router = (c) => {
      if (path(c) === '/v2/post/publish/creator_info/query/') return { json: creator };
      if (path(c) === '/v2/post/publish/video/init/')
        return { json: { data: { publish_id: 'p1' }, error: { code: 'ok' } } };
      if (path(c) === '/v2/post/publish/status/fetch/')
        return {
          json: {
            data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [123] },
            error: { code: 'ok' },
          },
        };
      return undefined;
    };
    const out = await client.publish(payload('tiktok', { tiktok: tt }), io());
    expect(out).toMatchObject({ done: true, externalId: '123' });
    const init = JSON.parse(String(calls.find((c) => path(c).endsWith('/init/'))?.body));
    expect(init.source_info).toEqual({ source: 'PULL_FROM_URL', video_url: tt.videoUrl });
    expect(init.post_info).toMatchObject({
      title: 'Caption #ai',
      privacy_level: 'SELF_ONLY',
      disable_comment: false,
      disable_duet: true, // the creator disabled duets
      disable_stitch: true,
      brand_organic_toggle: true,
      brand_content_toggle: false,
    });
    expect(calls[0]?.headers.authorization).toBe('Bearer the-token');
  });

  it('never sends a privacy level the creator does not offer, or a video longer than allowed', async () => {
    router = () => ({ json: creator });
    await expect(
      client.publish(
        payload('tiktok', { tiktok: { ...tt, options: { ...options, privacy: 'PUBLIC_TO_EVERYONE' } } }),
        io(),
      ),
    ).rejects.toMatchObject({ kind: 'final', code: 'privacy_level_option_mismatch' });
    expect(calls.some((c) => path(c).endsWith('/init/'))).toBe(false);
    await expect(
      client.publish(payload('tiktok', { tiktok: tt, durationSeconds: 700 }), io()),
    ).rejects.toMatchObject({ kind: 'final' });
    await expect(client.publish(payload('tiktok'), io())).rejects.toMatchObject({ kind: 'final' });
  });

  it('still processing keeps the publish id; FAILED fail reasons map to retry, final and auth', async () => {
    router = (c) => {
      if (path(c).endsWith('creator_info/query/')) return { json: creator };
      if (path(c).endsWith('/init/')) return { json: { data: { publish_id: 'p2' }, error: { code: 'ok' } } };
      return { json: { data: { status: 'PROCESSING_DOWNLOAD' }, error: { code: 'ok' } } };
    };
    const st = io();
    expect(await client.publish(payload('tiktok', { tiktok: tt }), st)).toMatchObject({ done: false });
    expect(st.state.ttPublishId).toBe('p2');
    for (const [reason, kind] of [
      ['video_pull_failed', 'retry'],
      ['spam_risk_too_many_posts', 'final'],
      ['auth_removed', 'auth'],
    ] as const) {
      router = () => ({ json: { data: { status: 'FAILED', fail_reason: reason }, error: { code: 'ok' } } });
      await expect(
        client.publish(payload('tiktok', { tiktok: tt }), io({ ttPublishId: 'p2' })),
      ).rejects.toMatchObject({ kind });
    }
  });

  it('classifies the init error codes', async () => {
    const initError = (code: string, status = 403) => {
      router = (c) =>
        path(c).endsWith('creator_info/query/')
          ? { json: creator }
          : { status, json: { error: { code, message: 'm' } } };
    };
    for (const [code, kind, status] of [
      ['unaudited_client_can_only_post_to_private_accounts', 'final', 403],
      ['url_ownership_unverified', 'final', 403],
      ['access_token_invalid', 'auth', 401],
      ['rate_limit_exceeded', 'retry', 429],
    ] as const) {
      initError(code, status);
      await expect(client.publish(payload('tiktok', { tiktok: tt }), io())).rejects.toMatchObject({
        kind,
        code,
      });
    }
  });

  it('exchanges a code and refreshes a token (form-encoded, rotated refresh token returned)', async () => {
    router = () => ({ json: { access_token: 'a', refresh_token: 'r2', expires_in: 86400, open_id: 'o1' } });
    const t1 = await client.tiktokToken(
      { code: 'c', redirectUri: 'https://aom.test/cb' },
      { clientKey: 'k', clientSecret: 's' },
    );
    expect(t1).toMatchObject({ accessToken: 'a', refreshToken: 'r2', openId: 'o1' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.body)))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'https://aom.test/cb',
      client_key: 'k',
    });
    await client.tiktokToken({ refreshToken: 'r1' }, { clientKey: 'k', clientSecret: 's' });
    expect(Object.fromEntries(new URLSearchParams(String(calls[1]?.body)))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
    });
    router = () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'expired' } });
    await expect(
      client.tiktokToken({ refreshToken: 'dead' }, { clientKey: 'k', clientSecret: 's' }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});
