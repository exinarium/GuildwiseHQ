import { readFile } from 'node:fs/promises';
import type { BlueskyFacet, TikTokOptions, VideoDestination } from '@aom/shared';
import { oauth1Header } from '../blog/oauth1.ts';
import { GRAPH_VERSION, LINKEDIN_VERSION } from '../blog/social-client.ts';

/**
 * The only code that posts a rendered video to Facebook (Page Reels), Instagram (Reels), X, LinkedIn, Bluesky and TikTok.
 * The worker (`sweep.ts`) goes through `VideoDestinationClient`, so no test ever reaches a real network. Versions are
 * pinned on purpose (Graph and LinkedIn: `blog/social-client.ts`); review them every 6 to 12 months.
 *
 * One `publish` call walks the steps of a destination and keeps its progress in `io.state` (saved after every step that
 * must not be repeated: an upload session, a container, a media id, a publish id), so a retry resumes instead of
 * uploading or posting twice. A destination that needs time to process (TikTok, Instagram) answers `{done:false}` and the
 * worker calls again later.
 */

export type DestinationErrorKind = 'auth' | 'retry' | 'final';
export class DestinationError extends Error {
  constructor(
    readonly kind: DestinationErrorKind,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DestinationError';
  }
}

export type ShortDestination = Exclude<VideoDestination, 'youtube'>;
export const SHORT_DESTINATIONS: readonly ShortDestination[] = [
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'bluesky',
  'tiktok',
];

export interface DestinationPayload {
  network: ShortDestination;
  /** Page id, IG user id, organization id, handle, open_id. */
  accountId: string;
  /**
   * Facebook and Instagram: the Page access token. LinkedIn and TikTok: the access token. X: JSON
   * `{apiKey, apiSecret, accessToken, accessSecret}`. Bluesky: JSON `{handle, appPassword}`.
   */
  credentials: string;
  filePath: string;
  bytes: number;
  durationSeconds: number;
  /** The caption as posted (hashtags and limits applied, no link). */
  text: string;
  /** Bluesky tag facets of `text`. */
  facets: BlueskyFacet[];
  /** The video title (LinkedIn media title). */
  title: string;
  /** TikTok: what the owner chose, and the signed temporary URL TikTok pulls the file from. */
  tiktok?: { options: TikTokOptions; videoUrl: string };
}

export interface DestinationIO {
  /** Progress that survives a crash or a retry; `save()` persists it. */
  state: Record<string, unknown>;
  save(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type DestinationOutcome =
  | { done: true; externalId: string; url: string | null }
  | { done: false; retryInMs: number; note: string };

export interface TikTokCreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}
export interface TikTokTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  openId: string;
}
export interface TikTokAppCreds {
  clientKey: string;
  clientSecret: string;
}

export interface VideoDestinationClient {
  publish(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome>;
  tiktokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo>;
  /** The authorization code (connect) or the refresh token (renewal) for a pair of tokens; TikTok may rotate the refresh token. */
  tiktokToken(
    grant: { code: string; redirectUri: string } | { refreshToken: string },
    app: TikTokAppCreds,
  ): Promise<TikTokTokens>;
  /** Checks an Instagram professional account id with its Page token; returns the username. */
  instagramAccount(accountId: string, accessToken: string): Promise<{ username: string }>;
}

// ---- http

interface Res {
  status: number;
  body: string;
  headers: Headers;
}
const MIN = 60_000;
async function http(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Res> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } catch (err) {
    throw new DestinationError('retry', `network error: ${(err as Error).message}`);
  }
}
const UPLOAD_TIMEOUT = 10 * MIN;
const json = <T>(r: Res): T => {
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new DestinationError('retry', `HTTP ${r.status}: not JSON: ${r.body.slice(0, 120)}`);
  }
};

/** 401/403: the token (auth). 429 and 5xx: try later. Anything else is the video's or the request's fault (final). */
function classify(r: Res, what: string): DestinationError {
  const msg = `${what}: HTTP ${r.status}: ${r.body.slice(0, 300)}`;
  if (r.status === 401 || r.status === 403) return new DestinationError('auth', msg);
  if (r.status === 429 || r.status >= 500) return new DestinationError('retry', msg);
  return new DestinationError('final', msg);
}

