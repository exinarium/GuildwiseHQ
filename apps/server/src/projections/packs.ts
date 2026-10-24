import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * Capability packs (docs/ARCHITECTURE.md section 38.4): the owner's decisions and what a workstation saw at the pinned commit.
 * Every handler is a plain upsert/update keyed by the pack id, so replay gives the same rows.
 */
export const packProjectors: Record<string, Projector> = {
  PackAdded: async (tx, e) => {
    const p = (e.event as EventOf<'PackAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO packs (id, org_id, name, url, ref, adapter, scope, project_id, preset, added_by, added_at, workstation_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.packId,
        p.orgId,
        p.name,
        p.url,
        p.ref,
        p.adapter,
        p.scope,
        p.projectId,
        p.preset,
        p.addedBy,
        e.createdAt,
        p.workstationIds ?? [],
      ],
    );
  },

  PackRefResolved: async (tx, e) => {
    const p = (e.event as EventOf<'PackRefResolved'>).payload;
    // The first resolution pins the commit. A later report of the same commit refreshes nothing the owner decided; a report of
    // another commit (a workstation resolved the ref again) is ignored: the pin only moves with PackUpdateAccepted.
    await exec(
      tx,
      `UPDATE packs SET pinned_sha=$2, content_hash=$3, snapshot=$4, has_scripts=$5, license=$6, status='ready', error=NULL
        WHERE id=$1 AND removed_at IS NULL AND pinned_sha IS NULL`,
      [
        p.packId,
        p.snapshot.sha,
        p.snapshot.contentHash,
        JSON.stringify(p.snapshot),
        p.snapshot.hasScripts,
        p.snapshot.license,
      ],
    );
    // The pinned commit with the approved content again on this workstation (files restored): its integrity flag goes.
    await exec(
      tx,
      `UPDATE pack_workstation_state SET integrity_failed=false, updated_at=$4
        WHERE pack_id=$1 AND workstation_id=$5
          AND EXISTS (SELECT 1 FROM packs WHERE id=$1 AND removed_at IS NULL AND pinned_sha=$2 AND content_hash=$3)`,
      [p.packId, p.snapshot.sha, p.snapshot.contentHash, e.createdAt, p.workstationId],
    );
    await exec(tx, `UPDATE packs SET status='ready', error=NULL WHERE id=$1 AND removed_at IS NULL`, [
      p.packId,
    ]);
  },

  PackUpdateAvailable: async (tx, e) => {
    const p = (e.event as EventOf<'PackUpdateAvailable'>).payload;
    await exec(
      tx,
      `UPDATE packs SET update_snapshot=$2, update_diff=$3, update_found_at=$4, last_checked_at=$4
        WHERE id=$1 AND removed_at IS NULL AND (pinned_sha IS DISTINCT FROM $5)`,
      [p.packId, JSON.stringify(p.snapshot), JSON.stringify(p.diff), e.createdAt, p.snapshot.sha],
    );
  },

  PackUpToDate: async (tx, e) => {
    const p = (e.event as EventOf<'PackUpToDate'>).payload;
    await exec(
      tx,
      `UPDATE packs SET last_checked_at=$2, update_snapshot=NULL, update_diff=NULL, update_found_at=NULL
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, e.createdAt],
    );
  },

  PackUpdateAccepted: async (tx, e) => {
    const p = (e.event as EventOf<'PackUpdateAccepted'>).payload;
    // The accepted snapshot is the update on offer; the pin, the ref, the review snapshot and the approval all move together.
    await exec(
      tx,
      `UPDATE packs SET pinned_sha=$2, ref=$3, content_hash=$4, snapshot=update_snapshot,
              has_scripts=COALESCE((update_snapshot->>'hasScripts')::boolean, has_scripts),
              license=COALESCE(update_snapshot->>'license', license),
              update_snapshot=NULL, update_diff=NULL, update_found_at=NULL,
              trusted=$5, trusted_sha=CASE WHEN $5 THEN $2 ELSE NULL END, trusted_hash=CASE WHEN $5 THEN $4 ELSE NULL END,
              scripts_enabled=CASE WHEN $6 THEN false ELSE scripts_enabled END
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.sha, p.ref, p.contentHash, p.keepTrust, p.scriptsReset],
    );
    // a new pin is a new comparison: earlier per-workstation findings were about the old content
    await exec(tx, 'DELETE FROM pack_workstation_state WHERE pack_id=$1', [p.packId]);
  },

  PackTrusted: async (tx, e) => {
    const p = (e.event as EventOf<'PackTrusted'>).payload;
    await exec(
      tx,
      `UPDATE packs SET trusted=true, trusted_sha=$2, trusted_hash=$3, trusted_by=$4, trusted_at=$5
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.sha, p.contentHash, p.trustedBy, e.createdAt],
    );
  },

  PackTrustRevoked: async (tx, e) => {
    const p = (e.event as EventOf<'PackTrustRevoked'>).payload;
    await exec(
      tx,
      `UPDATE packs SET trusted=false, trusted_sha=NULL, trusted_hash=NULL, scripts_enabled=false
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId],
    );
  },

  PackScriptsChanged: async (tx, e) => {
    const p = (e.event as EventOf<'PackScriptsChanged'>).payload;
    await exec(tx, `UPDATE packs SET scripts_enabled=$2 WHERE id=$1 AND removed_at IS NULL`, [
      p.packId,
      p.enabled,
    ]);
  },

  PackIntegrityFailed: async (tx, e) => {
    const p = (e.event as EventOf<'PackIntegrityFailed'>).payload;
    // One workstation's files differ from what the owner approved: that workstation stops serving the pack (the runner does it);
    // the organization's approval and the other workstations are untouched.
    await exec(
      tx,
      `INSERT INTO pack_workstation_state (pack_id, workstation_id, integrity_failed, updated_at)
       VALUES ($1,$2,true,$3)
       ON CONFLICT (pack_id, workstation_id) DO UPDATE SET integrity_failed=true, updated_at=EXCLUDED.updated_at`,
      [p.packId, p.workstationId, e.createdAt],
    );
  },

  PackFailed: async (tx, e) => {
    const p = (e.event as EventOf<'PackFailed'>).payload;
    // A failed check does not fail a pack that already works; a pack that never resolved is shown as failed.
    await exec(
      tx,
      `UPDATE packs SET error=$2, last_checked_at=$3,
              status=CASE WHEN pinned_sha IS NULL THEN 'failed' ELSE status END
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.message, e.createdAt],
    );
  },

  PackRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'PackRemoved'>).payload;
    await exec(tx, `UPDATE packs SET removed_at=$2 WHERE id=$1`, [p.packId, e.createdAt]);
  },

  ProjectCapabilityReviewed: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCapabilityReviewed'>).payload;
    if (p.status === 'unreviewed') {
      await exec(tx, 'DELETE FROM capability_reviews WHERE project_id=$1 AND kind=$2 AND key=$3', [
        p.projectId,
        p.kind,
        p.key,
      ]);
      return;
    }
    await exec(
      tx,
      `INSERT INTO capability_reviews (org_id, project_id, kind, key, hash, status, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (project_id, kind, key) DO UPDATE SET hash=EXCLUDED.hash, status=EXCLUDED.status,
         reviewed_by=EXCLUDED.reviewed_by, reviewed_at=EXCLUDED.reviewed_at`,
      [p.orgId, p.projectId, p.kind, p.key, p.hash, p.status, p.by, e.createdAt],
    );
  },

  ProjectCapabilitiesReported: async (tx, e) => {
    const p = (e.event as EventOf<'ProjectCapabilitiesReported'>).payload;
    await exec(tx, 'DELETE FROM project_capability_index WHERE project_id=$1', [p.projectId]);
    for (const i of p.items)
      await exec(
        tx,
        `INSERT INTO project_capability_index (org_id, project_id, kind, key, name, description, hash, icon, path, reported_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (project_id, kind, key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
           hash=EXCLUDED.hash, icon=EXCLUDED.icon, path=EXCLUDED.path, reported_at=EXCLUDED.reported_at`,
        [
          p.orgId,
          p.projectId,
          i.kind,
          i.key,
          i.name,
          i.description,
          i.hash,
          i.icon ?? null,
          i.path ?? null,
          e.createdAt,
        ],
      );
    await exec(
      tx,
      `INSERT INTO project_capability_status (project_id, org_id, issues, reported_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id) DO UPDATE SET issues=EXCLUDED.issues, reported_at=EXCLUDED.reported_at`,
      [p.projectId, p.orgId, JSON.stringify(p.issues), e.createdAt],
    );
  },
};
