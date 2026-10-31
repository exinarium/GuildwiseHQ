import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <
  T extends
    | 'ReleaseProposed'
    | 'ReleaseApproved'
    | 'ReleaseProposalClosed'
    | 'ReleaseShipStarted'
    | 'ReleaseCommitted'
    | 'ReleaseFailed'
    | 'ReleasePublishPlanned'
    | 'ReleaseLanded'
    | 'ReleaseTagged'
    | 'ReleasePublished'
    | 'ReleasePublishRetried',
>(
  e: StoredEvent,
) => e.event as EventOf<T>;

export const releaseProjectors: Record<string, Projector> = {
  ReleaseProposed: async (tx, e) => {
    const p = ev<'ReleaseProposed'>(e).payload;
    await exec(
      tx,
      `INSERT INTO release_proposals (id, org_id, project_id, repo_id, desk_item_id, state, trigger, recommended_version,
                                      recommended_level, reason, last_tag, head_sha, created_at, updated_at)
       SELECT $1, pr.org_id, pr.id, $3, $4, 'proposed', $5, $6, $7, $8, $9, $10, $11, $11
         FROM projects pr WHERE pr.id = $2`,
      [
        p.proposalId,
        p.projectId,
        p.repoId,
        p.deskItemId,
        p.trigger,
        p.recommendedVersion,
        p.level,
        p.reason,
        p.lastTag,
        p.headSha,
        e.createdAt,
      ],
    );
  },
  ReleaseApproved: async (tx, e) => {
    const p = ev<'ReleaseApproved'>(e).payload;
    await exec(
      tx,
      `UPDATE release_proposals SET state='approved', version=$2, components=$3::jsonb, notes=$4, notes_source=$5,
              approved_by=$6, approved_at=$7, head_sha=$8, updated_at=$7 WHERE id=$1`,
      [
        p.proposalId,
        p.version,
        JSON.stringify(p.components),
        p.notes,
        p.notesSource,
        p.approvedBy,
        e.createdAt,
        p.headSha,
      ],
    );
  },
  ReleaseProposalClosed: async (tx, e) => {
    const p = ev<'ReleaseProposalClosed'>(e).payload;
    const state =
      p.reason === 'released' ? 'released' : p.reason === 'nothing_to_release' ? 'closed' : 'dismissed';
    await exec(tx, `UPDATE release_proposals SET state=$2, closed_reason=$3, updated_at=$4 WHERE id=$1`, [
      p.proposalId,
      state,
      p.reason,
      e.createdAt,
    ]);
  },
  ReleaseShipStarted: async (tx, e) => {
    const p = ev<'ReleaseShipStarted'>(e).payload;
    // A version of an abandoned release proposed again: the earlier row (another proposal) goes.
    await exec(tx, 'DELETE FROM release_ships WHERE repo_id=$1 AND version=$2 AND id<>$3', [
      p.repoId,
      p.version,
      p.shipId,
    ]);
    await exec(
      tx,
      `INSERT INTO release_ships (id, org_id, project_id, repo_id, version, tag, release_date, payload, status, workstation_id, created_at, updated_at)
       SELECT $1, pr.org_id, pr.id, $3, $4, $5, $6::date, $7::jsonb, 'committing', $8, $9, $9
         FROM projects pr WHERE pr.id = (SELECT project_id FROM release_proposals WHERE id = $2)
       ON CONFLICT (id) DO UPDATE SET status='committing', workstation_id=$8, step=NULL, error=NULL, payload=$7::jsonb, updated_at=$9`,
      [
        p.shipId,
        p.proposalId,
        p.repoId,
        p.version,
        p.tag,
        p.date,
        JSON.stringify(p.payload),
        p.workstationId,
        e.createdAt,
      ],
    );
  },
  ReleaseCommitted: async (tx, e) => {
    const p = ev<'ReleaseCommitted'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET status='committed', commit_sha=$2, step='push', error=NULL, updated_at=$3 WHERE id=$1`,
      [p.shipId, p.commit, e.createdAt],
    );
  },
  ReleaseFailed: async (tx, e) => {
    const p = ev<'ReleaseFailed'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET status='failed', step=$2, error=$3, alert_desk_item_id=$4, updated_at=$5 WHERE id=$1`,
      [p.shipId, p.step, p.error, p.alertDeskItemId ?? null, e.createdAt],
    );
  },
  ReleasePublishPlanned: async (tx, e) => {
    const p = ev<'ReleasePublishPlanned'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET land_mode=$2, pr_url=COALESCE($3, pr_url), step='land', error=NULL, updated_at=$4 WHERE id=$1`,
      [p.shipId, p.landMode, p.prUrl ?? null, e.createdAt],
    );
  },
  ReleaseLanded: async (tx, e) => {
    const p = ev<'ReleaseLanded'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET merge_sha=$2, landed_at=$3, land_mode=$4, pr_url=COALESCE($5, pr_url), step='tag', step_message=NULL, updated_at=$3 WHERE id=$1`,
      [p.shipId, p.mergeSha, e.createdAt, p.mode, p.prUrl ?? null],
    );
  },
  ReleaseTagged: async (tx, e) => {
    const p = ev<'ReleaseTagged'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET status='tagged', tag_name=$2, tag_sha=$3, tag_state=$4, tag_url=$5, tagged_at=$6, step='publish', step_message=NULL, error=NULL, updated_at=$6 WHERE id=$1`,
      [p.shipId, p.tag, p.targetSha, p.state, p.tagUrl, e.createdAt],
    );
  },
  ReleasePublished: async (tx, e) => {
    const p = ev<'ReleasePublished'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET status='published', release_state=$2, release_url=$3, release_latest=$4, published_desk_item_id=$5,
              published_at=$6, step=NULL, step_message=NULL, error=NULL, updated_at=$6 WHERE id=$1`,
      [p.shipId, p.state, p.releaseUrl, p.latest ?? null, p.deskItemId ?? null, e.createdAt],
    );
  },
  ReleasePublishRetried: async (tx, e) => {
    const p = ev<'ReleasePublishRetried'>(e).payload;
    await exec(
      tx,
      `UPDATE release_ships SET status = CASE WHEN tag_name IS NULL THEN 'committed' ELSE 'tagged' END, error=NULL,
              workstation_id=$2, publish_checked_at=NULL, updated_at=$3 WHERE id=$1`,
      [p.shipId, p.workstationId, e.createdAt],
    );
  },
};
