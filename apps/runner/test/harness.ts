import { join } from 'node:path';
import { Runner, type RunnerOptions } from '../src/runner.ts';
import { FakeServer, type FakeServerOptions } from './fake-server.ts';
import { makeShiftStart, type ShiftOptions } from './fixtures.ts';
import { makeConfig, makeRepo, type TestRepo, tmp, waitUntil } from './helpers.ts';

export interface Harness {
  server: FakeServer;
  runner: Runner;
  repo: TestRepo;
  dataDir: string;
  /** Sends a shift.start and resolves with its `shift.ended` message. */
  runShift(
    o: Omit<ShiftOptions, 'remoteNormalized'>,
  ): Promise<{ shiftId: string; ended: import('@aom/shared').RunnerToServerOf<'shift.ended'> }>;
  stop(): Promise<void>;
}

export async function startHarness(
  serverOpts: FakeServerOptions = {},
  runnerOpts: Partial<RunnerOptions> = {},
  repo: TestRepo = makeRepo(),
): Promise<Harness> {
  const server = await FakeServer.start(serverOpts);
  const dataDir = tmp('aom-data-');
  const config = makeConfig(server.url, { repoRoots: [repo.scanRoot] });
  const runner = new Runner({ config, dataDir, exitGraceMs: 5000, ...runnerOpts });
  await runner.start();
  await waitUntil(() => server.helloCount > 0 && runner.client.isReady, 10_000, 'runner welcome');
  return {
    server,
    runner,
    repo,
    dataDir,
    async runShift(o) {
      const msg = makeShiftStart({ ...o, remoteNormalized: repo.remoteNormalized });
      const shiftId = msg.shiftId as string;
      server.send('shift.start', msg);
      const ended = await server.waitFor('shift.ended', (m) => m.shiftId === shiftId, 60_000);
      return { shiftId, ended };
    },
    async stop() {
      await runner.stop();
      await server.close();
    },
  };
}

export const worktreeOf = (h: Harness, key = 'TOY', ref = 'TOY-1') => join(h.dataDir, 'worktrees', key, ref);
