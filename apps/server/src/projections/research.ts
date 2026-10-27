import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';
import { mutateCard } from './util.ts';

export const researchProjectors: Record<string, Projector> = {
  ResearchPublished: async (tx, e) => {
    const p = (e.event as EventOf<'ResearchPublished'>).payload;
    // A republished card replaces its earlier note: older live rows are superseded (kept as history).
    await exec(
      tx,
      `UPDATE research_publications SET superseded_at=$2 WHERE card_id=$1 AND superseded_at IS NULL`,
      [p.cardId, e.createdAt],
    );
    // The id is derived from the event so a rebuild reproduces the same row.
    await exec(
      tx,
      `INSERT INTO research_publications (id, card_id, project_id, vault_path, title, citations, excerpt, event_seq, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        publicationId(e.seq),
        p.cardId,
        p.projectId,
        p.vaultPath,
        p.title,
        JSON.stringify(p.citations),
        p.excerpt,
        e.seq.toString(),
        e.createdAt,
      ],
    );
    // The fact check was the research workflow's last stage: the card is done (the claim is released next).
    await mutateCard(tx, e, p.cardId, () =>
      exec(tx, `UPDATE cards SET stage='done', status='done', finalized_at=$2, updated_at=$2 WHERE id=$1`, [
        p.cardId,
        e.createdAt,
      ]),
    );
  },
};

/** Deterministic uuid for the publication row of an event (v4 shape, seeded by the event seq). */
function publicationId(seq: bigint): string {
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}
