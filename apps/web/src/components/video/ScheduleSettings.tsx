import {
  type FormatSchedule,
  type PatchVideoSettingsRequest,
  sortDays,
  VIDEO_DESTINATIONS,
  type VideoDestination,
  type VideoFormat,
  type VideoStatus,
  WEEKDAYS,
  type Weekday,
} from '@aom/shared';
import { useState } from 'react';
import { usePatchVideoSettings, useVideoChannels } from '../../api/queries/video.ts';
import { DESTINATION_LABEL, WEEKDAY_LABEL, weeklyCapText } from '../../lib/video-schedule.ts';
import { Disclosure } from '../ui/Disclosure.tsx';
import { Callout, ErrorBox, Panel, Select, TextInput } from '../ui.tsx';

const FALLBACK_ZONES = [
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Chicago',
  'America/Los_Angeles',
  'America/New_York',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/London',
  'UTC',
];
function zones(current: string): string[] {
  let list: string[] = FALLBACK_ZONES;
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    );
    if (all?.length) list = all;
  } catch {
    /* an older browser: the short list */
  }
  return list.includes(current) ? list : [current, ...list];
}

const TITLES: Record<VideoFormat, string> = { long: 'Videos', short: 'Shorts' };

function FormatCard({
  format,
  fs,
  connected,
  onPatch,
}: {
  format: VideoFormat;
  fs: FormatSchedule;
  connected: (d: VideoDestination) => boolean;
  onPatch: (p: Partial<FormatSchedule>) => void;
}) {
  const [lead, setLead] = useState(String(fs.renderLeadHours));
  const toggleDay = (d: Weekday, on: boolean) =>
    onPatch({ days: sortDays(on ? [...fs.days, d] : fs.days.filter((x) => x !== d)) });
  const toggleDest = (d: VideoDestination, on: boolean) => {
    const next = on ? [...fs.destinations, d] : fs.destinations.filter((x) => x !== d);
    if (next.length > 0) onPatch({ destinations: next });
  };
  const dests = format === 'long' ? (['youtube'] as VideoDestination[]) : [...VIDEO_DESTINATIONS];
  return (
    <section
      className="flex flex-col gap-3 rounded-card border border-line p-3"
      aria-label={`${TITLES[format]} schedule`}
      data-testid={`schedule-${format}`}
    >
      <h3 className="text-sm font-semibold text-fg">{TITLES[format]}</h3>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-fg">Days</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {WEEKDAYS.map((d) => (
            <label key={d} className="flex items-center gap-1.5 text-sm text-fg">
              <input
                type="checkbox"
                checked={fs.days.includes(d)}
                onChange={(e) => toggleDay(d, e.target.checked)}
                aria-label={WEEKDAY_LABEL[d]}
                data-testid={`day-${format}-${d}`}
              />
              {WEEKDAY_LABEL[d].slice(0, 3)}
            </label>
          ))}
        </div>
      </fieldset>
      <TextInput
        label="Time of day"
        type="time"
        value={fs.time}
        onChange={(e) =>
          /^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value) && onPatch({ time: e.target.value })
        }
        data-testid={`time-${format}`}
      />
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium text-fg">Post to</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {dests.map((d) => {
            const ok = connected(d);
            const ticked = fs.destinations.includes(d);
            const fixed = format === 'long' || (ticked && fs.destinations.length === 1);
            return (
              <div key={d} className="flex flex-col">
                <label
                  className={`flex items-center gap-1.5 text-sm ${ok || ticked ? 'text-fg' : 'text-subtle'}`}
                >
                  <input
                    type="checkbox"
                    checked={ticked}
                    disabled={fixed || (!ok && !ticked)}
                    onChange={(e) => toggleDest(d, e.target.checked)}
                    data-testid={`dest-${format}-${d}`}
                  />
                  {DESTINATION_LABEL[d]}
                  <span className="text-xs text-muted">{ok ? 'connected' : 'not connected'}</span>
                </label>
                {!ok && !ticked && (
                  <span className="ml-5 text-xs text-muted">
                    Connect it under Social sharing on the Posts tab first.
                  </span>
                )}
                {d === 'tiktok' && (
                  <span className="ml-5 text-xs text-muted">
                    TikTok posts privately until the app is audited.
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>
      <Disclosure summary="Advanced">
        <TextInput
          label="Render lead (hours before the slot)"
          type="number"
          min={1}
          max={168}
          value={lead}
          onChange={(e) => setLead(e.target.value)}
          onBlur={() => {
            const n = Number(lead);
            if (Number.isInteger(n) && n >= 1 && n <= 168) {
              if (n !== fs.renderLeadHours) onPatch({ renderLeadHours: n });
            } else setLead(String(fs.renderLeadHours));
          }}
          hint="The video renders this long before its slot."
          data-testid={`lead-${format}`}
        />
      </Disclosure>
    </section>
  );
}

/** When each format goes out and where; the writer's weekly cap is derived from the ticked days. */
export function ScheduleSettings({ status }: { status: VideoStatus }) {
  const patch = usePatchVideoSettings();
  const channels = useVideoChannels();
  const sched = status.settings.schedule;
  const connected = (d: VideoDestination) =>
    d === 'youtube'
      ? status.channel.connected
      : !!channels.data?.channels.some((c) => c.network === d && c.connected);
  const set = (v: PatchVideoSettingsRequest) => patch.mutate(v);
  return (
    <Panel title="Schedule" data-testid="video-schedule-settings">
      <div className="flex flex-col gap-3">
        <Select
          label="Time zone"
          value={sched.timezone}
          onChange={(e) => set({ schedule: { timezone: e.target.value } })}
          data-testid="schedule-timezone"
          hint="The days and times below are on this clock."
        >
          {zones(sched.timezone).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Select>
        <div className="grid gap-3 lg:grid-cols-2">
          {(['long', 'short'] as const).map((f) => (
            <FormatCard
              key={f}
              format={f}
              fs={sched[f]}
              connected={connected}
              onPatch={(p) => set({ schedule: { [f]: p } })}
            />
          ))}
        </div>
        <p className="text-sm text-muted" data-testid="schedule-cap">
          {weeklyCapText(sched)}
        </p>
        {sched.long.days.length === 0 && (
          <Callout tone="warning">No video days are ticked: videos cannot be scheduled.</Callout>
        )}
        <ErrorBox error={patch.error} />
      </div>
    </Panel>
  );
}
