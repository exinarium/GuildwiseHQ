import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { cardRow, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
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

const setSuite = (enabled: boolean, cookie = w.owner.cookie, status = 200) =>
  ok<any>(w.t.req('PUT', `/api/projects/${w.projectId}/full-suite`, { cookie, body: { enabled } }), status);
const project = () => ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));

async function finalizeOne(title: string) {
  await freshState();
  await hireTeam(w);
  const card = await w.card({ title });
  await p.toTest('Bea', ['Rex']);
  await p.run('Tess', testPass());
  const from = r.received.length;
  await ok(w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
  const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
  r.send('command.result', {
    commandId: cmd.commandId,
    ok: true,
    result: { ok: true, action: 'merge', mergeCommit: 'a1b2c3d' },
  });
  await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'finalized');
  return card;
}

describe('project setting: full E2E suite after each finished card', () => {
  it('is on by default; the owner switches it off and on', async () => {
    await freshState();
    expect((await project()).project.fullSuiteAfterFinalize).toBe(true);
    expect((await setSuite(false)).project.fullSuiteAfterFinalize).toBe(false);
    expect(await eventsOfType('ProjectFullSuiteSet')).toHaveLength(1);
    expect((await setSuite(false)).project.fullSuiteAfterFinalize).toBe(false);
    expect(await eventsOfType('ProjectFullSuiteSet')).toHaveLength(1);
    expect((await setSuite(true)).project.fullSuiteAfterFinalize).toBe(true);
  });

  it('an additional manager (not Owner or Admin of the organization) cannot change it', async () => {
    await freshState();
    const manager = await addMember(w, 'mgr');
    await setSuite(false, manager.cookie, 403);
    expect((await project()).project.fullSuiteAfterFinalize).toBe(true);
  });

  it('on: finalizing spawns the suite card; off: it does not', async () => {
    await setSuite(true);
    const on = await finalizeOne('With suite');
    expect(
      await q('SELECT 1 FROM cards WHERE parent_card_id=$1 AND origin=$2', [on.id, 'full_suite']),
    ).toHaveLength(1);

    await setSuite(false);
    const off = await finalizeOne('Without suite');
    expect(
      await q('SELECT 1 FROM cards WHERE parent_card_id=$1 AND origin=$2', [off.id, 'full_suite']),
    ).toHaveLength(0);
    expect((await eventsOfType('FullSuiteStarted')).filter((e) => e.cardId === off.id)).toHaveLength(0);
    await setSuite(true);
  });
});
