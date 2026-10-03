import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
/** A runner rejection puts the agent on a 30 s cooldown; the tests do not wait for it. */
const reject = async (...a: Parameters<typeof p.reject>) => {
  const s = await p.reject(...a);
  dispatcher().cooldown.clear();
  return s;
};
const desk = async () =>
  (await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }))).items.filter(
    (i: any) => i.subkind === 'test_environment',
  );
const grant = (body: Record<string, unknown>) =>
  ok(
    w.t.req('PATCH', `/api/workstations/${w.workstationId}/devops-access`, { cookie: w.owner.cookie, body }),
  );

async function finishDevopsRequest() {
  await dispatcher().run();
  const start = (await r.waitFor('shift.start', (f) => f.kind === 'devops' && !seen.has(f.shiftId))) as any;
  seen.add(start.shiftId);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'devops running',
  );
  const { reportId } = r.report(start.shiftId, {
    kind: 'outcome',
    outcomeId: 'devops_done',
    note: 'done',
    data: { summary: 'done', commands: ['docker compose up -d'] },
  });
  await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(start.shiftId, 'reported');
  return start;
}
const seen = new Set<string>();

/** Like freshState but keeps the workstation's DevOps engineer (auto-hired at pairing). */
async function freshState() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, devops_requests, runner_commands, runner_inbox CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
}

describe('test environment check before a tester shift', () => {
  it('app not deployed: raises a DevOps request for the card and parks it until DevOps is done', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Needs the app' });
    await p.toTest('Bea', ['Rex']);

    await reject('Tess', 'environment_not_ready', {
      environment: { problem: 'app_not_deployed', detail: 'GET http://localhost:3000 refused' },
    });
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'test',
      status: 'waiting',
      claim_id: null,
      park_problem: 'app_not_deployed',
      env_parks: 1,
    });
    const req = (await q('SELECT * FROM devops_requests WHERE card_id=$1', [card.id]))[0]!;
    expect(req.summary).toMatch(/start the app/i);
    expect(req.requested_by_kind).toBe('system');
    expect(req.id).toBe((await cardRow(card.id)).parked_request_id);
    const d = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(d.testing.parkedOn).toMatchObject({ requestId: req.id, problem: 'app_not_deployed' });

    // parked: the tester is not offered the card meanwhile
    const made = await dispatcher().runPass();
    expect(made.filter((m) => m.cardId === card.id)).toHaveLength(0);

    await finishDevopsRequest();
    await until(
      async () => (await q('SELECT status FROM devops_requests WHERE id=$1', [req.id]))[0]?.status === 'done',
      3000,
      'request done',
    );
    await dispatcher().runPass();
    await until(
      async () =>
        (await cardRow(card.id)).status === 'claimed' || (await cardRow(card.id)).status === 'queued',
      3000,
      'unparked',
    );
    expect((await cardRow(card.id)).parked_request_id).toBeNull();
    const run = await p.run('Tess', testPass());
    expect(run.start.brief.card.ref).toBe(card.ref);
    expect((await cardRow(card.id)).stage).toBe('finalize');
    expect((await cardRow(card.id)).env_parks).toBe(0);
  });

  it('Docker missing and not installable by DevOps: hard stop on the desk as a blocker', async () => {
    await freshState();
    await q('DELETE FROM desk_items');
    await hireTeam(w);
    const card = await w.card({ title: 'Needs docker' });
    await p.toTest('Bea', ['Rex']);
    await reject('Tess', 'environment_not_ready', { environment: { problem: 'docker_missing' } });

    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked', claim_id: null, stage: 'test' });
    expect(await q('SELECT 1 FROM devops_requests WHERE card_id=$1', [card.id])).toHaveLength(0);
    const items = await desk();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'escalation', blocking: true, pinned: true, status: 'open' });
    expect(items[0].title).toMatch(/docker/i);
    expect(items[0].card.ref).toBe(card.ref);

    // the manager fixes it and resolves: the card is back in the queue
    await ok(
      w.t.req('POST', `/api/desk/${items[0].id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'acknowledged' },
      }),
    );
    expect(await cardRow(card.id)).toMatchObject({ status: 'queued' });
  });

  it('Docker missing but DevOps may install it: asks DevOps instead of stopping', async () => {
    await freshState();
    await q('DELETE FROM desk_items');
    await grant({ allowInstall: true, allowDocker: true });
    await hireTeam(w);
    const card = await w.card({ title: 'Docker installable' });
    await p.toTest('Bea', ['Rex']);
    await reject('Tess', 'environment_not_ready', { environment: { problem: 'docker_missing' } });
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', park_problem: 'docker_missing' });
    const req = (await q('SELECT summary FROM devops_requests WHERE card_id=$1', [card.id]))[0]!;
    expect(req.summary).toMatch(/install docker/i);
    expect(await desk()).toHaveLength(0);
    await grant({ allowInstall: false, allowDocker: false });
  });

  it('a second failed attempt is a hard stop too', async () => {
    await freshState();
    await q('DELETE FROM desk_items');
    await hireTeam(w);
    const card = await w.card({ title: 'Never works' });
    await p.toTest('Bea', ['Rex']);
    await reject('Tess', 'environment_not_ready', { environment: { problem: 'app_not_deployed' } });
    await finishDevopsRequest();
    await until(
      async () =>
        (await q('SELECT 1 FROM devops_requests WHERE card_id=$1 AND status=$2', [card.id, 'done']))[0],
      3000,
      'done',
    );
    await dispatcher().runPass();
    await until(async () => (await cardRow(card.id)).status !== 'waiting', 3000, 'unparked');
    await reject('Tess', 'environment_not_ready', { environment: { problem: 'app_not_deployed' } });
    expect((await cardRow(card.id)).status).toBe('waiting');
    await finishDevopsRequest();
    await until(
      async () =>
        (
          await q('SELECT count(*)::int AS n FROM devops_requests WHERE card_id=$1 AND status=$2', [
            card.id,
            'done',
          ])
        )[0]?.n === 2,
      3000,
      'second done',
    );
    await dispatcher().runPass();
    await until(async () => (await cardRow(card.id)).status !== 'waiting', 3000, 'unparked again');
    await reject('Tess', 'environment_not_ready', { environment: { problem: 'app_not_deployed' } });
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
    expect(await desk()).toHaveLength(1);
  });
});
