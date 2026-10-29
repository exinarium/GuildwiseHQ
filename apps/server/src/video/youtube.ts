import { open, readFile, stat } from 'node:fs/promises';

/**
 * The only code that talks to YouTube and Google's token endpoint. Everything else (and every test) goes through the
 * `YouTubeClient` interface, so no test ever reaches Google. One scope is requested by the owner when the refresh token
 * is made: `https://www.googleapis.com/auth/youtube.force-ssl` (it covers videos.insert, thumbnails.set, captions.insert
 * and playlistItems.insert).
 *
 * Quota (since 2026-06-01): videos.insert has its own bucket of 100 calls a day, the other calls share 10,000 units a day
 * (thumbnails.set about 50, captions.insert 400, playlistItems.insert 50, videos.list 1): about 500 units a video, and the
 * worker uploads at most one video a day.
 */

export type YouTubeErrorKind =
  /** The refresh token or the scope is refused: the channel needs a reconnect. */
  | 'auth'
  /** Network error, 5xx, 429 or a quota: try again later. */
  | 'retry'
  /** This request can never work (400, 404, ...). */
  | 'final'
  /** The access token was refused mid-session (they last an hour): mint another and try again before concluding anything. */
  | 'unauthorized'
  /** Our own OAuth client is wrong (AOM_YOUTUBE_CLIENT_ID / SECRET): a configuration error, not a reason to reconnect. */
  | 'config'
  /** The channel may not do this (an unverified channel setting a custom thumbnail): skip the step with a warning. */
  | 'forbidden';

export class YouTubeError extends Error {
  constructor(
    readonly kind: YouTubeErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface YouTubeChannelInfo {
  id: string;
  title: string;
  /** Phone-verified (long uploads allowed): custom thumbnails need it. Null when YouTube did not say. */
  verified: boolean | null;
}

export interface UploadSpec {
  filePath: string;
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    defaultLanguage: string;
    defaultAudioLanguage: string;
  };
  status: {
    privacyStatus: 'public' | 'unlisted' | 'private';
    /** Scheduled publishing: the video is uploaded private and YouTube makes it public at this ISO time. */
    publishAt?: string;
    selfDeclaredMadeForKids: false;
    containsSyntheticMedia: false;
  };
  /** A session left by an interrupted upload of this video: the upload continues instead of starting over. */
  sessionUri?: string | undefined;
  /** Called once the upload session exists, so a crash can resume it. */
  onSession?: (uri: string) => Promise<void> | void;
  /** Called after every chunk (the worker's heartbeat: an upload of a big file takes minutes). */
  onProgress?: () => Promise<void> | void;
}

export interface YouTubeVideoStatus {
  privacyStatus: string;
  uploadStatus: string | null;
  /** Set when the video is scheduled. */
  publishAt: string | null;
  rejectionReason: string | null;
  failureReason: string | null;
}

export interface YouTubeClient {
  /** A short-lived access token for the refresh token (`auth` error on invalid_grant). */
  accessToken(creds: YouTubeCredentials): Promise<string>;
  /** channels.list mine=true: the channel the token belongs to. */
  channelMine(accessToken: string): Promise<YouTubeChannelInfo>;
  /** videos.insert, resumable. Resumes after a 5xx or a dropped connection. */
  upload(accessToken: string, spec: UploadSpec): Promise<{ videoId: string }>;
  setThumbnail(accessToken: string, videoId: string, filePath: string): Promise<void>;
  insertCaption(accessToken: string, videoId: string, vttPath: string, language: string): Promise<void>;
  addToPlaylist(accessToken: string, playlistId: string, videoId: string): Promise<void>;
  /**
   * After a dead upload session: did the video get uploaded anyway? Looks at the channel's newest uploads (uploads playlist)
   * for the title, published since `since`. Null when there is none.
   */
  findRecentUpload(accessToken: string, title: string, since: Date): Promise<string | null>;
  /** videos.list part=status. Null when the video is gone. */
  videoStatus(accessToken: string, videoId: string): Promise<YouTubeVideoStatus | null>;
  /** videos.update part=status: make a video public now (its `publishAt` slipped into the past while the upload ran). */
  makePublic(accessToken: string, videoId: string): Promise<void>;
}

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** A multiple of 256 KiB, as the resumable protocol wants. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_FAILURES = 8;

type FetchLike = typeof fetch;

export interface YouTubeClientOptions {
  fetch?: FetchLike;
  /** Back-off between upload retries (tests pass an instant one). */
  sleep?: (ms: number) => Promise<void>;
  chunkBytes?: number;
}

function reason(body: string): string {
  try {
    const j = JSON.parse(body) as {
      error?: { errors?: Array<{ reason?: string }>; message?: string } | string;
    };
    if (typeof j.error === 'string') return j.error;
    return j.error?.errors?.[0]?.reason ?? j.error?.message ?? '';
  } catch {
    return '';
  }
}

function classify(status: number, body: string): YouTubeError {
  const why = reason(body);
  const msg = `HTTP ${status}${why ? ` ${why}` : ''}: ${body.slice(0, 240)}`;
  // Only the token endpoint's invalid_grant means "reconnect". An API call that answers 401 is handled by minting a new access
  // token; a 403 is the channel not being allowed (or the project lacking quota or the API), never a dead refresh token.
  if (status === 401) return new YouTubeError('unauthorized', msg, status);
  if (status === 429 || status >= 500) return new YouTubeError('retry', msg, status);
  if (status === 403) {
    if (/quota|rateLimit|uploadLimit|dailyLimit/i.test(why)) return new YouTubeError('retry', msg, status);
    if (/insufficientPermissions/i.test(why))
      return new YouTubeError(
        'final',
        `${msg} (the refresh token lacks the youtube.force-ssl scope)`,
        status,
      );
    return new YouTubeError('forbidden', msg, status);
  }
  return new YouTubeError('final', msg, status);
}

export function createYouTubeClient(opts: YouTubeClientOptions = {}): YouTubeClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK_BYTES;

