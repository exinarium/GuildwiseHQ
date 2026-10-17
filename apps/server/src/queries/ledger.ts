import type { LedgerEntryDto, LedgerMatch, LedgerVersionDto } from '@aom/shared';
import { iso, type Queryable, type Row, rows } from '../db/sql.ts';

export type LedgerScopeFilter = 'all' | 'feature' | 'decision' | 'standing_order';

const COLS = 'e.id, e.scope, e.title, e.body';

/** Words of at least 3 characters (the english config drops stop words), joined into an OR tsquery. */
export function looseTsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, 12);
  return words.length ? words.join(' | ') : null;
}

interface SearchOpts {
  orgId: string;
  /** Entries of this project plus org-wide ones; null/undefined = every entry of the org. */
  projectId?: string | null;
  scope?: LedgerScopeFilter;
  limit?: number;
  /** Minimum rank for loose (any-word) matches; strict (all-words) matches always count. */
  looseMinRank?: number;
}

/**
 * Full-text search over live ledger entries. Strict first (`websearch_to_tsquery`, all words), then loose (any
 * word) matches above `looseMinRank` to fill up to `limit`. Scoped to the org and, when given, the project plus
 * org-wide standing orders (docs/ARCHITECTURE.md section 15).
 */
export async function searchLedger(db: Queryable, query: string, o: SearchOpts): Promise<LedgerMatch[]> {
  const limit = o.limit ?? 10;
  const scope = o.scope ?? 'all';
  const sql = (tsquery: string, minRank: boolean) => `
    SELECT ${COLS}, ts_rank(e.search, q) AS rank
      FROM ledger_entries e, ${tsquery} AS q
     WHERE e.org_id = $2 AND e.superseded_by IS NULL AND e.retired_at IS NULL AND e.search @@ q
       AND ($3::uuid IS NULL OR e.project_id IS NULL OR e.project_id = $3)
       AND ($4 = 'all' OR e.scope = $4)
       ${minRank ? 'AND ts_rank(e.search, q) >= $6' : ''}
     ORDER BY rank DESC, e.created_at DESC LIMIT $5`;
  const common = [o.orgId, o.projectId ?? null, scope, limit];
  const strict = await rows(db, sql("websearch_to_tsquery('english', $1)", false), [query, ...common]);
  const out = new Map<string, LedgerMatch>(strict.map((r) => [r.id, toMatch(r)]));
  const loose = looseTsQuery(query);
  if (out.size < limit && loose) {
    const extra = await rows(db, sql("to_tsquery('english', $1)", true), [
      loose,
      ...common,
      o.looseMinRank ?? 0,
    ]);
    for (const r of extra) if (!out.has(r.id)) out.set(r.id, toMatch(r));
  }
  return [...out.values()].slice(0, limit);
}

const toMatch = (r: Row): LedgerMatch => ({
  id: r.id,
  scope: r.scope,
  title: r.title,
  body: r.body,
  rank: Number(r.rank),
});

/**
 * Duplicate check for a new question: top 3 relevant entries of the card's org and project (+ standing orders).
 * All-words matches always count. Any-word matches need roughly two matching terms: `ts_rank` of an OR query
 * is ~0.015 per matching lexeme, so the section 15 floor of 0.1 (which suits all-words queries) would never be reached.
 */
export const dedupMatches = (db: Queryable, orgId: string, projectId: string | null, question: string) =>
  searchLedger(db, question, { orgId, projectId, limit: 3, looseMinRank: 0.03 });

/** Standing orders every agent of the org (and of this project) loads at the start of a shift. */
export async function standingOrdersFor(
  db: Queryable,
  orgId: string,
  projectId: string,
): Promise<Array<{ title: string; body: string }>> {
  return (
    await rows(
      db,
      `SELECT title, body FROM ledger_entries
        WHERE org_id=$1 AND scope='standing_order' AND superseded_by IS NULL AND retired_at IS NULL AND (project_id IS NULL OR project_id=$2)
        ORDER BY created_at, id`,
      [orgId, projectId],
    )
  ).map((r) => ({ title: r.title, body: r.body }));
}

