import type pg from 'pg';

/** Anything with `query`: a Pool, PoolClient or Tx. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export type Row = Record<string, any>;

/** Tiny typed helpers: no ORM (docs/ARCHITECTURE.md section 1). */
export async function rows<T extends Row = Row>(
  db: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}

export async function one<T extends Row = Row>(
  db: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const r = await db.query<T>(text, params);
  return r.rows[0];
}

export async function exec(db: Queryable, text: string, params: unknown[] = []): Promise<number> {
  const r = await db.query(text, params);
  return r.rowCount ?? 0;
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

/** Escapes `\`, `%` and `_` so user text matches literally inside a `LIKE`/`ILIKE` pattern. */
export const escapeLike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);
