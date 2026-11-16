import type { DeskItemDto, ReleaseQueueItem } from '@aom/shared';

/**
 * What the Releases badge, the Release prep tab, the Release queue panel and the Desk count as "waiting": one definition,
 * so the counts cannot drift apart.
 */

/** A Ship release desk item (the release proposal the Owner approves). */
export const isShipReleaseItem = (i: Pick<DeskItemDto, 'kind' | 'subkind'>): boolean =>
  i.kind === 'approval' && i.subkind === 'ship_release';

/** A Ship release item that is still open. The open desk list also carries resolved CEO decisions; they do not count. */
export const isOpenShipRelease = (i: Pick<DeskItemDto, 'kind' | 'subkind' | 'status'>): boolean =>
  isShipReleaseItem(i) && i.status === 'open';

export const countOpenShipReleases = (
  items: readonly Pick<DeskItemDto, 'kind' | 'subkind' | 'status'>[] | undefined,
): number => (items ?? []).filter(isOpenShipRelease).length;

/** One per row of the Release queue panel (a project, environment and commit), the same as its "Waiting for you" tab badge. */
export const countWaitingReleases = (queue: readonly ReleaseQueueItem[] | undefined): number =>
  Array.isArray(queue) ? queue.length : 0;
