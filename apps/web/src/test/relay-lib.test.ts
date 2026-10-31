import type { RelayIntegrationDto, RelayIntegrationStatus } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  mergeRelay,
  offlineActive,
  RELAY_WHATSAPP_CLI,
  relayOfflineNotice,
  relayRowState,
  relayServeCommand,
} from '../lib/relay.ts';
import { keysForEvent } from '../ws/invalidate.ts';

const ID = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const dto = (n: number, over: Partial<RelayIntegrationDto> = {}): RelayIntegrationDto => ({
  id: ID(n),
  orgId: ID(1),
  kind: 'whatsapp_cloud',
  label: `Hook ${n}`,
  status: 'active',
  createdAt: '2026-10-30T10:00:00.000Z',
  rotatedAt: null,
  revokedAt: null,
  ...over,
});
const live = (n: number, over: Partial<RelayIntegrationStatus> = {}): RelayIntegrationStatus => ({
  integrationId: ID(n),
  connected: false,
  servingWorkstations: 0,
  everServed: true,
  offlineSince: '2026-10-31T09:00:00.000Z',
  refusedSinceOffline: { count: 0, lastAt: null },
  lastEvent: null,
  ...over,
});

describe('the offline notice rule', () => {
  const notice = (d: RelayIntegrationDto, s: RelayIntegrationStatus) =>
    relayOfflineNotice(mergeRelay([d], [s]));

  it('is shown for an active integration with no runner and a refused request', () => {
    const n = notice(
      dto(1),
      live(1, { refusedSinceOffline: { count: 2, lastAt: '2026-10-31T09:30:00.000Z' } }),
    );
    expect(n?.items).toEqual([
      expect.objectContaining({ id: ID(1), label: 'Hook 1', since: '2026-10-31T09:00:00.000Z', refused: 2 }),
    ]);
  });
  it('is not shown when offline with no refused request (only the row says so)', () => {
    const rows = mergeRelay([dto(1)], [live(1)]);
    expect(relayOfflineNotice(rows)).toBeNull();
    expect(relayRowState(rows[0]!)).toBe('runner_offline');
  });
  it('is not shown when a runner is connected', () => {
    const rows = mergeRelay([dto(1)], [live(1, { connected: true, offlineSince: null })]);
    expect(relayOfflineNotice(rows)).toBeNull();
    expect(relayRowState(rows[0]!)).toBe('connected');
  });
  it('is not shown for a revoked integration', () => {
    const rows = mergeRelay(
      [dto(1, { status: 'revoked' })],
      [live(1, { refusedSinceOffline: { count: 5, lastAt: null } })],
    );
    expect(relayOfflineNotice(rows)).toBeNull();
    expect(relayRowState(rows[0]!)).toBe('revoked');
    expect(offlineActive(rows[0]!)).toBe(false);
  });
  it('uses the last refused time when no runner ever served it', () => {
    const n = notice(
      dto(1),
      live(1, {
        offlineSince: null,
        everServed: false,
        refusedSinceOffline: { count: 1, lastAt: '2026-10-31T08:00:00.000Z' },
      }),
    );
    expect(n?.items[0]?.since).toBe('2026-10-31T08:00:00.000Z');
  });
  it('names the 7 day retry window for WhatsApp only, and a limited time otherwise', () => {
    const refused = { refusedSinceOffline: { count: 1, lastAt: '2026-10-31T09:30:00.000Z' } };
    expect(notice(dto(1), live(1, refused))?.retryText).toContain('up to 7 days');
    expect(notice(dto(1, { kind: 'generic' }), live(1, refused))?.retryText).toBe(
      'The provider retries for a limited time.',
    );
    const mixed = relayOfflineNotice(
      mergeRelay([dto(1), dto(2, { kind: 'generic' })], [live(1, refused), live(2, refused)]),
    );
    expect(mixed?.items).toHaveLength(2);
    expect(mixed?.retryText).toBe('The provider retries for a limited time.');
  });
  it('treats an active row with no status as offline but gives no notice', () => {
    const rows = mergeRelay([dto(1)], []);
    expect(relayRowState(rows[0]!)).toBe('runner_offline');
    expect(relayOfflineNotice(rows)).toBeNull();
  });
});

describe('commands', () => {
  it('shows the serve command with the id and kind, and the runner CLI for the secrets', () => {
    expect(relayServeCommand(dto(1, { kind: 'webhook_in' }))).toBe(
      `guildwise-runner relay add ${ID(1)} --kind webhook_in`,
    );
    expect(RELAY_WHATSAPP_CLI).toBe('guildwise-runner whatsapp-connect');
  });
});

describe('live updates', () => {
  it('refetches the relay queries on workstation and relay events', () => {
    expect(
      keysForEvent({ type: 'WorkstationConnected', streamId: 'workstation-x', projectId: null }),
    ).toContainEqual(['relay']);
    expect(
      keysForEvent({ type: 'RelayIntegrationRotated', streamId: `relay-${ID(1)}`, projectId: null }),
    ).toEqual([['relay']]);
  });
});
