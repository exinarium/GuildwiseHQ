import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import { act, appoint, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** A queued `spec_card` BA task for a card that was cancelled meanwhile is dropped at dispatch (front door step 0 leftover). */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await wakeNow(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('spec_card tasks', () => {
  it('are dropped when their card was cancelled while they waited, and run when it was not', async () => {
    const { shiftId } = await startCeoShift(w, r);
    await w.hire('Ben', 'ba', 'senior');
    const text = 'Customers cannot reset their password from the mobile app.\nThe link opens a blank page.';
    const make = async (key: string) => {
      const res = (await act(r, shiftId, 'intake', { project: 'TOY', text }, { key })).result;
      expect(res.result.baQueued, JSON.stringify(res)).toBe(true);
      return res.result.cardId as string;
    };
    const cancelled = await make('spec-1');
    const live = await make('spec-2');
    await ok(
      w.t.req('POST', `/api/cards/${cancelled}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'not needed' },
      }),
    );
    const queued = async (cardId: string) =>
      (await q('SELECT * FROM ba_tasks WHERE card_id=$1', [cardId]))[0]!;
    expect((await queued(cancelled)).status).toBe('queued');
    await baTaskPass(w.t.app.ctx);
    expect(await queued(cancelled)).toMatchObject({ status: 'cancelled' });
    expect((await queued(cancelled)).note).toContain('cancelled');
    // the other task is untouched (it waits for a BA that is online)
    expect((await queued(live)).status).not.toBe('cancelled');
  });
});
