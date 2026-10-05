import { describe, expect, it } from 'vitest';
import {
  type FloorDigest,
  floorReportDue,
  isValidTimeZone,
  localParts,
  REPORTER,
  ReportingPrefsSchema,
  renderFloorReportFallback,
  renderSignalFallback,
  reporterBriefOutcomes,
  TriageDataSchema,
} from '../src/index.ts';

describe('local time', () => {
  it('reads the date and minutes in the manager zone', () => {
    expect(localParts(new Date('2026-11-10T06:00:00Z'), 'Africa/Johannesburg')).toEqual({
      date: '2026-11-10',
      minutes: 8 * 60,
    });
    expect(localParts(new Date('2026-11-10T06:30:00Z'), 'America/Los_Angeles')).toEqual({
      date: '2026-11-09',
      minutes: 22 * 60 + 30,
    });
    expect(localParts(new Date('2026-11-10T23:30:00Z'), null).date).toBe('2026-11-10');
    expect(localParts(new Date('2026-11-10T23:30:00Z'), 'Not/AZone').date).toBe('2026-11-10');
  });

  it('validates zones', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('the floor report is due from dailyAt, once per local day', () => {
    const tz = 'Africa/Johannesburg';
    expect(floorReportDue(new Date('2026-11-10T05:59:00Z'), tz, '08:00', '2026-11-09').due).toBe(false);
    expect(floorReportDue(new Date('2026-11-10T06:00:00Z'), tz, '08:00', '2026-11-09')).toEqual({
      due: true,
      localDate: '2026-11-10',
    });
    expect(floorReportDue(new Date('2026-11-10T09:00:00Z'), tz, '08:00', '2026-11-10').due).toBe(false);
    // a server that was down at 08:00 reports when it is back
    expect(floorReportDue(new Date('2026-11-10T13:00:00Z'), tz, '08:00', '2026-11-09').due).toBe(true);
  });

  it('a brand-new organization waits for the next report time', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(floorReportDue(now, 'UTC', '08:00', null, new Date('2026-11-10T10:00:00Z')).due).toBe(false);
    expect(floorReportDue(now, 'UTC', '08:00', null, new Date('2026-11-09T10:00:00Z')).due).toBe(true);
  });
});

describe('reporter contract', () => {
  it('keeps the owner thresholds in one object', () => {
    expect(REPORTER.loop).toEqual({ failures: 3, windowMinutes: 10 });
    expect(REPORTER.repeatedApproval).toMatchObject({ count: 3, windowHours: 24 });
    expect(REPORTER.blockedHours).toBe(4);
    expect(REPORTER.unclaimedMinutes).toBe(30);
    expect(REPORTER.defaultDailyAt).toBe('08:00');
  });

  it('prefs and decisions validate', () => {
    expect(ReportingPrefsSchema.safeParse({ routeViaBa: true, dailyAt: '08:00' }).success).toBe(true);
    expect(ReportingPrefsSchema.safeParse({ routeViaBa: true, dailyAt: '8am' }).success).toBe(false);
    expect(TriageDataSchema.safeParse({ decisions: [] }).success).toBe(false);
    expect(reporterBriefOutcomes('floor_report')[0]?.id).toBe('floor_report');
  });

  it('the template report has the six sections the manager expects', () => {
    const d: FloorDigest = {
      generatedAt: '2026-11-10T06:00:00.000Z',
      localDate: '2026-11-10',
      since: null,
      phases: [{ ref: 'TOY-P1', name: 'Autosave', status: 'open', projectKey: 'TOY', lateBugs: ['TOY-9'] }],
      signals: [],
      backingOff: [],
      devopsOpen: [],
      resolvedByBa: [],
      failures: [],
    };
    const text = renderFloorReportFallback(d);
    expect(text).toContain('TOY-P1 Autosave: open, held open by late bugs TOY-9');
    expect((text.match(/^## /gm) ?? []).length).toBe(6);
    expect(
      renderSignalFallback({
        id: '8a8d0b0e-0c3b-4c6c-9a5b-0f2d2b3b2a11',
        kind: 'loop',
        urgency: 'urgent',
        fingerprint: 'x',
        count: 3,
        status: 'open',
        firstSeenAt: 'a',
        lastSeenAt: 'b',
        subject: { title: 'TOY-1 keeps failing', detail: '' },
        evidence: {},
      }),
    ).toContain('Shift loop: TOY-1 keeps failing');
  });
});
