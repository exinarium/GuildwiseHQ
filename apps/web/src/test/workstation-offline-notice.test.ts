import { describe, expect, it } from 'vitest';
import { OFFLINE_NOTICE_MS, offlineNotice } from '../pages/Workstations.tsx';

/** UAT 1.10.0 finding 4: a runner that stayed offline all day showed only a grey dot. */
describe('offlineNotice', () => {
  const now = Date.parse('2026-11-22T18:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('says nothing while connected or only briefly offline', () => {
    expect(offlineNotice({ connected: true, lastSeenAt: ago(3_600_000) }, now)).toBeNull();
    expect(offlineNotice({ connected: false, lastSeenAt: ago(OFFLINE_NOTICE_MS - 1000) }, now)).toBeNull();
    expect(offlineNotice({ connected: false, lastSeenAt: null }, now)).toBeNull();
  });

  it('names how long and what to do, in plain words', () => {
    expect(offlineNotice({ connected: false, lastSeenAt: ago(12 * 60_000) }, now)).toMatch(
      /^Not connected for 12 minutes\..*guildwise-runner doctor/,
    );
    expect(offlineNotice({ connected: false, lastSeenAt: ago(18 * 3_600_000) }, now)).toMatch(
      /^Not connected for 18 hours\./,
    );
    expect(offlineNotice({ connected: false, lastSeenAt: ago(3 * 86_400_000) }, now)).toMatch(/3 days/);
  });
});
