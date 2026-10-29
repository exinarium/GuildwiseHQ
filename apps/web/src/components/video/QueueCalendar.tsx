import type { VideoDestination, VideoFormat, VideoPost, VideoStatus } from '@aom/shared';
import { localDate } from '@aom/shared';
import { CheckCircle2, Clock, Loader2, Lock, MinusCircle, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useMoveVideo,
  useRetryVideo,
  useSwapVideo,
  useUnscheduleVideo,
  useVideoSlots,
} from '../../api/queries/video.ts';
import {
  type CalendarDay,
  calendarDays,
  DESTINATION_LABEL,
  dayHeading,
  PHASE_LABEL,
  PHASE_TONE,
  slotLabel,
  slotTime,
} from '../../lib/video-schedule.ts';
import { Badge, Button, EmptyState, ErrorBox, Panel, Select, useToast } from '../ui.tsx';

type ShareState = 'pending' | 'posting' | 'sent' | 'failed' | 'skipped' | 'locked_private';
const ICON = {
  pending: { Icon: Clock, cls: 'text-muted', label: 'waiting' },
  posting: { Icon: Loader2, cls: 'text-info-soft-fg', label: 'posting' },
  sent: { Icon: CheckCircle2, cls: 'text-success-soft-fg', label: 'sent' },
  failed: { Icon: XCircle, cls: 'text-danger', label: 'failed' },
  skipped: { Icon: MinusCircle, cls: 'text-muted', label: 'skipped' },
  locked_private: { Icon: Lock, cls: 'text-danger', label: 'kept private' },
} as const;

/** The state of each destination of a post: YouTube is the upload, the others are shares. */
export function destinationStates(
  p: VideoPost,
): Array<{ dest: VideoDestination; state: ShareState; url: string | null }> {
  const dests = p.destinations.length ? p.destinations : (['youtube'] as VideoDestination[]);
  return dests.map((dest) => {
    if (dest === 'youtube')
      return { dest, state: (p.upload?.status ?? 'pending') as ShareState, url: p.upload?.url ?? null };
    const s = p.shares.find((x) => x.network === dest);
    return { dest, state: (s?.status ?? 'pending') as ShareState, url: s?.url ?? null };
  });
}

/** Move, swap and unschedule are refused once any destination has the video. */
export function canChangeSlot(p: VideoPost): boolean {
  if (p.status !== 'approved' || p.publishMode !== 'slot') return false;
  if (p.upload && (p.upload.videoId || ['posting', 'sent', 'locked_private'].includes(p.upload.status)))
    return false;
  return !p.shares.some((s) => ['posting', 'sent', 'locked_private'].includes(s.status));
}

function Icons({ post }: { post: VideoPost }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Destinations">
      {destinationStates(post).map(({ dest, state }) => {
        const { Icon, cls, label } = ICON[state];
        return (
          <li
            key={dest}
            className={`inline-flex items-center gap-1 text-xs ${cls}`}
            title={`${DESTINATION_LABEL[dest]}: ${label}`}
            data-testid={`dest-icon-${dest}-${state}`}
          >
            <Icon aria-hidden="true" className={`size-3.5 ${state === 'posting' ? 'animate-spin' : ''}`} />
            <span>
              {DESTINATION_LABEL[dest]}
              <span className="sr-only">: {label}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MoveForm({ post, onDone }: { post: VideoPost; onDone: () => void }) {
  const slots = useVideoSlots(post.format);
  const move = useMoveVideo();
  const toast = useToast();
  const [to, setTo] = useState('');
  const free = (slots.data?.slots ?? []).filter((s) => s.free);
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <Select label="Move to" value={to} onChange={(e) => setTo(e.target.value)} data-testid="move-select">
        <option value="">Choose a free slot</option>
        {free.map((s) => (
          <option key={s.at} value={s.at}>
            {slotLabel(s.at)}
          </option>
        ))}
      </Select>
      <Button
        variant="primary"
        disabled={!to}
        loading={move.isPending}
        data-testid="move-confirm"
        onClick={() =>
          move.mutate(
            { id: post.id, slotAt: to },
            {
              onSuccess: () => {
                toast.success('Moved');
                onDone();
              },
            },
          )
        }
      >
        Move
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      <ErrorBox error={move.error} />
    </div>
  );
}

function SwapForm({ post, others, onDone }: { post: VideoPost; others: VideoPost[]; onDone: () => void }) {
  const swap = useSwapVideo();
  const toast = useToast();
  const [withId, setWithId] = useState('');
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <Select
        label="Swap with"
        value={withId}
        onChange={(e) => setWithId(e.target.value)}
        data-testid="swap-select"
      >
        <option value="">Choose a video</option>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {o.title} ({o.slotAt ? slotLabel(o.slotAt) : ''})
          </option>
        ))}
      </Select>
      <Button
        variant="primary"
        disabled={!withId}
        loading={swap.isPending}
        data-testid="swap-confirm"
        onClick={() =>
          swap.mutate(
            { id: post.id, withId },
            {
              onSuccess: () => {
                toast.success('Swapped');
                onDone();
              },
            },
          )
        }
      >
        Swap
      </Button>
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      <ErrorBox error={swap.error} />
    </div>
  );
}