/** Graph API errors come as 400 with `error.code`: 190 and the permission codes are the token, 4/17/32/613 a rate limit. */
function graphError(r: Res, what: string): DestinationError {
  try {
    const e = (JSON.parse(r.body) as { error?: { code?: number; message?: string } }).error;
    if (e?.code !== undefined) {
      const msg = `${what}: Graph error ${e.code}: ${(e.message ?? '').slice(0, 300)}`;
      if (e.code === 190 || e.code === 102 || e.code === 10 || (e.code >= 200 && e.code < 300))
        return new DestinationError('auth', msg, String(e.code));
      if ([1, 2, 4, 17, 32, 341, 613].includes(e.code))
        return new DestinationError('retry', msg, String(e.code));
      if (r.status >= 500) return new DestinationError('retry', msg, String(e.code));
      return new DestinationError('final', msg, String(e.code));
    }
  } catch {
    // not JSON: classified by status
  }
  return classify(r, what);
}

const chunks = (buf: Buffer, size: number): Buffer[] => {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out.length ? out : [Buffer.alloc(0)];
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// ---- Facebook Page Reels

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const RUPLOAD = 'https://rupload.facebook.com';

async function postToFacebook(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
  const s = io.state;
  const token = p.credentials;
  if (!str(s.fbVideoId)) {
    const r = await http(`${GRAPH}/${encodeURIComponent(p.accountId)}/video_reels`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ upload_phase: 'start', access_token: token }),
    });
    if (r.status >= 300) throw graphError(r, 'Facebook reel start');
    const id = str(json<{ video_id?: string }>(r).video_id);
    if (!id) throw new DestinationError('final', 'Facebook gave no video id for the reel');
    s.fbVideoId = id;
    await io.save();
  }
  const id = s.fbVideoId as string;
  if (!s.fbUploaded) {
    const buf = await readFile(p.filePath);
    const r = await http(
      `${RUPLOAD}/video-upload/${GRAPH_VERSION}/${id}`,
      {
        method: 'POST',
        headers: {
          authorization: `OAuth ${token}`,
          offset: '0',
          file_size: String(buf.length),
          'content-type': 'application/octet-stream',
        },
        body: buf,
      },
      UPLOAD_TIMEOUT,
    );
    if (r.status >= 300) throw graphError(r, 'Facebook reel upload');
    s.fbUploaded = true;
    await io.save();
  }
  // the file is processed after the upload: wait (briefly) until Facebook says it is ready, then publish
  for (let i = 0; i < 6; i++) {
    const r = await http(`${GRAPH}/${id}?fields=status&access_token=${encodeURIComponent(token)}`).catch(
      () => null,
    );
    if (!r || r.status >= 300) break;
    const st = json<{ status?: { video_status?: string; uploading_phase?: { status?: string } } }>(r).status;
    if (st?.video_status === 'ready' || st?.uploading_phase?.status === 'complete') break;
    if (st?.video_status === 'error')
      throw new DestinationError('final', 'Facebook could not process the video');
    await io.sleep(5_000);
  }
  const r = await http(`${GRAPH}/${encodeURIComponent(p.accountId)}/video_reels`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      video_id: id,
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: p.text,
      access_token: token,
    }),
  });
  if (r.status >= 300) throw graphError(r, 'Facebook reel publish');
  return { done: true, externalId: id, url: `https://www.facebook.com/reel/${id}` };
}

// ---- Instagram Reels

