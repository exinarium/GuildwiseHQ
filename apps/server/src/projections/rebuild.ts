import type { Pool } from '../db/pool.ts';
import { exec } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';
import type { PgEventStore } from '../eventstore/pg-event-store.ts';
import { PROJECTION_TABLES } from './index.ts';

/** Operational tables that reference projection tables: saved before the truncate, restored after the replay. */
const SAVED: Array<{ table: string; restoreWhere: string }> = [
  { table: 'auth_sessions', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  { table: 'pairing_codes', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  // Two-factor secrets and recovery codes are operational (they never enter the event log).
  { table: 'user_totp', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  { table: 'user_recovery_codes', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  { table: 'login_challenges', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  { table: 'runner_commands', restoreWhere: 'workstation_id IN (SELECT id FROM workstations)' },
  // The runner's public key for the sudo password (migration 1370): announced in `hello`, not an event.
  { table: 'workstation_keys', restoreWhere: 'workstation_id IN (SELECT id FROM workstations)' },
  { table: 'runner_token_rotations', restoreWhere: 'workstation_id IN (SELECT id FROM workstations)' },
  {
    table: 'workstation_repos',
    restoreWhere:
      'workstation_id IN (SELECT id FROM workstations) AND project_repo_id IN (SELECT id FROM project_repos)',
  },
  // Written by the runner's rpc, not a projection (migration 1300), but it references `projects`: the CASCADE below empties it.
  { table: 'transcripts', restoreWhere: 'project_id IN (SELECT id FROM projects)' },
  {
    table: 'workstation_vaults',
    restoreWhere: 'workstation_id IN (SELECT id FROM workstations) AND vault_id IN (SELECT id FROM vaults)',
  },
];

/**
 * Truncates every projection table and replays all events in seq order (batches of 1000) inside one transaction
 * (docs/ARCHITECTURE.md section 3.3). Operational data (sessions, pairing codes, runner command queue, presence,
 * heartbeats, shift progress) is preserved; live leases are carried over (a claim unknown before the rebuild gets `now + 1h`).
 */
export async function rebuildProjections(
  pool: Pool,
  store: PgEventStore,
  now: Date = new Date(),
): Promise<{ events: number }> {
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7311)'); // no appends while rebuilding
    for (const s of SAVED)
      await exec(tx, `CREATE TEMP TABLE _save_${s.table} ON COMMIT DROP AS SELECT * FROM ${s.table}`);
    await exec(
      tx,
      'CREATE TEMP TABLE _save_users ON COMMIT DROP AS SELECT id, last_login_at, last_org_id, tour_status, tour_step FROM users',
    );
    await exec(
      tx,
      'CREATE TEMP TABLE _save_ws ON COMMIT DROP AS SELECT id, connected, last_seen_at, runtimes, hostname, platform, runner_version FROM workstations',
    );
    // Live claims keep the lease the heartbeats extended: replay alone would reset it to `claimed_at + 1h`, which
    // for a long shift is already in the past and would make the reaper release a claim that is still working.
    await exec(
      tx,
      'CREATE TEMP TABLE _save_leases ON COMMIT DROP AS SELECT id, claim_id, lease_expires_at FROM cards WHERE claim_id IS NOT NULL',
    );
    await exec(
      tx,
      'CREATE TEMP TABLE _save_shifts ON COMMIT DROP AS SELECT id, progress_tail, accepted_at FROM shifts',
    );

    await exec(tx, `TRUNCATE ${PROJECTION_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

    let after = 0n;
    let count = 0;
    for (;;) {
      const batch = await store.readAll(after, 1000);
      if (batch.length === 0) break;
      for (const e of batch) {
        await store.project(tx, e);
        after = e.seq;
        count++;
      }
    }

    for (const s of SAVED) {
      await exec(tx, `INSERT INTO ${s.table} SELECT * FROM _save_${s.table} WHERE ${s.restoreWhere}`);
    }
    await exec(
      tx,
      'UPDATE users u SET last_login_at = s.last_login_at, last_org_id = s.last_org_id FROM _save_users s WHERE u.id = s.id',
    );
    // Users who had the tour marked done by migration 1321 (before it had events) keep that; an event replayed above wins.
    await exec(
      tx,
      `UPDATE users u SET tour_status = s.tour_status, tour_step = s.tour_step FROM _save_users s
        WHERE u.id = s.id AND u.tour_status IS NULL AND s.tour_status IS NOT NULL`,
    );
    await exec(
      tx,
      `UPDATE workstations w SET connected = s.connected, last_seen_at = s.last_seen_at, runtimes = s.runtimes,
            hostname = s.hostname, platform = s.platform, runner_version = s.runner_version
         FROM _save_ws s WHERE w.id = s.id`,
    );
    await exec(
      tx,
      `UPDATE shifts x SET progress_tail = s.progress_tail, accepted_at = s.accepted_at FROM _save_shifts s WHERE x.id = s.id`,
    );
    await exec(
      tx,
      `UPDATE cards c SET lease_expires_at = s.lease_expires_at
         FROM _save_leases s WHERE c.id = s.id AND c.claim_id = s.claim_id`,
    );
    // A claim the saved copy does not know (made between the copy and the replay cannot happen under the lock;
    // this covers events appended by an older version): a fresh lease rather than an already-expired one.
    await exec(
      tx,
      `UPDATE cards SET lease_expires_at = $1
        WHERE claim_id IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at < $1)
          AND id NOT IN (SELECT id FROM _save_leases)`,
      [new Date(now.getTime() + 3600_000)],
    );
    return { events: count };
  });
}
