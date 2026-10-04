import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { FakeServer } from './fake-server.ts';
import { makeShiftStart } from './fixtures.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';

const require = createRequire(import.meta.url);
cleanupTmp();
const dist = join(import.meta.dirname, '..', 'dist');
const built =
  existsSync(join(dist, 'aom-runner.mjs')) &&
  existsSync(join(dist, 'aom.mjs')) &&
  existsSync(join(dist, 'mock-agent.mjs'));

/** Runs the bundled binaries (what the E2E lane and users run). Skipped until `pnpm build` has produced dist/. */
describe.skipIf(!built)('bundled runner (dist/)', () => {
  // An agent's `aom ... | head` stays inside Claude Code's shell sandbox, where node_modules under /home is
  // unreadable; a real BA shift failed with "Cannot find package 'zod'". dist/aom.mjs must stand alone.
  it('dist/aom.mjs imports only node built-ins and runs from a directory with no node_modules', async () => {
    const src = readFileSync(join(dist, 'aom.mjs'), 'utf8');
    const specifiers = [...src.matchAll(/^import\s[^;]*?from\s*["']([^"']+)["']/gm)].map(
      (m) => m[1] as string,
    );
    const nodeBuiltins = new Set(require('node:module').builtinModules as string[]);
    const bare = specifiers.filter((sp) => !sp.startsWith('node:') && !nodeBuiltins.has(sp));
    expect(bare).toEqual([]);
    const dir = tmp();
    copyFileSync(join(dist, 'aom.mjs'), join(dir, 'aom.mjs'));
    const r = await execa('node', [join(dir, 'aom.mjs'), 'ledger', 'search', 'x'], {
      cwd: dir,
      reject: false,
      env: {
        PATH: process.env.PATH ?? '',
        AOM_IPC_URL: 'http://127.0.0.1:1',
        AOM_SHIFT_TOKEN: 't',
        AOM_IPC_SOCKET: join(dir, 'none.sock'),
      },
      extendEnv: false,
    });
    expect(r.stderr).not.toMatch(/Cannot find (package|module)/);
    expect(r.stderr).toContain('Run aom as a standalone command');
  });

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