async function postToInstagram(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
  const s = io.state;
  const token = p.credentials;
  if (!str(s.igContainer)) {
    const r = await http(`${GRAPH}/${encodeURIComponent(p.accountId)}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        media_type: 'REELS',
        upload_type: 'resumable',
        caption: p.text,
        share_to_feed: 'true',
        access_token: token,
      }),
    });
    if (r.status >= 300) throw graphError(r, 'Instagram container');
    const id = str(json<{ id?: string }>(r).id);
    if (!id) throw new DestinationError('final', 'Instagram gave no container id');
    s.igContainer = id;
    await io.save();
  }
  const container = s.igContainer as string;
  if (!s.igUploaded) {
    const buf = await readFile(p.filePath);
    const r = await http(
      `${RUPLOAD}/ig-api-upload/${GRAPH_VERSION}/${container}`,
      {
        method: 'POST',
        headers: {
          authorization: `OAuth ${token}`,
          offset: '0',
          file_size: String(buf.length),
          'content-type': 'application/octet-stream',
        },
        body: buf,
      },
      UPLOAD_TIMEOUT,
    );
    if (r.status >= 300) throw graphError(r, 'Instagram upload');
    s.igUploaded = true;
    await io.save();
  }
  if (!s.igPublished) {
    // processing takes up to a few minutes: look about every 10 seconds for ~2 minutes, then come back later
    let code = '';
    for (let i = 0; i < 12; i++) {
      const r = await http(
        `${GRAPH}/${container}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
      );
      if (r.status >= 300) throw graphError(r, 'Instagram status');
      const j = json<{ status_code?: string; status?: string }>(r);
      code = j.status_code ?? '';
      if (code === 'FINISHED' || code === 'PUBLISHED') break;
      if (code === 'ERROR' || code === 'EXPIRED') {
        // the container is dead: the next attempt (a retry) starts a new one
        delete s.igContainer;
        delete s.igUploaded;
        await io.save();
        throw new DestinationError(
          'final',
          `Instagram could not process the video: ${code} ${j.status ?? ''}`.trim(),
        );
      }
      await io.sleep(10_000);
    }
    if (code !== 'FINISHED' && code !== 'PUBLISHED')
      return { done: false, retryInMs: MIN, note: 'Instagram is still processing the video' };
    const r = await http(`${GRAPH}/${encodeURIComponent(p.accountId)}/media_publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ creation_id: container, access_token: token }),
    });
    if (r.status >= 300) throw graphError(r, 'Instagram publish');
    const mediaId = str(json<{ id?: string }>(r).id);
    if (!mediaId) throw new DestinationError('final', 'Instagram gave no media id');
    s.igPublished = mediaId;
    await io.save();
  }
  const mediaId = s.igPublished as string;
  let url: string | null = null;
  const pl = await http(
    `${GRAPH}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`,
  ).catch(() => null);
  if (pl && pl.status < 300) url = str(json<{ permalink?: string }>(pl).permalink) ?? null;
  return { done: true, externalId: mediaId, url };
}

// ---- X (OAuth 1.0a user context; see docs/BLOG-API.md for what is and is not verified)

const X_API = 'https://api.x.com';
const X_CHUNK = 4 * 1024 * 1024;

async function postToX(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
  let c: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string };
  try {
    c = JSON.parse(p.credentials);
    if (!c.apiKey || !c.apiSecret || !c.accessToken || !c.accessSecret) throw new Error('incomplete');
  } catch {
    throw new DestinationError('auth', 'the stored X credentials are incomplete; paste them again');
  }
  const sign = (method: string, url: string, params?: Record<string, string>) =>
    oauth1Header({
      method,
      url,
      consumerKey: c.apiKey,
      consumerSecret: c.apiSecret,
      token: c.accessToken,
      tokenSecret: c.accessSecret,
      ...(params ? { params } : {}),
    });
  /** The v2 media endpoints may demand an OAuth 2.0 user token (media.write): tell the owner what to do, do not retry blindly. */
  const xError = (r: Res, what: string): DestinationError => {
    if (r.status === 402)
      return new DestinationError('auth', `${what}: HTTP 402: the X API credits are used up`);
    if (r.status === 401 || r.status === 403)
      return new DestinationError(
        'auth',
        `${what}: HTTP ${r.status}: X refused the OAuth 1.0a keys for video upload. The v2 media endpoints may need an OAuth 2.0 user token with the media.write scope (see docs/BLOG-API.md, X setup). ${r.body.slice(0, 160)}`,
      );
    return classify(r, what);
  };
  const s = io.state;
  if (!str(s.xMediaId)) {
    const buf = await readFile(p.filePath);
    const initUrl = `${X_API}/2/media/upload/initialize`;
    const init = await http(initUrl, {
      method: 'POST',
      headers: { authorization: sign('POST', initUrl), 'content-type': 'application/json' },
      body: JSON.stringify({
        media_type: 'video/mp4',
        total_bytes: buf.length,
        media_category: 'tweet_video',
      }),
    });
    if (init.status >= 300) throw xError(init, 'X media initialize');
    const id = str(json<{ data?: { id?: string } }>(init).data?.id);
    if (!id) throw new DestinationError('final', 'X gave no media id');
    s.xMediaId = id;
    await io.save();
    const appendUrl = `${X_API}/2/media/upload/${id}/append`;
    let i = 0;
    for (const part of chunks(buf, X_CHUNK)) {
      const form = new FormData();
      form.set('segment_index', String(i));
      form.set('media', new Blob([new Uint8Array(part)]), 'chunk');
      // a multipart body adds no signed parameters
      const r = await http(
        appendUrl,
        { method: 'POST', headers: { authorization: sign('POST', appendUrl) }, body: form },
        UPLOAD_TIMEOUT,
      );
      if (r.status >= 300) throw xError(r, `X media append ${i}`);
      i++;
    }
    const finUrl = `${X_API}/2/media/upload/${id}/finalize`;
    const fin = await http(finUrl, { method: 'POST', headers: { authorization: sign('POST', finUrl) } });
    if (fin.status >= 300) throw xError(fin, 'X media finalize');
    s.xProcessing = json<{ data?: { processing_info?: unknown } }>(fin).data?.processing_info ?? null;
    s.xUploaded = true;
    await io.save();
  }
  const mediaId = s.xMediaId as string;
  // wait for X to process the video (processing_info), up to ~2 minutes, then come back
  if (s.xProcessing) {
    const statusUrl = `${X_API}/2/media/upload`;
    for (let i = 0; i < 12; i++) {
      const q = { command: 'STATUS', media_id: mediaId };
      const r = await http(`${statusUrl}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, {
        headers: { authorization: sign('GET', statusUrl, q) },
      });
      if (r.status >= 300) throw xError(r, 'X media status');
      const info = json<{
        data?: {
          processing_info?: { state?: string; error?: { message?: string }; check_after_secs?: number };
        };
      }>(r).data?.processing_info;
      if (!info || info.state === 'succeeded') break;
      if (info.state === 'failed')
        throw new DestinationError(
          'final',
          `X could not process the video: ${info.error?.message ?? 'failed'}`,
        );
      await io.sleep(Math.min(Math.max(info.check_after_secs ?? 5, 2), 15) * 1000);
      if (i === 11) return { done: false, retryInMs: 2 * MIN, note: 'X is still processing the video' };
    }
  }
  const tweetUrl = `${X_API}/2/tweets`;
  const r = await http(tweetUrl, {
    method: 'POST',
    headers: { authorization: sign('POST', tweetUrl), 'content-type': 'application/json' },
    body: JSON.stringify({ text: p.text, media: { media_ids: [mediaId] } }),
  });
  if (r.status >= 300) throw xError(r, 'X post');
  const id = str(json<{ data?: { id?: string } }>(r).data?.id);
  if (!id) throw new DestinationError('final', 'no post id in the answer');
  return { done: true, externalId: id, url: `https://x.com/i/web/status/${id}` };
}

