import { digestCapabilityIndex, type EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** The organization vault's capability index, as the last report said (metadata only). */
export const capabilityProjectors: Record<string, Projector> = {
  CapabilityIndexReported: async (tx, e) => {
    const p = (e.event as EventOf<'CapabilityIndexReported'>).payload;
    await exec(tx, 'DELETE FROM capability_index WHERE org_id = $1', [p.orgId]);
    for (const i of p.items)
      await exec(
        tx,
        `INSERT INTO capability_index (org_id, kind, key, name, description, hash, source, vault_id, reported_at)
         VALUES ($1,$2,$3,$4,$5,$6,'org-vault',$7,$8)
         ON CONFLICT (org_id, kind, key) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, hash=EXCLUDED.hash,
           vault_id=EXCLUDED.vault_id, reported_at=EXCLUDED.reported_at`,
        [p.orgId, i.kind, i.key, i.name, i.description, i.hash, p.vaultId, e.createdAt],
      );
    await exec(
      tx,
      `INSERT INTO capability_index_status (org_id, vault_id, workstation_id, issues, item_hash, reported_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id) DO UPDATE SET vault_id=EXCLUDED.vault_id, workstation_id=EXCLUDED.workstation_id,
         issues=EXCLUDED.issues, item_hash=EXCLUDED.item_hash, reported_at=EXCLUDED.reported_at`,
      [
        p.orgId,
        p.vaultId,
        p.workstationId,
        JSON.stringify(p.issues),
        digestCapabilityIndex(p.items, p.issues),
        e.createdAt,
      ],
    );
  },
};