  async function call(url: string, init: RequestInit, timeoutMs = 30_000) {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, body: await res.text(), headers: res.headers };
    } catch (err) {
      throw new YouTubeError('retry', `network error: ${(err as Error).message}`);
    }
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function json<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
    const r = await call(url, { ...init, headers: { ...auth(token), ...(init.headers ?? {}) } });
    if (r.status >= 300) throw classify(r.status, r.body);
    return (r.body ? JSON.parse(r.body) : {}) as T;
  }

  /** PUT one chunk. Returns the finished video, or the next offset the server expects. */
  async function putChunk(
    session: string,
    token: string,
    total: number,
    start: number,
    data: Buffer | null,
  ): Promise<{ done: true; videoId: string } | { done: false; next: number }> {
    const end = data ? start + data.length - 1 : -1;
    const range = data ? `bytes ${start}-${end}/${total}` : `bytes */${total}`;
    const r = await call(
      session,
      {
        method: 'PUT',
        headers: { ...auth(token), 'content-length': String(data?.length ?? 0), 'content-range': range },
        ...(data ? { body: new Uint8Array(data) } : {}),
      },
      180_000,
    );
    if (r.status === 200 || r.status === 201) {
      const id = (JSON.parse(r.body) as { id?: string }).id;
      if (!id) throw new YouTubeError('final', 'upload finished but the response has no video id');
      return { done: true, videoId: id };
    }
    if (r.status === 308) {
      const m = /bytes=0-(\d+)/.exec(r.headers.get('range') ?? '');
      return { done: false, next: m ? Number(m[1]) + 1 : 0 };
    }
    if (r.status === 404 || r.status === 410)
      throw new YouTubeError('retry', 'the upload session expired', r.status);
    throw classify(r.status, r.body);
  }

  async function startSession(token: string, spec: UploadSpec, size: number): Promise<string> {
    const r = await call(`${UPLOAD}/videos?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        ...auth(token),
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify({ snippet: spec.snippet, status: spec.status }),
    });
    if (r.status >= 300) throw classify(r.status, r.body);
    const loc = r.headers.get('location');
    if (!loc) throw new YouTubeError('retry', 'YouTube returned no upload location');
    return loc;
  }

  return {
    async accessToken(creds) {
      const r = await call(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: creds.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
      if (r.status >= 300) {
        const why = reason(r.body);
        // invalid_grant: revoked, expired (7 days in Testing mode, 6 months unused) or over the 100 tokens a client may have
        if (/invalid_grant/i.test(why))
          throw new YouTubeError('auth', `Google refused the refresh token (${why})`, r.status);
        if (/invalid_client|unauthorized_client|invalid_request/i.test(why) || r.status === 401)
          throw new YouTubeError(
            'config',
            `Google refused the OAuth client (${why || r.status}): check AOM_YOUTUBE_CLIENT_ID and AOM_YOUTUBE_CLIENT_SECRET`,
            r.status,
          );
        throw classify(r.status, r.body);
      }
      const token = (JSON.parse(r.body) as { access_token?: string }).access_token;
      if (!token) throw new YouTubeError('final', 'Google returned no access token');
      return token;
    },

    async channelMine(token) {
      const j = await json<{
        items?: Array<{
          id: string;
          snippet?: { title?: string };
          status?: { longUploadsStatus?: string; isLinked?: boolean };
        }>;
      }>(`${API}/channels?part=snippet,status&mine=true`, token);
      const c = j.items?.[0];
      if (!c) throw new YouTubeError('final', 'this Google account has no YouTube channel');
      const lu = c.status?.longUploadsStatus;
      return {
        id: c.id,
        title: c.snippet?.title ?? c.id,
        verified: lu === undefined ? null : lu === 'allowed',
      };
    },

    async upload(token, spec) {
      const size = (await stat(spec.filePath)).size;
      let session = spec.sessionUri;
      if (!session) {
        session = await startSession(token, spec, size);
        await spec.onSession?.(session);
      }
      const fh = await open(spec.filePath, 'r');
      try {
        let offset = 0;
        let failures = 0;
        let probe = !!spec.sessionUri; // a resumed session first asks how far it got
        for (;;) {
          try {
            if (probe) {
              const r = await putChunk(session, token, size, 0, null);
              if (r.done) return { videoId: r.videoId };
              offset = r.next;
              probe = false;
            }
            const len = Math.min(chunkBytes, size - offset);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, offset);
            const r = await putChunk(session, token, size, offset, buf);
            failures = 0;
            await spec.onProgress?.();
            if (r.done) return { videoId: r.videoId };
            offset = r.next;
          } catch (err) {
            if (
              !(err instanceof YouTubeError) ||
              err.kind !== 'retry' ||
              err.status === 404 ||
              err.status === 410
            )
              throw err;
            if (++failures > MAX_CHUNK_FAILURES) throw err;
            // 5xx or a dropped connection: wait, ask the server how much it has, continue from there
            await sleep(Math.min(2 ** failures * 500, 30_000));
            probe = true;
          }
        }
      } finally {
        await fh.close();
      }
    },

    async setThumbnail(token, videoId, filePath) {
      const r = await call(
        `${UPLOAD}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
        {
          method: 'POST',
          headers: { ...auth(token), 'content-type': 'image/png' },
          body: new Uint8Array(await readFile(filePath)),
        },
      );
      if (r.status >= 300) throw classify(r.status, r.body);
    },

    async insertCaption(token, videoId, vttPath, language) {
      const boundary = `aom${Date.now().toString(36)}`;
      const meta = JSON.stringify({ snippet: { videoId, language, name: 'English', isDraft: false } });
      const vtt = await readFile(vttPath, 'utf8');
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: text/vtt\r\n\r\n${vtt}\r\n--${boundary}--`;
      const r = await call(`${UPLOAD}/captions?uploadType=multipart&part=snippet`, {
        method: 'POST',
        headers: { ...auth(token), 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
      if (r.status >= 300) throw classify(r.status, r.body);
    },

    async addToPlaylist(token, playlistId, videoId) {
      await json(`${API}/playlistItems?part=snippet`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
        }),
      });
    },

    async findRecentUpload(token, title, since) {
      const ch = await json<{
        items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
      }>(`${API}/channels?part=contentDetails&mine=true`, token);
      const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return null;
      const pl = await json<{
        items?: Array<{
          snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } };
        }>;
      }>(`${API}/playlistItems?part=snippet&maxResults=10&playlistId=${encodeURIComponent(uploads)}`, token);
      const hit = pl.items?.find(
        (i) =>
          i.snippet?.title === title &&
          i.snippet.resourceId?.videoId &&
          Date.parse(i.snippet.publishedAt ?? '') >= since.getTime(),
      );
      return hit?.snippet?.resourceId?.videoId ?? null;
    },

    async videoStatus(token, videoId) {
      const j = await json<{
        items?: Array<{
          status?: {
            privacyStatus?: string;
            uploadStatus?: string;
            publishAt?: string;
            rejectionReason?: string;
            failureReason?: string;
          };
        }>;
      }>(`${API}/videos?part=status&id=${encodeURIComponent(videoId)}`, token);
      const s = j.items?.[0]?.status;
      if (!s) return null;
      return {
        privacyStatus: s.privacyStatus ?? 'unknown',
        uploadStatus: s.uploadStatus ?? null,
        publishAt: s.publishAt ?? null,
        rejectionReason: s.rejectionReason ?? null,
        failureReason: s.failureReason ?? null,
      };
    },

    async makePublic(token, videoId) {
      await json(`${API}/videos?part=status`, token, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: videoId,
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
        }),
      });
    },
  };
}

export const watchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;
