import pg from 'pg';

export const TEST_DB_URL = process.env.DATABASE_URL as string;
if (!/\/aom_test(_[a-z0-9]+)?$/.test(TEST_DB_URL ?? ''))
  throw new Error(`tests must use aom_test, got ${TEST_DB_URL}`);

let admin: pg.Pool | null = null;
const adminPool = () => (admin ??= new pg.Pool({ connectionString: TEST_DB_URL, max: 2 }));

/** TRUNCATE every table except schema_migrations. (The events append-only trigger is row-level; TRUNCATE passes.) */
export async function resetDb(): Promise<void> {
  const p = adminPool();
  const { rows } = await p.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
  );
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await p.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function closeAdminPool(): Promise<void> {
  await admin?.end();
  admin = null;
}

export async function q<T extends Record<string, any> = Record<string, any>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  // A TRUNCATE between tests can deadlock with the previous test's last background dispatch or presence update:
  // the test statement is the victim, so simply run it again.
  for (let attempt = 0; ; attempt++) {
    try {
      return (await adminPool().query(sql, params)).rows as T[];
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}
