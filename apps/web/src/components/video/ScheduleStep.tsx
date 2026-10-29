import type {
  ScheduleVideoPostRequest,
  TikTokOptions,
  VideoCaptions,
  VideoDestination,
  VideoPost,
  VideoStatus,
} from '@aom/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useScheduleVideo, useVideoChannels, useVideoSlots } from '../../api/queries/video.ts';
import {
  type Caption,
  captionStats,
  DESTINATION_LABEL,
  defaultCaption,
  slotLabel,
} from '../../lib/video-schedule.ts';
import { Tabs } from '../ui/Tabs.tsx';
import { Button, Callout, ErrorBox, Select, TextArea, TextInput, useToast } from '../ui.tsx';
import { TikTokPanel, type TikTokState } from './TikTokPanel.tsx';

/**
 * "Where it goes": the destinations of the format's schedule, one caption tab per destination other than YouTube (live
 * counters), the TikTok panel, and the Schedule button with the slot menu. Schedule approves the script and gives it a
 * slot; the video renders shortly before.
 */
export function ScheduleStep({
  post,
  status,
  disabledReason,
  privacy,
}: {
  post: VideoPost;
  status?: VideoStatus | undefined;
  /** Why Schedule cannot be pressed now (unsaved edits). */
  disabledReason?: string | null;
  /** The privacy the video would get (its own choice or the setting). */
  privacy: string;
}) {
  const toast = useToast();
  const schedule = useScheduleVideo(post.id);
  const format = post.format;
  const fs = status?.settings.schedule[format];
  const allDestinations = useMemo<VideoDestination[]>(() => fs?.destinations ?? ['youtube'], [fs]);
  const channels = useVideoChannels();
  const connected = useCallback(
    (d: VideoDestination) =>
      d === 'youtube' || d === 'tiktok' || !channels.data
        ? true
        : channels.data.channels.some((c) => c.network === d && c.connected),
    [channels.data],
  );
  const [picked, setPicked] = useState<Partial<Record<VideoDestination, boolean>>>({});
  const [tiktokConnected, setTiktokConnected] = useState<boolean | null>(null);
  const on = (d: VideoDestination) =>
    d === 'tiktok' ? tiktokConnected !== false && picked[d] !== false : connected(d) && picked[d] !== false;
  const selected = allDestinations.filter(on);
  const extras: VideoDestination[] = selected.filter((d) => d !== 'youtube');

  const [captions, setCaptions] = useState<Partial<Record<VideoDestination, Caption>>>({});
  const [tab, setTab] = useState<string>('');
  // the owner's edit, else the drafter's caption stored with the post, else a default from the metadata
  const captionOf = (d: VideoDestination): Caption =>
    captions[d] ?? post.captions?.[d] ?? defaultCaption(d, post.meta);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new defaults when the stored revision changes
  useEffect(() => setCaptions({}), [post.revision, post.updatedAt]);
  const activeTab = extras.includes(tab as VideoDestination) ? (tab as VideoDestination) : extras[0];

  const [tiktok, setTiktok] = useState<TikTokState>({
    options: null,
    blocker: 'Choose who can see the TikTok video.',
  });
  const showTikTok = format === 'short' && allDestinations.includes('tiktok');
  const tiktokOn = selected.includes('tiktok');

  const slots = useVideoSlots(format, true);
  const next = status?.nextSlot[format] ?? null;
  const free = (slots.data?.slots ?? []).filter(
    (s) => s.free && (!next || Date.parse(s.at) >= Date.parse(next)),
  );
  const [slotAt, setSlotAt] = useState('');
  const chosen = slotAt || free[0]?.at || next;
  const canNow = format === 'short' || privacy === 'public';

  const blocked =
    disabledReason ??
    (selected.length === 0
      ? 'Tick at least one destination.'
      : tiktokOn && tiktok.blocker
        ? tiktok.blocker
        : !chosen
          ? 'The schedule has no free slot: tick a day in the settings.'
          : null);

  const run = (mode: 'slot' | 'now') => {
    const sent: VideoCaptions = {};
    for (const d of extras) sent[d] = captionOf(d);
    const body: ScheduleVideoPostRequest = {
      mode,
      ...(mode === 'slot' && slotAt ? { slotAt } : {}),
      ...(status ? { destinations: selected } : {}),
      ...(extras.length ? { captions: sent } : {}),
      ...(tiktokOn && tiktok.options
        ? { destinationOptions: { tiktok: tiktok.options as TikTokOptions } }
        : {}),
    };
    schedule.mutate(body, {
      onSuccess: (p) =>
        toast.success(
          p.publishMode === 'now'
            ? 'Publishing as soon as it is rendered'
            : `Scheduled for ${slotLabel(p.slotAt ?? '')}`,
        ),
    });
  };

  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-line p-3"
      data-testid="schedule-step"
      aria-label="Schedule"
    >
      <h3 className="text-sm font-semibold text-fg">Schedule</h3>
      {allDestinations.length > 1 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-fg">Post to</legend>
          <div className="flex flex-wrap gap-4">
            {allDestinations.map((d) => {
              const off = d === 'tiktok' ? tiktokConnected === false : !connected(d);
              return (
                <label
                  key={d}
                  className={`flex items-center gap-2 text-sm ${off ? 'text-subtle' : 'text-fg'}`}
                >
                  <input
                    type="checkbox"
                    checked={on(d)}
                    disabled={off}
                    onChange={(e) => setPicked((p) => ({ ...p, [d]: e.target.checked }))}
                    data-testid={`dest-${d}`}
                  />
                  {DESTINATION_LABEL[d]}
                  {off && <span className="text-xs">(not connected)</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {extras.length > 0 && activeTab && (
        <div data-testid="caption-tabs">
          <Tabs
            label="Captions per destination"
            prefix="caption"
            className="!mb-2"
            tabs={extras.map((d) => ({ id: d, label: DESTINATION_LABEL[d], testId: `caption-tab-${d}` }))}
            value={activeTab}
            onChange={setTab}
          />
          <CaptionEditor
            key={activeTab}
            dest={activeTab}
            caption={captionOf(activeTab)}
            onChange={(c) => setCaptions((v) => ({ ...v, [activeTab]: c }))}
          />
        </div>
      )}

      {showTikTok && (
        <div className="rounded-control border border-line p-3">
          <h4 className="mb-2 text-sm font-semibold text-fg">TikTok</h4>
          <TikTokPanel
            durationSeconds={post.render?.durationSeconds ?? null}
            onChange={setTiktok}
            onConnection={setTiktokConnected}
          />
        </div>
      )}

      <ErrorBox error={schedule.error} />
      {blocked && (
        <p className="text-sm text-muted" data-testid="schedule-blocker">
          {blocked}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="primary"
          loading={schedule.isPending}
          disabled={!!blocked}
          onClick={() => run('slot')}
          data-testid="video-approve"
        >
          {chosen ? `Schedule: ${slotLabel(chosen)}` : 'Schedule'}
        </Button>
        {free.length > 0 && (
          <Select
            label="Another slot"
            value={slotAt}
            onChange={(e) => setSlotAt(e.target.value)}
            data-testid="slot-menu"
          >
            <option value="">Next free slot{free[0] ? ` (${slotLabel(free[0].at)})` : ''}</option>
            {free.slice(1).map((s) => (
              <option key={s.at} value={s.at}>
                {slotLabel(s.at)}
              </option>
            ))}
          </Select>
        )}
        {canNow && (
          <Button
            loading={schedule.isPending}
            disabled={!!blocked}
            onClick={() => run('now')}
            data-testid="video-publish-now"
          >
            Publish now
          </Button>
        )}
      </div>
      {slots.data && (
        <p className="text-xs text-muted">
          Times are on this computer's clock; the schedule runs in {slots.data.timezone}.
        </p>
      )}
    </section>
  );
}

function CaptionEditor({
  dest,
  caption,
  onChange,
}: {
  dest: VideoDestination;
  caption: Caption;
  onChange: (c: Caption) => void;
}) {
  const stats = captionStats(dest, caption);
  const [tags, setTags] = useState(caption.tags.map((t) => `#${t}`).join(' '));
  const counterId = `caption-count-${dest}`;
  return (
    <div
      className="flex flex-col gap-2"
      role="tabpanel"
      id={`caption-panel-${dest}`}
      aria-labelledby={`caption-tab-${dest}`}
    >
      <TextArea
        label={`${DESTINATION_LABEL[dest]} caption`}
        rows={4}
        value={caption.text}
        aria-describedby={counterId}
        onChange={(e) => onChange({ ...caption, text: e.target.value })}
      />
      <TextInput
        label="Hashtags"
        value={tags}
        hint={`${stats.minTags} to ${stats.maxTags}, separated by spaces`}
        onChange={(e) => {
          setTags(e.target.value);
          onChange({
            ...caption,
            tags: e.target.value
              .split(/[\s,]+/)
              .map((t) => t.replace(/^#/, ''))
              .filter(Boolean),
          });
        }}
      />
      <p
        id={counterId}
        data-testid={`caption-count-${dest}`}
        className={`text-xs ${stats.over || stats.tagsOver ? 'text-danger' : 'text-muted'}`}
      >
        {stats.count} / {stats.max}
        {stats.over ? ` (${stats.count - stats.max} over: the end is cut)` : ''}
        {stats.tagsOver ? ` · at most ${stats.maxTags} hashtags` : ''}
        {dest === 'x' ? ' · X: no link ($0.015 post)' : ''}
      </p>
      {stats.over && (
        <Callout tone="warning">
          Posted as: <span className="whitespace-pre-wrap">{stats.posted}</span>
        </Callout>
      )}
    </div>
  );
}
