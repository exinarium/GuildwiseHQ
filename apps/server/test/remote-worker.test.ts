import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EncoderChoice } from '@aom/video';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishServerVersion } from '../src/commands/video-posts.ts';
import type { Row } from '../src/db/sql.ts';
import { pushArtifacts, pushFile } from '../src/video/push-client.ts';
import {
  type RemoteRenderFn,
  RemoteWorker,
  type RemoteWorkerConfig,
  remoteWorkerConfig,
} from '../src/video/remote-worker.ts';
import { addRenderWorker } from '../src/video/render-workers.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { approvedPost, cleanVideo, fakeMp4, videoReady } from './helpers/render.ts';

/** R16: the remote render worker (`video-worker --remote`) against the real job API, with a fake render. */

const TOKEN = 'aomv_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const NVENC: EncoderChoice = { encoder: 'nvenc', reason: null, bin: '/opt/ffmpeg-gpu/bin/ffmpeg' };

describe('configuration', () => {
  const ok = { AOM_RENDER_SERVER_URL: 'https://render.example.com/', AOM_RENDER_WORKER_TOKEN: TOKEN };

  it('reads the token from the file once and prefers it over the variable', () => {
    const reads: string[] = [];
    const cfg = remoteWorkerConfig(
      {
        ...ok,
        AOM_RENDER_WORKER_TOKEN: 'aomv_other',
        AOM_RENDER_WORKER_TOKEN_FILE: '/run/secrets/render-token',
      },
      (p) => {
        reads.push(p);
        return `${TOKEN}\n`;
      },
    );
    expect(cfg).toEqual({
      serverUrl: 'https://render.example.com',
      token: TOKEN,
      videoDir: '/data/video',
      encodeThreads: undefined,
    });
    expect(reads).toEqual(['/run/secrets/render-token']);
  });

  it('refuses DATABASE_URL and AOM_SECRET_KEY (the retired tunnel mode)', () => {
    expect(() => remoteWorkerConfig({ ...ok, DATABASE_URL: 'postgres://x' })).toThrow(/DATABASE_URL is set/);
    expect(() => remoteWorkerConfig({ ...ok, AOM_SECRET_KEY: 'k'.repeat(40) })).toThrow(
      /AOM_SECRET_KEY is set/,
    );
  });

  it('refuses plain http (loopback excepted) and NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
    expect(() => remoteWorkerConfig({ ...ok, AOM_RENDER_SERVER_URL: 'http://render.example.com' })).toThrow(
      /must be https/,
    );
    expect(() => remoteWorkerConfig({ ...ok, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toThrow(
      /NODE_TLS_REJECT_UNAUTHORIZED=0 is refused/,
    );
    expect(remoteWorkerConfig({ ...ok, AOM_RENDER_SERVER_URL: 'http://127.0.0.1:4600' }).serverUrl).toBe(
      'http://127.0.0.1:4600',
    );
  });

  it('refuses a missing or foreign token and never echoes it', () => {
    expect(() => remoteWorkerConfig({ AOM_RENDER_SERVER_URL: ok.AOM_RENDER_SERVER_URL })).toThrow(
      /no worker token/,
    );
    let msg = '';
    try {
      remoteWorkerConfig({ ...ok, AOM_RENDER_WORKER_TOKEN: 'secret-looking-value-123' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/does not look like a render worker token/);
    expect(msg).not.toContain('secret-looking-value-123');
  });

  it('the worker module imports nothing that reaches the database or loads the server config', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/video/remote-worker.ts'), 'utf8');
    for (const banned of ["'../db/", "'../app.ts'", 'loadConfig', 'createApp', "'../context.ts'"])
      expect(src, banned).not.toContain(banned);
    const push = readFileSync(resolve(import.meta.dirname, '../src/video/push-client.ts'), 'utf8');
    expect(push).not.toMatch(/from '\.\.\/(db|app|config)/);
  });
});

describe('backoff', () => {
  const cfg: RemoteWorkerConfig = {
    serverUrl: 'https://render.example.com',
    token: TOKEN,
    videoDir: '/tmp',
    encodeThreads: undefined,
  };
  it('idle polls every 15 s; 429 and 5xx back off 15 s doubling up to 5 min; a good answer resets it', async () => {
    const answers = [503, 429, 502, 500, 500, 500, 500, 204, 503];
    const fetchFake = (async () => {
      const status = answers.shift() as number;
      return new Response(status === 204 ? null : 'busy', { status });
    }) as typeof fetch;
    const w = new RemoteWorker(cfg, { fetch: fetchFake, log: () => {}, version: '2.0.0' });
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) waits.push((await w.tick()).waitMs);
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 15_000, 15_000]);
  });

  it('a network error backs off too; a revoked token waits long and says so', async () => {
    const lines: string[] = [];
    const down = new RemoteWorker(cfg, {
      fetch: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
      log: (l) => lines.push(l),
    });
    expect(await down.tick()).toEqual({ outcome: 'backoff', waitMs: 15_000 });
    const refused = new RemoteWorker(cfg, {
      fetch: (async () =>
        new Response('{"error":{"code":"unauthenticated","message":"no"}}', { status: 401 })) as typeof fetch,
      log: (l) => lines.push(l),
    });
    expect((await refused.tick()).outcome).toBe('refused');
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});

describe('against the job API', () => {
  let t: TestApp;
  let videoDir: string;
  let scratch: string;
  let base: string;
  let sa: { id: string; cookie: string };
  let token: string;
  let workerId: string;

  const fakeRender =
    (seconds = 90, hook?: (opts: Parameters<RemoteRenderFn>[1]) => Promise<void> | void): RemoteRenderFn =>
    async (script, opts) => {
      await hook?.(opts);
      mkdirSync(opts.outDir, { recursive: true });
      const f = (name: string, body: Buffer | string) => {
        const p = join(opts.outDir, name);
        writeFileSync(p, body);
        return p;
      };
      return {
        artifacts: {
          video: f('video.mp4', fakeMp4(seconds)),
          captionsVtt: f('captions.vtt', 'WEBVTT\n'),
          captionsSrt: f('captions.srt', '1\n'),
          thumb: f('thumb.png', 'png'),
          script: f('script.json', JSON.stringify(script)),
          description: f('description.txt', 'desc'),
          log: f('render.log', 'ok'),
        },
        durationSeconds: 1,
        bytes: 1,
        encoder: opts.gpu ? 'nvenc' : 'cpu',
      };
    };

  beforeAll(async () => {
    videoDir = mkdtempSync(join(tmpdir(), 'remote-worker-vol-'));
    scratch = mkdtempSync(join(tmpdir(), 'remote-worker-scratch-'));
    t = await createTestApp({
      env: {
        AOM_VIDEO_DIR: videoDir,
        AOM_YOUTUBE_CLIENT_ID: 'cid',
        AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
        AOM_VIDEO_WORKER_TOKEN: 'push-endpoint-switch-0123456789abcdef',
      },
    });
    sa = await videoReady(t);
    base = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const w = await addRenderWorker(t.app.ctx, sa.id, 'devbox');
    token = w.token;
    workerId = w.worker.id;
  });
  afterAll(async () => {
    rmSync(videoDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    await t.close();
    await closeAdminPool();
  });
  beforeEach(async () => {
    await cleanVideo();
    await publishServerVersion(t.app.ctx, '2.0.0');
  });

  /** A worker whose environment is watched: it may only check that DATABASE_URL and AOM_SECRET_KEY are absent. */
  function worker(render: RemoteRenderFn, lines: string[] = []) {
    const reads: string[] = [];
    const env = new Proxy(
      {
        AOM_RENDER_SERVER_URL: base,
        AOM_RENDER_WORKER_TOKEN_FILE: join(scratch, 'token'),
        AOM_VIDEO_DIR: scratch,
      } as Record<string, string | undefined>,
      {
        get(target, key: string) {
          reads.push(key);
          return target[key];
        },
      },
    );
    rmSync(join(scratch, 'token'), { force: true });
    writeFileSync(join(scratch, 'token'), `${token}\n`, { mode: 0o400 });
    const cfg = remoteWorkerConfig(env);
    const w = new RemoteWorker(cfg, {
      render,
      detect: async () => NVENC,
      log: (l) => lines.push(l),
      version: '2.0.0',
      push: { sleep: async () => {}, backoffMs: [0] },
    });
    return { w, reads, lines };
  }

  it('claims, fetches the script, renders, uploads to the signed links and completes; no DB, no server key', async () => {
    const post = await approvedPost(t, sa.cookie, 'remote-ok');
    const seen: unknown[] = [];
    const { w, reads, lines } = worker(fakeRender(90, () => {}));
    await w.start();
    const r = await w.tick();
    expect(r.outcome).toBe('rendered');
    const row = (
      await q(
        'SELECT status, worker_id, encoder, duration_s, artifacts FROM video_renders WHERE post_id=$1',
        [post.id],
      )
    )[0] as Row;
    expect(row).toMatchObject({ status: 'rendered', worker_id: workerId, encoder: 'nvenc' });
    expect(Number(row.duration_s)).toBeCloseTo(90, 1);
    expect(Object.keys(row.artifacts).sort()).toEqual(
      ['captionsSrt', 'captionsVtt', 'description', 'log', 'script', 'thumb', 'video'].sort(),
    );
    expect(readFileSync(join(videoDir, post.id, '1', 'captions.vtt'), 'utf8')).toBe('WEBVTT\n');
    // only presence checks of the two keys, never their use
    expect(reads.filter((k) => k === 'DATABASE_URL')).toHaveLength(1);
    expect(reads.filter((k) => k === 'AOM_SECRET_KEY')).toHaveLength(1);
    // the encoder line render-worker.sh status reads, and never the token
    expect(lines[0]).toMatch(/render worker: encoder nvenc/);
    expect(lines.join('\n')).not.toContain(token);
    expect(seen).toEqual([]);
    // the local scratch copy is gone
    expect(
      (await import('node:fs')).existsSync(
        join(scratch, (await q('SELECT id FROM video_renders WHERE post_id=$1', [post.id]))[0]?.id),
      ),
    ).toBe(false);
  });

  it('a render error is reported with fail and the render goes back to the queue', async () => {
    const post = await approvedPost(t, sa.cookie, 'remote-fail');
    const { w } = worker(async () => {
      throw new Error('chromium crashed');
    });
    await w.start();
    expect((await w.tick()).outcome).toBe('failed');
    expect((await q('SELECT status, error FROM video_renders WHERE post_id=$1', [post.id]))[0]).toMatchObject(
      {
        status: 'queued',
        error: 'chromium crashed',
      },
    );
  });

  it('a server upgraded during a render refuses the files; the attempt is not counted', async () => {
    const post = await approvedPost(t, sa.cookie, 'remote-upgrade');
    const { w } = worker(fakeRender(90, () => publishServerVersion(t.app.ctx, '2.5.0')));
    await w.start();
    expect((await w.tick()).outcome).toBe('failed');
    expect(
      (await q('SELECT status, attempts, error FROM video_renders WHERE post_id=$1', [post.id]))[0],
    ).toMatchObject({
      status: 'queued',
      attempts: 0,
      error: 'video worker 2.0.0 is older than server 2.5.0; update the worker',
    });
  });

  it('a lost lease uploads nothing', async () => {
    const post = await approvedPost(t, sa.cookie, 'remote-lost');
    const { w } = worker(
      fakeRender(90, async () => {
        // another claim took the render over while this one rendered
        await q(`UPDATE video_renders SET attempts=attempts+1 WHERE post_id=$1`, [post.id]);
      }),
    );
    await w.start();
    expect((await w.tick()).outcome).toBe('failed');
    expect((await import('node:fs')).existsSync(join(videoDir, post.id, '1', 'video.mp4'))).toBe(false);
  });
});

describe('the upload client (push-client.ts): retries and backoff (review S3)', () => {
  // left in the run's temp folder: the client opens each file's stream lazily, after a fake fetch may have returned
  const dir = mkdtempSync(join(tmpdir(), 'push-client-'));
  const file = (name: string, body = 'bytes') => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  const answering = (statuses: number[], seen: string[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(
        `${String(input).split('/').pop()}:${(init?.headers as Record<string, string> | undefined)?.authorization}`,
      );
      (init?.body as { destroy?: () => void } | undefined)?.destroy?.(); // the fake reads no body
      const s = statuses.shift() ?? 200;
      return new Response(s === 200 ? '{"ok":true}' : 'busy', { status: s });
    }) as typeof fetch;

  it('retries a failed push with the backoff waits, then succeeds', async () => {
    const waits: number[] = [];
    const seen: string[] = [];
    await pushFile({ url: 'https://r.example/u/thumb.png', token: TOKEN }, file('thumb.png'), {
      fetch: answering([503, 429, 200], seen),
      sleep: async (ms) => {
        waits.push(ms);
      },
      backoffMs: [5, 10, 20],
    });
    expect(waits).toEqual([5, 10]);
    expect(seen).toEqual(Array(3).fill(`thumb.png:Bearer ${TOKEN}`));
  });

  it('a push that never succeeds throws after every attempt', async () => {
    const waits: number[] = [];
    await expect(
      pushFile({ url: 'https://r.example/u/x.mp4', token: TOKEN }, file('x.mp4'), {
        fetch: (async () => {
          throw new Error('connection refused');
        }) as typeof fetch,
        sleep: async (ms) => {
          waits.push(ms);
        },
        backoffMs: [1, 2],
      }),
    ).rejects.toThrow(/push of x\.mp4 failed after 3 attempts: connection refused/);
    expect(waits).toEqual([1, 2]);
  });

  it('a refusal (4xx other than 408/429) is not retried', async () => {
    let calls = 0;
    const counting = (async (_i: string | URL | Request, init?: RequestInit) => {
      (init?.body as { destroy?: () => void } | undefined)?.destroy?.();
      calls++;
      return new Response('{"error":{"code":"lease_lost"}}', { status: 409 });
    }) as typeof fetch;
    await expect(
      pushFile({ url: 'https://r.example/u/a.vtt', token: TOKEN }, file('a.vtt'), {
        fetch: counting,
        sleep: async () => {},
        backoffMs: [1, 1, 1],
      }),
    ).rejects.toThrow(/push of a\.vtt refused: HTTP 409/);
    expect(calls).toBe(1);
  });

  it('pushArtifacts sends the video last and every file to its own link', async () => {
    const seen: string[] = [];
    await pushArtifacts(
      { token: TOKEN, urlOf: (n) => `https://r.example/up/${n}` },
      [file('video.mp4'), file('captions.vtt'), file('render.log')],
      { fetch: answering([], seen), sleep: async () => {}, backoffMs: [] },
    );
    expect(seen.map((s) => s.split(':')[0])).toEqual(['captions.vtt', 'render.log', 'video.mp4']);
  });
});

describe('links from the server', () => {
  it('a link that resolves to another origin is refused (the token never leaves)', () => {
    const w = new RemoteWorker(
      { serverUrl: 'https://render.example.com', token: TOKEN, videoDir: '/tmp', encodeThreads: undefined },
      { log: () => {} },
    );
    expect(w.resolve('/api/render/jobs/x/input?sig=1')).toBe(
      'https://render.example.com/api/render/jobs/x/input?sig=1',
    );
    expect(() => w.resolve('//evil.example/steal')).toThrow(/another origin/);
    expect(() => w.resolve('https://evil.example/steal')).toThrow(/another origin/);
  });
});
