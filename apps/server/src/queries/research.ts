import type { PublicationDto } from '@aom/shared';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';

const SELECT = `SELECT r.*, c.ref AS card_ref, p.key AS project_key FROM research_publications r
  JOIN cards c ON c.id = r.card_id JOIN projects p ON p.id = r.project_id`;

const toDto = (r: Row): PublicationDto => ({
  id: r.id,
  cardId: r.card_id,
  cardRef: r.card_ref,
  projectId: r.project_id,
  projectKey: r.project_key,
  vaultPath: r.vault_path,
  title: r.title,
  citations: r.citations,
  excerpt: r.excerpt,
  createdAt: iso(r.created_at) as string,
});

/** The published note of a research card, if any (the caller already checked the card is visible). */
export async function publicationOfCard(db: Queryable, cardId: string): Promise<PublicationDto | null> {
  const r = await one(db, `${SELECT} WHERE r.card_id=$1 ORDER BY r.event_seq DESC LIMIT 1`, [cardId]);
  return r ? toDto(r) : null;
}

/** Published notes in the user's visible projects, newest first. */
export async function listPublications(
  db: Queryable,
  userId: string,
  projectId?: string,
  interestId?: string,
): Promise<PublicationDto[]> {
  const r = await rows(
    db,
    `${SELECT} WHERE r.project_id IN (SELECT project_id FROM project_members WHERE user_id=$1 AND status='active')
       AND (p.kind = 'project' OR $3::uuid IS NOT NULL)
       AND ($2::uuid IS NULL OR r.project_id=$2) AND ($3::uuid IS NULL OR c.interest_id=$3)
     ORDER BY r.event_seq DESC`,
    [userId, projectId ?? null, interestId ?? null],
  );
  return r.map(toDto);
}