// ---- LinkedIn organization video

const LI = 'https://api.linkedin.com/rest';

async function postToLinkedIn(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
  const headers = {
    authorization: `Bearer ${p.credentials}`,
    'linkedin-version': LINKEDIN_VERSION,
    'x-restli-protocol-version': '2.0.0',
    'content-type': 'application/json',
  };
  const owner = `urn:li:organization:${p.accountId}`;
  const s = io.state;
  if (!str(s.liVideo)) {
    const buf = await readFile(p.filePath);
    if (buf.length < 75 * 1024 || buf.length > 500 * 1024 * 1024)
      throw new DestinationError('final', 'LinkedIn takes videos of 75 KB to 500 MB');
    const init = await http(`${LI}/videos?action=initializeUpload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        initializeUploadRequest: {
          owner,
          fileSizeBytes: buf.length,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      }),
    });
    if (init.status >= 300) throw classify(init, 'LinkedIn video initialize');
    const v = json<{
      value?: {
        video?: string;
        uploadToken?: string;
        uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
      };
    }>(init).value;
    if (!v?.video || !v.uploadInstructions?.length)
      throw new DestinationError('final', 'LinkedIn gave no upload instructions');
    const etags: string[] = [];
    for (const part of v.uploadInstructions) {
      const r = await http(
        part.uploadUrl,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: buf.subarray(part.firstByte, part.lastByte + 1),
        },
        UPLOAD_TIMEOUT,
      );
      if (r.status >= 300) throw classify(r, 'LinkedIn video part');
      const tag = r.headers.get('etag');
      if (!tag) throw new DestinationError('final', 'LinkedIn returned no ETag for an uploaded part');
      etags.push(tag.replace(/^"|"$/g, ''));
    }
    const fin = await http(`${LI}/videos?action=finalizeUpload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? '', uploadedPartIds: etags },
      }),
    });
    if (fin.status >= 300) throw classify(fin, 'LinkedIn video finalize');
    s.liVideo = v.video;
    await io.save();
  }
  const video = s.liVideo as string;
  // wait until LinkedIn has the video (AVAILABLE), ~2 minutes, then come back
  let status = '';
  for (let i = 0; i < 12; i++) {
    const r = await http(`${LI}/videos/${encodeURIComponent(video)}`, { headers });
    if (r.status >= 300) throw classify(r, 'LinkedIn video status');
    const j = json<{ status?: string; processingFailureReason?: string }>(r);
    status = j.status ?? '';
    if (status === 'AVAILABLE') break;
    if (status === 'PROCESSING_FAILED')
      throw new DestinationError(
        'final',
        `LinkedIn could not process the video: ${j.processingFailureReason ?? 'failed'}`,
      );
    await io.sleep(10_000);
  }
  if (status !== 'AVAILABLE')
    return { done: false, retryInMs: 2 * MIN, note: 'LinkedIn is still processing the video' };
  const r = await http(`${LI}/posts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      author: owner,
      commentary: p.text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { title: p.title.slice(0, 200), id: video } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (r.status >= 300) throw classify(r, 'LinkedIn post');
  const id = r.headers.get('x-restli-id') ?? '';
  if (!id) throw new DestinationError('final', 'no post id in the answer');
  return { done: true, externalId: id, url: `https://www.linkedin.com/feed/update/${id}` };
}

