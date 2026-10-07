import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';
import { mutateCard } from './util.ts';

export const feedProjectors: Record<string, Projector> = {
  DigestPosted: async (tx, e) => {
    const p = (e.event as EventOf<'DigestPosted'>).payload;
    let position = 0;
    for (const item of p.items) {
      await exec(
        tx,
        `INSERT INTO digest_items (id, card_id, project_id, desk_item_id, kind, url, url_normalized, title, source,
           published_at, summary, position, event_seq, created_at, transcript, delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          item.itemId,
          p.cardId,
          p.projectId,
          p.deskItemId ?? null,
          item.kind,
          item.url,
          item.urlNormalized,
          item.title,
          item.source,
          item.publishedAt,
          item.summary,
          position++,
          e.seq.toString(),
          e.createdAt,
          item.transcript ? JSON.stringify(item.transcript) : null,
          p.held ? null : e.createdAt,
        ],
      );
      await exec(
        tx,
        `INSERT INTO feed_seen (project_id, url_normalized, first_seen_at) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [p.projectId, item.urlNormalized, e.createdAt],
      );
    }
    // The digest is the feed workflow's last stage: the card is done (the claim is released by the next event).
    await mutateCard(tx, e, p.cardId, () =>
      exec(tx, `UPDATE cards SET stage='done', status='done', finalized_at=$2, updated_at=$2 WHERE id=$1`, [
        p.cardId,
        e.createdAt,
      ]),
    );
  },

  ItemRated: async (tx, e) => {
    const p = (e.event as EventOf<'ItemRated'>).payload;
    await exec(
      tx,
      `UPDATE digest_items SET verdict=$2, verdict_reason=$3, rated_by=$4, rated_at=$5 WHERE id=$1`,
      [p.itemId, p.verdict, p.reason ?? null, p.ratedBy, e.createdAt],
    );
  },
};
