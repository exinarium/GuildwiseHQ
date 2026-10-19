import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;
const j = (v: unknown) => JSON.stringify(v);

/**
 * `ceo_topic_candidates` (docs/design/ceo-blog-topics.md, Phase 2): problem notes and topic candidates of an organization.
 * Every handler is idempotent and touches only its own row (and the row a merge joins), so a rebuild is replay-safe.
 */
export const ceoTopicProjectors: Record<string, Projector> = {
  CeoTopicNoted: async (tx, e) => {
    const p = ev<'CeoTopicNoted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_topic_candidates (id, org_id, status, source_kind, evidence, note, created_at, updated_at)
       VALUES ($1,$2,'note',$3,$4::jsonb,$5,$6,$6) ON CONFLICT (id) DO NOTHING`,
      [p.candidateId, p.orgId, p.sourceKind, j(p.evidence), p.note, e.createdAt],
    );
  },
  CeoTopicProposed: async (tx, e) => {
    const p = ev<'CeoTopicProposed'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_topic_candidates SET status='proposed', question=$2, area=$3, audience=$4, findings=$5::jsonb, updated_at=$6
        WHERE id=$1`,
      [p.candidateId, p.question, p.area, p.audience ?? null, j(p.findings), e.createdAt],
    );
  },
  CeoTopicMerged: async (tx, e) => {
    const p = ev<'CeoTopicMerged'>(e).payload;
    // The note joins the earlier candidate: its occurrences and evidence are added to that one.
    await exec(
      tx,
      `UPDATE ceo_topic_candidates t SET
         occurrences = t.occurrences + s.occurrences,
         evidence = (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
                       SELECT DISTINCT x FROM jsonb_array_elements(t.evidence || s.evidence) x LIMIT 50) u),
         updated_at = $3
       FROM ceo_topic_candidates s WHERE t.id=$2 AND s.id=$1 AND s.status <> 'merged'`,
      [p.candidateId, p.intoId, e.createdAt],
    );
    await exec(
      tx,
      `UPDATE ceo_topic_candidates SET status='merged', merged_into=$2, updated_at=$3 WHERE id=$1`,
      [p.candidateId, p.intoId, e.createdAt],
    );
  },
  CeoTopicReviewed: async (tx, e) => {
    const p = ev<'CeoTopicReviewed'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_topic_candidates SET status=$2,
              question = COALESCE($3, question), area = COALESCE($4, area), audience = COALESCE($5, audience),
              topic_id = COALESCE($6::uuid, topic_id), allow_terms = COALESCE($7::text[], allow_terms),
              decided_by=$8, decided_at=$9, updated_at=$9
        WHERE id=$1`,
      [
        p.candidateId,
        p.decision === 'accepted' ? 'accepted' : 'rejected',
        p.question ?? null,
        p.area ?? null,
        p.audience ?? null,
        p.topicId ?? null,
        p.allowTerms ?? null,
        p.by,
        e.createdAt,
      ],
    );
  },
  CeoTopicExpired: async (tx, e) => {
    const p = ev<'CeoTopicExpired'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_topic_candidates SET status='expired', updated_at=$2 WHERE id=$1 AND status IN ('note','proposed')`,
      [p.candidateId, e.createdAt],
    );
  },
  CeoTopicHandedOff: async (tx, e) => {
    const p = ev<'CeoTopicHandedOff'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_topic_candidates SET status=$2, topic_id=COALESCE(topic_id, $3::uuid), handed_off_at=$4, updated_at=$4
        WHERE id=$1 AND status='accepted'`,
      [p.candidateId, p.status, p.topicId, e.createdAt],
    );
  },
  CeoTopicOutcome: async (tx, e) => {
    const p = ev<'CeoTopicOutcome'>(e).payload;
    // The platform removing a queued topic reads, on this side, as "declined".
    const status = p.outcome === 'rejected' ? 'declined' : p.outcome;
    await exec(
      tx,
      `UPDATE ceo_topic_candidates SET status=$2, post_slug=COALESCE($3, post_slug), post_title=COALESCE($4, post_title),
              published_at = CASE WHEN $2 = 'published' THEN $5::timestamptz ELSE published_at END, updated_at=$5
        WHERE id=$1`,
      [p.candidateId, status, p.postSlug ?? null, p.postTitle ?? null, e.createdAt],
    );
  },
};
