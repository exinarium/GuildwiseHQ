import { migrate } from '../src/db/migrate.ts';

export default async function setup() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.endsWith('/aom_test')) throw new Error(`refusing to run tests against ${url}`);
  await migrate(url);
}
