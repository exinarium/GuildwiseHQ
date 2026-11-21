import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

/**
 * Release signing per deploy target (R30): `deploy_targets.signing`, the artefact each target's release was packaged into
 * (`release_artefacts`, newest wins) and the stored signatures (`release_signatures`, public data). Replay-safe: every
 * write is keyed and idempotent, and a key change drops the artefacts packaged with the old key in event order.
 */

const ev = <T extends 'DeployTargetSigningSet' | 'ReleaseArtefactPrepared' | 'ReleaseArtefactSigned'>(
  e: StoredEvent,
) => e.event as EventOf<T>;

export const releaseSigningProjectors: Record<string, Projector> = {
  DeployTargetSigningSet: async (tx, e) => {
    const p = ev<'DeployTargetSigningSet'>(e).payload;
    const before = await one(tx, 'SELECT signing FROM deploy_targets WHERE id=$1', [p.targetId]);
    if (!before) return;
    await exec(tx, 'UPDATE deploy_targets SET signing=$2, updated_at=$3 WHERE id=$1', [
      p.targetId,
      p.signing ? JSON.stringify(p.signing) : null,
      e.createdAt,
    ]);
    // A runner packaged with another key embeds that key: it must be packaged (and signed) again.
    const oldKey = before.signing?.keyId ?? null;
    const oldPub = before.signing?.publicKey ?? null;
    if (oldKey !== (p.signing?.keyId ?? null) || oldPub !== (p.signing?.publicKey ?? null))
      await exec(tx, 'DELETE FROM release_artefacts WHERE target_id=$1', [p.targetId]);
  },
  ReleaseArtefactPrepared: async (tx, e) => {
    const p = ev<'ReleaseArtefactPrepared'>(e).payload;
    const ws = e.actor.kind === 'runner' ? e.actor.id : null;
    await exec(
      tx,
      `INSERT INTO release_artefacts (release_id, target_id, artefact_sha256, version, manifest, workstation_id, prepared_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (release_id, target_id) DO UPDATE SET artefact_sha256=EXCLUDED.artefact_sha256, version=EXCLUDED.version,
         manifest=EXCLUDED.manifest, workstation_id=EXCLUDED.workstation_id, prepared_at=EXCLUDED.prepared_at`,
      [p.releaseId, p.targetId, p.artefactSha256, p.version, p.manifest ?? null, ws, e.createdAt],
    );
  },
  ReleaseArtefactSigned: async (tx, e) => {
    const p = ev<'ReleaseArtefactSigned'>(e).payload;
    const by = e.actor.kind === 'user' ? e.actor.id : null;
    await exec(
      tx,
      `INSERT INTO release_signatures (release_id, target_id, key_id, artefact_sha256, minisig, source, by_user, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [p.releaseId, p.targetId, p.keyId, p.artefactSha256, p.minisig, p.source, by, e.createdAt],
    );
  },
};
