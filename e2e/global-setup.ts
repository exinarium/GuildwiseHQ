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
  PG_ADMIN_URL,
  PORT,
  paths,
  ROOT,
  SMTP_URL,
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
      'feeder@e2e.test',
      'scholar@e2e.test',
      'intaker@e2e.test',
      'outboxer@e2e.test',
      'phaser@e2e.test',
      'reporter@e2e.test',
      'hygiener@e2e.test',
      'interester@e2e.test',
    ].map(deleteMailFor),
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
    // phases: re-check a finalized pull request / pushed branch against the working branch every few seconds
    AOM_MERGE_CHECK_SECONDS: '4',
    // BA reporter: sweep for signals, expired holds and the daily report every few seconds
    AOM_REPORTER_SECONDS: '3',
    // repository hygiene runs only when a spec asks ("Run hygiene now"): the specs move the clock by days
    AOM_HYGIENE_SCHEDULE: 'false',
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
      ADMIN.name,
      '--password',
      ADMIN.password,
    ],
    {
      cwd: ROOT,
      env,
    },
  );

  const log = openSync(paths.serverLog, 'a');
  const server: ChildProcess = spawn('node', [paths.server], { env, stdio: ['ignore', log, log] });
  closeSync(log);
  await waitHealthy();
  writeFileSync(paths.pids, JSON.stringify({ server: server.pid }));

  return async () => {
    killAllRunners('SIGTERM');
    server.kill('SIGTERM');
  };
}
