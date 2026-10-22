import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerPrincipal } from '../src/ceo/engine.ts';
import { moveCard } from '../src/commands/cards.ts';
import { agentActor } from '../src/commands/common.ts';
import { migrateStrandedTestCards, STRANDED_TEST_CARDS_MIGRATION } from '../src/data-migrations/index.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  designed,
  freshKeepDevops,
  handoffEv,
  hireLeanTeam,
  leanAttach,
  leanPipeline,
  planned,
  SHA1,
  verdict,
} from './helpers/lean.ts';
import { cardRow } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code' },
    lean: true,
    integrationTests: 'off',
  });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2', 'runs:3'] });
  p = leanPipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const setMode = (mode: 'off' | 'local') =>
  ok<any>(
    w.t.req('PUT', `/api/projects/${w.projectId}/integration-tests`, {
      cookie: w.owner.cookie,
      body: { settings: { mode } },
    }),
    200,
  );

beforeEach(async () => {
  await freshKeepDevops();
  dispatcher().cooldown.clear();
  await hireLeanTeam(w);
});

/** A card built and pre-reviewed, queued for the reviewer. */
async function cardInReview(mode: 'off' | 'local') {
  await setMode(mode);
  const card = await w.card({ title: `Moves to test (${mode})` });
  await p.run('Pia', planned());
  await p.run('Arc', designed(card.ref));
  await p.runAt('Bea', handoffEv(), leanAttach(SHA1), SHA1);
  await p.runAt('Pre', verdict('approve'), {}, SHA1);
  expect((await cardRow(card.id)).stage).toBe('review');
  return card;
}
const move = (id: string, toStage: string) =>
  w.t.req('POST', `/api/cards/${id}/move`, {
    cookie: w.owner.cookie,
    body: { toStage, reason: 'Reviewed together' },
  });

describe('a card moved straight to Test', () => {
  it('with integration tests off is marked skipped and a tester claims it', async () => {
    const card = await cardInReview('off');
    expect((await move(card.id, 'test')).status).toBe(200);
    const row = await cardRow(card.id);
    expect(row.stage).toBe('test');
    expect(row.test_deploy_state).toBe('skipped');
    const start = await p.next('Tess');
    expect(start.brief.card.ref).toBe(card.ref);
  });

  it('by the CEO (agent actor) is marked skipped too', async () => {
    const card = await cardInReview('off');
    const ceo = (await q('SELECT id FROM agents LIMIT 1'))[0].id as string;
    await moveCard(
      w.t.app.ctx,
      await ownerPrincipal(w.t.app.ctx, w.owner.id),
      card.id,
      'test',
      'moved by the CEO',
      {
        actor: agentActor(ceo),
        by: 'Ceo (CEO)',
      },
    );
    expect((await cardRow(card.id)).test_deploy_state).toBe('skipped');
    const start = await p.next('Tess');
    expect(start.brief.card.ref).toBe(card.ref);
  });

  it('with integration tests on is routed through Test deploy, which starts the environment', async () => {
    const card = await cardInReview('local');
    const res = await move(card.id, 'test');
    expect(res.status).toBe(200);
    expect(res.body.moveNotice).toMatch(/test_deploy/);
    const row = await cardRow(card.id);
    expect(row.stage).toBe('test_deploy');
    expect(row.test_deploy_state).toBeNull();
    await dispatcher().run();
    await r.barrier();
    await until(
      async () => (await q('SELECT 1 FROM run_environments WHERE card_id=$1', [card.id])).length > 0,
      5000,
      'Test deploy to start an environment',
    );
  });

  it('a reopened card goes the same way', async () => {
    const card = await cardInReview('off');
    await q(`UPDATE cards SET status='done', test_deploy_state=NULL WHERE id=$1`, [card.id]);
    const res = await w.t.req('POST', `/api/cards/${card.id}/reopen`, {
      cookie: w.owner.cookie,
      body: { toStage: 'test', reason: 'again' },
    });
    expect(res.status).toBe(200);
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'test', status: 'queued', test_deploy_state: 'skipped' });
  });
});

describe('the stranded-test-cards data migration', () => {
  it('releases queued Test cards with no result when tests are off, leaves the rest, is idempotent and survives a rebuild', async () => {
    const stranded = await cardInReview('off');
    await move(stranded.id, 'test');
    await q('UPDATE cards SET test_deploy_state=NULL WHERE id=$1', [stranded.id]);
    const needsEnv = await cardInReview('off');
    await move(needsEnv.id, 'test');
    await q('UPDATE cards SET test_deploy_state=NULL WHERE id=$1', [needsEnv.id]);
    await setMode('local');
    await q(`UPDATE cards SET fields = fields || '{"integrationTests": true}'::jsonb WHERE id=$1`, [
      needsEnv.id,
    ]);
    await q('DELETE FROM data_migrations WHERE name=$1', [STRANDED_TEST_CARDS_MIGRATION]);
    const env = () => ({
      pool: w.t.app.ctx.pool,
      store: w.t.app.ctx.store,
      clock: w.t.clock,
      log: () => {},
    });
    await q(`UPDATE cards SET fields = fields || '{"integrationTests": false}'::jsonb WHERE id=$1`, [
      stranded.id,
    ]);
    const report = await migrateStrandedTestCards(env());
    const refs = report?.released.map((x) => x.ref) ?? [];
    expect(refs).toContain(stranded.ref);
    expect(refs).not.toContain(needsEnv.ref);
    expect((await cardRow(stranded.id)).test_deploy_state).toBe('skipped');
    expect((await cardRow(needsEnv.id)).test_deploy_state).toBeNull();
    expect(await migrateStrandedTestCards(env())).toBeNull();
    await q('DELETE FROM data_migrations WHERE name=$1', [STRANDED_TEST_CARDS_MIGRATION]);
    expect((await migrateStrandedTestCards(env()))?.released).not.toContain(stranded.ref);
    expect((await cardRow(stranded.id)).test_deploy_state).toBe('skipped');
  });
});
