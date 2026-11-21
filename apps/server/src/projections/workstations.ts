import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

export const workstationProjectors: Record<string, Projector> = {
  WorkstationPaired: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationPaired'>).payload;
    await exec(
      tx,
      `INSERT INTO workstations (id, user_id, name, platform, hostname, runner_version, token_hash, status, paired_at,
         simulation_org_id, release_signed, release_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11)`,
      [
        p.workstationId,
        p.userId,
        p.name,
        p.platform,
        p.hostname,
        p.runnerVersion,
        p.tokenHash,
        e.createdAt,
        p.simulationOrgId ?? null,
        // A release the server verified at pairing (R21, R27); `hello` keeps it current.
        !!p.release?.keyId,
        p.release?.keyId ?? null,
      ],
    );
  },
  WorkstationShiftLimitSet: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationShiftLimitSet'>).payload;
    await exec(tx, 'UPDATE workstations SET shift_limit=$2, shift_limit_unlimited=$3 WHERE id=$1', [
      p.workstationId,
      typeof p.limit === 'number' ? p.limit : null,
      p.limit === 'unlimited',
    ]);
  },
  WorkstationAccountSharingSet: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationAccountSharingSet'>).payload;
    await exec(tx, 'UPDATE workstations SET share_accounts=$2 WHERE id=$1', [p.workstationId, p.allow]);
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
      `UPDATE workstations SET connected=true, connected_at=$3, runner_version=COALESCE($2, runner_version) WHERE id=$1 AND status='active'`,
      [p.workstationId, p.runnerVersion ?? null, e.createdAt],
    );
  },
  WorkstationDisconnected: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationDisconnected'>).payload;
    await exec(tx, 'UPDATE workstations SET connected=false WHERE id=$1', [p.workstationId]);
  },
  /** Passkeys registered for approvals (R22). The runner trusts one only after a local `guildwise-runner passkey trust`. */
  WorkstationPasskeyAdded: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationPasskeyAdded'>).payload;
    await exec(
      tx,
      `INSERT INTO workstation_passkeys (id, workstation_id, user_id, credential_id, public_key, alg, name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [p.passkeyId, p.workstationId, p.by, p.credentialId, p.publicKey, p.alg, p.name, e.createdAt],
    );
  },
  WorkstationPasskeyRemoved: async (tx, e) => {
    const p = (e.event as EventOf<'WorkstationPasskeyRemoved'>).payload;
    await exec(
      tx,
      'UPDATE workstation_passkeys SET removed_at=$3 WHERE id=$1 AND workstation_id=$2 AND removed_at IS NULL',
      [p.passkeyId, p.workstationId, e.createdAt],
    );
  },
};