// ---- Bluesky video

const BSKY = 'https://bsky.social/xrpc';
const BSKY_VIDEO = 'https://video.bsky.app/xrpc';

async function postToBluesky(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
  let c: { handle: string; appPassword: string };
  try {
    c = JSON.parse(p.credentials);
    if (!c.handle || !c.appPassword) throw new Error('incomplete');
  } catch {
    throw new DestinationError('auth', 'the stored Bluesky credentials are incomplete; paste them again');
  }
  const handle = c.handle.replace(/^@/, '');
  const login = await http(`${BSKY}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: c.appPassword }),
  });
  if (login.status === 400 || login.status === 401)
    throw new DestinationError('auth', `HTTP ${login.status}: login refused`);
  if (login.status >= 300) throw classify(login, 'Bluesky login');
  const session = json<{
    accessJwt?: string;
    did?: string;
    didDoc?: { service?: Array<{ id?: string; serviceEndpoint?: string }> };
  }>(login);
  if (!session.accessJwt || !session.did) throw new DestinationError('final', 'no session in the answer');
  const pds = session.didDoc?.service?.find((x) => x.id?.endsWith('#atproto_pds'))?.serviceEndpoint;
  const pdsUrl = pds ?? 'https://bsky.social';
  const pdsHost = new URL(pdsUrl).host;
  const auth = { authorization: `Bearer ${session.accessJwt}` };
  const serviceAuth = async (aud: string, lxm: string): Promise<string> => {
    const exp = Math.floor(Date.now() / 1000) + 30 * 60;
    const r = await http(
      `${pdsUrl}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(aud)}&lxm=${encodeURIComponent(lxm)}&exp=${exp}`,
      { headers: auth },
    );
    if (r.status === 400 || r.status === 401 || r.status === 403)
      throw new DestinationError(
        'auth',
        `Bluesky refused a service token (${lxm}). An app password may not be allowed to create one; HTTP ${r.status}: ${r.body.slice(0, 160)}`,
      );
    if (r.status >= 300) throw classify(r, 'Bluesky service auth');
    const token = str(json<{ token?: string }>(r).token);
    if (!token) throw new DestinationError('final', 'Bluesky gave no service token');
    return token;
  };
  const s = io.state;
  if (!s.bskyBlob) {
    // the daily quota, before any upload
    const limitsToken = await serviceAuth('did:web:video.bsky.app', 'app.bsky.video.getUploadLimits');
    const lim = await http(`${BSKY_VIDEO}/app.bsky.video.getUploadLimits`, {
      headers: { authorization: `Bearer ${limitsToken}` },
    });
    if (lim.status >= 300) throw classify(lim, 'Bluesky upload limits');
    const l = json<{
      canUpload?: boolean;
      remainingDailyVideos?: number;
      remainingDailyBytes?: number;
      message?: string;
    }>(lim);
    if (l.canUpload === false || (l.remainingDailyBytes !== undefined && l.remainingDailyBytes < p.bytes))
      throw new DestinationError(
        'retry',
        `Bluesky's daily video quota is used (${l.remainingDailyVideos ?? 0} videos, ${l.remainingDailyBytes ?? 0} bytes left): ${l.message ?? 'try again later'}`,
      );
    if (!str(s.bskyJob)) {
      const token = await serviceAuth(`did:web:${pdsHost}`, 'com.atproto.repo.uploadBlob');
      const buf = await readFile(p.filePath);
      const up = await http(
        `${BSKY_VIDEO}/app.bsky.video.uploadVideo?did=${encodeURIComponent(session.did)}&name=video.mp4`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'video/mp4' },
          body: buf,
        },
        UPLOAD_TIMEOUT,
      );
      // 409 already_exists carries the job of an identical earlier upload
      const j = json<{
        jobId?: string;
        jobStatus?: { jobId?: string; blob?: unknown };
        error?: string;
        message?: string;
      }>(up);
      const jobId = str(j.jobId) ?? str(j.jobStatus?.jobId);
      if (up.status >= 300 && !jobId) throw classify(up, 'Bluesky video upload');
      if (!jobId) throw new DestinationError('final', 'Bluesky gave no job id');
      s.bskyJob = jobId;
      if (j.jobStatus?.blob) s.bskyBlob = j.jobStatus.blob;
      await io.save();
    }
    for (let i = 0; i < 18 && !s.bskyBlob; i++) {
      const r = await http(
        `${BSKY_VIDEO}/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(s.bskyJob as string)}`,
      );
      if (r.status >= 300) throw classify(r, 'Bluesky job status');
      const st = json<{ jobStatus?: { state?: string; blob?: unknown; error?: string; message?: string } }>(
        r,
      ).jobStatus;
      if (st?.state === 'JOB_STATE_COMPLETED' && st.blob) {
        s.bskyBlob = st.blob;
        await io.save();
        break;
      }
      if (st?.state === 'JOB_STATE_FAILED')
        throw new DestinationError(
          'final',
          `Bluesky could not process the video: ${st.error ?? st.message ?? 'failed'}`,
        );
      await io.sleep(10_000);
    }
    if (!s.bskyBlob)
      return { done: false, retryInMs: 2 * MIN, note: 'Bluesky is still processing the video' };
  }
  const r = await http(`${BSKY}/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text: p.text,
        createdAt: new Date().toISOString(),
        facets: p.facets,
        embed: { $type: 'app.bsky.embed.video', video: s.bskyBlob, alt: p.title.slice(0, 300) },
      },
    }),
  });
  if (r.status >= 300) throw classify(r, 'Bluesky post');
  const uri = str(json<{ uri?: string }>(r).uri);
  const rkey = uri?.split('/').pop();
  if (!uri || !rkey) throw new DestinationError('final', 'no post uri in the answer');
  return { done: true, externalId: uri, url: `https://bsky.app/profile/${handle}/post/${rkey}` };
}

