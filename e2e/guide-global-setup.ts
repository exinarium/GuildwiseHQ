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
import { SUPER_DEMO } from './support/guide.ts';
import { deleteMailFor } from './support/mail.ts';
import { killAllRunners } from './support/runner.ts';

/**
 * Global setup of the `guide` project only (`AOM_E2E_GUIDE=1`, see playwright.config.ts): the same stack as
 * global-setup.ts (database, toy origin, admin, server) with two switches for the screenshot workflow.
 *   AOM_GUIDE_KEEP=1   leave the server and the runners running after the run (detached), so the seeded demo world
 *                      survives and the screenshots can be taken again without seeding.
 *   AOM_GUIDE_REUSE=1  if the server of a kept run is healthy, reuse it (no reset, no new server).
 * Without the switches it behaves like the default setup: fresh database, everything stopped at the end.
 */
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
    sh('git', ['-C', paths.toyClone, '-c', 'user.name=Toy', '-c', 'user.email=toy@demo.local', ...a]);
  sh('git', ['clone', paths.origin, paths.toyClone]);
  g('checkout', '-b', 'main');
  writeFileSync(join(paths.toyClone, 'README.md'), '# Web\n\nThe demo web application.\n');
  writeFileSync(join(paths.toyClone, 'index.js'), "console.log('web');\n");
  g('add', '.');
  g('commit', '-m', 'Initial commit');
  g('push', '-u', 'origin', 'main');
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${BASE_URL}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function waitHealthy(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become healthy; see ${paths.serverLog}`);
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  const keep = process.env.AOM_GUIDE_KEEP === '1';
  process.env.AOM_E2E_DIR = E2E_DIR;
  if (process.env.AOM_GUIDE_REUSE === '1' && (await healthy())) {
    console.log(`guide: reusing the server on ${BASE_URL}`);
    return undefined;
  }
  rmSync(E2E_DIR, { recursive: true, force: true });
  mkdirSync(E2E_DIR, { recursive: true });

  await recreateDb();
  makeToyRepo();
  await Promise.all(
    [
      'pieter@demo.local',
      'maya@demo.local',
      'sam@demo.local',
      'lee@demo.local',
      'jo@demo.local',
      'noor@demo.local',
      'ari@demo.local',
      'platform@demo.local',
      'northwind@demo.local',
      'support@example.com',
    ].map(deleteMailFor),
  );

  // Commits need an identity (backlog #65): the demo workstation owner, so no machine's own git config is read.
  const gitConfig = join(E2E_DIR, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Pieter Demo\n\temail = pieter@demo.local\n');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

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
    // The existing e2e flows were written for the code workflow; new projects default to lean team in production.
    AOM_DEFAULT_WORKFLOW: 'code',
    AOM_TOUR_AUTOSTART: 'false',
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
    { cwd: ROOT, env },
  );

  sh(
    'pnpm',
    [
      '--filter',
      '@aom/server',
      'superadmin:create',
      '--email',
      SUPER_DEMO.email,
      '--name',
      SUPER_DEMO.name,
      '--password',
      SUPER_DEMO.password,
    ],
    { cwd: ROOT, env },
  );

  const log = openSync(paths.serverLog, 'a');
  const server: ChildProcess = spawn('node', [paths.server], {
    env,
    stdio: ['ignore', log, log],
    detached: keep,
  });
  closeSync(log);
  if (keep) server.unref();
  await waitHealthy();
  writeFileSync(paths.pids, JSON.stringify({ server: server.pid }));

  if (keep) return undefined;
  return async () => {
    killAllRunners('SIGTERM');
    server.kill('SIGTERM');
  };
}
