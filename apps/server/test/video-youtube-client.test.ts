import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createYouTubeClient, YouTubeError } from '../src/video/youtube.ts';

/** The resumable upload protocol of YouTube against a fake `fetch`: no Google is ever reached. */
const dir = mkdtempSync(join(tmpdir(), 'yt-client-'));
const file = join(dir, 'v.mp4');
writeFileSync(file, Buffer.alloc(1_000_000, 7));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spec = (over = {}) => ({
  filePath: file,
  snippet: {
    title: 't',
    description: 'd',
    tags: [],
    categoryId: '28',
    defaultLanguage: 'en',
    defaultAudioLanguage: 'en',
  },
  status: {
    privacyStatus: 'private' as const,
    selfDeclaredMadeForKids: false as const,
    containsSyntheticMedia: false as const,
  },
  ...over,
});
const res = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

describe('resumable upload', () => {
  it('starts a session, sends chunks, and resumes from the server offset after a 503', async () => {
    const seen: Array<{ method: string; range?: string; len?: number }> = [];
    let received = 0;
    let failedOnce = false;
    const fetchFake = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      if (String(url).includes('uploadType=resumable')) {
        expect(headers['x-upload-content-length']).toBe('1000000');
        expect(headers['x-upload-content-type']).toBe('video/mp4');
        return res(200, '', { location: 'https://upload.test/session1' });
      }
      const range = headers['content-range'] as string;
      seen.push({ method: init.method as string, range });
      if (range.startsWith('bytes */')) {
        // status query after the failure: the server has the first chunk
        return res(308, '', { range: `bytes=0-${received - 1}` });
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range) as RegExpExecArray;
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (start === 262144 * 2 && !failedOnce) {
        failedOnce = true;
        return res(503, 'backend error');
      }
      expect(start).toBe(received);
      received = end + 1;
      if (received >= Number(m[3])) return res(200, JSON.stringify({ id: 'abc123xyz' }));
      return res(308, '', { range: `bytes=0-${received - 1}` });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const client = createYouTubeClient({
      fetch: fetchFake,
      chunkBytes: 262144 * 2,
      sleep: async (ms) => void sleeps.push(ms),
    });
    const sessions: string[] = [];
    const r = await client.upload('tok', spec({ onSession: (u: string) => void sessions.push(u) }));
    expect(r.videoId).toBe('abc123xyz');
    expect(sessions).toEqual(['https://upload.test/session1']);
    expect(failedOnce).toBe(true);
    expect(sleeps).toHaveLength(1); // one back-off
    expect(received).toBe(1_000_000);
    // after the 503 it asked where it was and carried on from there, never from the start
    const afterFail = seen.slice(seen.findIndex((s) => s.range?.startsWith('bytes */')));
    expect(afterFail[1]?.range).toMatch(/^bytes 524288-/);
  });

  it('resumes a saved session by asking first, and gives up with a retry error after repeated 5xx', async () => {
    let n = 0;
    const fetchFake = (async () => {
      n++;
      return res(500, 'down');
    }) as unknown as typeof fetch;
    const client = createYouTubeClient({ fetch: fetchFake, sleep: async () => {} });
    await expect(client.upload('tok', spec({ sessionUri: 'https://upload.test/old' }))).rejects.toMatchObject(
      {
        kind: 'retry',
      },
    );
    expect(n).toBeGreaterThan(5);
  });

  it('classifies errors: invalid_grant is auth, quota is retry, a bad request is final', async () => {
    const mk = (status: number, body: string) =>
      createYouTubeClient({ fetch: (async () => res(status, body)) as unknown as typeof fetch });
    await expect(
      mk(400, '{"error":"invalid_grant"}').accessToken({
        clientId: 'a',
        clientSecret: 'b',
        refreshToken: 'c',
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
    await expect(
      mk(403, '{"error":{"errors":[{"reason":"quotaExceeded"}]}}').channelMine('t'),
    ).rejects.toMatchObject({
      kind: 'retry',
    });
    await expect(mk(400, '{"error":{"message":"bad"}}').videoStatus('t', 'x')).rejects.toBeInstanceOf(
      YouTubeError,
    );
  });

  it('reads channels.list and videos.list', async () => {
    const client = createYouTubeClient({
      fetch: (async (url: string) =>
        String(url).includes('/channels')
          ? res(
              200,
              JSON.stringify({
                items: [{ id: 'UC1', snippet: { title: 'Chan' }, status: { longUploadsStatus: 'allowed' } }],
              }),
            )
          : res(
              200,
              JSON.stringify({
                items: [
                  {
                    status: {
                      privacyStatus: 'private',
                      publishAt: '2026-11-03T08:00:00Z',
                      uploadStatus: 'processed',
                    },
                  },
                ],
              }),
            )) as unknown as typeof fetch,
    });
    expect(await client.channelMine('t')).toEqual({ id: 'UC1', title: 'Chan', verified: true });
    expect(await client.videoStatus('t', 'v')).toMatchObject({
      privacyStatus: 'private',
      publishAt: '2026-11-03T08:00:00Z',
    });
  });

  it('classifies for the sweep: only invalid_grant means reconnect', async () => {
    const mk = (status: number, body: string) =>
      createYouTubeClient({ fetch: (async () => res(status, body)) as unknown as typeof fetch });
    const creds = { clientId: 'a', clientSecret: 'b', refreshToken: 'c' };
    // an API call refused with 401: the access token expired (mint another), never "reconnect"
    await expect(
      mk(401, '{"error":{"message":"Invalid Credentials"}}').channelMine('t'),
    ).rejects.toMatchObject({ kind: 'unauthorized' });
    // a 403 with an empty body (or any reason but quota) is the channel not being allowed, not a dead token
    await expect(mk(403, '').channelMine('t')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(
      mk(403, '{"error":{"errors":[{"reason":"forbidden"}]}}').channelMine('t'),
    ).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(
      mk(403, '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}').channelMine('t'),
    ).rejects.toMatchObject({ kind: 'final' });
    // the token endpoint
    await expect(mk(400, '{"error":"invalid_grant"}').accessToken(creds)).rejects.toMatchObject({
      kind: 'auth',
    });
    await expect(mk(401, '{"error":"invalid_client"}').accessToken(creds)).rejects.toMatchObject({
      kind: 'config',
    });
    await expect(mk(400, '{"error":"unauthorized_client"}').accessToken(creds)).rejects.toMatchObject({
      kind: 'config',
    });
    await expect(mk(503, 'down').accessToken(creds)).rejects.toMatchObject({ kind: 'retry' });
  });

  it('reports progress after every chunk (the worker heartbeat)', async () => {
    let received = 0;
    const fetchFake = (async (url: string, init: RequestInit) => {
      if (String(url).includes('uploadType=resumable'))
        return res(200, '', { location: 'https://upload.test/s' });
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(
        (init.headers as Record<string, string>)['content-range'] as string,
      ) as RegExpExecArray;
      received = Number(m[2]) + 1;
      return received >= Number(m[3])
        ? res(200, JSON.stringify({ id: 'vid' }))
        : res(308, '', { range: `bytes=0-${received - 1}` });
    }) as unknown as typeof fetch;
    let beats = 0;
    const client = createYouTubeClient({ fetch: fetchFake, chunkBytes: 262144 });
    await client.upload('t', spec({ onProgress: () => void beats++ }));
    expect(beats).toBe(Math.ceil(1_000_000 / 262144));
  });

  it('finds an upload that finished although its session looked dead', async () => {
    const client = createYouTubeClient({
      fetch: (async (url: string) =>
        String(url).includes('/channels')
          ? res(
              200,
              JSON.stringify({ items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] }),
            )
          : res(
              200,
              JSON.stringify({
                items: [
                  {
                    snippet: {
                      title: 'Other',
                      publishedAt: '2026-10-28T10:00:00Z',
                      resourceId: { videoId: 'no1' },
                    },
                  },
                  {
                    snippet: {
                      title: 'My video',
                      publishedAt: '2026-10-28T10:05:00Z',
                      resourceId: { videoId: 'yes1' },
                    },
                  },
                  {
                    snippet: {
                      title: 'My video',
                      publishedAt: '2026-01-01T10:05:00Z',
                      resourceId: { videoId: 'old1' },
                    },
                  },
                ],
              }),
            )) as unknown as typeof fetch,
    });
    expect(await client.findRecentUpload('t', 'My video', new Date('2026-10-28T09:00:00Z'))).toBe('yes1');
    expect(await client.findRecentUpload('t', 'Missing', new Date('2026-10-28T09:00:00Z'))).toBeNull();
  });
});