/**
 * Standing orders for work that spans projects or none (a DevOps request, a chat): the organization-wide ones plus
 * those of every project involved. A project's order is titled with the project key so the reader knows its reach.
 */
export async function standingOrdersForProjects(
  db: Queryable,
  orgId: string,
  projectIds: string[],
): Promise<Array<{ title: string; body: string }>> {
  return (
    await rows(
      db,
      `SELECT e.title, e.body, p.key AS project_key FROM ledger_entries e LEFT JOIN projects p ON p.id = e.project_id
        WHERE e.org_id=$1 AND e.scope='standing_order' AND e.superseded_by IS NULL AND e.retired_at IS NULL
          AND (e.project_id IS NULL OR e.project_id = ANY($2::uuid[]))
        ORDER BY e.project_id NULLS FIRST, e.created_at, e.id`,
      [orgId, [...new Set(projectIds)]],
    )
  ).map((r) => ({ title: r.project_key ? `${r.project_key}: ${r.title}` : r.title, body: r.body }));
}

/** What a card's brief carries of its own ledger entries: the newest few, as one-liners, within a byte budget. */
export const CARD_LEDGER_MAX_ENTRIES = 5;
export const CARD_LEDGER_MAX_BYTES = 4096;
const ONE_LINER_CHARS = 280;

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Pure: caps the entries (newest first in, oldest-to-newest out) to `max` one-liners within `maxBytes`. */
export function capLedgerEntries<T extends { title: string; body: string }>(
  newestFirst: T[],
  max = CARD_LEDGER_MAX_ENTRIES,
  maxBytes = CARD_LEDGER_MAX_BYTES,
): T[] {
  const out: T[] = [];
  let bytes = 0;
  for (const e of newestFirst.slice(0, max)) {
    const one = { ...e, title: oneLine(e.title, 120), body: oneLine(e.body, ONE_LINER_CHARS) };
    const size = Buffer.byteLength(`${one.title}${one.body}`) + 40;
    if (bytes + size > maxBytes && out.length > 0) break;
    bytes += size;
    out.push(one);
  }
  return out.reverse();
}

/**
 * Requirements and decisions linked to a card (answers to its questions land here), capped at the source: the newest
 * five as one-liners within 4 KB. `total` counts all of them, so the prompt can point at `aom ledger search` for the rest.
 */
