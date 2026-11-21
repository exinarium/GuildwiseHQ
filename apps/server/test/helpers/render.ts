import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VideoScript } from '@aom/shared';
import type { UploadSpec, YouTubeClient } from '../../src/video/youtube.ts';
import type { TestApp } from './app.ts';
import { CaptureMailer, FakeSocial } from './blog.ts';
import { q } from './db.ts';
import { ok } from './world.ts';

/** Helpers of the render job API suites (R16, R19, R23): a ready video setup, posts to render and a minimal MP4. */

export const LONG: VideoScript = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../packages/video/test/fixtures/agents-long.json'),
    'utf8',
  ),
);

export class FakeYouTube implements YouTubeClient {
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
  async videoStatus() {
    return {
      privacyStatus: 'private',
      uploadStatus: 'uploaded',
      publishAt: '2099-01-01T00:00:00Z',
      rejectionReason: null,
      failureReason: null,
    } as never;
  }
}

/** Connects a fake YouTube channel and switches videos on with every day in the schedule. Returns the super admin. */
export async function videoReady(t: TestApp): Promise<{ id: string; cookie: string; mailer: CaptureMailer }> {
  const mailer = new CaptureMailer();
  t.app.ctx.youtube = new FakeYouTube();
  t.app.ctx.mailer = mailer;
  t.app.ctx.social = new FakeSocial();
  const sa = await t.superAdminSession();
  const api = (method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: sa.cookie, ...(body !== undefined ? { body } : {}) });
  await ok(
    api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }),
  );
  await ok(api('PATCH', '/api/platform/video/settings', { enabled: true }));
  await ok(
    api('PATCH', '/api/platform/video/settings', {
      schedule: { long: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], renderLeadHours: 168 } },
    }),
  );
  return { id: sa.id, cookie: sa.cookie, mailer };
}

/** An approved long video post (its render row is queued). */
export async function approvedPost(t: TestApp, cookie: string, ref: string): Promise<{ id: string }> {
  const api = (method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) });
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

export const cleanVideo = async () => {
  await q('DELETE FROM social_shares');
  await q('DELETE FROM video_renders');
  await q('DELETE FROM video_posts');
  await q(
    `DELETE FROM platform_settings WHERE key LIKE 'video_worker_%' OR key IN ('video_cleanup_at', 'server_version',
       'render_worker_silent_mail') OR key LIKE 'video_alert:%' OR key LIKE 'render_worker_cpu_mail:%'`,
  );
};

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** The smallest MP4 the server's length check reads: ftyp, moov with a version-0 mvhd of `seconds`, and an mdat. */
export function fakeMp4(seconds: number): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(0, 0); // version 0, flags
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16); // duration
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), Buffer.alloc(4), Buffer.from('isomavc1', 'latin1'));
  return Buffer.concat([ftyp, box('moov', box('mvhd', mvhd)), box('mdat', Buffer.from('fake frames'))]);
}
