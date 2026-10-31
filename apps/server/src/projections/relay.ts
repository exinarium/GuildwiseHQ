import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends 'RelayIntegrationCreated' | 'RelayIntegrationRotated' | 'RelayIntegrationRevoked'>(
  e: StoredEvent,
) => e.event as EventOf<T>;

/** Inbound relay integrations. Only the hash of the path token is stored. Writes use the event time. */
export const relayProjectors: Record<string, Projector> = {
  RelayIntegrationCreated: async (tx, e) => {
    const p = ev<'RelayIntegrationCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO relay_integrations (id, org_id, kind, label, status, token_hash, created_by, created_at)
       VALUES ($1,$2,$3,$4,'active',$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [p.integrationId, p.orgId, p.kind, p.label, p.tokenHash, p.by, e.createdAt],
    );
  },
  RelayIntegrationRotated: async (tx, e) => {
    const p = ev<'RelayIntegrationRotated'>(e).payload;
    await exec(tx, `UPDATE relay_integrations SET token_hash=$2, rotated_at=$3 WHERE id=$1`, [
      p.integrationId,
      p.tokenHash,
      e.createdAt,
    ]);
  },
  RelayIntegrationRevoked: async (tx, e) => {
    const p = ev<'RelayIntegrationRevoked'>(e).payload;
    await exec(
      tx,
      `UPDATE relay_integrations SET status='revoked', token_hash=NULL, revoked_at=$2 WHERE id=$1`,
      [p.integrationId, e.createdAt],
    );
  },
};
