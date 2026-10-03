import { migrate } from '../src/db/migrate.ts';

export default async function setup() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/\/aom_test(_[a-z0-9]+)?$/.test(url)) throw new Error(`refusing to run tests against ${url}`);
  await migrate(url);
}
