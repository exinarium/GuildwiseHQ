import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { VideoScript } from '@aom/shared';
import type { RenderOptions } from '@aom/video';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, parseEncodeThreads } from '../src/config.ts';
import type { Ctx } from '../src/context.ts';
import { renderScript } from '../src/video/renders.ts';
import { type RenderFn, renderNext } from '../src/video/sweep.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

const seen = vi.hoisted(() => ({ opts: [] as unknown[] }));
vi.mock('@aom/video', async (orig) => ({
  ...(await orig<typeof import('@aom/video')>()),
  renderVideo: vi.fn(async (_s: unknown, opts: unknown) => {
    seen.opts.push(opts);
    return { fake: true };
  }),
}));

const SHORT: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../packages/video/test/fixtures/agents-short.json'),
    'utf8',
  ),
);

describe('AOM_VIDEO_ENCODE_THREADS', () => {
  const threads = (v: string | undefined) => {
    const env: Record<string, string | undefined> = { ...process.env, AOM_VIDEO_ENCODE_THREADS: v };
    if (v === undefined) delete env.AOM_VIDEO_ENCODE_THREADS;
    return loadConfig(env).videoEncodeThreads;
  };

  it('is undefined (the renderer default) when unset or empty', () => {
    expect(threads(undefined)).toBeUndefined();
    expect(threads('')).toBeUndefined();
    expect(parseEncodeThreads(undefined)).toBeUndefined();
  });

  it('takes a whole number as it is (the renderer clamps it to the cores)', () => {
    expect(threads('3')).toBe(3);
    expect(threads(' 8 ')).toBe(8);
    expect(threads('64')).toBe(64);
  });

  it('ignores 0, negative, fractional and text values without failing the boot', () => {
    for (const bad of ['0', '-1', 'abc', '1.5', '4x']) {
      expect(() => threads(bad)).not.toThrow();
      expect(threads(bad)).toBeUndefined();
    }
  });
});

describe('renderScript', () => {
  it('passes the thread count and the render label to renderVideo', async () => {
    seen.opts.length = 0;
    await renderScript(SHORT, {
      outDir: '/tmp/unused',
      catalog: [{ slug: 'agents', title: 'Agents', duration: 60, mp4: 'agents.mp4', chapters: [] }],
      encodeThreads: 3,
      renderLabel: 'post p1 render r1',
    });
    expect(seen.opts).toHaveLength(1);
    expect(seen.opts[0]).toMatchObject({
      encodeThreads: 3,
      renderLabel: 'post p1 render r1',
    } satisfies Partial<RenderOptions>);
  });
});

describe('renderNext', () => {
  let t: TestApp;
  let videoDir: string;
  let sa: { cookie: string };
  const api = (method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: sa.cookie, ...(body !== undefined ? { body } : {}) });

  beforeAll(async () => {
    videoDir = mkdtempSync(join(tmpdir(), 'video-threads-'));
    t = await createTestApp({
      env: {
        AOM_VIDEO_DIR: videoDir,
        AOM_YOUTUBE_CLIENT_ID: 'cid',
        AOM_YOUTUBE_CLIENT_SECRET: 'csecret',
        AOM_VIDEO_ENCODE_THREADS: '3',
      },
    });
    t.app.ctx.youtube = {
      accessToken: async () => 'access-token',
      channelMine: async () => ({ id: 'UC123', title: 'Guildwise HQ', verified: true }),
    } as unknown as Ctx['youtube'];
    sa = await t.superAdminSession();
    await ok(
      api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }),
    );
    await ok(api('PATCH', '/api/platform/video/settings', { enabled: true }));
    await ok(
      api('PATCH', '/api/platform/video/settings', {
        schedule: {
          short: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], renderLeadHours: 168 },
        },
      }),
    );
  });
  afterAll(async () => {
    await q('DELETE FROM social_shares');
    await q('DELETE FROM video_renders');
    await q('DELETE FROM video_posts');
    rmSync(videoDir, { recursive: true, force: true });
    await t.close();
    await closeAdminPool();
  });

  it('passes the configured threads and "post <id> render <id>", and forwards render lines to the worker log', async () => {
    await q('DELETE FROM social_shares');
    await q('DELETE FROM video_renders');
    await q('DELETE FROM video_posts');
    const p = await ok(
      api('POST', '/api/platform/video/posts', {
        kind: 'tutorial',
        format: 'short',
        ref: 'threads',
        script: { ...SHORT, kind: 'tutorial', ref: 'threads' },
      }),
      201,
    );
    await ok(api('POST', `/api/platform/video/posts/${p.id}/approve`));
    const logged: Array<{ obj: unknown; msg: string }> = [];
    const ctx: Ctx = {
      ...t.app.ctx,
      log: Object.assign(Object.create(t.app.ctx.log), {
        info: (obj: unknown, msg: string) => logged.push({ obj, msg }),
      }) as Ctx['log'],
    };
    let got: Parameters<RenderFn>[1] | undefined;
    const capture: RenderFn = async (_s, opts) => {
      got = opts;
      opts.log('encode threads: 3');
      throw new Error('stop after capturing');
    };
    await renderNext(ctx, { render: capture });
    const r = (await q(`SELECT id FROM video_renders WHERE post_id=$1`, [p.id]))[0] as { id: string };
    expect(got?.encodeThreads).toBe(3);
    expect(got?.renderLabel).toBe(`post ${p.id} render ${r.id}`);
    expect(logged).toContainEqual({
      obj: { postId: p.id, renderId: r.id },
      msg: 'video render: encode threads: 3',
    });
  });
});
