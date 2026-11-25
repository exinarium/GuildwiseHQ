import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Runner, type RunnerOptions } from '../src/runner.ts';
import { FakeServer, type FakeServerOptions } from './fake-server.ts';
import { makeShiftStart, type ShiftOptions } from './fixtures.ts';
import { makeConfig, makeRepo, type TestRepo, tmp, waitUntil } from './helpers.ts';
import { grantedAuthority } from './test-authority.ts';

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
  // a workstation set up and granted locally (R18-S); the local-authority tests pass their own `authority`
  const runner = new Runner({
    config,
    dataDir,
    exitGraceMs: 5000,
    authority: grantedAuthority(),
    policyDir: tmp('aom-policy-'),
    ...runnerOpts,
  });
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
      // shift.ended goes out before the shift's temp cleanup; wait for that to finish too
      await runner.supervisor.whenSettled(shiftId);
      return { shiftId, ended };
    },
    async stop() {
      await runner.stop();
      await server.close();
    },
  };
}

/** The card's worktree: `worktrees/<KEY>-<project>/<REF>` (the project id keeps same-keyed projects apart). */
export const worktreeOf = (h: Harness, key = 'TOY', ref = 'TOY-1'): string => {
  const root = join(h.dataDir, 'worktrees');
  const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith(`${key}-`)) : undefined;
  return join(root, dir ?? key, ref);
};

/**
 * quiet-approvals: the runtime has no DevOps box at all (fail closed), so a DevOps request takes the
 * held path as before: for the tests of that path (one held item per request, a local no, ...).
 */
export function noBox(h: Harness): void {
  const adapters = (h.runner as unknown as { adapters: Map<string, { boxMissing?: () => string | null }> })
    .adapters;
  // a runtime with no box at all (Rework 1: one whose box cannot start is refused instead, with the reason)
  for (const a of adapters.values()) (a as { boxMissing?: unknown }).boxMissing = undefined;
}
