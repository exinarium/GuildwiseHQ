import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VideoScript } from '@aom/shared';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appVersion } from '../src/app-version.ts';
import { beatHeartbeat, publishServerVersion, videoStatus } from '../src/commands/video-posts.ts';
import type { Ctx } from '../src/context.ts';
import { videoPushRoutes } from '../src/video/push.ts';
import { pushArtifacts } from '../src/video/push-client.ts';
import { type RenderFn, renderNext, videoTick, videoWatch } from '../src/video/sweep.ts';
import type { UploadSpec, YouTubeClient } from '../src/video/youtube.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { CaptureMailer, FakeSocial } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

const TOKEN = 'worker-token-0123456789abcdef-long';

class FakeYouTube implements YouTubeClient {
  uploads: UploadSpec[] = [];
  async accessToken() {
    return 'access-token';
  }
  async channelMine() {
    return { id: 'UC123', title: 'Guildwise HQ', verified: true };
  }
  async upload(_t: string, spec: UploadSpec) {
    this.uploads.push(spec);
    return { videoId: `vid${this.uploads.length}abcdef` };
  }
  async findRecentUpload() {
    return null;
  }
  async setThumbnail() {}
  async insertCaption() {}
  async addToPlaylist() {}
  async makePublic() {}
  async videoStatus(_t: string, _id: string) {
    return {
      privacyStatus: 'private',
      uploadStatus: 'uploaded',
      publishAt: '2099-01-01T00:00:00Z',
      rejectionReason: null,
      failureReason: null,
    } as never;
  }
}

const LONG: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/video/test/fixtures/agents-long.json'),
    'utf8',
  ),
);
const fakeRender: RenderFn = async (s, { outDir }) => {
  mkdirSync(outDir, { recursive: true });
  const f = (name: string, body: string) => {
    const p = join(outDir, name);
    writeFileSync(p, body);
    return p;
  };
  return {
    artifacts: {
      video: f('video.mp4', 'fake mp4 bytes'.repeat(100)),
      captionsVtt: f('captions.vtt', 'WEBVTT\n'),
      captionsSrt: f('captions.srt', '1\n'),
      thumb: f('thumb.png', 'png'),
      script: f('script.json', JSON.stringify(s)),
      description: f('description.txt', 'desc'),
      log: f('render.log', 'ok'),
    },
    durationSeconds: 130,
    bytes: 1400,
  };
};
const mustNotRender: RenderFn = async () => {
  throw new Error('the publish role must not render');
};
const instant = { sleep: async () => {}, backoffMs: [0, 0] };

let t: TestApp;
let videoDir: string;
let sa: { cookie: string };
const yt = new FakeYouTube();
const api = (method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: sa.cookie, ...(body !== undefined ? { body } : {}) });

async function newPost(ref: string): Promise<{ id: string }> {
  const p = await ok(
    api('POST', '/api/platform/video/posts', {
      kind: 'tutorial',
      format: 'long',
      ref,
      script: { ...LONG, kind: 'tutorial', ref },
    }),
    201,
  );
  await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
  return p;
}
const clean = async () => {
  await q('DELETE FROM social_shares');
  await q('DELETE FROM video_renders');
  await q('DELETE FROM video_posts');
  await q(
    `DELETE FROM platform_settings WHERE key LIKE 'video_worker_%' OR key IN ('video_cleanup_at', 'server_version')
        OR key LIKE 'video_alert:outdated:%'`,
  );
};

beforeAll(async () => {
  videoDir = mkdtempSync(join(tmpdir(), 'video-roles-'));
  t = await createTestApp({
    env: {
      AOM_VIDEO_DIR: videoDir,
      AOM_YOUTUBE_CLIENT_ID: 'cid',
      AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
      AOM_VIDEO_WORKER_TOKEN: TOKEN,
    },
  });
  t.app.ctx.youtube = yt;
  t.app.ctx.mailer = new CaptureMailer();
  t.app.ctx.social = new FakeSocial();
  sa = await t.superAdminSession();
  await ok(
    api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }),
  );
  await ok(api('PATCH', '/api/platform/video/settings', { enabled: true }));
  await ok(
    api('PATCH', '/api/platform/video/settings', {
      schedule: {
        long: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], renderLeadHours: 168 },
      },
    }),
  );
});
afterAll(async () => {
  rmSync(videoDir, { recursive: true, force: true });
  await t.close();
  await closeAdminPool();
});

