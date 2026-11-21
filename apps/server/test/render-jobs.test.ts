import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redactUrl, requestLogSerializer } from '../src/app.ts';
import { publishServerVersion } from '../src/commands/video-posts.ts';
import type { Row } from '../src/db/sql.ts';
import { refuseRetiredPushMode } from '../src/video/remote-worker.ts';
import { renderNext } from '../src/video/sweep.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { approvedPost, cleanVideo, fakeMp4, videoReady } from './helpers/render.ts';

/** R16: the render job API (claim, input, uploads, heartbeat, complete, fail) and the super admin's worker list. */

const PUSH_SWITCH = 'push-endpoint-switch-0123456789abcdef';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let t: TestApp;
let videoDir: string;
let sa: { id: string; cookie: string };
const admin = (method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: sa.cookie, ...(body !== undefined ? { body } : {}) });

async function addWorker(name = 'devbox'): Promise<{ id: string; token: string }> {
  const r = await admin('POST', '/api/platform/render-workers', { name });
  expect(r.status).toBe(201);
  return { id: r.body.worker.id, token: r.body.token };
}
const call = (token: string | null, method: string, url: string, body?: unknown) =>
  t.app.inject({
    method: method as 'GET',
    url,
    headers: {
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
const claim = (token: string, body: Record<string, unknown> = {}) =>
  call(token, 'POST', '/api/render/jobs/claim', { version: '2.0.0', encoder: 'nvenc', ...body });
const upload = (token: string | null, url: string, body: Buffer | string) =>
  t.app.inject({
    method: 'PUT',
    url,
    payload: body,
    headers: {
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/octet-stream',
      'x-content-sha256': sha(body),
      'x-worker-version': '2.0.0',
    },
  });
const renderRow = async (id: string) => (await q('SELECT * FROM video_renders WHERE id=$1', [id]))[0] as Row;

beforeAll(async () => {
  videoDir = mkdtempSync(join(tmpdir(), 'render-jobs-'));
  t = await createTestApp({
    env: {
      AOM_VIDEO_DIR: videoDir,
      AOM_YOUTUBE_CLIENT_ID: 'cid',
      AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
      AOM_VIDEO_WORKER_TOKEN: PUSH_SWITCH,
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
  // the suites move the clock on: a fresh session keeps "Confirm it's you" fresh for the worker writes
  const s = await t.superAdminSession();
  sa = { id: s.id, cookie: s.cookie };
  await cleanVideo();
  await publishServerVersion(t.app.ctx, '2.0.0');
  await q('DELETE FROM render_worker_log');
});

describe('workers: add, list, revoke', () => {
  it('the token is shown once (aomv_ prefix), only its sha256 is stored, and both events reach the platform audit', async () => {
    const w = await addWorker('gpu box');
    expect(w.token).toMatch(/^aomv_[A-Za-z0-9_-]{40,}$/);
    const row = (await q('SELECT * FROM render_workers WHERE id=$1', [w.id]))[0] as Row;
    expect(row.token_hash).toBe(sha(w.token));
    expect(JSON.stringify(row)).not.toContain(w.token);
    const list = await admin('GET', '/api/platform/render-workers');
    expect(JSON.stringify(list.body)).not.toContain(w.token);
    expect(list.body.workers.find((x: { id: string }) => x.id === w.id)).toMatchObject({
      name: 'gpu box',
      revokedAt: null,
    });
    expect((await admin('POST', `/api/platform/render-workers/${w.id}/revoke`)).status).toBe(200);
    const audit = await q(
      `SELECT action FROM platform_audit_log WHERE action IN ('RenderWorkerAdded','RenderWorkerRevoked') AND details->>'workerId'=$1 ORDER BY seq`,
      [w.id],
    );
    expect(audit.map((a) => a.action)).toEqual(['RenderWorkerAdded', 'RenderWorkerRevoked']);
  });

  it('only super admins manage workers', async () => {
    const u = await t.userSession(`member-${Date.now()}@example.test`);
    expect((await t.req('GET', '/api/platform/render-workers', { cookie: u.cookie })).status).toBe(404);
    expect(
      (await t.req('POST', '/api/platform/render-workers', { cookie: u.cookie, body: { name: 'x' } })).status,
    ).toBe(404);
  });
});

describe('claim, input, upload, heartbeat, complete', () => {
  it('a whole render: claim binds the worker, the signed input gives the script, uploads land, complete measures and records', async () => {
    const w = await addWorker();
    const post = await approvedPost(t, sa.cookie, 'jobs-ok');
    const c = await claim(w.token);
    expect(c.statusCode).toBe(200);
    const job = c.json();
    expect(job).toMatchObject({ attempt: 1 });
    const lease = new Date(job.leaseUntil).getTime() - t.clock.now().getTime();
    expect(lease).toBeGreaterThan(10 * 60_000 - 5_000);
    expect(lease).toBeLessThanOrEqual(10 * 60_000);
    expect(job.inputUrl).toMatch(/^\/api\/render\/jobs\/[0-9a-f-]+\/input\?attempt=1&exp=\d+&sig=/);
    let r = await renderRow(job.renderId);
    expect(r).toMatchObject({ status: 'rendering', worker_id: w.id, attempts: 1 });
    // the claim also beats the render half's heartbeat (the Video page status)
    expect((await admin('GET', '/api/platform/video/status')).body.render.running).toBe(true);

    const input = await call(w.token, 'GET', job.inputUrl);
    expect(input.statusCode).toBe(200);
    expect(input.json().script.ref).toBe('jobs-ok');
    expect(Object.keys(input.json()).sort()).toEqual(['attempt', 'options', 'renderId', 'script']);

    const hb = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/heartbeat`, {
      attempt: 1,
      encoder: 'nvenc',
    });
    expect(hb.statusCode).toBe(200);

    const video = fakeMp4(130);
    const files: Record<string, Buffer> = { 'video.mp4': video, 'captions.vtt': Buffer.from('WEBVTT\n') };
    for (const [name, body] of Object.entries(files))
      expect((await upload(w.token, job.uploadUrls[name], body)).statusCode).toBe(200);
    const artifacts = Object.fromEntries(
      Object.entries(files).map(([n, b]) => [n, { sha256: sha(b), size: b.length }]),
    );
    // the worker claims 5 s; the server measures 130 s itself
    const done = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/complete`, {
      attempt: 1,
      bytes: 1,
      artifacts,
      encoder: 'nvenc',
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toEqual({ status: 'rendered' });
    r = await renderRow(job.renderId);
    expect(r).toMatchObject({ status: 'rendered', encoder: 'nvenc', bytes: String(video.length) });
    expect(Number(r.duration_s)).toBeCloseTo(130, 1);
    expect(r.artifacts).toEqual({
      video: `${post.id}/1/video.mp4`,
      captionsVtt: `${post.id}/1/captions.vtt`,
    });
    const log = await q(`SELECT action, outcome FROM render_worker_log WHERE worker_id=$1 ORDER BY id`, [
      w.id,
    ]);
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['encoder', 'claim', 'complete']));
    expect(log.find((l) => l.action === 'complete')?.outcome).toBe('rendered (nvenc)');
  });

  it('204 when there is nothing to do', async () => {
    const w = await addWorker();
    expect((await claim(w.token)).statusCode).toBe(204);
  });

  it('fail: back to the queue with the message, counted as an attempt', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'jobs-fail');
    const job = (await claim(w.token)).json();
    const f = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/fail`, {
      attempt: 1,
      message: 'chromium crashed',
    });
    expect(f.statusCode).toBe(200);
    expect(await renderRow(job.renderId)).toMatchObject({
      status: 'queued',
      error: 'chromium crashed',
      attempts: 1,
    });
    expect((await q(`SELECT outcome FROM render_worker_log WHERE action='fail'`))[0]?.outcome).toBe(
      'chromium crashed',
    );
  });

  it('an expired lease returns the job to the queue; the stale attempt is refused everywhere', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'jobs-lease');
    const first = (await claim(w.token)).json();
    t.clock.advance(11 * 60_000);
    const second = (await claim(w.token)).json();
    expect(second).toMatchObject({ renderId: first.renderId, attempt: 2 });
    const id = first.renderId;
    const hb = await call(w.token, 'POST', `/api/render/jobs/${id}/heartbeat`, { attempt: 1 });
    expect(hb.statusCode).toBe(409);
    expect(hb.json().error.code).toBe('lease_lost');
    expect(
      (await call(w.token, 'POST', `/api/render/jobs/${id}/fail`, { attempt: 1, message: 'x' })).statusCode,
    ).toBe(409);
    const body = Buffer.from('WEBVTT\n');
    const stale = await upload(w.token, first.uploadUrls['captions.vtt'], body);
    expect(stale.statusCode).toBe(409);
    const done = await call(w.token, 'POST', `/api/render/jobs/${id}/complete`, {
      attempt: 1,
      bytes: 1,
      artifacts: { 'video.mp4': { sha256: sha('x'), size: 1 } },
    });
    expect(done.statusCode).toBe(409);
    expect(await renderRow(id)).toMatchObject({ status: 'rendering', attempts: 2 });
    // the current attempt still works
    expect((await call(w.token, 'POST', `/api/render/jobs/${id}/heartbeat`, { attempt: 2 })).statusCode).toBe(
      200,
    );
  });
});

describe('tokens and limits', () => {
  it('an unknown or revoked token gets 401, and the denial is logged', async () => {
    const w = await addWorker();
    expect((await claim('aomv_unknown-token-value-that-is-long-enough')).statusCode).toBe(401);
    expect(
      (await call(null, 'POST', '/api/render/jobs/claim', { version: '2.0.0', encoder: 'cpu' })).statusCode,
    ).toBe(401);
    expect((await claim(PUSH_SWITCH)).statusCode).toBe(401);
    await admin('POST', `/api/platform/render-workers/${w.id}/revoke`);
    expect((await claim(w.token)).statusCode).toBe(401);
    const denied = await q(
      `SELECT count(*)::int AS n FROM render_worker_log WHERE outcome='denied: bad token'`,
    );
    // throttled: one row per caller and outcome per minute (review blocker 1)
    expect(denied[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it('bad tokens from one address: the limit trips before any log write, and at most one row a minute is written', async () => {
    const flood = async (url: string, method: 'POST' | 'PUT', ip: string) => {
      const codes: number[] = [];
      for (let i = 0; i < 25; i++)
        codes.push(
          (
            await t.app.inject({
              method,
              url,
              remoteAddress: ip,
              headers: { authorization: 'Bearer aomv_flood', 'content-type': 'application/json' },
              payload: JSON.stringify({ version: '2.0.0', encoder: 'cpu' }),
            })
          ).statusCode,
        );
      return codes;
    };
    const rowsFor = async (ip: string) =>
      (await q(`SELECT count(*)::int AS n FROM render_worker_log WHERE ip=$1`, [ip]))[0]?.n;
    const claimCodes = await flood('/api/render/jobs/claim', 'POST', '198.51.100.21');
    expect(claimCodes.filter((c) => c === 401)).toHaveLength(10);
    expect(claimCodes.filter((c) => c === 429)).toHaveLength(15);
    expect(await rowsFor('198.51.100.21')).toBe(1);
    const uploadUrl = `/api/worker/video/renders/00000000-0000-4000-8000-000000000003/files/captions.vtt?attempt=1&exp=1&sig=x`;
    const pushCodes = await flood(uploadUrl, 'PUT', '198.51.100.22');
    expect(pushCodes.filter((c) => c === 401)).toHaveLength(10);
    expect(pushCodes.filter((c) => c === 429)).toHaveLength(15);
    expect(await rowsFor('198.51.100.22')).toBe(1);
    // a minute later: one more row, not one per request
    t.clock.advance(61_000);
    await flood('/api/render/jobs/claim', 'POST', '198.51.100.21');
    expect(await rowsFor('198.51.100.21')).toBe(2);
    t.clock.advance(61_000);
  });

  it('an authenticated worker over its limit is not logged per request either', async () => {
    const w = await addWorker();
    const id = '00000000-0000-4000-8000-000000000004';
    for (let i = 0; i < 140; i++)
      await call(w.token, 'GET', `/api/render/jobs/${id}/input?attempt=1&exp=1&sig=x`);
    const n = (await q(`SELECT count(*)::int AS n FROM render_worker_log WHERE worker_id=$1`, [w.id]))[0]?.n;
    expect(n).toBeLessThanOrEqual(2); // one bad-signature row, one rate-limited row
    t.clock.advance(61_000);
  });

  it('failed authentication: 10 a minute per address, then 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push(
        (
          await t.app.inject({
            method: 'POST',
            url: '/api/render/jobs/claim',
            remoteAddress: '203.0.113.77',
            headers: { authorization: 'Bearer aomv_nope', 'content-type': 'application/json' },
            payload: JSON.stringify({ version: '2.0.0', encoder: 'cpu' }),
          })
        ).statusCode,
      );
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    t.clock.advance(61_000);
  });

  it('a worker gets 120 requests a minute, then 429', async () => {
    const w = await addWorker();
    const id = '00000000-0000-4000-8000-000000000001';
    const codes: number[] = [];
    for (let i = 0; i < 121; i++)
      codes.push(
        (await call(w.token, 'GET', `/api/render/jobs/${id}/input?attempt=1&exp=1&sig=x`)).statusCode,
      );
    expect(codes.slice(0, 120).every((c) => c === 403)).toBe(true);
    expect(codes[120]).toBe(429);
    t.clock.advance(61_000);
  });

  it('an outdated worker gets 409 worker_outdated and claims nothing', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'jobs-outdated');
    const r = await claim(w.token, { version: '1.5.0' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('worker_outdated');
    expect((await q(`SELECT status FROM video_renders`))[0]?.status).toBe('queued');
  });
});

describe('signed links', () => {
  it('refuse expiry, tampering, a different render and a different name', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'jobs-sig');
    const job = (await claim(w.token)).json();
    const tampered = job.inputUrl.replace(
      /sig=([^&]+)/,
      (_m: string, s: string) => `sig=${s.slice(0, -2)}AA`,
    );
    expect((await call(w.token, 'GET', tampered)).json().error.code).toBe('bad_signature');
    const otherRender = job.inputUrl.replace(job.renderId, '00000000-0000-4000-8000-000000000002');
    expect((await call(w.token, 'GET', otherRender)).statusCode).toBe(403);
    // an upload link of one name does not open another
    const swapped = job.uploadUrls['captions.vtt'].replace('captions.vtt', 'script.json');
    expect((await upload(w.token, swapped, 'x')).statusCode).toBe(403);
    // the attempt is part of the signature
    expect((await call(w.token, 'GET', job.inputUrl.replace('attempt=1', 'attempt=2'))).statusCode).toBe(403);
    t.clock.advance(16 * 60_000);
    // keep the lease alive past the input link's 15 minutes: only the link expires
    await q(`UPDATE video_renders SET lease_until=$2 WHERE id=$1`, [
      job.renderId,
      new Date(t.clock.now().getTime() + 600_000),
    ]);
    const expired = await call(w.token, 'GET', job.inputUrl);
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error.code).toBe('link_expired');
  });

  it('sig= and exp= never reach a log', () => {
    const url = '/api/worker/video/renders/r1/files/video.mp4?attempt=2&exp=1795214082229&sig=abcDEF_123-x';
    expect(redactUrl(url)).toBe(
      '/api/worker/video/renders/r1/files/video.mp4?attempt=2&exp=[redacted]&sig=[redacted]',
    );
    expect(
      requestLogSerializer({ method: 'GET', url: '/api/render/jobs/x/input?attempt=1&sig=s3cr3t&exp=9' }).url,
    ).not.toMatch(/s3cr3t|exp=9/);
  });
});

describe('binding to the claiming worker', () => {
  it("heartbeat, complete, fail and input are refused for another worker's job; uploads need the bearer", async () => {
    const owner = await addWorker('owner');
    const other = await addWorker('other');
    await approvedPost(t, sa.cookie, 'jobs-bind');
    const job = (await claim(owner.token)).json();
    const id = job.renderId;
    expect((await call(other.token, 'GET', job.inputUrl)).statusCode).toBe(409);
    expect(
      (await call(other.token, 'POST', `/api/render/jobs/${id}/heartbeat`, { attempt: 1 })).statusCode,
    ).toBe(409);
    expect(
      (await call(other.token, 'POST', `/api/render/jobs/${id}/fail`, { attempt: 1, message: 'x' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call(other.token, 'POST', `/api/render/jobs/${id}/complete`, {
          attempt: 1,
          bytes: 1,
          artifacts: { 'video.mp4': { sha256: sha('x'), size: 1 } },
        })
      ).statusCode,
    ).toBe(409);
    // the signed link alone is not enough: no bearer, or another worker's bearer
    expect((await upload(null, job.uploadUrls['captions.vtt'], 'WEBVTT\n')).statusCode).toBe(401);
    expect((await upload(other.token, job.uploadUrls['captions.vtt'], 'WEBVTT\n')).statusCode).toBe(409);
    expect(await renderRow(id)).toMatchObject({ status: 'rendering', worker_id: owner.id });
  });
});

describe('complete checks the files itself', () => {
  async function claimed(ref: string) {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, ref);
    return { w, job: (await claim(w.token)).json() };
  }

  it('refuses a sha256 that does not match the uploaded file, and a file that never arrived', async () => {
    const { w, job } = await claimed('jobs-sha');
    const video = fakeMp4(60);
    await upload(w.token, job.uploadUrls['video.mp4'], video);
    const wrong = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/complete`, {
      attempt: 1,
      bytes: video.length,
      artifacts: { 'video.mp4': { sha256: sha('something else'), size: video.length } },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('hash_mismatch');
    const missing = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/complete`, {
      attempt: 1,
      bytes: video.length,
      artifacts: {
        'video.mp4': { sha256: sha(video), size: video.length },
        'thumb.png': { sha256: sha('png'), size: 3 },
      },
    });
    expect(missing.json().error.code).toBe('missing_artifact');
    expect((await renderRow(job.renderId)).status).toBe('rendering');
  });

  it('measures the length itself: an over-long video fails for good whatever the worker says', async () => {
    const { w, job } = await claimed('jobs-long');
    const video = fakeMp4(700); // the long-video limit is 600 s
    await upload(w.token, job.uploadUrls['video.mp4'], video);
    const r = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/complete`, {
      attempt: 1,
      bytes: video.length,
      artifacts: { 'video.mp4': { sha256: sha(video), size: video.length } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('failed');
    expect(await renderRow(job.renderId)).toMatchObject({ status: 'failed', attempts: 3 });
    expect((await renderRow(job.renderId)).error).toMatch(/the video is 700 seconds; the limit is 600/);
  });

  it('a video that is not an MP4 fails the attempt', async () => {
    const { w, job } = await claimed('jobs-junk');
    const junk = Buffer.from('not an mp4 at all');
    await upload(w.token, job.uploadUrls['video.mp4'], junk);
    const r = await call(w.token, 'POST', `/api/render/jobs/${job.renderId}/complete`, {
      attempt: 1,
      bytes: junk.length,
      artifacts: { 'video.mp4': { sha256: sha(junk), size: junk.length } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('bad_video');
    expect((await renderRow(job.renderId)).status).toBe('queued');
  });
});

describe('the retired tunnel mode', () => {
  it('the video-worker entry refuses AOM_VIDEO_PUSH_URL with the hint', () => {
    expect(() => refuseRetiredPushMode({ AOM_VIDEO_PUSH_URL: 'https://video.example.com' })).toThrow(
      /remote render workers use `video-worker --remote` with AOM_RENDER_SERVER_URL/,
    );
    expect(() => refuseRetiredPushMode({})).not.toThrow();
  });

  it('the in-process path still renders (no worker binding, CPU, 40 min lease)', async () => {
    await approvedPost(t, sa.cookie, 'jobs-inprocess');
    const out = join(videoDir, 'inprocess');
    const done = await renderNext(t.app.ctx, {
      version: '2.0.0',
      render: async (_s, { outDir }) => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
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
          durationSeconds: 100,
          bytes: 9,
        };
      },
    });
    expect(done).toBe(true);
    const r = (await q(`SELECT status, worker_id, encoder FROM video_renders`))[0];
    expect(r).toEqual({ status: 'rendered', worker_id: null, encoder: 'cpu' });
    expect(existsSync(out)).toBe(false);
  });
});

describe('one upload slot per attempt (review S1, S2)', () => {
  const complete = (token: string, id: string, attempt: number, files: Record<string, Buffer>) =>
    call(token, 'POST', `/api/render/jobs/${id}/complete`, {
      attempt,
      bytes: 1,
      artifacts: Object.fromEntries(
        Object.entries(files).map(([n, b]) => [n, { sha256: sha(b), size: b.length }]),
      ),
    });

  it('a long render gets no short.mp4 link, and complete refuses a second or a foreign video name', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'slot-names');
    const job = (await claim(w.token)).json();
    expect(Object.keys(job.uploadUrls)).toContain('video.mp4');
    expect(Object.keys(job.uploadUrls)).not.toContain('short.mp4');
    const short = fakeMp4(10);
    expect((await upload(w.token, job.uploadUrls['video.mp4'], short)).statusCode).toBe(200);
    const both = await complete(w.token, job.renderId, 1, { 'video.mp4': short, 'short.mp4': fakeMp4(7200) });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.code).toBe('wrong_video');
    const foreign = await complete(w.token, job.renderId, 1, { 'short.mp4': short });
    expect(foreign.json().error.code).toBe('wrong_video');
    expect((await renderRow(job.renderId)).status).toBe('rendering');
  });

  it('a measured video cannot be swapped: a second upload of other bytes in the same attempt is refused', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'slot-swap');
    const job = (await claim(w.token)).json();
    const ok10 = fakeMp4(10);
    expect((await upload(w.token, job.uploadUrls['video.mp4'], ok10)).statusCode).toBe(200);
    const swap = await upload(w.token, job.uploadUrls['video.mp4'], fakeMp4(7200));
    expect(swap.statusCode).toBe(409);
    expect(swap.json().error.code).toBe('already_uploaded');
    // a lost answer retried with the same bytes is fine
    expect((await upload(w.token, job.uploadUrls['video.mp4'], ok10)).json()).toMatchObject({
      repeated: true,
    });
    expect((await complete(w.token, job.renderId, 1, { 'video.mp4': ok10 })).json()).toEqual({
      status: 'rendered',
    });
  });

  it("a file left by an earlier attempt is not this attempt's upload", async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'slot-leftover');
    const first = (await claim(w.token)).json();
    const video = fakeMp4(20);
    await upload(w.token, first.uploadUrls['video.mp4'], video);
    t.clock.advance(11 * 60_000);
    const second = (await claim(w.token)).json();
    expect(second.attempt).toBe(2);
    const r = await complete(w.token, second.renderId, 2, { 'video.mp4': video });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('missing_artifact');
    // uploading it again in attempt 2 opens the slot for attempt 2
    expect((await upload(w.token, second.uploadUrls['video.mp4'], video)).statusCode).toBe(200);
    expect((await complete(w.token, second.renderId, 2, { 'video.mp4': video })).json()).toEqual({
      status: 'rendered',
    });
  });

  it('a re-queued render (attempts back to 0) uploads new bytes for attempt 1 and completes (review round 2)', async () => {
    const w = await addWorker();
    const post = await approvedPost(t, sa.cookie, 'slot-requeued');
    const first = (await claim(w.token)).json();
    const a = fakeMp4(30);
    expect((await upload(w.token, first.uploadUrls['video.mp4'], a)).statusCode).toBe(200);
    expect((await complete(w.token, first.renderId, 1, { 'video.mp4': a })).json()).toEqual({
      status: 'rendered',
    });
    // the reset ensureFinalRender does for a failed or purged row of the same revision
    await q(`UPDATE video_renders SET status='failed', finished_at=now() WHERE id=$1`, [first.renderId]);
    await q(
      `UPDATE video_renders SET status='queued', attempts=0, error=NULL, lease_until=NULL, purged_at=NULL,
              artifacts='{}'::jsonb, bytes=NULL, duration_s=NULL, finished_at=NULL
        WHERE post_id=$1 AND (status='failed' OR purged_at IS NOT NULL)`,
      [post.id],
    );
    t.clock.advance(1_000); // a new claim, a new link expiry
    const again = (await claim(w.token)).json();
    expect(again).toMatchObject({ renderId: first.renderId, attempt: 1 });
    // the old claim's link (same worker, same attempt number, still unexpired) cannot touch the new claim's slot
    const old = await upload(w.token, first.uploadUrls['video.mp4'], a);
    expect(old.statusCode).toBe(409);
    expect(old.json().error.code).toBe('lease_lost');
    const b = fakeMp4(40);
    const up = await upload(w.token, again.uploadUrls['video.mp4'], b);
    expect(up.statusCode).toBe(200);
    expect(up.json().repeated).toBeUndefined();
    expect((await complete(w.token, again.renderId, 1, { 'video.mp4': b })).json()).toEqual({
      status: 'rendered',
    });
    expect(Number((await renderRow(again.renderId)).duration_s)).toBeCloseTo(40, 1);
  });

  it('a former holder with an old version cannot put back a render another attempt holds', async () => {
    const w = await addWorker();
    await approvedPost(t, sa.cookie, 'slot-requeue');
    const first = (await claim(w.token)).json();
    t.clock.advance(11 * 60_000);
    const second = (await claim(w.token)).json();
    expect(second.attempt).toBe(2);
    const body = Buffer.from('WEBVTT\n');
    const stale = await t.app.inject({
      method: 'PUT',
      url: first.uploadUrls['captions.vtt'],
      payload: body,
      headers: {
        authorization: `Bearer ${w.token}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha(body),
        'x-worker-version': '1.0.0',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('lease_lost');
    expect(await renderRow(first.renderId)).toMatchObject({ status: 'rendering', attempts: 2 });
  });
});
