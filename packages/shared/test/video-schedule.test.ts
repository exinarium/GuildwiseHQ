import { describe, expect, it } from 'vitest';
import {
  backlogLimit,
  composeCaption,
  DEFAULT_VIDEO_SETTINGS,
  defaultSchedule,
  type FormatSchedule,
  isScheduleSlot,
  nextFreeSlot,
  PatchVideoSettingsRequestSchema,
  resolveSchedule,
  SOCIAL_NETWORKS,
  slotsFrom,
  VIDEO_CAPTION_LIMITS,
  VIDEO_DESTINATIONS,
  VideoScheduleSchema,
  VideoSettingsSchema,
  weeklyLimit,
  zonedWallToUtc,
} from '../src/index.ts';

const fs = (days: FormatSchedule['days'], time = '10:00'): FormatSchedule => ({
  days,
  time,
  destinations: ['youtube'],
  renderLeadHours: 48,
});
const iso = (d: Date | null | undefined) => d?.toISOString();

describe('zonedWallToUtc', () => {
  it('Africa/Johannesburg has no daylight saving: 10:00 is 08:00 UTC all year', () => {
    expect(iso(zonedWallToUtc('2026-01-15', '10:00', 'Africa/Johannesburg'))).toBe(
      '2026-01-15T08:00:00.000Z',
    );
    expect(iso(zonedWallToUtc('2026-07-15', '10:00', 'Africa/Johannesburg'))).toBe(
      '2026-07-15T08:00:00.000Z',
    );
  });
  it('Europe/Amsterdam: +2 in summer, +1 in winter, either side of the change', () => {
    expect(iso(zonedWallToUtc('2026-10-24', '10:00', 'Europe/Amsterdam'))).toBe('2026-10-24T08:00:00.000Z');
    expect(iso(zonedWallToUtc('2026-10-26', '10:00', 'Europe/Amsterdam'))).toBe('2026-10-26T09:00:00.000Z');
    expect(iso(zonedWallToUtc('2026-03-28', '10:00', 'Europe/Amsterdam'))).toBe('2026-03-28T09:00:00.000Z');
    expect(iso(zonedWallToUtc('2026-03-30', '10:00', 'Europe/Amsterdam'))).toBe('2026-03-30T08:00:00.000Z');
  });
  it('America/New_York: -4 in summer, -5 in winter', () => {
    expect(iso(zonedWallToUtc('2026-07-01', '09:00', 'America/New_York'))).toBe('2026-07-01T13:00:00.000Z');
    expect(iso(zonedWallToUtc('2026-12-01', '09:00', 'America/New_York'))).toBe('2026-12-01T14:00:00.000Z');
  });
  it('a wall time in the spring-forward gap moves forward; one that happens twice takes the first', () => {
    // 2026-03-08 02:30 does not exist in New York (02:00 jumps to 03:00): it lands at 03:30 EDT = 07:30Z
    expect(iso(zonedWallToUtc('2026-03-08', '02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z');
    // 2026-11-01 01:30 happens twice (EDT then EST): the first is 05:30Z
    expect(iso(zonedWallToUtc('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
    // Amsterdam: 2026-03-29 02:30 does not exist; 2026-10-25 02:30 happens twice
    expect(iso(zonedWallToUtc('2026-03-29', '02:30', 'Europe/Amsterdam'))).toBe('2026-03-29T01:30:00.000Z');
    expect(iso(zonedWallToUtc('2026-10-25', '02:30', 'Europe/Amsterdam'))).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('slotsFrom / nextFreeSlot / isScheduleSlot', () => {
  const tz = 'Africa/Johannesburg';
  const wed = fs(['mon', 'wed', 'fri']);
  it('lists the next slots at or after a moment, in order', () => {
    const got = slotsFrom(wed, tz, new Date('2026-10-28T06:00:00Z'), 4).map(iso); // a Wednesday, before 08:00Z
    expect(got).toEqual([
      '2026-10-28T08:00:00.000Z',
      '2026-10-30T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
      '2026-11-04T08:00:00.000Z',
    ]);
    // at the very instant of a slot, that slot is included; a millisecond later it is not
    expect(iso(slotsFrom(wed, tz, new Date('2026-10-28T08:00:00Z'), 1)[0])).toBe('2026-10-28T08:00:00.000Z');
    expect(iso(slotsFrom(wed, tz, new Date('2026-10-28T08:00:00.001Z'), 1)[0])).toBe(
      '2026-10-30T08:00:00.000Z',
    );
  });
  it('uses the local date of the zone, not the UTC date', () => {
    // 23:30 UTC on Tuesday 27 Oct is already Wednesday 28 Oct 01:30 in Johannesburg: Wednesday's slot is next
    expect(iso(slotsFrom(wed, tz, new Date('2026-10-27T23:30:00Z'), 1)[0])).toBe('2026-10-28T08:00:00.000Z');
    // a Friday 23:30 in New York is Saturday UTC; a slot at 20:00 New York Friday is Saturday 00:00Z
    const evening = fs(['fri'], '20:00');
    expect(iso(slotsFrom(evening, 'America/New_York', new Date('2026-10-30T12:00:00Z'), 1)[0])).toBe(
      '2026-10-31T00:00:00.000Z',
    );
  });
  it('no days: no slots; all seven days: every day', () => {
    expect(slotsFrom(fs([]), tz, new Date('2026-10-28T00:00:00Z'), 5)).toEqual([]);
    expect(nextFreeSlot(fs([]), tz, new Date('2026-10-28T00:00:00Z'), new Set(), 0)).toBeNull();
    const all = slotsFrom(
      fs(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      tz,
      new Date('2026-10-28T09:00:00Z'),
      8,
    );
    expect(all.map((d) => d.getUTCDate())).toEqual([29, 30, 31, 1, 2, 3, 4, 5]);
  });
  it('keeps the wall clock time across a daylight saving change', () => {
    const got = slotsFrom(fs(['mon', 'sun']), 'Europe/Amsterdam', new Date('2026-10-22T00:00:00Z'), 3).map(
      iso,
    );
    expect(got).toEqual(['2026-10-25T09:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-01T09:00:00.000Z']);
    // 10:00 local on Sunday 25 Oct (the change happens that night at 03:00) is still +1 after it: 09:00Z
  });
  it('the next free slot skips taken slots and keeps the minimum lead', () => {
    const now = new Date('2026-10-28T06:00:00Z');
    const taken = new Set([Date.parse('2026-10-28T08:00:00Z')]);
    expect(iso(nextFreeSlot(wed, tz, now, new Set(), 0))).toBe('2026-10-28T08:00:00.000Z');
    expect(iso(nextFreeSlot(wed, tz, now, taken, 0))).toBe('2026-10-30T08:00:00.000Z');
    // 3 hours of lead: 06:00 + 3h = 09:00 is past today's slot
    expect(iso(nextFreeSlot(wed, tz, now, new Set(), 3 * 3_600_000))).toBe('2026-10-30T08:00:00.000Z');
    // everything near is taken: the search goes on (up to 400 days)
    const many = new Set(slotsFrom(wed, tz, now, 100).map((d) => d.getTime()));
    expect(iso(nextFreeSlot(wed, tz, now, many, 0))).toBe(iso(slotsFrom(wed, tz, now, 101)[100]));
  });
  it('isScheduleSlot only accepts the exact instant of a slot', () => {
    expect(isScheduleSlot(wed, tz, new Date('2026-10-28T08:00:00Z'))).toBe(true);
    expect(isScheduleSlot(wed, tz, new Date('2026-10-28T08:01:00Z'))).toBe(false);
    expect(isScheduleSlot(wed, tz, new Date('2026-10-29T08:00:00Z'))).toBe(false); // a Thursday
    expect(isScheduleSlot(wed, tz, new Date('nope'))).toBe(false);
  });
});

describe('defaults and capacity', () => {
  it('3 and 3 a week: Mon/Wed/Fri 10:00 for videos, Tue/Thu/Sat 16:00 for Shorts, Africa/Johannesburg', () => {
    const d = defaultSchedule(3, 3);
    expect(d).toMatchObject({
      timezone: 'Africa/Johannesburg',
      long: { days: ['mon', 'wed', 'fri'], time: '10:00', destinations: ['youtube'], renderLeadHours: 48 },
      short: { days: ['tue', 'thu', 'sat'], time: '16:00', destinations: ['youtube'], renderLeadHours: 24 },
    });
    expect(VideoScheduleSchema.safeParse(d).success).toBe(true);
    expect(defaultSchedule(5, 1).long.days).toEqual(['mon', 'wed', 'fri', 'tue', 'thu']);
    expect(defaultSchedule(0, 7).long.days).toEqual([]);
    expect(defaultSchedule(7, 7).short.days).toHaveLength(7);
    expect(defaultSchedule(14, 14).long.days).toHaveLength(7); // the old limit was 14
  });
  it('resolveSchedule derives from the old counts until a schedule is saved, then ignores them', () => {
    expect(resolveSchedule({ perWeek: 2, shortsPerWeek: 4 }).long.days).toEqual(['mon', 'wed']);
    expect(resolveSchedule({ perWeek: 2, shortsPerWeek: 4 }).short.days).toHaveLength(4);
    expect(resolveSchedule({}).long.days).toHaveLength(3);
    const saved = defaultSchedule(1, 1);
    expect(resolveSchedule({ schedule: saved, perWeek: 6, shortsPerWeek: 6 })).toEqual(saved);
    expect(resolveSchedule({ schedule: { nonsense: true }, perWeek: 1 }).long.days).toEqual(['mon']);
  });
  it('the cap is the days ticked, the backlog limit twice that', () => {
    const f = fs(['mon', 'wed']);
    expect(weeklyLimit(f)).toBe(2);
    expect(backlogLimit(f)).toBe(4);
    expect(backlogLimit(fs([]))).toBe(0);
  });
  it('the default settings carry the derived schedule', () => {
    expect(DEFAULT_VIDEO_SETTINGS.schedule).toEqual(defaultSchedule(3, 3));
    expect(VideoSettingsSchema.parse(DEFAULT_VIDEO_SETTINGS).schedule.timezone).toBe('Africa/Johannesburg');
  });
});

describe('schedule validation', () => {
  const ok = (v: unknown) => VideoScheduleSchema.safeParse(v).success;
  const base = defaultSchedule(3, 3);
  it('a valid zone, unique days, HH:MM and a lead of 1 to 168 hours', () => {
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, timezone: 'Mars/Olympus' })).toBe(false);
    expect(ok({ ...base, long: { ...base.long, days: ['mon', 'mon'] } })).toBe(false);
    expect(ok({ ...base, long: { ...base.long, time: '24:00' } })).toBe(false);
    expect(ok({ ...base, short: { ...base.short, time: '9:00' } })).toBe(false);
    expect(ok({ ...base, short: { ...base.short, renderLeadHours: 0 } })).toBe(false);
    expect(ok({ ...base, short: { ...base.short, renderLeadHours: 169 } })).toBe(false);
  });
  it('long videos go to YouTube only; Shorts may go to every destination', () => {
    expect(ok({ ...base, long: { ...base.long, destinations: ['youtube', 'x'] } })).toBe(false);
    expect(ok({ ...base, long: { ...base.long, destinations: ['facebook'] } })).toBe(false);
    expect(ok({ ...base, short: { ...base.short, destinations: [...VIDEO_DESTINATIONS] } })).toBe(true);
    expect(VIDEO_DESTINATIONS).toEqual([
      'youtube',
      'facebook',
      'instagram',
      'x',
      'linkedin',
      'bluesky',
      'tiktok',
    ]);
  });
  it('there is no announce field, and Instagram and TikTok are not share networks of the blog', () => {
    expect(Object.keys(base.long)).not.toContain('announce');
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('instagram');
    expect(SOCIAL_NETWORKS as readonly string[]).not.toContain('tiktok');
  });
  it('a settings patch takes part of the schedule', () => {
    const p = PatchVideoSettingsRequestSchema.parse({
      schedule: { timezone: 'Europe/Amsterdam', short: { time: '09:30' } },
    });
    expect(p.schedule?.short?.time).toBe('09:30');
    expect(
      PatchVideoSettingsRequestSchema.safeParse({ schedule: { long: { days: ['funday'] } } }).success,
    ).toBe(false);
  });
});

describe('captions per destination', () => {
  it('limits: the four networks as before, Instagram and TikTok 2,200 with 3 to 5 tags, YouTube a 100-character title', () => {
    expect(VIDEO_CAPTION_LIMITS.x).toMatchObject({ total: 256 });
    expect(VIDEO_CAPTION_LIMITS.instagram).toMatchObject({ total: 2200, tags: [3, 5] });
    expect(VIDEO_CAPTION_LIMITS.tiktok).toMatchObject({ total: 2200, tags: [3, 5] });
    expect(VIDEO_CAPTION_LIMITS.youtube.title).toBe(100);
  });
  it('composes Instagram and TikTok as one block that fits, hashtags last', () => {
    const c = composeCaption('instagram', 'Watch how agents work', ['agents', 'ai', 'automation']);
    expect(c.text).toBe('Watch how agents work\n\n#agents #ai #automation');
    const long = composeCaption('tiktok', 'x'.repeat(3000), ['a1', 'b2', 'c3']);
    expect([...long.text].length).toBeLessThanOrEqual(2200);
    expect(long.text.endsWith('#a1 #b2 #c3')).toBe(true);
  });
  it('YouTube is a title cut to 100 characters; X carries no link when none is given', () => {
    expect([...composeCaption('youtube', 'T'.repeat(150)).text].length).toBe(100);
    expect(composeCaption('x', 'A new Short about agents', ['agents']).text).toBe(
      'A new Short about agents #agents',
    );
  });
  it('the four old networks compose as before', () => {
    expect(composeCaption('facebook', 'Hello', ['a1']).text).toBe('Hello\n\n#a1');
    expect(composeCaption('bluesky', 'Hello', ['a1']).text).toBe('Hello #a1');
  });
});
