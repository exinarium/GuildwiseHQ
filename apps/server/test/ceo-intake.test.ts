import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, appoint, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

/** `aom ceo act intake` (docs/design/ceo-front-door.md 2.4): card type, ticket, priority, and a BA task for what is missing. */
let w: World;
let r: FakeRunner;
let shiftId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};
const text = 'Customers cannot reset their password from the mobile app.\nThe link opens a blank page.';

describe('intake', () => {
  it('without a BA the card is drafted and the CEO is told to recommend hiring one: not a refusal', async () => {
    const res = result(await act(r, shiftId, 'intake', { project: 'TOY', text }, { key: 'no-ba' }));
    expect(res.status, JSON.stringify(res)).toBe('executed');
    expect(res.message).toContain('Recommend hiring a BA');
    expect(res.result).toMatchObject({ specified: false, baQueued: false });
    const card = (await q(`SELECT * FROM cards WHERE id=$1`, [res.result.cardId]))[0]!;
    expect(card).toMatchObject({ status: 'draft', card_type: 'feature' });
    expect(await q(`SELECT 1 FROM ba_tasks WHERE card_id=$1`, [card.id])).toHaveLength(0);
  });

  it('takes a card type, an external ticket and a priority, and queues the BA task that completes the draft', async () => {
    await w.hire('Ben', 'ba', 'senior');
    const res = result(
      await act(
        r,
        shiftId,
        'intake',
        {
          project: 'TOY',
          text,
          cardType: 'bug',
          ticket: 'SUP-1234',
          priority: 3,
          title: 'Password reset is blank',
        },
        { key: 'bug-1' },
      ),
    );
    expect(res.status, JSON.stringify(res)).toBe('executed');
    expect(res.message).toContain('sent to the BA to complete');
    expect(res.result).toMatchObject({ specified: false, baQueued: true });
    const card = (await q(`SELECT * FROM cards WHERE id=$1`, [res.result.cardId]))[0]!;
    expect(card).toMatchObject({
      card_type: 'bug',
      priority: 3,
      title: 'Password reset is blank',
      status: 'draft',
    });
    expect(card.fields).toMatchObject({ context: text, externalRef: 'SUP-1234' });
    const tasks = await q(`SELECT * FROM ba_tasks WHERE card_id=$1`, [card.id]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'spec_card', status: 'queued', project_id: w.projectId });
  });

  it('keeps `feature` as the default card type and still cancels the draft on undo', async () => {
    const res = result(await act(r, shiftId, 'intake', { project: 'TOY', text }, { key: 'feature-1' }));
    const card = (await q(`SELECT * FROM cards WHERE id=$1`, [res.result.cardId]))[0]!;
    expect(card.card_type).toBe('feature');
    expect(card.priority).toBe(5);
    expect(card.fields.externalRef).toBeUndefined();
    const undo = await w.t.req('POST', `/api/ceo/actions/${res.actionId}/undo`, { cookie: w.owner.cookie });
    expect(undo.status).toBe(200);
    expect((await q(`SELECT status FROM cards WHERE id=$1`, [card.id]))[0]!.status).toBe('cancelled');
  });

  it('refuses an unknown project and a card type that does not exist', async () => {
    const bad = await act(r, shiftId, 'intake', { project: 'NOPE', text }, { key: 'bad-project' });
    expect(bad.result?.status ?? bad.status).toBe('refused');
    const worse = await act(
      r,
      shiftId,
      'intake',
      { project: 'TOY', text, cardType: 'epic' },
      { key: 'bad-type' },
    );
    expect(worse.result?.status ?? worse.status).toBe('refused');
    expect(JSON.stringify(worse)).toMatch(/cardType|invalid/i);
  });
});
