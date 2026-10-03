import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const workstationProjectors: Record<string, Projector> = {
  WorkstationPaired: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationPaired'>).payload;
    await exec(
      tx,
      `INSERT INTO workstations (id, user_id, name, platform, hostname, runner_version, token_hash, status, paired_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
      [p.workstationId, p.userId, p.name, p.platform, p.hostname, p.runnerVersion, p.tokenHash, e.createdAt],
    );
  },
  WorkstationRenamed: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationRenamed'>).payload;
    await exec(tx, 'UPDATE workstations SET name=$2 WHERE id=$1', [p.workstationId, p.name]);
  },
  WorkstationUnlinked: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationUnlinked'>).payload;
    await exec(tx, `UPDATE workstations SET status='unlinked', unlinked_at=$2, connected=false WHERE id=$1`, [
      p.workstationId,
      e.createdAt,
    ]);
  },
  WorkstationTokenRotated: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationTokenRotated'>).payload;
    await exec(tx, 'UPDATE workstations SET token_hash=$2 WHERE id=$1', [p.workstationId, p.tokenHash]);
  },
  WorkstationConnected: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationConnected'>).payload;
    await exec(
      tx,
      `UPDATE workstations SET connected=true, runner_version=COALESCE($2, runner_version) WHERE id=$1 AND status='active'`,
      [p.workstationId, p.runnerVersion ?? null],
    );
  },
  WorkstationDisconnected: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationDisconnected'>).payload;
    await exec(tx, 'UPDATE workstations SET connected=false WHERE id=$1', [p.workstationId]);
  },
};
