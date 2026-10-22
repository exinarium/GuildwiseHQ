import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * A sub-pass of the dispatcher that throws must not skip `sendShiftStart` for the claims already made in the same pass
 * (production, Oct 15-16: 1,563 `runner_rejected` releases after a throw in one of the later passes).
 */
vi.mock('../src/dispatcher/ba-tasks.ts', () => ({
  baTaskPass: async () => {
    throw new Error('ba task pass blew up');
  },
}));
vi.mock('../src/dispatcher/bottleneck.ts', async (orig) => ({
  ...(await orig<typeof import('../src/dispatcher/bottleneck.ts')>()),
  testingPass: async () => {
    throw new Error('testing pass blew up');
  },
}));

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('dispatcher sub-passes', () => {
  it('still sends the shift start for a claim made before a later sub-pass throws', async () => {
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Claimed before the throw' });
    const start = await shiftHelpers(w).dispatchTo(r, 'Bea');
    expect(start.brief.card.id).toBe(card.id);
    const row = (await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(row.status).toBe('claimed');
    // and the claim was not released by the reaper's runner_rejected path
    expect(
      await q(`SELECT 1 FROM events WHERE type='ClaimReleased' AND payload->>'cardId'=$1`, [card.id]),
    ).toHaveLength(0);
  });
});