describe('worker roles', () => {
  it('the render role renders and never uploads; the publish role uploads and never renders', async () => {
    await clean();
    const p = await newPost('roles-1');
    const r1 = await videoTick(t.app.ctx, { render: fakeRender, role: 'render' });
    expect(r1).toMatchObject({ active: true, rendered: true, uploaded: false });
    expect(await q('SELECT 1 FROM social_shares WHERE post_id=$1', [p.id])).toHaveLength(0);
    expect(yt.uploads).toHaveLength(0);
    let st = await ok(api('GET', '/api/platform/video/status'));
    expect(st.render.running).toBe(true);
    expect(st.publish.running).toBe(false);
    expect(st.worker.running).toBe(false); // the combined view needs both

    const r2 = await videoTick(t.app.ctx, { render: mustNotRender, role: 'publish' });
    expect(r2).toMatchObject({ rendered: false, uploaded: true });
    expect(yt.uploads).toHaveLength(1);
    st = await ok(api('GET', '/api/platform/video/status'));
    expect(st.render.running && st.publish.running && st.worker.running).toBe(true);
  });

  it('a publish role does not render even when a render is queued', async () => {
    await clean();
    await newPost('roles-2');
    const out = await videoTick(t.app.ctx, { render: mustNotRender, role: 'publish' });
    expect(out.rendered).toBe(false);
    expect(await q(`SELECT status FROM video_renders`)).toEqual([{ status: 'queued' }]);
  });

  it('role all (the default) does both in one pass', async () => {
    await clean();
    await newPost('roles-3');
    expect(await videoTick(t.app.ctx, { render: fakeRender })).toMatchObject({
      rendered: true,
      uploaded: true,
    });
  });
});

describe('no YouTube channel yet', () => {
  it('a preview still renders (nothing is uploaded); a scheduled render waits for the channel', async () => {
    await clean();
    const scheduled = await newPost('no-channel-scheduled');
    const draft = await ok(
      api('POST', '/api/platform/video/posts', {
        kind: 'tutorial',
        format: 'long',
        ref: 'no-channel-preview',
        script: { ...LONG, kind: 'tutorial', ref: 'no-channel-preview' },
      }),
      201,
    );
    await ok(api('POST', `/api/platform/video/posts/${draft.id}/preview`));
    const saved = await q(`SELECT * FROM social_channels WHERE network='youtube'`);
    await q(`DELETE FROM social_channels WHERE network='youtube'`);
    try {
      const out = await videoTick(t.app.ctx, { render: fakeRender });
      expect(out).toMatchObject({ active: false, rendered: true, uploaded: false });
      expect(await q('SELECT status FROM video_renders WHERE post_id=$1', [draft.id])).toEqual([
        { status: 'rendered' },
      ]);
      expect(await q('SELECT status FROM video_renders WHERE post_id=$1', [scheduled.id])).toEqual([
        { status: 'queued' },
      ]);
      // nothing more to do: the scheduled one is not claimed
      expect((await videoTick(t.app.ctx, { render: mustNotRender })).rendered).toBe(false);
      // videos off: not even a preview
      await ok(api('PATCH', '/api/platform/video/settings', { enabled: false }));
      expect((await videoTick(t.app.ctx, { render: mustNotRender })).rendered).toBe(false);
    } finally {
      await ok(api('PATCH', '/api/platform/video/settings', { enabled: true }));
      await ok(
        api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }),
      );
      expect(saved).toHaveLength(1);
    }
  });
});