// ---- TikTok (Content Posting API, Direct Post, PULL_FROM_URL)

const TT = 'https://open.tiktokapis.com';

interface TtEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string };
}
/** TikTok answers `error.code` `ok` on success; the codes it uses for the other cases decide what happens next. */
function ttError(r: Res, what: string): DestinationError {
  let code = '';
  let message = '';
  try {
    const e = (JSON.parse(r.body) as TtEnvelope<unknown>).error;
    code = e?.code ?? '';
    message = e?.message ?? '';
  } catch {
    // not JSON
  }
  const msg = `${what}: ${code || `HTTP ${r.status}`}${message ? `: ${message.slice(0, 200)}` : ''}`;
  switch (code) {
    case 'access_token_invalid':
    case 'scope_not_authorized':
    case 'access_token_expired':
      return new DestinationError('auth', msg, code);
    case 'rate_limit_exceeded':
    case 'internal_error':
    case 'server_error':
      return new DestinationError('retry', msg, code);
    case 'unaudited_client_can_only_post_to_private_accounts':
      return new DestinationError(
        'final',
        `${msg}. The TikTok app has not passed its audit: only private (SELF_ONLY) posts are allowed.`,
        code,
      );
    case 'url_ownership_unverified':
      return new DestinationError(
        'final',
        `${msg}. Verify the guildwisehq.com domain (and the video URL prefix) in the TikTok developer portal.`,
        code,
      );
    case 'privacy_level_option_mismatch':
    case 'spam_risk_too_many_posts':
    case 'spam_risk_user_banned_from_posting':
    case 'reached_active_user_cap':
      return new DestinationError('final', msg, code);
    default:
      return classify(r, what.slice(0, 60));
  }
}

