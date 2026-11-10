import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { killFakeServers } from './runner.ts';

const exited = (c: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    c.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });

test('killFakeServers stops the web servers that serve a folder in the dir, nothing else', {
  skip: process.platform !== 'linux',
}, async () => {
  const base = mkdtempSync(join(tmpdir(), 'aom-e2e-unit-'));
  const dir = join(base, 'e2e');
  const other = join(base, 'other');
  for (const d of [join(dir, 'www'), join(other, 'www')]) mkdirSync(d, { recursive: true });
  const serve = (root: string) =>
    spawn('python3', ['-m', 'http.server', '0', '--bind', '127.0.0.1', '--directory', root], {
      stdio: 'ignore',
    });
  const inDir = serve(join(dir, 'www'));
  const elsewhere = serve(join(other, 'www'));
  // not a web server, though its command line names the dir (a `tail -f` of a log, say)
  const reader = spawn('sh', ['-c', 'sleep 30; true', join(dir, 'server.log')], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(killFakeServers(dir), 1);
    assert.equal(await exited(inDir, 5000), true);
    assert.equal(await exited(elsewhere, 300), false);
    assert.equal(await exited(reader, 300), false);
  } finally {
    for (const c of [inDir, elsewhere, reader]) c.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});
