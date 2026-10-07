import type { DigestItemDto } from '@aom/shared';
import { iso, type Queryable, type Row, rows } from '../db/sql.ts';

const SELECT = `SELECT i.*, c.ref AS card_ref, p.key AS project_key FROM digest_items i
  JOIN cards c ON c.id = i.card_id JOIN projects p ON p.id = i.project_id`;
const VISIBLE = `i.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active')`;

export const toDigestDto = (r: Row): DigestItemDto => ({
  id: r.id,
  cardId: r.card_id,
  cardRef: r.card_ref,
  projectId: r.project_id,
  projectKey: r.project_key,
  kind: r.kind,
  url: r.url,
  title: r.title,
  source: r.source,
  publishedAt: iso(r.published_at),
  summary: r.summary,
  transcript: r.transcript ?? null,
  verdict: r.verdict,
  verdictReason: r.verdict_reason,
  ratedAt: iso(r.rated_at),
  deskItemId: r.desk_item_id,
  createdAt: iso(r.created_at) as string,
});

/** The project's running list: oldest first, newest last (the order of `projects/<name>/feed.md`). */
export async function listDigestItems(
  db: Queryable,
  userId: string,
  opts: { projectId?: string | undefined; interestId?: string | undefined; status: 'unrated' | 'all' },
): Promise<DigestItemDto[]> {
  const r = await rows(
    db,
    `${SELECT} WHERE ${VISIBLE} AND i.delivered_at IS NOT NULL AND ($2::uuid IS NULL OR i.project_id = $2)
       AND ($3 = 'all' OR i.verdict IS NULL) AND ($4::uuid IS NULL OR c.interest_id = $4)
     ORDER BY i.event_seq, i.position`,
    [userId, opts.projectId ?? null, opts.status, opts.interestId ?? null],
  );
  return r.map(toDigestDto);
}

/** Digest items of the given rating desk items (for the desk DTO). */
export async function digestItemsForDesk(
  db: Queryable,
  deskItemIds: string[],
): Promise<Map<string, DigestItemDto[]>> {
  const out = new Map<string, DigestItemDto[]>();
  if (deskItemIds.length === 0) return out;
  const r = await rows(
    db,
    `${SELECT} WHERE i.desk_item_id = ANY($1::uuid[]) ORDER BY i.event_seq, i.position`,
    [deskItemIds],
  );
  for (const row of r) {
    const list = out.get(row.desk_item_id) ?? [];
    list.push(toDigestDto(row));
    out.set(row.desk_item_id, list);
  }
  return out;
}
