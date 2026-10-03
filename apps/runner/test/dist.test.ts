import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { FakeServer } from './fake-server.ts';
import { makeShiftStart } from './fixtures.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';

cleanupTmp();
const dist = join(import.meta.dirname, '..', 'dist');
const built =
  existsSync(join(dist, 'aom-runner.mjs')) &&
  existsSync(join(dist, 'aom.mjs')) &&
  existsSync(join(dist, 'mock-agent.mjs'));

/** Runs the bundled binaries (what the E2E lane and users run). Skipped until `pnpm build` has produced dist/. */
describe.skipIf(!built)('bundled runner (dist/)', () => {
  it('pair + start + a mock build shift through the shim and dist/aom.mjs', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    const repo = makeRepo();
    const node = process.execPath;
    const bin = join(dist, 'aom-runner.mjs');
    await execa(node, [
      bin,
      'pair',
      '--server',
      server.url,
      '--code',
      'ABCD-EFGH',
      '--data-dir',
      dir,
      '--mock',
    ]);
    await execa(node, [bin, 'repos', 'add', repo.scanRoot, '--data-dir', dir]);
    const child = execa(node, [bin, 'start', '--data-dir', dir], { reject: false });
    try {
      await server.waitFor('hello');
      const msg = makeShiftStart({ remoteNormalized: repo.remoteNormalized });
      server.send('shift.start', msg);
      const ended = await server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 30_000);
      expect(ended.outcome).toBe('reported');
      expect(server.of('shift.report')[0]?.diffStats?.files).toBe(2);
    } finally {
      child.kill('SIGTERM');
      await child;
      await server.close();
    }
  }, 60_000);
});
