import { describe, expect, it } from 'vitest';
import {
  buildDevcontainer,
  estimateMonthlyCost,
  inOfficeHours,
  type OfficeHours,
  officeHoursPerMonth,
} from '../src/index.ts';

const weekdays: OfficeHours = {
  days: [1, 2, 3, 4, 5],
  from: '08:00',
  to: '17:00',
  timezone: 'Africa/Johannesburg',
};

describe('office hours', () => {
  it('is always open without hours', () => {
    expect(inOfficeHours(null, new Date())).toBe(true);
  });
  it('uses the time zone of the window', () => {
    // Monday 2026-10-12 07:30 UTC is 09:30 in Johannesburg
    expect(inOfficeHours(weekdays, new Date('2026-10-12T07:30:00Z'))).toBe(true);
    // 16:30 UTC is 18:30 there
    expect(inOfficeHours(weekdays, new Date('2026-10-12T16:30:00Z'))).toBe(false);
    // Saturday
    expect(inOfficeHours(weekdays, new Date('2026-10-10T08:00:00Z'))).toBe(false);
  });
  it('handles a window that runs past midnight', () => {
    const night: OfficeHours = { days: [5], from: '22:00', to: '04:00', timezone: 'UTC' };
    expect(inOfficeHours(night, new Date('2026-10-09T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(inOfficeHours(night, new Date('2026-10-10T03:00:00Z'))).toBe(true); // Saturday 03:00, still Friday's window
    expect(inOfficeHours(night, new Date('2026-10-10T23:00:00Z'))).toBe(false);
  });
  it('counts the hours a month', () => {
    expect(officeHoursPerMonth(weekdays)).toBe(Math.round((9 * 5 * 52) / 12));
    expect(officeHoursPerMonth(null)).toBe(176);
  });
});

describe('cost estimate', () => {
  it('a VPS is its flat price; unknown price says so', () => {
    expect(estimateMonthlyCost({ provider: 'ssh', monthlyPriceUsd: 5.49 }).monthlyUsd).toBe(5.49);
    expect(estimateMonthlyCost({ provider: 'ssh', monthlyPriceUsd: null }).monthlyUsd).toBe(0);
  });
  it('Codespaces are hours times the rate plus storage', () => {
    const e = estimateMonthlyCost({ provider: 'codespaces', machine: 'basicLinux32gb', hoursPerMonth: 100 });
    expect(e.monthlyUsd).toBe(Math.round((0.18 * 100 + 32 * 0.07) * 100) / 100);
  });
});

describe('devcontainer', () => {
  it('adds features for the detected stacks and carries no secret', () => {
    const d = buildDevcontainer({
      name: 'X',
      serverUrl: 'https://hq.example.com/',
      stacks: [{ id: 'dotnet-maui', params: { sdkMajor: '9' } }, { id: 'python' }, { id: 'docker' }],
    }) as { features: Record<string, unknown>; postStartCommand: string };
    expect(Object.keys(d.features)).toEqual(
      expect.arrayContaining([
        'ghcr.io/devcontainers/features/node:1',
        'ghcr.io/devcontainers/features/dotnet:2',
        'ghcr.io/devcontainers/features/python:1',
      ]),
    );
    expect(d.features['ghcr.io/devcontainers/features/dotnet:2']).toEqual({ version: '9.0' });
    expect(JSON.stringify(d.features)).not.toContain('docker');
    expect(d.postStartCommand).toBe(
      'curl -fsSL https://hq.example.com/api/runner/codespaces-bootstrap.sh | bash',
    );
  });
});
