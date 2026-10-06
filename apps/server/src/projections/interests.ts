import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

type Body = EventOf<'InterestCreated'>['payload'];

/** `created_by` is the event's user actor (null for a system actor). */
async function upsert(
  tx: Parameters<Projector>[0],
  p: Body,
  at: Date,
  actorId: string | null,
  actorKind: string,
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO interests (id, org_id, name, description, feed_project_id, research_project_id, sub_category,
       preferred_sites, scan, status, schedule_id, adopted_from, created_by, created_at, updated_at, created_by_rank)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
       feed_project_id=EXCLUDED.feed_project_id, research_project_id=EXCLUDED.research_project_id,
       sub_category=EXCLUDED.sub_category, preferred_sites=EXCLUDED.preferred_sites, scan=EXCLUDED.scan,
       status=EXCLUDED.status, schedule_id=EXCLUDED.schedule_id, updated_at=EXCLUDED.updated_at`,
    [
      p.interestId,
      p.orgId,
      p.name,
      p.description,
      p.feedProjectId,
      p.researchProjectId,
      p.subCategory,
      p.preferredSites,
      p.scan ? JSON.stringify(p.scan) : null,
      p.status,
      p.scheduleId,
      p.adoptedFrom ?? null,
      actorKind === 'user' ? actorId : null,
      at,
      p.creatorRank ?? null,
    ],
  );
}

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
  /** Cards keep their `interest_id`: the stats of a deleted interest are simply not shown. */
  InterestDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'InterestDeleted'>).payload;
    await exec(tx, 'DELETE FROM interests WHERE id=$1', [p.interestId]);
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
