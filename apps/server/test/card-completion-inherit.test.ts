import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CARD_COMPLETION_INHERIT_MIGRATION,
  migrateCardCompletionInherit,
} from '../src/data-migrations/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const env = () => ({ pool: w.t.app.ctx.pool, store: w.t.app.ctx.store, clock: w.t.clock, log: () => {} });
const action = async (id: string) =>
  (await q('SELECT completion_action FROM cards WHERE id=$1', [id]))[0]?.completion_action;

describe('card-completion-inherit-2026-10', () => {
  it('clears the card-level value on open cards, keeps closed cards, is idempotent and survives a rebuild', async () => {
    await q('DELETE FROM data_migrations WHERE name=$1', [CARD_COMPLETION_INHERIT_MIGRATION]);
    const open = await w.card({ title: 'Open with pr', completionAction: 'pr' });
    const inheriting = await w.card({ title: 'Already inherits', completionAction: undefined });
    const done = await w.card({ title: 'Finished with pr', completionAction: 'pr' });
    const cancelled = await w.card({ title: 'Cancelled with push', completionAction: 'pr' });
    await q(`UPDATE cards SET completion_action='push_branch' WHERE id=$1`, [cancelled.id]);
    await q(`UPDATE cards SET status='done' WHERE id=$1`, [done.id]);
    await q(`UPDATE cards SET status='cancelled' WHERE id=$1`, [cancelled.id]);

    const report = await migrateCardCompletionInherit(env());
    expect(report?.cleared).toEqual([{ ref: open.ref, was: 'pr' }]);
    expect(await action(open.id)).toBeNull();
    expect(await action(inheriting.id)).toBeNull();
    expect(await action(done.id)).toBe('pr');
    expect(await action(cancelled.id)).toBe('push_branch');
    const ev = await q(
      `SELECT payload, actor_kind FROM events WHERE type='CardUpdated' AND stream_id=$1 ORDER BY seq DESC LIMIT 1`,
      [`card-${open.id}`],
    );
    expect(ev[0]?.payload).toMatchObject({
      changes: { completionAction: null },
      reason: 'follow the project default',
    });
    expect(ev[0]?.actor_kind).toBe('system');
    const rec = await q('SELECT summary FROM data_migrations WHERE name=$1', [
      CARD_COMPLETION_INHERIT_MIGRATION,
    ]);
    expect(rec).toHaveLength(1);

    // A second boot does nothing, even for a card given an override afterwards.
    await q(`UPDATE cards SET completion_action='merge' WHERE id=$1`, [inheriting.id]);
    expect(await migrateCardCompletionInherit(env())).toBeNull();
    expect(await action(inheriting.id)).toBe('merge');

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await action(open.id)).toBeNull();
    expect(await action(done.id)).toBe('pr');
  });
});