export async function cardLedgerEntries(
  db: Queryable,
  cardId: string,
): Promise<{ entries: Array<{ id: string; scope: string; title: string; body: string }>; total: number }> {
  const live = await rows(
    db,
    `SELECT id, scope, title, body FROM ledger_entries
      WHERE card_id=$1 AND scope <> 'standing_order' AND superseded_by IS NULL AND retired_at IS NULL
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [cardId, CARD_LEDGER_MAX_ENTRIES + 50],
  );
  const total = Number(
    (
      await rows<{ n: string }>(
        db,
        `SELECT count(*)::text AS n FROM ledger_entries
          WHERE card_id=$1 AND scope <> 'standing_order' AND superseded_by IS NULL AND retired_at IS NULL`,
        [cardId],
      )
    )[0]?.n ?? 0,
  );
  return {
    entries: capLedgerEntries(live.map((r) => ({ id: r.id, scope: r.scope, title: r.title, body: r.body }))),
    total,
  };
}

const DTO_SELECT = `SELECT e.*, p.key AS project_key, c.ref AS card_ref,
       CASE WHEN e.created_by_kind='user' THEN (SELECT display_name FROM users WHERE id=e.created_by_id)
            WHEN e.created_by_kind='agent' THEN (SELECT name FROM agents WHERE id=e.created_by_id) END AS created_by_name,
       CASE WHEN e.edited_by_kind='user' THEN (SELECT display_name FROM users WHERE id=e.edited_by_id)
            WHEN e.edited_by_kind='agent' THEN (SELECT name FROM agents WHERE id=e.edited_by_id) END AS edited_by_name
  FROM ledger_entries e LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN cards c ON c.id = e.card_id`;

export const toLedgerDto = (r: Row, rank?: number): LedgerEntryDto => ({
  id: r.id,
  scope: r.scope,
  projectId: r.project_id,
  projectKey: r.project_key,
  cardId: r.card_id,
  cardRef: r.card_ref,
  title: r.title,
  body: r.body,
  tags: r.tags,
  sourceDeskItemId: r.source_desk_item_id,
  vaultPath: r.vault_path,
  createdByKind: r.created_by_kind,
  createdByName: r.created_by_name,
  supersededBy: r.superseded_by,
  createdAt: iso(r.created_at) as string,
  version: r.version ?? 1,
  editedAt: iso(r.edited_at) ?? null,
  editedByName: r.edited_by_name ?? null,
  retiredAt: iso(r.retired_at) ?? null,
  retiredReason: r.retired_reason ?? null,
  conflictsWith: r.conflicts_with ?? [],
  canEdit: false,
  canRetire: false,
  ...(rank !== undefined ? { rank } : {}),
});

/**
 * What the user may see: org-wide entries of the organizations they are a member of, plus entries of every project
 * they are an active member of.
 */
const VISIBLE = `((e.project_id IS NULL AND EXISTS (SELECT 1 FROM org_members om WHERE om.org_id = e.org_id
        AND om.user_id = $1 AND om.status = 'active')) OR e.project_id IN
   (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'))`;
/** The tab's organization, plus the projects of organizations where the user is only a guest. */
const IN_ORG = (p: string) => `(${p}::uuid IS NULL OR e.org_id = ${p}::uuid OR NOT EXISTS
   (SELECT 1 FROM org_members om2 WHERE om2.org_id = e.org_id AND om2.user_id = $1 AND om2.status = 'active'))`;

/**
 * Marks the live standing orders the user may edit: organization-wide ones for the organization's Owner and Admins, a
 * project's own for its owner (the same people who may add them).
 */
export async function withCanEdit(
  db: Queryable,
  userId: string,
  entries: LedgerEntryDto[],
): Promise<LedgerEntryDto[]> {
  const live = entries.filter((e) => !e.supersededBy && !e.retiredAt);
  if (live.length === 0) return entries;
  const projectIds = [...new Set(live.map((e) => e.projectId).filter((x): x is string => !!x))];
  const owned = new Set(
    (
      await rows<{ project_id: string }>(
        db,
        `SELECT project_id FROM project_members WHERE user_id=$1 AND status='active' AND role='owner' AND project_id = ANY($2::uuid[])`,
        [userId, projectIds],
      )
    ).map((r) => r.project_id),
  );
  const managerOrgs = new Set(
    (
      await rows<{ org_id: string }>(
        db,
        `SELECT org_id FROM org_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin')`,
        [userId],
      )
    ).map((r) => r.org_id),
  );
  const orgOf = new Map(
    (
      await rows<{ id: string; org_id: string }>(
        db,
        'SELECT id, org_id FROM ledger_entries WHERE id = ANY($1::uuid[])',
        [live.map((e) => e.id)],
      )
    ).map((r) => [r.id, r.org_id]),
  );
  return entries.map((e) =>
    live.includes(e)
      ? (() => {
          const may = e.projectId ? owned.has(e.projectId) : managerOrgs.has(orgOf.get(e.id) ?? '');
          return { ...e, canEdit: e.scope === 'standing_order' && may, canRetire: may };
        })()
      : e,
  );
}

export async function listLedger(
  db: Queryable,
  userId: string,
  orgId: string | null,
  o: {
    q?: string | undefined;
    projectId?: string | undefined;
    scope: LedgerScopeFilter;
    includeRetired?: string | undefined;
  },
): Promise<LedgerEntryDto[]> {
  const scope = o.scope;
  const q = o.q?.trim();
  if (q) {
    // Rank with the same strict-then-loose search, restricted to what the user may see.
    const ids = new Map<string, number>();
    const orgs = await rows<{ org_id: string }>(
      db,
      `SELECT DISTINCT e.org_id FROM ledger_entries e WHERE ${VISIBLE}`,
      [userId],
    );
    for (const { org_id } of orgs) {
      for (const m of await searchLedger(db, q, {
        orgId: org_id,
        projectId: o.projectId ?? null,
        scope,
        limit: 50,
        looseMinRank: 0,
      }))
        ids.set(m.id, m.rank ?? 0);
    }
    if (ids.size === 0) return [];
    const found = await rows(
      db,
      `${DTO_SELECT} WHERE e.id = ANY($2::uuid[]) AND ${VISIBLE} AND ${IN_ORG('$3')}`,
      [userId, [...ids.keys()], orgId],
    );
    return withCanEdit(
      db,
      userId,
      found
        .map((r) => toLedgerDto(r, ids.get(r.id)))
        .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || b.createdAt.localeCompare(a.createdAt)),
    );
  }
  const list = await rows(
    db,
    `${DTO_SELECT}
      WHERE ${VISIBLE} AND ($5::boolean OR (e.superseded_by IS NULL AND e.retired_at IS NULL))
        AND ($2::uuid IS NULL OR e.project_id IS NULL OR e.project_id = $2)
        AND ($3 = 'all' OR e.scope = $3) AND ${IN_ORG('$4')}
      ORDER BY (e.retired_at IS NOT NULL), e.created_at DESC, e.id LIMIT 200`,
    [userId, o.projectId ?? null, scope, orgId, o.includeRetired === 'true'],
  );
  return withCanEdit(
    db,
    userId,
    list.map((r) => toLedgerDto(r)),
  );
}

export async function getLedgerDto(
  db: Queryable,
  id: string,
  userId?: string,
): Promise<LedgerEntryDto | undefined> {
  const r = (await rows(db, `${DTO_SELECT} WHERE e.id = $1`, [id]))[0];
  if (!r) return undefined;
  const dto = toLedgerDto(r);
  return userId ? (await withCanEdit(db, userId, [dto]))[0] : dto;
}

/** An entry the user may see (same visibility as the list), or undefined. */
export async function getVisibleLedgerDto(
  db: Queryable,
  userId: string,
  id: string,
): Promise<LedgerEntryDto | undefined> {
  const r = (await rows(db, `${DTO_SELECT} WHERE e.id = $2 AND ${VISIBLE}`, [userId, id]))[0];
  return r ? (await withCanEdit(db, userId, [toLedgerDto(r)]))[0] : undefined;
}

/** The wordings of an entry, newest first: the current one, then every earlier one. */
export async function ledgerVersions(db: Queryable, entry: LedgerEntryDto): Promise<LedgerVersionDto[]> {
  const earlier = await rows(
    db,
    `SELECT v.*, CASE WHEN v.saved_by_kind='user' THEN (SELECT display_name FROM users WHERE id=v.saved_by_id)
                      WHEN v.saved_by_kind='agent' THEN (SELECT name FROM agents WHERE id=v.saved_by_id) END AS by_name
       FROM ledger_entry_versions v WHERE v.entry_id=$1 ORDER BY v.version DESC`,
    [entry.id],
  );
  return [
    {
      version: entry.version,
      title: entry.title,
      body: entry.body,
      tags: entry.tags,
      savedAt: entry.editedAt ?? entry.createdAt,
      savedByName: entry.editedAt ? entry.editedByName : entry.createdByName,
      current: true,
    },
    ...earlier.map((v) => ({
      version: v.version as number,
      title: v.title as string,
      body: v.body as string,
      tags: v.tags as string[],
      savedAt: iso(v.saved_at) as string,
      savedByName: (v.by_name as string | null) ?? null,
      current: false,
    })),
  ];
}
