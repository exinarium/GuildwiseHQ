import type pg from 'pg';
import type { Queryable } from './sql.ts';

export type Tx = pg.PoolClient & Queryable;

/** Global event append lock (docs/ARCHITECTURE.md section 3.2). */
export const APPEND_LOCK_ID = 7311;
export const MIGRATION_LOCK_ID = 7300;
export const DISPATCH_LOCK_ID = 7320;

const pendingAfterCommit = new WeakMap<object, Array<() => unknown>>();

/** Runs fn once the transaction has committed; never when it rolls back. Only inside withTx / withAppendTx. */
export function afterCommit(tx: Tx, fn: () => unknown): void {
  const list = pendingAfterCommit.get(tx);
  if (!list) throw new Error('afterCommit needs a transaction opened by withTx');
  list.push(fn);
}

export async function withTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const after: Array<() => unknown> = [];
  pendingAfterCommit.set(client, after);
  try {
    await client.query('BEGIN');
    const out = await fn(client as Tx);
    await client.query('COMMIT');
    pendingAfterCommit.delete(client);
    // Fire and forget: a failing hook never changes the result of a committed transaction.
    for (const f of after)
      void Promise.resolve()
        .then(f)
        .catch(() => undefined);
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // connection is broken; release below discards it
    }
    throw err;
  } finally {
    pendingAfterCommit.delete(client);
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
