import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { BASE_URL, paths } from '../../support/env.ts';

/**
 * Restarts the e2e server the way a redeploy does: stop it, start the same binary again with the SAME environment (read
 * back from /proc, so nothing of the global setup is repeated or guessed). The new pid replaces the old one in pids.json,
 * where the global teardown and combined.sh look for it.
 */
export async function respawnServer(): Promise<void> {
  const pids = JSON.parse(readFileSync(paths.pids, 'utf8')) as { server: number };
  const old = pids.server;
  const env: NodeJS.ProcessEnv = {};
  for (const kv of readFileSync(`/proc/${old}/environ`, 'utf8').split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  process.kill(old, 'SIGTERM');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(old, 0);
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const log = openSync(paths.serverLog, 'a');
  const child = spawn('node', [paths.server], { env, stdio: ['ignore', log, log], detached: true });
  closeSync(log);
  child.unref();
  writeFileSync(paths.pids, JSON.stringify({ ...pids, server: child.pid }));
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${BASE_URL}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the restarted server did not become healthy; see ${paths.serverLog}`);
}
