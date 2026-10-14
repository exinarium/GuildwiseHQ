import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratePushBranchRetired, PUSH_BRANCH_RETIRED_MIGRATION } from '../src/data-migrations/index.ts';
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
const asPushBranch = (id: string) => q(`UPDATE cards SET completion_action='push_branch' WHERE id=$1`, [id]);

describe('push_branch is retired (backlog #61)', () => {
  it('the commands refuse it', async () => {
    const create = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: {
        projectId: w.projectId,
        title: 'Retired',
        cardType: 'feature',
        completionAction: 'push_branch',
      },
    });
    expect(create.status).toBe(400);
    const card = await w.card({ title: 'Patch target', completionAction: 'pr' });
    const patch = await w.t.req('PATCH', `/api/cards/${card.id}`, {
      cookie: w.owner.cookie,
      body: { completionAction: 'push_branch' },
    });
    expect(patch.status).toBe(400);
    const project = await w.t.req('PATCH', `/api/projects/${w.projectId}`, {
      cookie: w.owner.cookie,
      body: { defaultCompletion: 'push_branch' },
    });
    expect(project.status).toBe(400);
    expect(await action(card.id)).toBe('pr');
  });

  it('a card that still carries it follows the project instead', async () => {
    const card = await w.card({ title: 'Legacy carrier', completionAction: 'pr' });
    await asPushBranch(card.id);
    const shown = await w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie });
    expect(shown.body.card.effectiveCompletionAction).toBe('merge');
    expect(shown.body.card.completionActionSource).toBe('project');
  });

  it('the data migration clears open cards, keeps closed ones, is idempotent and survives a rebuild', async () => {
    await q('DELETE FROM data_migrations WHERE name=$1', [PUSH_BRANCH_RETIRED_MIGRATION]);
    const open = await w.card({ title: 'Open with push_branch', completionAction: 'pr' });
    const other = await w.card({ title: 'Open with pr', completionAction: 'pr' });
    const done = await w.card({ title: 'Done with push_branch', completionAction: 'pr' });
    const cancelled = await w.card({ title: 'Cancelled with push_branch', completionAction: 'pr' });
    for (const c of [open, done, cancelled]) await asPushBranch(c.id);
    await q(`UPDATE cards SET status='done' WHERE id=$1`, [done.id]);
    await q(`UPDATE cards SET status='cancelled' WHERE id=$1`, [cancelled.id]);
    // earlier test cards that still carry the value are cleared too: assert on ours
    const report = await migratePushBranchRetired(env());
    expect(report?.cleared.map((c) => c.ref)).toContain(open.ref);
    expect(report?.cleared.map((c) => c.ref)).not.toContain(done.ref);
    expect(report?.cleared.map((c) => c.ref)).not.toContain(cancelled.ref);
    expect(await action(open.id)).toBeNull();
    expect(await action(other.id)).toBe('pr');
    expect(await action(done.id)).toBe('push_branch');
    expect(await action(cancelled.id)).toBe('push_branch');
    const ev = await q(
      `SELECT payload, actor_kind FROM events WHERE type='CardUpdated' AND stream_id=$1 ORDER BY seq DESC LIMIT 1`,
      [`card-${open.id}`],
    );
    expect(ev[0]?.payload).toMatchObject({ changes: { completionAction: null } });
    expect(String(ev[0]?.payload.reason)).toMatch(/push_branch completion action was retired/);
    expect(ev[0]?.actor_kind).toBe('system');
    expect(
      await q('SELECT 1 FROM data_migrations WHERE name=$1', [PUSH_BRANCH_RETIRED_MIGRATION]),
    ).toHaveLength(1);

    // A second boot does nothing, even for a card given the value afterwards.
    await asPushBranch(other.id);
    expect(await migratePushBranchRetired(env())).toBeNull();
    expect(await action(other.id)).toBe('push_branch');
    await q(`UPDATE cards SET completion_action='pr' WHERE id=$1`, [other.id]);

    // Old events stay readable: a rebuild reproduces the cleared card and the closed ones.
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await action(open.id)).toBeNull();
  });
});
