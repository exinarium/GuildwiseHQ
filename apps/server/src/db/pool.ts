import pg from 'pg';

// bigint (int8) -> string; callers convert where they need numbers. numeric -> number is not needed.
pg.types.setTypeParser(20, (v) => v);

export type Pool = pg.Pool;

export function createPool(connectionString: string, max = 20): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