function ScheduledPost({
  post,
  others,
  timeZone,
}: {
  post: VideoPost;
  others: VideoPost[];
  timeZone: string;
}) {
  const [mode, setMode] = useState<'move' | 'swap' | null>(null);
  const unschedule = useUnscheduleVideo();
  const retry = useRetryVideo();
  const toast = useToast();
  const change = canChangeSlot(post);
  const youtubeFailed = post.upload?.status === 'failed';
  const renderFailed = post.render?.status === 'failed';
  return (
    <div className="flex flex-col gap-1.5" data-testid={`queue-post-${post.id}`}>
      <p className="text-sm font-medium text-fg">{post.title}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={PHASE_TONE[post.phase]}>{PHASE_LABEL[post.phase]}</Badge>
        <span className="text-xs text-muted">
          {post.publishMode === 'now' ? 'as soon as rendered' : slotTime(post.slotAt ?? '', timeZone)}
        </span>
        {post.slippedAt && <Badge tone="warning">slipped</Badge>}
      </div>
      <Icons post={post} />
      <div className="flex flex-wrap gap-1.5">
        {change && (
          <>
            <Button
              size="sm"
              onClick={() => setMode(mode === 'move' ? null : 'move')}
              aria-expanded={mode === 'move'}
            >
              Move
            </Button>
            {others.length > 0 && (
              <Button
                size="sm"
                onClick={() => setMode(mode === 'swap' ? null : 'swap')}
                aria-expanded={mode === 'swap'}
              >
                Swap
              </Button>
            )}
            <Button
              size="sm"
              loading={unschedule.isPending}
              onClick={() => unschedule.mutate(post.id, { onSuccess: () => toast.success('Back in review') })}
            >
              Unschedule
            </Button>
          </>
        )}
        {youtubeFailed && (
          <Button
            size="sm"
            loading={retry.isPending}
            onClick={() =>
              retry.mutate(
                { id: post.id, what: 'retry-upload' },
                { onSuccess: () => toast.success('Queued again') },
              )
            }
          >
            Retry YouTube
          </Button>
        )}
        {renderFailed && (
          <Button
            size="sm"
            loading={retry.isPending}
            onClick={() =>
              retry.mutate(
                { id: post.id, what: 'retry-render' },
                { onSuccess: () => toast.success('Queued again') },
              )
            }
          >
            Retry render
          </Button>
        )}
      </div>
      <ErrorBox error={unschedule.error ?? retry.error} />
      {mode === 'move' && <MoveForm post={post} onDone={() => setMode(null)} />}
      {mode === 'swap' && <SwapForm post={post} others={others} onDone={() => setMode(null)} />}
    </div>
  );
}

const FORMATS: Array<{ format: VideoFormat; label: string }> = [
  { format: 'long', label: 'Long' },
  { format: 'short', label: 'Shorts' },
];

