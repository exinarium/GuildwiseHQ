import { normalizeUrl } from '@aom/shared';

/** Records the pages an agent opened during one shift (the runner sees every `WebFetch` in the runtime stream). */
export class FetchedUrls {
  private readonly urls = new Set<string>();

  /** Called for every tool event; only page fetches count. */
  record(toolName: string, summary: string): void {
    if (toolName !== 'WebFetch') return;
    const url = /https?:\/\/\S+/.exec(summary)?.[0]?.replace(/["',}\]]+$/, '');
    if (url) this.urls.add(normalizeUrl(url));
  }

  has(url: string): boolean {
    return this.urls.has(normalizeUrl(url));
  }

  get size(): number {
    return this.urls.size;
  }
}

export interface FeedDataCheck {
  /** `candidates` (scout) or `digest` (curator). */
  dataKind: string;
  data: Record<string, unknown>;
  fetched: FetchedUrls;
  /** URLs that were opened in an earlier shift and already passed this check (the scout's candidates for a curator). */
  vouched?: readonly string[];
}

/**
 * No fabrication (docs/SPEC.md "Feed and research rules"): every item a scout or curator reports must be a real page
 * that was opened during the run. Returns the message for the agent when an item's URL was not opened, else null. The
 * curator may also report candidates the scout opened (those passed this check in the scout's shift).
 */
export function checkFeedItemsFetched(c: FeedDataCheck): string | null {
  if (c.dataKind !== 'candidates' && c.dataKind !== 'digest') return null;
  const items = Array.isArray(c.data.items) ? (c.data.items as Array<{ url?: unknown }>) : [];
  const vouched = new Set((c.vouched ?? []).map(normalizeUrl));
  const missing = items
    .map((i) => (typeof i.url === 'string' ? i.url : ''))
    .filter((u) => u && !c.fetched.has(u) && !(c.dataKind === 'digest' && vouched.has(normalizeUrl(u))));
  if (missing.length === 0) return null;
  return `these items are not pages you opened in this shift, so they cannot be reported: ${missing.join(', ')}. Open each page with your web tools first and report the URL you opened, or leave the item out. Never invent an item.`;
}
