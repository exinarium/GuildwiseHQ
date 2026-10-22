import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, appoint, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** A project with one repository (or none) behaves exactly as before repository scoping: nobody finds a repository. */
let w: World;
let r: FakeRunner;
const text = 'Customers cannot reset their password from the mobile app.\nThe link opens a blank page.';

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await wakeNow(w);
  await w.hire('Ben', 'ba', 'senior');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('a single-repository project', () => {
  it('takes its only repository; findRepo changes nothing and no BA task is queued', async () => {
    const res = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'Plain draft',
          cardType: 'feature',
          fields: { context: text },
          specify: true,
          findRepo: true,
        },
      }),
      201,
    );
    expect(res.specified).toBe(false);
    expect(res.message).toContain('required fields are missing');
    expect(res.message).not.toContain('repository');
    const [card] = await q('SELECT * FROM cards WHERE id=$1', [res.card.id]);
    expect(card).toMatchObject({ status: 'draft', repo_id: w.repoId });
    expect(await q('SELECT 1 FROM ba_tasks WHERE card_id=$1', [res.card.id])).toHaveLength(0);
  });

  it('intake queues the plain spec_card task: no repository mode', async () => {
    const { shiftId } = await startCeoShift(w, r);
    const res = (await act(r, shiftId, 'intake', { project: 'TOY', text }, { key: 'single-1' })).result;
    expect(res.message).toContain('sent to the BA to complete');
    expect(res.message).not.toContain('find the repository');
    const { buildSpecCardTask } = await import('../src/commands/spec-card.ts');
    const [task] = await q('SELECT * FROM ba_tasks WHERE card_id=$1', [res.result.cardId]);
    const built = await buildSpecCardTask(w.t.app.ctx.pool, task!);
    expect(built).not.toBeNull();
    expect(built!.chooseRepo).toBeUndefined();
    expect(built!.repos).toBeUndefined();
    expect(built!.missing).not.toContain('repoId');
  });

  it('a draft whose repository is gone still waits for a person: no BA task', async () => {
    const { shiftId } = await startCeoShift(w, r);
    const card = await w.card({ title: 'Lost its repo', fields: { context: 'x' }, specify: false });
    await q(`UPDATE cards SET repo_id=NULL WHERE id=$1`, [card.id]);
    const res = (await act(r, shiftId, 'specify', { card: card.ref }, { key: 'single-2' })).result;
    expect(res.message).toMatch(/repository/);
    expect(res.message).toContain('only a person can add');
    expect(await q('SELECT 1 FROM ba_tasks WHERE card_id=$1', [card.id])).toHaveLength(0);
  });

  it('a project whose second repository was removed counts as a single-repository project', async () => {
    const added = await ok<any>(
      w.t.req('POST', `/api/projects/${w.projectId}/repos`, {
        cookie: w.owner.cookie,
        body: { name: 'extra', remoteUrl: 'https://github.com/acme/extra.git' },
      }),
      201,
    );
    const extra = added.repos.find((x: any) => x.name === 'extra').id;
    await q(`UPDATE project_repos SET removed_at=now() WHERE id=$1`, [extra]);
    const card = await w.card({ title: 'One repo left', fields: { context: 'x' }, specify: false });
    await q(`UPDATE cards SET repo_id=NULL WHERE id=$1`, [card.id]);
    const { needsRepoScoping } = await import('../src/commands/card-repo.ts');
    const [row] = await q('SELECT * FROM cards WHERE id=$1', [card.id]);
    expect(await needsRepoScoping(w.t.app.ctx.pool, row!)).toBe(false);
  });
});