async function ttPost<T>(token: string, path: string, body: unknown, what: string): Promise<T> {
  const r = await http(`${TT}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  let env: TtEnvelope<T> = {};
  try {
    env = JSON.parse(r.body) as TtEnvelope<T>;
  } catch {
    // handled below
  }
  if (r.status >= 300 || (env.error?.code && env.error.code !== 'ok')) throw ttError(r, what);
  return env.data as T;
}

async function tiktokCreatorInfo(token: string): Promise<TikTokCreatorInfo> {
  const d = await ttPost<{
    creator_avatar_url?: string;
    creator_username?: string;
    creator_nickname?: string;
    privacy_level_options?: string[];
    comment_disabled?: boolean;
    duet_disabled?: boolean;
    stitch_disabled?: boolean;
    max_video_post_duration_sec?: number;
  }>(token, '/v2/post/publish/creator_info/query/', {}, 'TikTok creator info');
  return {
    nickname: d.creator_nickname ?? '',
    username: d.creator_username ?? '',
    avatarUrl: d.creator_avatar_url ?? null,
    privacyLevelOptions: d.privacy_level_options ?? [],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxVideoPostDurationSec:
      typeof d.max_video_post_duration_sec === 'number' ? d.max_video_post_duration_sec : null,
  };
}

async function postToTikTok(p: DestinationPayload, io: DestinationIO): Promise<DestinationOutcome> {
  const tt = p.tiktok;
  if (!tt) throw new DestinationError('final', 'TikTok needs the options the owner chose when scheduling');
  const token = p.credentials;
  const s = io.state;
  if (!str(s.ttPublishId)) {
    // TikTok wants fresh creator info for every post: never send a privacy level it does not offer, never a too long video
    const info = await tiktokCreatorInfo(token);
    if (!info.privacyLevelOptions.includes(tt.options.privacy))
      throw new DestinationError(
        'final',
        `TikTok does not offer "${tt.options.privacy}" for this account now (it offers ${info.privacyLevelOptions.join(', ') || 'nothing'}): schedule the video again`,
        'privacy_level_option_mismatch',
      );
    if (info.maxVideoPostDurationSec !== null && p.durationSeconds > info.maxVideoPostDurationSec)
      throw new DestinationError(
        'final',
        `the video is ${Math.round(p.durationSeconds)} s; this TikTok account may post ${info.maxVideoPostDurationSec} s at most`,
      );
    const o = tt.options;
    const d = await ttPost<{ publish_id?: string }>(
      token,
      '/v2/post/publish/video/init/',
      {
        post_info: {
          title: p.text,
          privacy_level: o.privacy,
          disable_comment: !o.allowComment || info.commentDisabled,
          disable_duet: !o.allowDuet || info.duetDisabled,
          disable_stitch: !o.allowStitch || info.stitchDisabled,
          brand_organic_toggle: o.commercial.on && o.commercial.yourBrand,
          brand_content_toggle: o.commercial.on && o.commercial.brandedContent,
        },
        source_info: { source: 'PULL_FROM_URL', video_url: tt.videoUrl },
      },
      'TikTok init',
    );
    const id = str(d.publish_id);
    if (!id) throw new DestinationError('final', 'TikTok gave no publish id');
    s.ttPublishId = id;
    await io.save();
  }
  const publishId = s.ttPublishId as string;
  for (let i = 0; i < 6; i++) {
    const d = await ttPost<{
      status?: string;
      fail_reason?: string;
      publicaly_available_post_id?: Array<string | number>;
    }>(token, '/v2/post/publish/status/fetch/', { publish_id: publishId }, 'TikTok status');
    if (d.status === 'PUBLISH_COMPLETE') {
      const post = d.publicaly_available_post_id?.[0];
      return {
        done: true,
        externalId: post !== undefined ? String(post) : publishId,
        url: post !== undefined ? `https://www.tiktok.com/video/${post}` : null,
      };
    }
    if (d.status === 'FAILED') {
      const why = d.fail_reason ?? 'failed';
      // the pull failed or TikTok had a problem: a new attempt starts a new publish
      delete s.ttPublishId;
      await io.save();
      if (why === 'auth_removed') throw new DestinationError('auth', `TikTok: ${why}`, why);
      if (why === 'internal' || why === 'video_pull_failed')
        throw new DestinationError('retry', `TikTok could not take the video (${why})`, why);
      throw new DestinationError('final', `TikTok rejected the video: ${why}`, why);
    }
    await io.sleep(10_000);
  }
  // public posts are checked by TikTok first (minutes to hours): keep the publish id and look again later
  return { done: false, retryInMs: 3 * MIN, note: 'TikTok is still processing the video' };
}

