import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * Capability packs (docs/ARCHITECTURE.md section 38.4): the owner's decisions and what a workstation saw at the pinned commit.
 * Every handler is a plain upsert/update keyed by the pack id, so replay gives the same rows.
 */
/** The revision number of an authored pack's ref (`v3`); 0 for a git ref. */
const revisionOf = (ref: string): number => {
  const m = /^v(\d{1,6})$/.exec(ref);
  return m ? Number(m[1]) : 0;
};

export const packProjectors: Record<string, Projector> = {
  PackAdded: async (tx, e) => {
    const p = (e.event as EventOf<'PackAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO packs (id, org_id, name, url, ref, adapter, scope, project_id, preset, added_by, added_at, workstation_ids,
                          source, visibility, owner_user_id, description, credential_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
        p.source ?? 'git',
        p.visibility ?? 'org',
        p.ownerUserId ?? null,
        p.description ?? '',
        p.credentialKind ?? null,
      ],
    );
  },

  PackRefResolved: async (tx, e) => {
    const p = (e.event as EventOf<'PackRefResolved'>).payload;
    // The first resolution pins the commit. A later report of the same commit refreshes nothing the owner decided; a report of
    // another commit (a workstation resolved the ref again) is ignored: the pin only moves with PackUpdateAccepted.
    await exec(
      tx,
      `UPDATE packs SET pinned_sha=$2, content_hash=$3, snapshot=$4, has_scripts=$5, license=$6, status='ready', error=NULL,
              revision=$7, save_pending=false
        WHERE id=$1 AND removed_at IS NULL AND pinned_sha IS NULL`,
      [
        p.packId,
        p.snapshot.sha,
        p.snapshot.contentHash,
        JSON.stringify(p.snapshot),
        p.snapshot.hasScripts,
        p.snapshot.license,
        revisionOf(p.snapshot.ref),
      ],
    );
    // this workstation holds the pinned revision (an authored organization pack travels to the others only when they lack it)
    await exec(
      tx,
      `INSERT INTO pack_workstation_state (pack_id, workstation_id, integrity_failed, content_sha, updated_at)
       SELECT $1,$2,false,$3,$4 WHERE EXISTS (SELECT 1 FROM packs WHERE id=$1 AND pinned_sha=$3)
       ON CONFLICT (pack_id, workstation_id) DO UPDATE SET content_sha=EXCLUDED.content_sha, updated_at=EXCLUDED.updated_at`,
      [p.packId, p.workstationId, p.snapshot.sha, e.createdAt],
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
      `UPDATE packs SET update_snapshot=$2, update_diff=$3, update_found_at=$4, last_checked_at=$4, save_pending=false
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
              scripts_enabled=CASE WHEN $6 THEN false ELSE scripts_enabled END, revision=$7
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.sha, p.ref, p.contentHash, p.keepTrust, p.scriptsReset, revisionOf(p.ref)],
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
              status=CASE WHEN pinned_sha IS NULL THEN 'failed' ELSE status END,
              save_pending=CASE WHEN $4 = 'save' THEN false ELSE save_pending END
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.message, e.createdAt, p.stage],
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

  // ---------------------------------------------------------------------------------------------- R3a

  PackWorkstationsChanged: async (tx, e) => {
    const p = (e.event as EventOf<'PackWorkstationsChanged'>).payload;
    await exec(tx, `UPDATE packs SET workstation_ids=$2::uuid[] WHERE id=$1 AND removed_at IS NULL`, [
      p.packId,
      p.workstationIds,
    ]);
    // a workstation that no longer holds the pack loses its assignment and its per-workstation state
    await exec(
      tx,
      `DELETE FROM pack_assignments WHERE pack_id=$1 AND NOT (workstation_id = ANY($2::uuid[]))`,
      [p.packId, p.workstationIds],
    );
    await exec(
      tx,
      `DELETE FROM pack_workstation_state WHERE pack_id=$1 AND NOT (workstation_id = ANY($2::uuid[]))`,
      [p.packId, p.workstationIds],
    );
  },

  PackAssignmentRequested: async (tx, e) => {
    const p = (e.event as EventOf<'PackAssignmentRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO pack_assignments (pack_id, workstation_id, user_id, status, desk_item_id, requested_by, requested_at)
       VALUES ($1,$2,$3,'pending',$4,$5,$6)
       ON CONFLICT (pack_id, workstation_id) DO UPDATE SET status='pending', user_id=EXCLUDED.user_id,
         desk_item_id=EXCLUDED.desk_item_id, requested_by=EXCLUDED.requested_by, requested_at=EXCLUDED.requested_at, decided_at=NULL`,
      [p.packId, p.workstationId, p.userId, p.deskItemId, p.requestedBy, e.createdAt],
    );
  },

  PackAssignmentDecided: async (tx, e) => {
    const p = (e.event as EventOf<'PackAssignmentDecided'>).payload;
    if (p.accepted) {
      await exec(
        tx,
        `UPDATE pack_assignments SET status='accepted', decided_at=$3 WHERE pack_id=$1 AND workstation_id=$2`,
        [p.packId, p.workstationId, e.createdAt],
      );
      return;
    }
    // declined: the assignment is removed, and the workstation is no longer one of the pack's holders
    await exec(tx, `DELETE FROM pack_assignments WHERE pack_id=$1 AND workstation_id=$2`, [
      p.packId,
      p.workstationId,
    ]);
    await exec(tx, `UPDATE packs SET workstation_ids = array_remove(workstation_ids, $2::uuid) WHERE id=$1`, [
      p.packId,
      p.workstationId,
    ]);
    await exec(tx, `DELETE FROM pack_workstation_state WHERE pack_id=$1 AND workstation_id=$2`, [
      p.packId,
      p.workstationId,
    ]);
  },

  PackCredentialSet: async (tx, e) => {
    const p = (e.event as EventOf<'PackCredentialSet'>).payload;
    await exec(
      tx,
      `UPDATE packs SET credential_kind=$2, credential_fingerprint=COALESCE($3, credential_fingerprint)
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.kind, p.fingerprint],
    );
  },

  PackCredentialCleared: async (tx, e) => {
    const p = (e.event as EventOf<'PackCredentialCleared'>).payload;
    await exec(
      tx,
      `UPDATE packs SET credential_kind=NULL, credential_fingerprint=NULL, host_key=NULL WHERE id=$1 AND removed_at IS NULL`,
      [p.packId],
    );
    await exec(tx, `UPDATE pack_workstation_state SET host_key_pinned=false WHERE pack_id=$1`, [p.packId]);
  },

  PackCredentialStored: async (tx, e) => {
    const p = (e.event as EventOf<'PackCredentialStored'>).payload;
    if (p.stored && p.fingerprint)
      await exec(tx, `UPDATE packs SET credential_fingerprint=$2 WHERE id=$1 AND removed_at IS NULL`, [
        p.packId,
        p.fingerprint,
      ]);
  },

  PackHostKeyPinned: async (tx, e) => {
    const p = (e.event as EventOf<'PackHostKeyPinned'>).payload;
    await exec(tx, `UPDATE packs SET host_key=$2 WHERE id=$1 AND removed_at IS NULL AND host_key IS NULL`, [
      p.packId,
      p.hostKey,
    ]);
    await exec(
      tx,
      `INSERT INTO pack_workstation_state (pack_id, workstation_id, integrity_failed, host_key_pinned, updated_at)
       VALUES ($1,$2,false,true,$3)
       ON CONFLICT (pack_id, workstation_id) DO UPDATE SET host_key_pinned=true, updated_at=EXCLUDED.updated_at`,
      [p.packId, p.workstationId, e.createdAt],
    );
  },

  PackAuthoredSaveRequested: async (tx, e) => {
    const p = (e.event as EventOf<'PackAuthoredSaveRequested'>).payload;
    await exec(tx, `UPDATE packs SET save_pending=true, save_approve=$2 WHERE id=$1 AND removed_at IS NULL`, [
      p.packId,
      p.approve,
    ]);
  },

  PackVisibilityChanged: async (tx, e) => {
    const p = (e.event as EventOf<'PackVisibilityChanged'>).payload;
    // Made private: the review no longer applies (it is the owner's own pack); made organization-visible: it starts untrusted.
    await exec(
      tx,
      `UPDATE packs SET visibility=$2, trusted=false, trusted_sha=NULL, trusted_hash=NULL, scripts_enabled=false
        WHERE id=$1 AND removed_at IS NULL`,
      [p.packId, p.visibility],
    );
    if (p.visibility === 'org') await exec(tx, 'DELETE FROM pack_agent_grants WHERE pack_id=$1', [p.packId]);
  },

  PackAgentGranted: async (tx, e) => {
    const p = (e.event as EventOf<'PackAgentGranted'>).payload;
    if (!p.granted) {
      await exec(tx, 'DELETE FROM pack_agent_grants WHERE pack_id=$1 AND agent_id=$2', [p.packId, p.agentId]);
      return;
    }
    await exec(
      tx,
      `INSERT INTO pack_agent_grants (pack_id, agent_id, granted_by, granted_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (pack_id, agent_id) DO NOTHING`,
      [p.packId, p.agentId, p.grantedBy, e.createdAt],
    );
  },

  RolePackUpdateOffered: async (tx, e) => {
    const p = (e.event as EventOf<'RolePackUpdateOffered'>).payload;
    await exec(
      tx,
      `INSERT INTO role_pack_offers (org_id, role_key, from_version, pack_id, capability, sha, hash, provenance, status, offered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)
       ON CONFLICT (org_id, role_key) DO UPDATE SET from_version=EXCLUDED.from_version, pack_id=EXCLUDED.pack_id,
         capability=EXCLUDED.capability, sha=EXCLUDED.sha, hash=EXCLUDED.hash, provenance=EXCLUDED.provenance,
         status='open', offered_at=EXCLUDED.offered_at`,
      [
        p.orgId,
        p.roleKey,
        p.fromVersion,
        p.packId,
        p.capability,
        p.sha,
        p.hash,
        JSON.stringify(p.provenance),
        e.createdAt,
      ],
    );
  },

  RolePackUpdateResolved: async (tx, e) => {
    const p = (e.event as EventOf<'RolePackUpdateResolved'>).payload;
    await exec(tx, `UPDATE role_pack_offers SET status=$3 WHERE org_id=$1 AND role_key=$2`, [
      p.orgId,
      p.roleKey,
      p.accepted ? 'accepted' : 'dismissed',
    ]);
  },
};