/**
 * The next two weeks: days in the schedule's time zone, a row per format in each day. A slot shows the video (title,
 * phase, one icon per destination) or "empty" with the number of scripts waiting; a day that is not a schedule day has
 * no slot. Below: the posts that already went out, with their links.
 */
export function QueueCalendar({
  posts,
  status,
  now = new Date(),
}: {
  posts: VideoPost[];
  status: VideoStatus;
  now?: Date;
}) {
  const tz = status.settings.schedule.timezone;
  const days = useMemo(() => calendarDays(tz, now, 14), [tz, now]);
  const scheduled = posts.filter((p) => p.status === 'approved' && p.slotAt);
  const waiting = (f: VideoFormat) => posts.filter((p) => p.format === f && p.status === 'in_review').length;
  const at = (d: CalendarDay, f: VideoFormat) =>
    scheduled.filter((p) => p.format === f && localDate(Date.parse(p.slotAt as string), tz) === d.date);
  const past = scheduled
    .filter((p) => ['published', 'partial', 'failed'].includes(p.phase))
    .sort((a, b) => Date.parse(b.slotAt as string) - Date.parse(a.slotAt as string));
  const weeks = [days.slice(0, 7), days.slice(7, 14)];

  return (
    <div className="flex flex-col gap-4" data-testid="video-queue">
      {weeks.map((week, wi) => (
        <Panel
          key={week[0]?.date}
          title={wi === 0 ? 'This week and next days' : 'The week after'}
          padding="compact"
        >
          <ol className="grid gap-2 md:grid-cols-7" aria-label={`Days from ${week[0]?.date}`}>
            {week.map((d) => (
              <li
                key={d.date}
                className={`flex flex-col gap-2 rounded-control border p-2 ${d.today ? 'border-brand' : 'border-line'}`}
                data-testid={`day-${d.date}`}
              >
                <h3 className="text-xs font-semibold text-fg">
                  {dayHeading(d)}
                  {d.today && <span className="ml-1 text-brand">today</span>}
                </h3>
                {FORMATS.map(({ format, label }) => {
                  const fs = status.settings.schedule[format];
                  const here = at(d, format);
                  const isSlotDay = fs.days.includes(d.weekday);
                  return (
                    <div
                      key={format}
                      data-testid={`cell-${format}-${d.date}`}
                      className="flex flex-col gap-1"
                    >
                      <p className="text-[0.7rem] font-semibold tracking-wide text-muted uppercase">
                        {label}
                      </p>
                      {here.map((p) => (
                        <ScheduledPost
                          key={p.id}
                          post={p}
                          others={scheduled.filter(
                            (o) => o.id !== p.id && o.format === format && canChangeSlot(o),
                          )}
                          timeZone={tz}
                        />
                      ))}
                      {here.length === 0 &&
                        (isSlotDay ? (
                          <p className="text-xs text-muted" data-testid={`empty-${format}-${d.date}`}>
                            Empty, {waiting(format)} {waiting(format) === 1 ? 'script' : 'scripts'} waiting
                          </p>
                        ) : (
                          <p className="text-xs text-subtle">
                            <span aria-hidden="true">–</span>
                            <span className="sr-only">No slot</span>
                          </p>
                        ))}
                    </div>
                  );
                })}
              </li>
            ))}
          </ol>
        </Panel>
      ))}
      <Panel title="Past posts" data-testid="video-past">
        {past.length === 0 ? (
          <EmptyState
            title="Nothing has gone out yet"
            description="Published videos and their links appear here."
          />
        ) : (
          <ul className="divide-y divide-line">
            {past.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="font-medium text-fg">{p.title}</span>
                <Badge tone={PHASE_TONE[p.phase]}>{PHASE_LABEL[p.phase]}</Badge>
                <span className="text-xs text-muted">{slotLabel(p.slotAt as string)}</span>
                <span className="flex flex-wrap gap-2 text-sm">
                  {destinationStates(p)
                    .filter((x) => x.url)
                    .map((x) => (
                      <a
                        key={x.dest}
                        href={x.url as string}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand hover:underline"
                      >
                        {DESTINATION_LABEL[x.dest]}
                      </a>
                    ))}
                </span>
                <Icons post={p} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
