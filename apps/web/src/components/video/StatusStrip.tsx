import type { VideoPost, VideoStatus } from '@aom/shared';
import { formatDateTime } from '../../lib/time.ts';
import { slotLabel } from '../../lib/video-schedule.ts';
import { Badge, Callout } from '../ui.tsx';

interface WorkerState {
  label: string;
  running: boolean;
  lastSeen: string | null;
}
/**
 * One state per worker role: the render worker (renders shortly before a slot) and the publish worker (uploads, posts at
 * the slot, cleans up), from `status.render` / `status.publish`; the combined `status.worker` for a server that has one heartbeat.
 */
export function workerStates(status: Pick<VideoStatus, 'worker' | 'render' | 'publish'>): WorkerState[] {
  const w = (status.render || status.publish
    ? { render: status.render, publish: status.publish }
    : status.worker) as unknown as Record<string, unknown>;
  const one = (label: string, v: unknown): WorkerState => {
    const x = (v ?? {}) as { running?: boolean; lastSeen?: string | null };
    return { label, running: !!x.running, lastSeen: x.lastSeen ?? null };
  };
  if ('render' in w || 'publish' in w)
    return [one('Render worker', w.render), one('Publish worker', w.publish)];
  return [one('Video worker', w)];
}

/** Derived alerts: what needs the owner's eye, from the posts the page already has. */
export function videoAlerts(posts: VideoPost[], status: VideoStatus): string[] {
  const out: string[] = [];
  const mine = posts.filter((p) => p.status === 'approved');
  const slipped = mine.filter((p) => p.slippedAt && p.phase !== 'published').length;
  if (slipped)
    out.push(
      `${slipped} video${slipped === 1 ? '' : 's'} slipped to a later slot because ${slipped === 1 ? 'it was' : 'they were'} not rendered in time.`,
    );
  const waiting = mine.filter((p) =>
    [p.upload?.error, ...p.shares.map((s) => s.error)].some((e) =>
      /waiting for the video file/i.test(e ?? ''),
    ),
  ).length;
  if (waiting)
    out.push(
      `${waiting} video${waiting === 1 ? ' is' : 's are'} waiting for the rendered file to reach the publish worker.`,
    );
  const failed = mine.filter((p) => p.phase === 'failed').length;
  if (failed) out.push(`${failed} video${failed === 1 ? '' : 's'} failed: open the queue to retry.`);
  if (status.storage.usedBytes > status.storage.maxBytes * 0.9)
    out.push('The disk budget for rendered videos is almost full.');
  return out;
}

/** Always visible: are the workers up, the next slot per format, this week's room, and the alerts. */
export function StatusStrip({ status, posts }: { status: VideoStatus; posts: VideoPost[] }) {
  const workers = workerStates(status);
  const alerts = videoAlerts(posts, status);
  const cap = status.capacity;
  return (
    <section className="flex flex-col gap-2" aria-label="Video status" data-testid="video-strip">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        <Badge tone={status.active ? 'success' : 'neutral'}>{status.active ? 'Active' : 'Not active'}</Badge>
        {workers.map((w) => (
          <span
            key={w.label}
            className="flex items-center gap-1.5"
            title={w.lastSeen ? `Last seen ${formatDateTime(w.lastSeen)}` : 'Never reported in'}
          >
            {w.label}
            <Badge tone={w.running ? 'success' : 'danger'}>{w.running ? 'online' : 'offline'}</Badge>
          </span>
        ))}
        <span data-testid="strip-next">
          Next slot: video {status.nextSlot.long ? slotLabel(status.nextSlot.long) : 'none'}, Short{' '}
          {status.nextSlot.short ? slotLabel(status.nextSlot.short) : 'none'}
        </span>
        <span>
          This week: {cap.long.used} of {cap.long.limit} videos, {cap.short.used} of {cap.short.limit} Shorts
        </span>
      </div>
      {alerts.map((a) => (
        <Callout key={a} tone="warning" role="alert" data-testid="video-alert">
          {a}
        </Callout>
      ))}
    </section>
  );
}
