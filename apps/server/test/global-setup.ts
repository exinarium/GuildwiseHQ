import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../src/db/migrate.ts';

const ROOT_PREFIX = 'aom-vt-server-';
const VARS = ['TMPDIR', 'TMP', 'TEMP', 'AOM_AGENT_TMP_ROOT'] as const;
/** A root this old belongs to a run that was killed before its teardown: the next run removes it. */
const STALE_MS = 12 * 3600_000;

const removeTree = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {
    /* busy: a later run's stale sweep tries again */
  }
};

function sweepStaleRoots(base: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const uid = process.getuid?.();
  for (const name of names) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      if (Date.now() - st.mtimeMs < STALE_MS) continue;
    } catch {
      continue;
    }
    removeTree(dir);
  }
}

/** The comment that marks a database a run created for itself (AOM_TEST_RUN_ID): only these are ever dropped. */
const RUN_MARK = 'aom-test-run ';

/** The same server's maintenance database, for CREATE and DROP DATABASE. */
function adminUrl(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: adminUrl(url) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * Creates the test database when it does not exist yet (42P04: it does). A run with AOM_TEST_RUN_ID that created its own
 * database marks it with a comment and first drops marked databases older than STALE_MS (left by killed runs). A database
 * created by hand, and the shared aom_test, are never marked, so never dropped. Returns true when this run created and
 * marked the database (and so drops it at teardown).
 */
async function ensureDatabase(url: string, name: string, perRun: boolean): Promise<boolean> {
  return withAdmin(url, async (c) => {
    if (perRun) {
      const stale = await c.query<{ datname: string; description: string }>(
        `SELECT d.datname, s.description FROM pg_database d JOIN pg_shdescription s ON s.objoid = d.oid
           WHERE s.classoid = 'pg_database'::regclass AND s.description LIKE $1`,
        [`${RUN_MARK}%`],
      );
      for (const row of stale.rows) {
        const at = Date.parse(row.description.slice(RUN_MARK.length));
        if (!/^aom_test_[a-z0-9]+$/.test(row.datname) || row.datname === name) continue;
        if (Number.isNaN(at) || Date.now() - at < STALE_MS) continue;
        await c
          .query(`DROP DATABASE IF EXISTS ${quoteIdent(row.datname)} WITH (FORCE)`)
          .catch(() => undefined);
      }
    }
    try {
      await c.query(`CREATE DATABASE ${quoteIdent(name)}`);
    } catch (err) {
      if ((err as { code?: string }).code === '42P04') return false;
      throw err;
    }
    if (!perRun) return false;
    await c.query(`COMMENT ON DATABASE ${quoteIdent(name)} IS '${RUN_MARK}${new Date().toISOString()}'`);
    return true;
  });
}

async function dropRunDatabase(url: string, name: string): Promise<void> {
  try {
    await withAdmin(url, (c) => c.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`));
  } catch {
    /* a later run's stale sweep removes it */
  }
}

export default async function setup() {
  const url = process.env.DATABASE_URL ?? '';
  const m = /\/(aom_test(?:_[a-z0-9]+)?)$/.exec(url);
  if (!m) throw new Error(`refusing to run tests against ${url}`);
  const dbName = m[1] as string;
  const runId = process.env.AOM_TEST_RUN_ID;
  const perRun = !!runId && dbName === `aom_test_${runId}`;
  // Without a run id (a developer, the regression run) a failure here is left to migrate(), which names it.
  const created = perRun
    ? await ensureDatabase(url, dbName, true)
    : await ensureDatabase(url, dbName, false).catch(() => false);
  await migrate(url);

  // One temp root per run: the test workers (forked after this) inherit TMPDIR, so every tmpdir() dir a test makes lands
  // here and goes at the end of the run, also when tests fail or the run is interrupted. AOM_AGENT_TMP_ROOT does the same
  // for the agent temp dirs of the runners the simulation tests start (they would go to /tmp otherwise).
  const base = tmpdir();
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  sweepStaleRoots(base);
  const root = mkdtempSync(join(base, ROOT_PREFIX));
  for (const k of VARS) process.env[k] = root;
  // vitest exits on SIGINT/SIGTERM with process.exit() and skips the teardown below
  const onExit = () => removeTree(root);
  process.once('exit', onExit);
  return async () => {
    process.off('exit', onExit);
    removeTree(root);
    // A killed run (SIGTERM, a timeout) skips this: its marked database goes with a later run's stale sweep.
    if (created) await dropRunDatabase(url, dbName);
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
