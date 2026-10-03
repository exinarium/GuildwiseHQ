import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const vaultProjectors: Record<string, Projector> = {
  VaultRegistered: async (tx, e) => {
    const p = (e.event as EventOf<'VaultRegistered'>).payload;
    await exec(
      tx,
      `INSERT INTO vaults (id, org_id, project_id, kind, name, remote_url, sync_interval_sec, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.vaultId, p.orgId, p.projectId ?? null, p.kind, p.name, p.remoteUrl, p.syncIntervalSec, e.createdAt],
    );
  },
  VaultUpdated: async (tx, e) => {
    const p = (e.event as EventOf<'VaultUpdated'>).payload;
    await exec(tx, `UPDATE vaults SET name=$2, remote_url=$3, sync_interval_sec=$4 WHERE id=$1`, [
      p.vaultId,
      p.name,
      p.remoteUrl,
      p.syncIntervalSec,
    ]);
  },
  // workstation_vaults is operational (runner reports): the conflict flag is kept there so the UI can show it.
  VaultSyncConflict: async (tx, e) => {
    const p = (e.event as EventOf<'VaultSyncConflict'>).payload;
    await exec(
      tx,
      `INSERT INTO workstation_vaults (workstation_id, vault_id, paused, conflict_files)
       VALUES ($1,$2,true,$3)
       ON CONFLICT (workstation_id, vault_id) DO UPDATE SET paused = true, conflict_files = EXCLUDED.conflict_files`,
      [p.workstationId, p.vaultId, p.files],
    );
  },
  VaultConflictResolved: async (tx, e) => {
    const p = (e.event as EventOf<'VaultConflictResolved'>).payload;
    await exec(
      tx,
      `UPDATE workstation_vaults SET paused = false, conflict_files = '{}', last_error = NULL
        WHERE workstation_id=$1 AND vault_id=$2`,
      [p.workstationId, p.vaultId],
    );
  },
};
