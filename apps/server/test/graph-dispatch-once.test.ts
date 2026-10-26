import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchGraphCommand } from '../src/commands/graph.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('a full index is asked once while one waits', () => {
  it('callers that arrive at the same moment (hello pass, vault registered) queue one graph.index, not one each', async () => {
    r = await w.connectRunner();
    await until(
      async () => (await q(`SELECT 1 FROM runner_commands WHERE type='graph.index'`)).length >= 1,
      4000,
      'first graph.index',
    );
    // let the connect pass settle, then clear the way: nothing waits any more
    await r.barrier();
    await q(`UPDATE runner_commands SET status='done' WHERE type='graph.index'`);
    const ctx = w.t.app.ctx;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => dispatchGraphCommand(ctx, w.projectId, w.repoId)),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE type='graph.index' AND status IN ('pending','sent')`),
    ).toHaveLength(1);
  });
});
