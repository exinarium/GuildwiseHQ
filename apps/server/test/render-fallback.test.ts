import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publishServerVersion } from '../src/commands/video-posts.ts';
import { RemoteWorker, remoteWorkerConfig } from '../src/video/remote-worker.ts';
import {
  RENDER_WORKER_SILENT_MS,
  renderWorkerWatch,
  SERVER_RENDER_NAME,
} from '../src/video/render-workers.ts';
import { type RenderFn, renderNext } from '../src/video/sweep.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import type { CaptureMailer } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { approvedPost, cleanVideo, fakeMp4, videoReady } from './helpers/render.ts';

/**
 * R23: the GPU worker is the production path and a CPU fallback is reported, never silent: the badge on the Render
 * workers card, the health entry in the video status, one mail per worker per 24 h, and `video_renders.encoder`.
 */

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
let t: TestApp;
let videoDir: string;
let sa: { id: string; cookie: string; mailer: CaptureMailer };
const admin = (method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: sa.cookie, ...(body !== undefined ? { body } : {}) });
const call = (token: string, method: string, url: string, body?: unknown) =>
  t.app.inject({
    method: method as 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
const claim = (token: string, encoder: 'nvenc' | 'cpu', encoderReason?: string) =>
  call(token, 'POST', '/api/render/jobs/claim', { version: '2.0.0', encoder, encoderReason });
const cpuMails = () => sa.mailer.sent.filter((m) => /renders on the CPU/.test(m.subject));
async function addWorker(name: string) {
  const r = await admin('POST', '/api/platform/render-workers', { name });
  expect(r.status).toBe(201);
  return { id: r.body.worker.id as string, token: r.body.token as string };
}
const workerCard = async (id: string) =>
  (await admin('GET', '/api/platform/render-workers')).body.workers.find((w: { id: string }) => w.id === id);
const health = async (name: string) =>
  (await admin('GET', '/api/platform/video/status')).body.renderWorkers.find(
    (w: { name: string }) => w.name === name,
  );

beforeAll(async () => {
  videoDir = mkdtempSync(join(tmpdir(), 'render-fallback-'));
  t = await createTestApp({
    env: {
      AOM_VIDEO_DIR: videoDir,
      AOM_YOUTUBE_CLIENT_ID: 'cid',
      AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
      AOM_VIDEO_WORKER_TOKEN: 'push-endpoint-switch-0123456789abcdef',
    },
  });
  sa = await videoReady(t);
});
afterAll(async () => {
  rmSync(videoDir, { recursive: true, force: true });
  await t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  const s = await t.superAdminSession();
  sa = { ...sa, id: s.id, cookie: s.cookie };
  sa.mailer.sent.length = 0;
  await cleanVideo();
  await q('DELETE FROM render_workers');
  await publishServerVersion(t.app.ctx, '2.0.0');
});

describe('a worker on the CPU is never silent', () => {
  it('a cpu claim after nvenc sets the badge, the health entry and one mail per 24 h', async () => {
    const w = await addWorker('devbox');
    expect((await claim(w.token, 'nvenc')).statusCode).toBe(204);
    expect(await workerCard(w.id)).toMatchObject({ encoder: 'nvenc', encoderReason: null, warning: false });
    expect(await health('devbox')).toMatchObject({ encoder: 'nvenc', warning: false });
    expect(cpuMails()).toEqual([]);

    const reason = 'libnvidia-encode.so.1 is missing: install libnvidia-encode-595 on the host';
    expect((await claim(w.token, 'cpu', reason)).statusCode).toBe(204);
    expect(await workerCard(w.id)).toMatchObject({ encoder: 'cpu', encoderReason: reason, warning: true });
    expect(await health('devbox')).toMatchObject({ encoder: 'cpu', reason, warning: true });
    const mails = cpuMails();
    // one alert (each super admin gets a copy)
    expect(new Set(mails.map((m) => m.subject))).toEqual(
      new Set(['Render worker devbox renders on the CPU']),
    );
    const perAdmin = mails.length;
    expect(perAdmin).toBeGreaterThan(0);
    expect(mails[0]?.html ?? mails[0]?.text).toContain(reason);
    const logged = await q(
      `SELECT outcome FROM render_worker_log WHERE worker_id=$1 AND action='encoder' ORDER BY id`,
      [w.id],
    );
    expect(logged.map((l) => l.outcome)).toEqual(['nvenc', `fallback to cpu: ${reason}`]);

    // back to nvenc and down again within the day: the badge follows, no second mail
    await claim(w.token, 'nvenc');
    await claim(w.token, 'cpu', 'no NVIDIA GPU is visible to the worker');
    expect((await workerCard(w.id)).warning).toBe(true);
    expect(cpuMails()).toHaveLength(perAdmin);

    // a day later it mails again
    t.clock.advance(24 * 3_600_000 + 60_000);
    const s = await t.superAdminSession();
    sa = { ...sa, cookie: s.cookie };
    await claim(w.token, 'nvenc');
    await claim(w.token, 'cpu', 'AOM_VIDEO_GPU=off');
    expect(cpuMails().length).toBeGreaterThan(perAdmin);
  });

  it('a worker that starts on the CPU is flagged too (no NVENC at all)', async () => {
    const w = await addWorker('cpu-only');
    await claim(w.token, 'cpu', 'AOM_VIDEO_GPU=off');
    expect(await workerCard(w.id)).toMatchObject({ encoder: 'cpu', warning: true });
    expect(cpuMails().length).toBeGreaterThan(0);
  });
});

describe('video_renders.encoder records what each render used', () => {
  async function renderWith(token: string, ref: string, encoder?: 'nvenc' | 'cpu' | 'cpu_fallback') {
    await approvedPost(t, sa.cookie, ref);
    const job = (await claim(token, 'nvenc')).json();
    const video = fakeMp4(60);
    const up = await t.app.inject({
      method: 'PUT',
      url: job.uploadUrls['video.mp4'],
      payload: video,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha(video),
        'x-worker-version': '2.0.0',
      },
    });
    expect(up.statusCode).toBe(200);
    const done = await call(token, 'POST', `/api/render/jobs/${job.renderId}/complete`, {
      attempt: 1,
      bytes: video.length,
      artifacts: { 'video.mp4': { sha256: sha(video), size: video.length } },
      ...(encoder ? { encoder } : {}),
    });
    expect(done.json()).toEqual({ status: 'rendered' });
    return (await q('SELECT encoder FROM video_renders WHERE id=$1', [job.renderId]))[0]?.encoder;
  }

  it('nvenc, and cpu_fallback (which also flags the worker and mails)', async () => {
    const w = await addWorker('gpu');
    expect(await renderWith(w.token, 'enc-nvenc', 'nvenc')).toBe('nvenc');
    expect(cpuMails()).toEqual([]);
    await cleanVideo();
    expect(await renderWith(w.token, 'enc-fallback', 'cpu_fallback')).toBe('cpu_fallback');
    expect(await workerCard(w.id)).toMatchObject({ encoder: 'cpu', warning: true });
    expect(cpuMails().length).toBeGreaterThan(0);
    expect(cpuMails()[0]?.subject).toBe('Render worker gpu renders on the CPU');
  });

  it("without the field the worker's reported encoder is recorded", async () => {
    const w = await addWorker('quiet');
    expect(await renderWith(w.token, 'enc-default')).toBe('nvenc');
  });
});

describe('the remote worker falls back at run time', () => {
  it('NVENC failing mid-render: the render still succeeds as cpu_fallback, the worker reports cpu from then on', async () => {
    const w = await addWorker('devbox-gpu');
    const post = await approvedPost(t, sa.cookie, 'runtime-fallback');
    const scratch = mkdtempSync(join(tmpdir(), 'render-fallback-worker-'));
    const base = await t.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      writeFileSync(join(scratch, 'token'), w.token, { mode: 0o400 });
      const lines: string[] = [];
      const reads: string[] = [];
      const cfg = remoteWorkerConfig(
        {
          AOM_RENDER_SERVER_URL: base,
          AOM_RENDER_WORKER_TOKEN_FILE: join(scratch, 'token'),
          AOM_VIDEO_DIR: scratch,
        },
        (p) => {
          reads.push(p);
          return readFileSync(p, 'utf8');
        },
      );
      expect(reads).toEqual([join(scratch, 'token')]);
      const worker = new RemoteWorker(cfg, {
        detect: async () => ({ encoder: 'nvenc', reason: null, bin: '/opt/ffmpeg-gpu/bin/ffmpeg' }),
        log: (l) => lines.push(l),
        version: '2.0.0',
        push: { sleep: async () => {}, backoffMs: [0] },
        render: async (_script, opts) => {
          expect(opts.gpu).toEqual({ bin: '/opt/ffmpeg-gpu/bin/ffmpeg' });
          opts.onGpuFailure('NVENC failed: OpenEncodeSessionEx failed: out of memory');
          mkdirSync(opts.outDir, { recursive: true });
          const video = join(opts.outDir, 'video.mp4');
          writeFileSync(video, fakeMp4(45));
          return { artifacts: { video }, durationSeconds: 45, bytes: 1, encoder: 'cpu_fallback' };
        },
      });
      await worker.start();
      expect((await worker.tick()).outcome).toBe('rendered');
      expect((await q('SELECT status, encoder FROM video_renders WHERE post_id=$1', [post.id]))[0]).toEqual({
        status: 'rendered',
        encoder: 'cpu_fallback',
      });
      expect(worker.currentEncoder.encoder).toBe('cpu');
      expect(await workerCard(w.id)).toMatchObject({ encoder: 'cpu', warning: true });
      expect((await workerCard(w.id)).encoderReason).toMatch(/OpenEncodeSessionEx/);
      // the next claim says cpu (until the worker restarts)
      expect((await worker.tick()).outcome).toBe('idle');
      expect((await workerCard(w.id)).encoder).toBe('cpu');
      // the token was read from the file and never logged
      expect(lines.join('\n')).not.toContain(w.token);
      expect(lines.some((l) => /render worker: encoder cpu \(NVENC failed during a render/.test(l))).toBe(
        true,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('no render worker seen while renders wait', () => {
  it('mails once (per 24 h) after 30 min of silence with a render waiting; nothing without workers or waiting renders', async () => {
    const silentMails = () => sa.mailer.sent.filter((m) => /No render worker is running/.test(m.subject));
    // no workers at all (self-hosted in-process path): nothing
    await approvedPost(t, sa.cookie, 'silent-1');
    expect((await renderWorkerWatch(t.app.ctx)).alerted).toBe(false);
    const w = await addWorker('sleepy');
    await claim(w.token, 'nvenc'); // seen now; it claims the waiting render, so free it again
    await q(`UPDATE video_renders SET status='queued', attempts=0, lease_until=NULL, worker_id=NULL`);
    expect((await renderWorkerWatch(t.app.ctx)).alerted).toBe(false);
    t.clock.advance(RENDER_WORKER_SILENT_MS + 60_000);
    expect((await renderWorkerWatch(t.app.ctx)).alerted).toBe(true);
    expect(silentMails().length).toBeGreaterThan(0);
    const n = silentMails().length;
    expect((await renderWorkerWatch(t.app.ctx)).alerted).toBe(false);
    expect(silentMails()).toHaveLength(n);
  });

  it('prunes worker log rows older than 90 days', async () => {
    await q(
      `INSERT INTO render_worker_log (at, worker_id, action, outcome) VALUES ($1, NULL, 'claim', 'old'), ($2, NULL, 'claim', 'new')`,
      [new Date(t.clock.now().getTime() - 91 * 86_400_000), t.clock.now()],
    );
    await renderWorkerWatch(t.app.ctx);
    expect(
      (await q(`SELECT outcome FROM render_worker_log WHERE outcome IN ('old','new')`)).map((r) => r.outcome),
    ).toEqual(['new']);
  });
});

describe('an emergency render on the server is a CPU fallback too (coordinator decision)', () => {
  const fakeRender: RenderFn = async (_s, { outDir }) => {
    mkdirSync(outDir, { recursive: true });
    const f = (n: string) => {
      const p = join(outDir, n);
      writeFileSync(p, n);
      return p;
    };
    return {
      artifacts: {
        video: f('video.mp4'),
        captionsVtt: f('captions.vtt'),
        captionsSrt: f('captions.srt'),
        thumb: null,
        script: f('script.json'),
        description: f('description.txt'),
        log: f('render.log'),
      },
      durationSeconds: 60,
      bytes: 9,
    };
  };
  const serverEntry = async () =>
    (await admin('GET', '/api/platform/video/status')).body.renderWorkers.find(
      (w: { name: string }) => w.name === SERVER_RENDER_NAME,
    );

  it('with AOM_ALLOW_SERVER_RENDER=true: the warning entry in the video status and one mail a day', async () => {
    const emergency = await createTestApp({
      env: {
        AOM_VIDEO_DIR: videoDir,
        AOM_YOUTUBE_CLIENT_ID: 'cid',
        AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
        AOM_ALLOW_SERVER_RENDER: 'true',
      },
      reset: false,
    });
    try {
      emergency.app.ctx.mailer = sa.mailer;
      emergency.app.ctx.youtube = t.app.ctx.youtube;
      // one clock for both apps (the suites above moved the main one on by a day)
      (emergency.app.ctx as { clock: typeof t.app.ctx.clock }).clock = t.app.ctx.clock;
      await approvedPost(t, sa.cookie, 'server-render-1');
      expect(await renderNext(emergency.app.ctx, { render: fakeRender, version: '2.0.0' })).toBe(true);
      expect(await serverEntry()).toMatchObject({ encoder: 'cpu', warning: true });
      expect((await serverEntry()).reason).toMatch(/AOM_ALLOW_SERVER_RENDER/);
      const mails = cpuMails();
      expect(new Set(mails.map((m) => m.subject))).toEqual(
        new Set([`Render worker ${SERVER_RENDER_NAME} renders on the CPU`]),
      );
      const n = mails.length;
      // a second server render the same day: still flagged, no second mail (the mail claim row is kept)
      await q('DELETE FROM social_shares');
      await q('DELETE FROM video_renders');
      await q('DELETE FROM video_posts');
      await approvedPost(t, sa.cookie, 'server-render-2');
      expect(await renderNext(emergency.app.ctx, { render: fakeRender, version: '2.0.0' })).toBe(true);
      expect(cpuMails()).toHaveLength(n);
      // the entry goes after a day without server renders
      t.clock.advance(24 * 3_600_000 + 60_000);
      const s = await t.superAdminSession();
      sa = { ...sa, cookie: s.cookie };
      expect(await serverEntry()).toBeUndefined();
    } finally {
      await emergency.close();
    }
  });

  it('without the switch an in-process render (a self-hoster) is not reported', async () => {
    await q(`DELETE FROM platform_settings WHERE key='render_server_fallback'`);
    await approvedPost(t, sa.cookie, 'server-render-self');
    expect(await renderNext(t.app.ctx, { render: fakeRender, version: '2.0.0' })).toBe(true);
    expect(await serverEntry()).toBeUndefined();
    expect(cpuMails()).toEqual([]);
  });
});
