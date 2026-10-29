import { nextFreeSlot, resolveSchedule, SCHEDULE_DEFAULTS, type VideoFormat } from '@aom/shared';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import { RENDER_DEFERRED, videoPostStream } from '../commands/video-posts.ts';
import { rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `video-schedule-2026-10`: videos moved from "render first, approve the video, one upload a day at 10:00" to "approve
 * the script, give it a slot, render just before it". Existing posts are brought over:
 *  1. an approved post whose YouTube upload is done (sent, locked private, or a video id exists) gets the slot its video
 *     has on YouTube (`detail.publishAt`, else the upload time) as a `VideoPostScheduled` ('migrated');
 *  2. an approved post still waiting to upload gets the next free slot of its format, in approval order; its render is
 *     already there, and the slot it had reserved in the share is dropped (the slot now comes from the post);
 *  3. a post in review whose video is rendered keeps it as a preview (reused if the script is unchanged at scheduling,
 *     the MP4 removed after 7 days without activity);
 *  4. a post in review whose render was only queued or running: that render is marked failed "renders now happen after
 *     scheduling" (queued again at scheduling, and not counted as one of the 3 renders);
 *  5. library imports and the tutorial cross-posts are not touched.
 * Idempotent (a post with a slot is skipped, a preview stays a preview); a rebuild of the projections reproduces the
 * result, the render rows are operational.
 */
export const VIDEO_SCHEDULE_MIGRATION = 'video-schedule-2026-10';

export interface VideoScheduleReport {
  scheduled: Array<{ postId: string; slotAt: string; step: 'uploaded' | 'waiting' }>;
  previews: number;
  deferred: number;
}

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;

export async function migrateVideoSchedule(env: DataMigrationEnv): Promise<VideoScheduleReport | null> {
  const { pool, store, clock, log } = env;
  const done = await pool.query('SELECT 1 FROM data_migrations WHERE name=$1', [VIDEO_SCHEDULE_MIGRATION]);
  if (done.rowCount) return null;
  const now = clock.now();
  const report: VideoScheduleReport = { scheduled: [], previews: 0, deferred: 0 };

  const setting = await pool.query(`SELECT value FROM platform_settings WHERE key='video_posts'`);
  const schedule = resolveSchedule((setting.rows[0]?.value ?? {}) as Record<string, never>);
  const approved = await selectRows(
    pool,
    `SELECT p.id, p.format, p.approved_at, p.created_at, p.slot_at, p.destinations,
            s.status AS share_status, s.external_id, s.detail, s.updated_at AS share_at
       FROM video_posts p
       LEFT JOIN social_shares s ON s.post_id = p.id AND s.network='youtube' AND s.source='video'
      WHERE p.status = 'approved'
      ORDER BY p.approved_at NULLS LAST, p.created_at, p.id`,
  );
  const taken: Record<VideoFormat, Set<number>> = { long: new Set(), short: new Set() };
  for (const p of approved) if (p.slot_at) taken[p.format as VideoFormat].add(new Date(p.slot_at).getTime());

  const schedulePost = async (postId: string, slot: Date, mode: 'slot' | 'now') =>
    store.append([
      {
        streamId: videoPostStream(postId),
        event: {
          type: 'VideoPostScheduled',
          payload: {
            postId,
            slotAt: slot.toISOString(),
            mode,
            destinations: ['youtube'],
            reason: 'migrated',
            by: 'system',
          },
        },
        actor: SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);

  // 1. already on YouTube: the slot it has there
  const waiting: typeof approved = [];
  for (const p of approved) {
    if (p.slot_at) continue;
    const d = (p.detail ?? {}) as { publishAt?: string | null; uploadedAt?: string };
    const uploaded = ['sent', 'locked_private'].includes(p.share_status) || !!p.external_id || !!d.uploadedAt;
    if (!uploaded) {
      waiting.push(p);
      continue;
    }
    const at = new Date(d.publishAt ?? d.uploadedAt ?? p.share_at ?? p.approved_at ?? now);
    await schedulePost(p.id, at, 'slot');
    taken[p.format as VideoFormat].add(at.getTime());
    report.scheduled.push({ postId: p.id, slotAt: at.toISOString(), step: 'uploaded' });
  }
  // 2. waiting to upload: the next free slot of the format, in approval order
  for (const p of waiting) {
    const format = p.format as VideoFormat;
    const free = nextFreeSlot(
      schedule[format],
      schedule.timezone,
      now,
      taken[format],
      SCHEDULE_DEFAULTS.minLeadMs[format],
    );
    const slot = free ?? now;
    await schedulePost(p.id, slot, free ? 'slot' : 'now');
    taken[format].add(slot.getTime());
    await pool.query(
      `UPDATE social_shares SET detail = COALESCE(detail,'{}'::jsonb) - 'publishAt' - 'reservedAt'
        WHERE post_id=$1 AND network='youtube' AND source='video'`,
      [p.id],
    );
    report.scheduled.push({ postId: p.id, slotAt: slot.toISOString(), step: 'waiting' });
  }
  // 3. in review with a finished video: a preview
  const previews = await pool.query(
    `UPDATE video_renders r SET preview = true
       FROM video_posts p
      WHERE p.id = r.post_id AND p.status IN ('draft','in_review') AND NOT r.library
        AND r.status = 'rendered' AND NOT r.preview`,
  );
  report.previews = previews.rowCount ?? 0;
  // 4. in review with a render that never finished: renders now happen after scheduling
  const deferred = await pool.query(
    `UPDATE video_renders r SET status='failed', error=$1, finished_at=$2, lease_until=NULL
       FROM video_posts p
      WHERE p.id = r.post_id AND p.status IN ('draft','in_review') AND NOT r.library
        AND r.status IN ('queued','rendering') AND NOT r.preview`,
    [RENDER_DEFERRED, now],
  );
  report.deferred = deferred.rowCount ?? 0;

  await pool.query(
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO NOTHING`,
    [VIDEO_SCHEDULE_MIGRATION, now, JSON.stringify(report)],
  );
  log(
    `${VIDEO_SCHEDULE_MIGRATION}: ${report.scheduled.length} scheduled, ${report.previews} previews, ${report.deferred} renders deferred`,
  );
  return report;
}
