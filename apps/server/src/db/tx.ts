import type pg from 'pg';
import type { Queryable } from './sql.ts';

export type Tx = pg.PoolClient & Queryable;

/** Global event append lock (docs/ARCHITECTURE.md section 3.2). */
export const APPEND_LOCK_ID = 7311;
export const MIGRATION_LOCK_ID = 7300;
export const DISPATCH_LOCK_ID = 7320;

export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client as Tx);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection is broken; release below discards it
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Transaction that holds the global append lock from the start (commands that read-then-append). */
export function withAppendTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTx(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [APPEND_LOCK_ID]);
    return fn(tx);
  });
}
