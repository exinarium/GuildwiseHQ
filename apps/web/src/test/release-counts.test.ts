import type { DeskItemDto, ReleaseQueueItem } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  countOpenShipReleases,
  countWaitingReleases,
  isOpenShipRelease,
  isShipReleaseItem,
} from '../lib/releaseCounts.ts';

type Item = Pick<DeskItemDto, 'kind' | 'subkind' | 'status'>;
const item = (over: Partial<Item> = {}): Item => ({
  kind: 'approval',
  subkind: 'ship_release',
  status: 'open',
  ...over,
});

describe('release counts', () => {
  it('knows a Ship release item by kind and subkind', () => {
    expect(isShipReleaseItem(item())).toBe(true);
    expect(isShipReleaseItem(item({ subkind: 'outbound' }))).toBe(false);
    expect(isShipReleaseItem(item({ kind: 'question' }))).toBe(false);
    expect(isShipReleaseItem(item({ subkind: null }))).toBe(false);
  });

  it('counts only the open Ship release items', () => {
    const items = [
      item(),
      item(),
      // a resolved one in the open list (a CEO decision not yet reviewed) does not count
      item({ status: 'answered' }),
      item({ status: 'dismissed' }),
      item({ subkind: 'outbound' }),
      item({ kind: 'question', subkind: null }),
    ];
    expect(isOpenShipRelease(items[2] as Item)).toBe(false);
    expect(countOpenShipReleases(items)).toBe(2);
    expect(countOpenShipReleases([])).toBe(0);
    expect(countOpenShipReleases(undefined)).toBe(0);
  });

  it('counts one per release queue row, and nothing without a queue', () => {
    expect(countWaitingReleases([{}, {}] as unknown as ReleaseQueueItem[])).toBe(2);
    expect(countWaitingReleases([])).toBe(0);
    expect(countWaitingReleases(undefined)).toBe(0);
  });
});
