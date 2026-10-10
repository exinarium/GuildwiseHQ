import type { MeResponse } from '@aom/shared';
import { type Block, parseBlocks } from '../help/markdown.ts';

export type Audience = 'all' | 'owner' | 'admin' | 'superadmin';

export interface WhatsNewEntry {
  /** The file name without `.md`: stable, and what the server remembers as "seen". */
  id: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
  audience: Audience;
  /** Deep link to a help article, `/help/<slug>` or `/help/<slug>#anchor`. */
  help?: string;
  blocks: Block[];
  /** Plain body, for tests. */
  body: string;
}

const AUDIENCES: readonly Audience[] = ['all', 'owner', 'admin', 'superadmin'];

/** Reads one entry file: a small frontmatter (title, date, audience, help) and a markdown body. */
export function parseEntry(id: string, src: string): WhatsNewEntry {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const raw: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    // a trailing "# comment" after the value is allowed (the README shows the format that way)
    raw[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .replace(/\s+#\s.*$/, '')
      .trim();
  }
  const body = (m ? src.slice(m[0].length) : src).trim();
  const audience = AUDIENCES.find((a) => a === raw.audience) ?? 'all';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date ?? '') ? (raw.date as string) : '1970-01-01';
  return {
    id,
    title: raw.title || id,
    date,
    audience,
    ...(raw.help?.startsWith('/help/') ? { help: raw.help } : {}),
    blocks: parseBlocks(body),
    body,
  };
}

// Bundled at build time, like the help articles: no request leaves the app.
const FILES = import.meta.glob('./entries/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

/** Newest first; entries of the same day by file name, so the order is stable. */
export const sortEntries = (list: WhatsNewEntry[]): WhatsNewEntry[] =>
  [...list].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

export const ENTRIES: WhatsNewEntry[] = sortEntries(
  Object.entries(FILES)
    .map(([path, src]) => ({ id: /([^/]+)\.md$/.exec(path)?.[1] ?? path, src }))
    .filter((f) => !/readme/i.test(f.id))
    .map((f) => parseEntry(f.id, f.src)),
);

/** Does this entry concern the user: by role in the current organization; platform entries only for platform users. */
export function matchesAudience(e: WhatsNewEntry, me: MeResponse): boolean {
  const platform = me.account?.kind === 'super_admin';
  const role = me.activeOrg?.role;
  switch (e.audience) {
    case 'all':
      return true;
    case 'superadmin':
      return platform;
    case 'owner':
      return !platform && role === 'owner';
    case 'admin':
      return !platform && (role === 'owner' || role === 'admin');
  }
}

/** The entries for this user (all of them, seen or not), newest first. */
export function entriesFor(me: MeResponse, all: WhatsNewEntry[] = ENTRIES): WhatsNewEntry[] {
  return all.filter((e) => matchesAudience(e, me));
}

/**
 * What the popup shows: entries for the user that they have not seen. Entries dated before the account was created
 * count as seen: a new user gets the tour and the setup checklist instead of a list of things they never knew without.
 */
export function unseenFor(me: MeResponse, all: WhatsNewEntry[] = ENTRIES): WhatsNewEntry[] {
  const seen = new Set(me.user.whatsNewSeen ?? []);
  const created = me.user.createdAt.slice(0, 10);
  return entriesFor(me, all).filter((e) => !seen.has(e.id) && e.date >= created);
}