describe('push endpoint', () => {
  const sha = (b: string) => createHash('sha256').update(b).digest('hex');
  let renderId: string;
  let postId: string;
  const put = (name: string, body: string, headers: Record<string, string> = {}, id = () => renderId) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/worker/video/renders/${id()}/files/${name}`,
      payload: body,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha(body),
        'x-worker-version': '2.0.0',
        ...headers,
      },
    });
  beforeAll(async () => {
    await clean();
    await publishServerVersion(t.app.ctx, '2.0.0');
    const p = await newPost('push-1');
    postId = p.id;
    await q(
      `UPDATE video_renders SET status='rendering', lease_until = now() + interval '1 hour' WHERE post_id=$1`,
      [p.id],
    );
    renderId = (await q('SELECT id FROM video_renders WHERE post_id=$1', [p.id]))[0]?.id;
  });

  it('is a 404 when no token is configured', async () => {
    const app = Fastify({ logger: false });
    await app.register(
      videoPushRoutes({ ...t.app.ctx, config: { ...t.app.ctx.config, videoWorkerToken: undefined } }),
    );
    const res = await app.inject({
      method: 'PUT',
      url: `/api/worker/video/renders/${renderId}/files/video.mp4`,
      payload: 'x',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-content-sha256': sha('x') },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('refuses a missing or wrong token', async () => {
    expect((await put('video.mp4', 'abc', { authorization: 'Bearer nope' })).statusCode).toBe(401);
    expect((await put('video.mp4', 'abc', { authorization: '' })).statusCode).toBe(401);
    expect(existsSync(join(videoDir, postId))).toBe(false);
  });

  it('refuses names outside the whitelist, and traversal', async () => {
    for (const name of ['constructor', '__proto__', 'evil.sh', '..%2F..%2Fx.mp4', '%2E%2E%2Fvideo.mp4'])
      expect([400, 404], name).toContain((await put(name, 'abc')).statusCode);
    expect(existsSync(join(videoDir, postId, '1', 'evil.sh'))).toBe(false);
  });

  it('refuses a body whose hash or size is wrong, and leaves no file behind', async () => {
    const bad = await put('captions.vtt', 'hello', { 'x-content-sha256': sha('other') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('hash_mismatch');
    expect((await put('captions.vtt', 'hello', { 'x-content-sha256': 'zz' })).statusCode).toBe(400);
    const dir = join(videoDir, postId, '1');
    expect(existsSync(join(dir, 'captions.vtt'))).toBe(false);
  });

  it('refuses a render that is not waiting for files', async () => {
    const res = await put('video.mp4', 'abc', {}, () => '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('accepts a 0-byte artifact (no body at all)', async () => {
    const res = await put('captions.srt', '', { 'content-length': '0' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, bytes: 0 });
    expect(readFileSync(join(videoDir, postId, '1', 'captions.srt'), 'utf8')).toBe('');
  });

  it('two pushes of one name at once: each is verified on its own, the last rename wins, no temp file is left', async () => {
    const [a, b] = await Promise.all([put('script.json', '{"a":1}'), put('script.json', '{"a":1}')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const dir = join(videoDir, postId, '1');
    expect(readFileSync(join(dir, 'script.json'), 'utf8')).toBe('{"a":1}');
    expect((await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('the clean-up removes push temp files over an hour old and keeps fresh ones', async () => {
    const { utimesSync, writeFileSync: write } = await import('node:fs');
    const { cleanupPushTemps } = await import('../src/video/sweep.ts');
    const dir = join(videoDir, postId, '1');
    const old = join(dir, '.push-old.tmp');
    const fresh = join(dir, '.push-fresh.tmp');
    write(old, 'x');
    write(fresh, 'x');
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, longAgo, longAgo);
    expect(await cleanupPushTemps(t.app.ctx)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    (await import('node:fs')).rmSync(fresh);
  });

  it('writes a good push atomically', async () => {
    const res = await put('captions.vtt', 'WEBVTT\nhello');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, bytes: 12 });
    const dir = join(videoDir, postId, '1');
    expect(readFileSync(join(dir, 'captions.vtt'), 'utf8')).toBe('WEBVTT\nhello');
    expect(
      existsSync(dir) && (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('the render worker pushes', () => {
  let server: ReturnType<typeof Fastify>;
  let url: string;
  let localDir: string;
  let renderCtx: Ctx;
  beforeAll(async () => {
    server = Fastify({ logger: false });
    await server.register(videoPushRoutes(t.app.ctx));
    url = await server.listen({ port: 0, host: '127.0.0.1' });
    localDir = mkdtempSync(join(tmpdir(), 'video-roles-local-'));
    renderCtx = {
      ...t.app.ctx,
      config: { ...t.app.ctx.config, videoDir: localDir, videoPushUrl: url, videoWorkerToken: TOKEN },
    };
  });
  afterAll(async () => {
    await server.close();
    rmSync(localDir, { recursive: true, force: true });
  });

  it('marks the render rendered only after every push is acknowledged, then deletes the local copy', async () => {
    await clean();
    const p = await newPost('push-ok');
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      const row = (await q(`SELECT status FROM video_renders WHERE post_id=$1`, [p.id]))[0];
      seen.push(`${String(input).split('/').pop()}:${row?.status}`);
      return fetch(input, init);
    };
    expect(await renderNext(renderCtx, { render: fakeRender, push: { ...instant, fetch: spy } })).toBe(true);
    expect(seen).toHaveLength(7);
    expect(seen.every((s) => s.endsWith(':rendering'))).toBe(true);
    expect((await q(`SELECT status, artifacts FROM video_renders WHERE post_id=$1`, [p.id]))[0]?.status).toBe(
      'rendered',
    );
    const dir = join(videoDir, p.id, '1');
    expect(readFileSync(join(dir, 'video.mp4'), 'utf8')).toBe('fake mp4 bytes'.repeat(100));
    expect(existsSync(join(localDir, p.id))).toBe(false);
  });

  it('retries a failed push, and a push that never succeeds leaves the render unfinished', async () => {
    await clean();
    const p = await newPost('push-retry');
    let flaky = 0;
    const retrying: typeof fetch = async (input, init) => {
      if (String(input).endsWith('thumb.png') && flaky++ < 2) return new Response('busy', { status: 503 });
      return fetch(input, init);
    };
    await renderNext(renderCtx, { render: fakeRender, push: { ...instant, fetch: retrying } });
    expect(flaky).toBe(3);
    expect((await q(`SELECT status FROM video_renders WHERE post_id=$1`, [p.id]))[0]?.status).toBe(
      'rendered',
    );

    await clean();
    const p2 = await newPost('push-down');
    const down: typeof fetch = async () => {
      throw new Error('connection refused');
    };
    await renderNext(renderCtx, { render: fakeRender, push: { ...instant, fetch: down } });
    const row = (await q(`SELECT status, error FROM video_renders WHERE post_id=$1`, [p2.id]))[0];
    expect(row?.status).toBe('queued'); // not rendered: it will be tried again
    expect(row?.error).toMatch(/push of .* failed/);
  });

  it('a refused push (bad token) is not retried', async () => {
    await clean();
    await newPost('push-refused');
    let calls = 0;
    const counting: typeof fetch = async (input, init) => {
      calls++;
      return fetch(input, init);
    };
    const bad = { ...renderCtx, config: { ...renderCtx.config, videoWorkerToken: `${TOKEN}-wrong` } };
    await renderNext(bad, { render: fakeRender, push: { ...instant, fetch: counting } });
    expect(calls).toBe(1);
  });
});

describe('a missing file for a rendered video', () => {
  it('waits for it until the slot, then fails for good', async () => {
    await clean();
    const p = await newPost('missing-1');
    await videoTick(t.app.ctx, { render: fakeRender, role: 'render' });
    rmSync(join(videoDir, p.id, '1', 'video.mp4'));
    const slot = new Date(t.clock.now().getTime() + 2 * 3_600_000);
    await q('UPDATE video_posts SET slot_at=$2 WHERE id=$1', [p.id, slot]);
    await videoTick(t.app.ctx, { render: mustNotRender, role: 'publish' });
    let s = (await q('SELECT status, error, attempts FROM social_shares WHERE post_id=$1', [p.id]))[0];
    expect(s).toMatchObject({ status: 'pending', error: 'waiting for the video file', attempts: 0 });
    // the file arrives: the upload goes
    writeFileSync(join(videoDir, p.id, '1', 'video.mp4'), 'late bytes');
    t.clock.advance(2 * 60_000);
    await videoTick(t.app.ctx, { render: mustNotRender, role: 'publish' });
    expect(yt.uploads.length).toBeGreaterThan(0);

    // and a file that never arrives fails once the slot has passed
    await clean();
    const p2 = await newPost('missing-2');
    await videoTick(t.app.ctx, { render: fakeRender, role: 'render' });
    rmSync(join(videoDir, p2.id, '1', 'video.mp4'));
    await q('UPDATE video_posts SET slot_at=$2 WHERE id=$1', [
      p2.id,
      new Date(t.clock.now().getTime() + 3_600_000),
    ]);
    await videoTick(t.app.ctx, { render: mustNotRender, role: 'publish' });
    s = (await q('SELECT status, error FROM social_shares WHERE post_id=$1', [p2.id]))[0];
    expect(s?.status).toBe('pending');
    t.clock.advance(2 * 3_600_000);
    await videoTick(t.app.ctx, { render: mustNotRender, role: 'publish' });
    s = (
      await q('SELECT status, error FROM social_shares WHERE post_id=$1 ORDER BY created_at LIMIT 1', [p2.id])
    )[0];
    expect(s?.status).toBe('failed');
    expect(s?.error).toMatch(/video file was not found/);
  });
});

describe('worker version', () => {
  const SERVER = '2.0.0';
  const sha = (b: string) => createHash('sha256').update(b).digest('hex');
  const push = (renderId: string, version: string | null, body = 'WEBVTT\n') =>
    t.app.inject({
      method: 'PUT',
      url: `/api/worker/video/renders/${renderId}/files/captions.vtt`,
      payload: body,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/octet-stream',
        'x-content-sha256': sha(body),
        ...(version !== null ? { 'x-worker-version': version } : {}),
      },
    });
  const renderOf = async (postId: string) =>
    (
      await q('SELECT id, status, attempts, error, lease_until FROM video_renders WHERE post_id=$1', [postId])
    )[0];
  /** A rendering row, as if a worker had claimed it. */
  const claimed = async (ref: string) => {
    const p = await newPost(ref);
    await q(
      `UPDATE video_renders SET status='rendering', attempts=1, lease_until = now() + interval '1 hour' WHERE post_id=$1`,
      [p.id],
    );
    return { postId: p.id, renderId: (await renderOf(p.id))?.id as string };
  };
  /** A ctx whose error log is captured (the logger keeps its prototype). */
  const withLog = () => {
    const errors: string[] = [];
    const log = Object.create(t.app.ctx.log);
    log.error = (a: unknown, b?: unknown) => {
      errors.push(String(typeof a === 'string' ? a : b));
    };
    return { ctx: { ...t.app.ctx, log } as Ctx, errors };
  };
  const reset = async () => {
    await clean();
    await publishServerVersion(t.app.ctx, SERVER);
  };
  // the earlier suites move the clock on by hours: a fresh session
  beforeAll(async () => {
    sa = await t.superAdminSession();
  });
  afterAll(clean);

  describe('the flag', () => {
    for (const [version, outdated] of [
      ['1.5.0', true],
      [null, true],
      ['2.0.0', false],
      ['2.1.0', false],
    ] as const)
      it(`a worker on ${version ?? 'no version'} is ${outdated ? '' : 'not '}outdated against server ${SERVER}`, async () => {
        await reset();
        await videoTick(t.app.ctx, { render: mustNotRender, role: 'render', version });
        const row = (await q(`SELECT value FROM platform_settings WHERE key='video_worker_render'`))[0];
        expect(row?.value.version).toBe(version);
        const st = await ok(api('GET', '/api/platform/video/status'));
        expect(st.serverVersion).toBe(SERVER);
        expect(st.render).toMatchObject({ running: true, version, outdated });
        expect(st.publish).toMatchObject({ running: false, outdated: false }); // never beat: offline, not outdated
        expect(st.worker).toEqual({ running: false, lastSeen: expect.any(String) }); // the combined view is unchanged
      });

    it('a heartbeat from before version reporting (no version key) reads as outdated and does not throw', async () => {
      await reset();
      await q(
        `INSERT INTO platform_settings (key, value, updated_at) VALUES ('video_worker_render', $1::jsonb, now())`,
        [JSON.stringify({ at: t.clock.now().toISOString() })],
      );
      const st = await videoStatus(t.app.ctx);
      expect(st.render).toMatchObject({ running: true, version: null, outdated: true });
    });

    it('a keep-alive beat without a version keeps this build version', async () => {
      await reset();
      await beatHeartbeat(t.app.ctx, 'render', { busy: 'render' });
      const row = (await q(`SELECT value FROM platform_settings WHERE key='video_worker_render'`))[0];
      expect(row?.value).toMatchObject({ busy: 'render', version: appVersion() });
    });

    it('with no recorded server version the build version is the reference; an unknown one flags nobody', async () => {
      await clean();
      await beatHeartbeat(t.app.ctx, 'render', { version: null });
      expect((await videoStatus(t.app.ctx)).serverVersion).toBe(appVersion());
      await publishServerVersion(t.app.ctx, null);
      const st = await videoStatus(t.app.ctx);
      expect(st.serverVersion).toBeNull();
      expect(st.render?.outdated).toBe(false);
    });
  });

  describe('the refusal', () => {
    for (const version of ['1.5.0', null] as const)
      it(`a worker on ${version ?? 'no version'} claims no render, logs the reason once and keeps beating`, async () => {
        await reset();
        const p = await newPost(`old-${version ?? 'none'}`);
        const { ctx, errors } = withLog();
        expect(await videoTick(ctx, { render: mustNotRender, role: 'render', version })).toMatchObject({
          rendered: false,
        });
        expect(await videoTick(ctx, { render: mustNotRender, role: 'render', version })).toMatchObject({
          rendered: false,
        });
        expect(await renderOf(p.id)).toMatchObject({ status: 'queued', attempts: 0 });
        const message = `video worker ${version ?? '(no version)'} is older than server ${SERVER}; update the worker`;
        expect(errors.filter((e) => e === message)).toHaveLength(1);
        const st = await ok(api('GET', '/api/platform/video/status'));
        expect(st.render).toMatchObject({ running: true, outdated: true });
      });

    for (const version of ['2.0.0', '2.1.0'] as const)
      it(`a worker on ${version} renders as today`, async () => {
        await reset();
        const p = await newPost(`current-${version}`);
        expect(await videoTick(t.app.ctx, { render: fakeRender, role: 'render', version })).toMatchObject({
          rendered: true,
        });
        expect((await renderOf(p.id))?.status).toBe('rendered');
      });

    for (const version of ['1.5.0', null] as const)
      it(`a push from a worker on ${version ?? 'no version'} is refused naming both versions; the render goes back to the queue`, async () => {
        await reset();
        const { postId, renderId } = await claimed(`push-old-${version ?? 'none'}`);
        const res = await push(renderId, version);
        expect(res.statusCode).toBe(409);
        const message = `video worker ${version ?? '(no version)'} is older than server ${SERVER}; update the worker`;
        expect(res.json()).toEqual({ error: { code: 'worker_outdated', message } });
        const row = await renderOf(postId);
        expect(row).toMatchObject({ status: 'queued', attempts: 0, error: message });
        expect(new Date(row?.lease_until).getTime()).toBeGreaterThan(t.clock.now().getTime());
        expect(existsSync(join(videoDir, postId, '1', 'captions.vtt'))).toBe(false);
      });

    it('the version is checked after the token: a bad token never sees the versions', async () => {
      await reset();
      const { postId, renderId } = await claimed('push-old-token');
      const res = await t.app.inject({
        method: 'PUT',
        url: `/api/worker/video/renders/${renderId}/files/captions.vtt`,
        payload: 'x',
        headers: { authorization: 'Bearer nope', 'x-content-sha256': sha('x'), 'x-worker-version': '1.5.0' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(SERVER);
      expect((await renderOf(postId))?.status).toBe('rendering');
    });

    for (const version of ['2.0.0', '2.1.0'] as const)
      it(`a push from a worker on ${version} is accepted`, async () => {
        await reset();
        const { postId, renderId } = await claimed(`push-current-${version}`);
        const res = await push(renderId, version);
        expect(res.statusCode).toBe(200);
        expect((await renderOf(postId))?.status).toBe('rendering');
        expect(readFileSync(join(videoDir, postId, '1', 'captions.vtt'), 'utf8')).toBe('WEBVTT\n');
      });

    it('the push client sends the version header and an outdated push fails with the message', async () => {
      await reset();
      const server = Fastify({ logger: false });
      await server.register(videoPushRoutes(t.app.ctx));
      const url = await server.listen({ port: 0, host: '127.0.0.1' });
      const dir = mkdtempSync(join(tmpdir(), 'video-roles-version-'));
      try {
        const file = join(dir, 'captions.vtt');
        writeFileSync(file, 'WEBVTT\n');
        const { postId, renderId } = await claimed('client-old');
        let calls = 0;
        const counting: typeof fetch = async (input, init) => {
          calls++;
          return fetch(input, init);
        };
        await expect(
          pushArtifacts({ baseUrl: url, token: TOKEN, version: '1.5.0' }, renderId, [file], {
            ...instant,
            fetch: counting,
          }),
        ).rejects.toThrow(
          /refused: HTTP 409 .*video worker 1\.5\.0 is older than server 2\.0\.0; update the worker/,
        );
        expect(calls).toBe(1); // a refusal is not retried
        await q(`UPDATE video_renders SET status='rendering' WHERE id=$1`, [renderId]);
        await pushArtifacts({ baseUrl: url, token: TOKEN, version: '2.0.0' }, renderId, [file], instant);
        expect(readFileSync(join(videoDir, postId, '1', 'captions.vtt'), 'utf8')).toBe('WEBVTT\n');
      } finally {
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a server upgraded during a render refuses the files; the worker logs it and the attempt is not counted', async () => {
      await reset();
      const server = Fastify({ logger: false });
      await server.register(videoPushRoutes(t.app.ctx));
      const url = await server.listen({ port: 0, host: '127.0.0.1' });
      const localDir = mkdtempSync(join(tmpdir(), 'video-roles-upgrade-'));
      try {
        const p = await newPost('upgrade-mid-render');
        const upgrading: RenderFn = async (s, opts) => {
          await publishServerVersion(t.app.ctx, '2.5.0');
          return fakeRender(s, opts);
        };
        const ctx: Ctx = {
          ...t.app.ctx,
          config: { ...t.app.ctx.config, videoDir: localDir, videoPushUrl: url, videoWorkerToken: TOKEN },
        };
        expect(await renderNext(ctx, { render: upgrading, push: instant, version: SERVER })).toBe(true);
        expect(await renderOf(p.id)).toMatchObject({
          status: 'queued',
          attempts: 0,
          error: 'video worker 2.0.0 is older than server 2.5.0; update the worker',
        });
        expect(existsSync(join(videoDir, p.id, '1', 'video.mp4'))).toBe(false);
      } finally {
        await server.close();
        rmSync(localDir, { recursive: true, force: true });
      }
    });
  });

  describe('recovery', () => {
    it('the next heartbeat of an updated worker clears the flag and renders, a refused render included', async () => {
      await reset();
      const { postId, renderId } = await claimed('recover');
      expect((await push(renderId, '1.5.0')).statusCode).toBe(409); // back in the queue with a 10-minute wait
      const { ctx, errors } = withLog();
      expect(
        (await videoTick(ctx, { render: mustNotRender, role: 'render', version: '1.5.0' })).rendered,
      ).toBe(false);
      expect((await videoStatus(t.app.ctx)).render?.outdated).toBe(true);
      expect(errors).toHaveLength(1);

      const out = await videoTick(ctx, { render: fakeRender, role: 'render', version: SERVER });
      expect(out.rendered).toBe(true);
      expect((await videoStatus(t.app.ctx)).render).toMatchObject({ version: SERVER, outdated: false });
      expect(await renderOf(postId)).toMatchObject({ status: 'rendered', error: null });
    });
  });

  describe('the watch', () => {
    /** One entry per alert (each alert goes to every super-admin). */
    const outdatedMails = (mailer: CaptureMailer) => [
      ...new Set(
        mailer.sent
          .filter((m) => JSON.stringify(m).includes('is older than server'))
          .map((m) => JSON.stringify({ ...m, to: undefined })),
      ),
    ];

    for (const [version, mails] of [
      ['1.5.0', 1],
      [null, 1],
      ['2.0.0', 0],
      ['2.1.0', 0],
    ] as const)
      it(`a running render worker on ${version ?? 'no version'} raises ${mails} alert`, async () => {
        await reset();
        const mailer = t.app.ctx.mailer as CaptureMailer;
        mailer.sent = [];
        await beatHeartbeat(t.app.ctx, 'render', { version });
        expect((await videoWatch(t.app.ctx)).alerts).toBe(mails);
        expect(outdatedMails(mailer)).toHaveLength(mails);
        if (mails) {
          const text = JSON.stringify(outdatedMails(mailer)[0]);
          expect(text).toContain(`video worker ${version ?? '(no version)'} is older than server ${SERVER}`);
          expect(text).toContain('out of date');
        }
        // not repeated on the next run
        expect((await videoWatch(t.app.ctx)).alerts).toBe(0);
        expect(outdatedMails(mailer)).toHaveLength(mails);
      });

    it('a worker that missed another release is reported again', async () => {
      await reset();
      const mailer = t.app.ctx.mailer as CaptureMailer;
      mailer.sent = [];
      await beatHeartbeat(t.app.ctx, 'publish', { version: '1.5.0' });
      expect((await videoWatch(t.app.ctx)).alerts).toBe(1);
      await publishServerVersion(t.app.ctx, '2.1.0');
      expect((await videoWatch(t.app.ctx)).alerts).toBe(1);
      expect(outdatedMails(mailer)).toHaveLength(2);
    });
  });
});

describe('configuration', () => {
  it('AOM_VIDEO_PUSH_URL needs AOM_VIDEO_WORKER_TOKEN: the server refuses to start without it', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const base = {
      ...process.env,
      AOM_VIDEO_PUSH_URL: 'https://video.example.com',
      AOM_VIDEO_WORKER_TOKEN: undefined,
    };
    expect(() => loadConfig(base)).toThrow(/AOM_VIDEO_WORKER_TOKEN/);
    expect(() => loadConfig({ ...base, AOM_VIDEO_WORKER_TOKEN: TOKEN })).not.toThrow();
    expect(() =>
      loadConfig({ ...process.env, AOM_VIDEO_PUSH_URL: undefined, AOM_VIDEO_WORKER_TOKEN: undefined }),
    ).not.toThrow();
  });
});
