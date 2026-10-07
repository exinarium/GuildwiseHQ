import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

type Body = EventOf<'InterestCreated'>['payload'];

/**
 * `created_by` is the event's user actor (null for a system actor). A body of the first model (no backing project) maps
 * to the `legacy_*` columns; the data migration's `InterestMigrated` gives it a project later.
 */
async function upsert(
  tx: Parameters<Projector>[0],
  p: Body,
  at: Date,
  actorId: string | null,
  actorKind: string,
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO interests (id, org_id, name, description, project_id, slug, sub_category, preferred_sites,
       kinds, scan, delivery, agents, status, next_scan_at, next_delivery_at, legacy_feed_project_id,
       legacy_research_project_id, legacy_schedule_id, adopted_from, created_by, created_at, updated_at, created_by_rank)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
       project_id=COALESCE(EXCLUDED.project_id, interests.project_id), slug=COALESCE(EXCLUDED.slug, interests.slug),
       sub_category=EXCLUDED.sub_category,
       preferred_sites=EXCLUDED.preferred_sites, kinds=EXCLUDED.kinds, scan=EXCLUDED.scan, delivery=EXCLUDED.delivery,
       agents=EXCLUDED.agents, status=EXCLUDED.status,
       next_scan_at = CASE WHEN $23::boolean THEN EXCLUDED.next_scan_at ELSE interests.next_scan_at END,
       next_delivery_at = CASE WHEN $24::boolean THEN EXCLUDED.next_delivery_at ELSE interests.next_delivery_at END,
       legacy_feed_project_id=COALESCE(EXCLUDED.legacy_feed_project_id, interests.legacy_feed_project_id),
       legacy_research_project_id=COALESCE(EXCLUDED.legacy_research_project_id, interests.legacy_research_project_id),
       legacy_schedule_id=COALESCE(EXCLUDED.legacy_schedule_id, interests.legacy_schedule_id),
       updated_at=EXCLUDED.updated_at`,
    [
      p.interestId,
      p.orgId,
      p.name,
      p.description,
      p.projectId ?? null,
      p.slug ?? null,
      p.subCategory,
      p.preferredSites,
      p.kinds,
      p.scan ? JSON.stringify(p.scan) : null,
      JSON.stringify(p.delivery),
      JSON.stringify(p.agents),
      p.status,
      p.nextScanAt ?? null,
      p.nextDeliveryAt ?? null,
      p.feedProjectId ?? null,
      p.researchProjectId ?? null,
      p.scheduleId ?? null,
      p.adoptedFrom ?? null,
      actorKind === 'user' ? actorId : null,
      at,
      p.creatorRank ?? null,
      p.nextScanAt !== undefined,
      p.nextDeliveryAt !== undefined,
    ],
  );
}

/** The id of a migrated run: derived from its card id (a uuid v4 shape), so a rebuild reproduces it. */
const runIdSql = (cardId: string): string => {
  const h = `md5('interest-run-' || ${cardId}::text)`;
  return `(substr(${h},1,8) || '-' || substr(${h},9,4) || '-4' || substr(${h},13,3) || '-8' || substr(${h},17,3) || '-' || substr(${h},21,12))::uuid`;
};

export const interestProjectors: Record<string, Projector> = {
  InterestCreated: async (tx, e) =>
    upsert(
      tx,
      (e.event as EventOf<'InterestCreated'>).payload,
      e.createdAt,
      e.actor.id ?? null,
      e.actor.kind,
    ),
  InterestUpdated: async (tx, e) =>
    upsert(
      tx,
      (e.event as EventOf<'InterestUpdated'>).payload,
      e.createdAt,
      e.actor.id ?? null,
      e.actor.kind,
    ),
  InterestArchived: async (tx, e) => {
    const p = (e.event as EventOf<'InterestArchived'>).payload;
    await exec(
      tx,
      'UPDATE interests SET archived_at=$2, updated_at=$2, next_scan_at=NULL, next_delivery_at=NULL WHERE id=$1',
      [p.interestId, e.createdAt],
    );
  },
  InterestRestored: async (tx, e) => {
    const p = (e.event as EventOf<'InterestRestored'>).payload;
    await exec(tx, 'UPDATE interests SET archived_at=NULL, updated_at=$2 WHERE id=$1', [
      p.interestId,
      e.createdAt,
    ]);
  },
  /** Cards keep their `interest_id`: the stats of a deleted interest are simply not shown. */
  InterestDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'InterestDeleted'>).payload;
    await exec(tx, 'DELETE FROM interest_runs WHERE interest_id=$1', [p.interestId]);
    await exec(tx, 'DELETE FROM interest_deliveries WHERE interest_id=$1', [p.interestId]);
    await exec(tx, 'DELETE FROM interests WHERE id=$1', [p.interestId]);
  },
  InterestTasteSet: async (tx, e) => {
    const p = (e.event as EventOf<'InterestTasteSet'>).payload;
    await exec(tx, 'UPDATE interests SET taste_rules=$2, taste_version=$3, updated_at=$4 WHERE id=$1', [
      p.interestId,
      JSON.stringify(p.rules),
      p.version,
      e.createdAt,
    ]);
  },
  /**
   * The data migration: the interest has its backing project. Back-fills `cards.interest_id` of the feed cards the filter
   * names, copies the seen-list and writes the run log of those cards. Deterministic on replay: every row it reads was
   * written by an earlier event.
   */
  InterestMigrated: async (tx, e) => {
    const p = (e.event as EventOf<'InterestMigrated'>).payload;
    await exec(tx, 'UPDATE interests SET project_id=$2, slug=$3, updated_at=$4 WHERE id=$1', [
      p.interestId,
      p.projectId,
      p.slug,
      e.createdAt,
    ]);
    const f = p.cardFilter;
    if (f.projectId) {
      await exec(
        tx,
        `UPDATE cards SET interest_id=$1 WHERE project_id=$2 AND card_type='feed' AND interest_id IS NULL
            AND (($3::uuid IS NOT NULL AND schedule_id = $3) OR $4::boolean)`,
        [p.interestId, f.projectId, f.scheduleId ?? null, f.untaggedFeedCards],
      );
      // The cards are the runs: the run id is derived from the card id (deterministic, so a rebuild reproduces it).
      await exec(
        tx,
        `UPDATE cards c SET interest_run_id = ${runIdSql('c.id')}
          WHERE c.interest_id = $1 AND c.project_id = $2 AND c.card_type IN ('feed','research')
            AND c.interest_run_id IS NULL`,
        [p.interestId, f.projectId],
      );
      await exec(
        tx,
        `INSERT INTO interest_runs (id, interest_id, org_id, kind, trigger, card_id, status, found, published,
           started_at, finished_at)
         SELECT ${runIdSql('c.id')}, $1, c.org_id,
                CASE WHEN c.card_type = 'research' THEN 'research' ELSE 'scan' END, 'migrated', c.id,
                CASE WHEN c.status = 'cancelled' THEN 'cancelled'
                     WHEN c.status = 'done' THEN
                       CASE WHEN EXISTS (SELECT 1 FROM digest_items d WHERE d.card_id = c.id)
                              OR EXISTS (SELECT 1 FROM research_publications r WHERE r.card_id = c.id)
                            THEN 'published' ELSE 'nothing' END
                     WHEN c.stage = 'curate' THEN 'curating'
                     WHEN c.stage = 'scan' AND c.status = 'claimed' THEN 'scanning'
                     ELSE 'queued' END,
                NULL,
                CASE WHEN c.status = 'done'
                     THEN (SELECT count(*) FROM digest_items d WHERE d.card_id = c.id)
                        + (SELECT count(*) FROM research_publications r WHERE r.card_id = c.id)
                     ELSE NULL END,
                c.created_at,
                CASE WHEN c.status IN ('done','cancelled') THEN COALESCE(c.finalized_at, c.updated_at) ELSE NULL END
           FROM cards c
          WHERE c.interest_id = $1 AND c.project_id = $2 AND c.card_type IN ('feed','research')
         ON CONFLICT (id) DO NOTHING`,
        [p.interestId, f.projectId],
      );
    }
    if (p.copySeenFrom)
      await exec(
        tx,
        `INSERT INTO feed_seen (project_id, url_normalized, first_seen_at)
         SELECT $1, url_normalized, first_seen_at FROM feed_seen WHERE project_id=$2
         ON CONFLICT DO NOTHING`,
        [p.projectId, p.copySeenFrom],
      );
  },
  TasteSeedSet: async (tx, e) => {
    const p = (e.event as EventOf<'TasteSeedSet'>).payload;
    await exec(
      tx,
      `INSERT INTO taste_seeds (project_id, version, rules, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (project_id) DO UPDATE SET version=EXCLUDED.version, rules=EXCLUDED.rules,
         updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
      [
        p.projectId,
        p.version,
        JSON.stringify(p.rules),
        e.actor.kind === 'user' ? (e.actor.id ?? null) : null,
        e.createdAt,
      ],
    );
  },
};
