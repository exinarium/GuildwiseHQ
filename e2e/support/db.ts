import pg from 'pg';
import { DATABASE_URL } from './env.ts';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

export interface Transition {
  card_id: string;
  from_stage: string | null;
  to_stage: string;
  from_status: string | null;
  to_status: string;
  agent_id: string | null;
  reason: string;
  at: Date;
}

export const transitionsFor = (ref: string) =>
  q<Transition>(
    `SELECT t.* FROM card_transitions t JOIN cards c ON c.id = t.card_id WHERE c.ref = $1 ORDER BY t.id`,
    [ref],
  );

/** Poll a DB-derived value until `pred` holds. */
export async function waitFor<T>(
  what: string,
  get: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await get();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}
