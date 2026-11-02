import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends 'StorageConnectionCreated' | 'StorageConnectionRenamed' | 'StorageConnectionRemoved'>(
  e: StoredEvent,
) => e.event as EventOf<T>;

/** Storage connections: id, kind, label, workstation. Never a token, key, endpoint or path (the runner holds those). */
export const storageProjectors: Record<string, Projector> = {
  StorageConnectionCreated: async (tx, e) => {
    const p = ev<'StorageConnectionCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO storage_connections (id, org_id, kind, label, workstation_id, status, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [p.connectionId, p.orgId, p.kind, p.label, p.workstationId, p.by, e.createdAt],
    );
  },
  StorageConnectionRenamed: async (tx, e) => {
    const p = ev<'StorageConnectionRenamed'>(e).payload;
    await exec(tx, `UPDATE storage_connections SET label=$2 WHERE id=$1`, [p.connectionId, p.label]);
  },
  StorageConnectionRemoved: async (tx, e) => {
    const p = ev<'StorageConnectionRemoved'>(e).payload;
    await exec(tx, `UPDATE storage_connections SET status='removed', removed_at=$2 WHERE id=$1`, [
      p.connectionId,
      e.createdAt,
    ]);
  },
};