async function tiktokToken(
  grant: { code: string; redirectUri: string } | { refreshToken: string },
  app: TikTokAppCreds,
): Promise<TikTokTokens> {
  const body = new URLSearchParams({ client_key: app.clientKey, client_secret: app.clientSecret });
  if ('code' in grant) {
    body.set('code', grant.code);
    body.set('grant_type', 'authorization_code');
    body.set('redirect_uri', grant.redirectUri);
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', grant.refreshToken);
  }
  const r = await http(`${TT}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cache-control': 'no-cache' },
    body,
  });
  const j = json<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    open_id?: string;
    error?: string;
    error_description?: string;
  }>(r);
  if (r.status >= 300 || j.error || !j.access_token || !j.refresh_token) {
    const msg = `TikTok token: ${j.error ?? `HTTP ${r.status}`}${j.error_description ? `: ${j.error_description.slice(0, 200)}` : ''}`;
    // invalid_grant / invalid_request on a refresh: the refresh token is dead, reconnect
    if (j.error === 'invalid_grant' || r.status === 400 || r.status === 401)
      throw new DestinationError('auth', msg);
    throw classify(r, 'TikTok token');
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: new Date(Date.now() + (j.expires_in ?? 86_400) * 1000),
    openId: j.open_id ?? '',
  };
}

// ---- Instagram account check

async function instagramAccount(accountId: string, accessToken: string): Promise<{ username: string }> {
  const r = await http(
    `${GRAPH}/${encodeURIComponent(accountId)}?fields=username&access_token=${encodeURIComponent(accessToken)}`,
  );
  if (r.status >= 300) throw graphError(r, 'Instagram account');
  const username = str(json<{ username?: string }>(r).username);
  if (!username)
    throw new DestinationError('final', 'Instagram did not return a username for this account id');
  return { username };
}

/** The real thing. */
export function createVideoDestinationClient(): VideoDestinationClient {
  return {
    publish(p, io) {
      switch (p.network) {
        case 'facebook':
          return postToFacebook(p, io);
        case 'instagram':
          return postToInstagram(p, io);
        case 'x':
          return postToX(p, io);
        case 'linkedin':
          return postToLinkedIn(p, io);
        case 'bluesky':
          return postToBluesky(p, io);
        case 'tiktok':
          return postToTikTok(p, io);
      }
    },
    tiktokCreatorInfo,
    tiktokToken,
    instagramAccount,
  };
}
