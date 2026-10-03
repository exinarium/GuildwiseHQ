import type { Pool } from '../db/pool.ts';
import { exec } from '../db/sql.ts';
import { withTx } from '../db/tx.ts';
import type { PgEventStore } from '../eventstore/pg-event-store.ts';
import { PROJECTION_TABLES } from './index.ts';

/** Operational tables that reference projection tables: saved before the truncate, restored after the replay. */
const SAVED: Array<{ table: string; restoreWhere: string }> = [
  { table: 'auth_sessions', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  { table: 'pairing_codes', restoreWhere: 'user_id IN (SELECT id FROM users)' },
  { table: 'runner_commands', restoreWhere: 'workstation_id IN (SELECT id FROM workstations)' },
  {
    table: 'workstation_repos',
    restoreWhere:
      'workstation_id IN (SELECT id FROM workstations) AND project_repo_id IN (SELECT id FROM project_repos)',
  },
  {
    table: 'workstation_vaults',
    restoreWhere: 'workstation_id IN (SELECT id FROM workstations) AND vault_id IN (SELECT id FROM vaults)',
  },
];

/**
 * Truncates every projection table and replays all events in seq order (batches of 1000) inside one transaction
 * (docs/ARCHITECTURE.md section 3.3). Operational data (sessions, pairing codes, runner command queue, presence,
 * heartbeats, shift progress) is preserved; leases are recomputed as `claimed_at + 1h` by the projector.
 */
export async function rebuildProjections(pool: Pool, store: PgEventStore): Promise<{ events: number }> {
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7311)'); // no appends while rebuilding
    for (const s of SAVED)
      await exec(tx, `CREATE TEMP TABLE _save_${s.table} ON COMMIT DROP AS SELECT * FROM ${s.table}`);
    await exec(tx, 'CREATE TEMP TABLE _save_users ON COMMIT DROP AS SELECT id, last_login_at FROM users');
    await exec(
      tx,
      'CREATE TEMP TABLE _save_ws ON COMMIT DROP AS SELECT id, connected, last_seen_at, runtimes, hostname, platform, runner_version FROM workstations',
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
    await exec(tx, 'UPDATE users u SET last_login_at = s.last_login_at FROM _save_users s WHERE u.id = s.id');
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
    return { events: count };
  });
}
