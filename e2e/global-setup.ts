import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  ADMIN,
  BASE_URL,
  DATABASE_URL,
  DB_NAME,
  E2E_DIR,
  NEWORG,
  ORGMEM,
  PG_ADMIN_URL,
  PORT,
  paths,
  ROOT,
  SMTP_URL,
  SUPER,
} from './support/env.ts';
import { deleteMailFor } from './support/mail.ts';
import { killAllRunners } from './support/runner.ts';

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

async function recreateDb(): Promise<void> {
  const c = new pg.Client({ connectionString: PG_ADMIN_URL });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await c.end();
  }
}

function makeToyRepo(): void {
  mkdirSync(join(E2E_DIR, 'origin'), { recursive: true });
  mkdirSync(paths.repoRoot, { recursive: true });
  sh('git', ['init', '--bare', '-b', 'main', paths.origin]);
  const g = (...a: string[]) =>
    sh('git', ['-C', paths.toyClone, '-c', 'user.name=Toy', '-c', 'user.email=toy@e2e.test', ...a]);
  sh('git', ['clone', paths.origin, paths.toyClone]);
  g('checkout', '-b', 'main');
  writeFileSync(join(paths.toyClone, 'README.md'), '# Toy\n\nA toy project for the AOM e2e suite.\n');
  writeFileSync(join(paths.toyClone, 'index.js'), "console.log('toy');\n");
  g('add', '.');
  g('commit', '-m', 'Initial commit');
  g('push', '-u', 'origin', 'main');
}

async function waitHealthy(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become healthy; see ${paths.serverLog}`);
}

/**
 * Pins the server's test clock to a fixed time of day, so the suite does not depend on when it runs. The daily floor
 * report fires once the manager's local clock passes 08:00, and specs advance the clock (core-loop by an hour and a
 * minute), so a run started shortly before 08:00 local would see a report appear mid-suite. The clock only moves
 * forward: to the next 10:00 UTC (12:00 in Johannesburg), which leaves hours of headroom either side for any zone.
 */
async function pinTestClock(): Promise<void> {
  const post = (advanceMs: number) =>
    fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs }),
    });
  const now = new Date(((await (await post(0)).json()) as { now: string }).now);
  // Already in the safe part of the day (08:30 to 22:00 UTC)? Stay put. Jumping a day ahead from here would carry the
  // organizations created a moment ago across the next 08:00, and each would get a floor report mid-suite.
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (hour >= 8.5 && hour < 22) return;
  const target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0);
  const next = target > now.getTime() ? target : target + 86_400_000;
  const r = await post(next - now.getTime());
  if (!r.ok) throw new Error(`could not pin the test clock: ${r.status}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.AOM_E2E_DIR = E2E_DIR;
  rmSync(E2E_DIR, { recursive: true, force: true });
  mkdirSync(E2E_DIR, { recursive: true });

  await recreateDb();
  makeToyRepo();
  await Promise.all(
    [
      'member@e2e.test',
      'other@e2e.test',
      'devops@e2e.test',
      'sharer@e2e.test',
      'guest@e2e.test',
      'tester@e2e.test',
      'migrant@e2e.test',
      'scholar@e2e.test',
      'intaker@e2e.test',
      'outboxer@e2e.test',
      'phaser@e2e.test',
      'reporter@e2e.test',
      'hygiener@e2e.test',
      'interester@e2e.test',
      'scheduler@e2e.test',
      'installer@e2e.test',
      'supporter@e2e.test',
      'tourist@e2e.test',
      'visitor@e2e.test',
      SUPER.email,
      NEWORG.email,
      ORGMEM.email,
    ].map(deleteMailFor),
  );

  const releaseDir = join(E2E_DIR, 'release');
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(
    join(releaseDir, 'aom-runner-0.1.0.tgz'),
    'not a real tarball: the e2e suite never installs it\n',
  );

  const env = {
    ...process.env,
    DATABASE_URL,
    AOM_PORT: String(PORT),
    AOM_HOST: '127.0.0.1',
    AOM_PUBLIC_ORIGIN: BASE_URL,
    AOM_SMTP_URL: SMTP_URL,
    AOM_SERVE_WEB: 'true',
    AOM_WEB_DIST: paths.webDist,
    AOM_RATE_LIMIT: 'false',
    AOM_TEST_CLOCK: 'true',
    AOM_ALLOW_LOCAL_REMOTES: 'true',
    AOM_MOCK_UI: 'true',
    // the first-login tour is off for every user (the tour spec switches it on for its own); it would cover the page under test
    AOM_TOUR_AUTOSTART: 'false',
    // phases: re-check a finalized pull request / pushed branch against the working branch every few seconds
    AOM_MERGE_CHECK_SECONDS: '4',
    // BA reporter: sweep for signals, expired holds and the daily report every few seconds
    AOM_REPORTER_SECONDS: '3',
    // repository hygiene runs only when a spec asks ("Run hygiene now"): the specs move the clock by days
    AOM_HYGIENE_SCHEDULE: 'false',
    // schedules: the webhook receivers of the specs listen on this machine
    AOM_WEBHOOK_ALLOW_PRIVATE: 'true',
    // the "Add a workstation" wizard serves a runner release: a stand-in file is enough, no spec downloads it
    AOM_RUNNER_RELEASE_DIR: releaseDir,
    LOG_LEVEL: 'info',
  };
  sh(
    'pnpm',
    [
      '--filter',
      '@aom/server',
      'admin:create',
      '--email',
      ADMIN.email,
      '--name',
      process.env.AOM_E2E_ADMIN_NAME ?? ADMIN.name,
      '--password',
      ADMIN.password,
      // the getting-started video renames the demo organization ("Acme")
      ...(process.env.AOM_E2E_ADMIN_ORG ? ['--org', process.env.AOM_E2E_ADMIN_ORG] : []),
    ],
    {
      cwd: ROOT,
      env,
    },
  );

  sh(
    'pnpm',
    [
      '--filter',
      '@aom/server',
      'superadmin:create',
      '--email',
      SUPER.email,
      '--name',
      SUPER.name,
      '--password',
      SUPER.password,
    ],
    { cwd: ROOT, env },
  );

  const log = openSync(paths.serverLog, 'a');
  const server: ChildProcess = spawn('node', [paths.server], { env, stdio: ['ignore', log, log] });
  closeSync(log);
  await waitHealthy();
  await pinTestClock();
  writeFileSync(paths.pids, JSON.stringify({ server: server.pid }));

  return async () => {
    killAllRunners('SIGTERM');
    server.kill('SIGTERM');
  };
}
