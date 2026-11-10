import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export default async function setup() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/\/aom_test(_[a-z0-9]+)?$/.test(url)) throw new Error(`refusing to run tests against ${url}`);
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
  return () => {
    process.off('exit', onExit);
    removeTree(root);
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
