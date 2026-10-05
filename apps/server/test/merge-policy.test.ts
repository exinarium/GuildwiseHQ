import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { cardRow, DIFF_LARGE, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
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

const setPolicy = (on: boolean, cookie = w.owner.cookie, status = 200) =>
  ok<any>(
    w.t.req('PUT', `/api/projects/${w.projectId}/merge-policy`, {
      cookie,
      body: { mergeLargeWithoutApproval: on },
    }),
    status,
  );
const project = () => ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: w.owner.cookie }));
const desk = () => ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
const finalize = (id: string) =>
  ok<any>(w.t.req('POST', `/api/cards/${id}/finalize`, { cookie: w.owner.cookie, body: {} }));

async function largeCardAtFinalize(title = 'Large one') {
  await freshState();
  await q('UPDATE projects SET merge_large_without_approval=false WHERE id=$1', [w.projectId]);
  await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
  const card = await w.card({ title });
  const outcome = (id: string, data = {}) => ({ kind: 'outcome', outcomeId: id, note: 'ok', data });
  await p.run('Bea', outcome('handoff'), DIFF_LARGE);
  await p.run('Rex', outcome('approve', { score: 4 }));
  await p.run('Ria', outcome('approve', { score: 4 }));
  await p.run('Tess', testPass());
  expect((await cardRow(card.id)).stage).toBe('finalize');
  return card;
}

describe('project setting: merge large changes without the manager', () => {
  it('is off by default; the owner turns it on and off, recorded as an event with who and when', async () => {
    await freshState();
    await q('UPDATE projects SET merge_large_without_approval=false WHERE id=$1', [w.projectId]);
    const before = await project();
    expect(before.project.mergeLargeWithoutApproval).toBe(false);
    expect(before.project.mergeLargeChanged).toBeNull();

    const on = await setPolicy(true);
    expect(on.project.mergeLargeWithoutApproval).toBe(true);
    expect(on.project.mergeLargeChanged).toMatchObject({ byName: expect.any(String) });
    expect(on.mergePolicyHistory).toHaveLength(1);
    expect(on.mergePolicyHistory[0]).toMatchObject({ enabled: true });
    const events = await eventsOfType('ProjectMergePolicyChanged');
    expect(events.at(-1)).toMatchObject({
      projectId: w.projectId,
      mergeLargeWithoutApproval: true,
      changedBy: w.owner.id,
    });

    // setting the same value again records nothing
    await setPolicy(true);
    expect(await eventsOfType('ProjectMergePolicyChanged')).toHaveLength(events.length);

    const off = await setPolicy(false);
    expect(off.project.mergeLargeWithoutApproval).toBe(false);
    expect(off.mergePolicyHistory.map((h: any) => h.enabled)).toEqual([false, true]);
  });

  it('only the project owner may change it: an additional manager gets 403 and nothing changes', async () => {
    await freshState();
    await q('UPDATE projects SET merge_large_without_approval=false WHERE id=$1', [w.projectId]);
    const manager = await addMember(w, 'mgr');
    await setPolicy(true, manager.cookie, 403);
    expect((await project()).project.mergeLargeWithoutApproval).toBe(false);
    // the manager can read it, though
    const seen = await ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie: manager.cookie }));
    expect(seen.project).toMatchObject({ myRole: 'manager', mergeLargeWithoutApproval: false });
    // and it is not settable through the general project PATCH either
    await ok(
      w.t.req('PATCH', `/api/projects/${w.projectId}`, {
        cookie: w.owner.cookie,
        body: { mergeLargeWithoutApproval: true },
      }),
    );
    expect((await project()).project.mergeLargeWithoutApproval).toBe(false);
  });

  it('off (default): a large merge waits for the desk approval', async () => {
    const card = await largeCardAtFinalize();
    const out = await finalize(card.id);
    expect(out.state).toBe('awaiting_approval');
    expect(out.deskItemId).toBeTruthy();
    const d = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(d.testing.finalize.requiresApproval).toBe(true);
  });

  it('on: the same large merge goes straight to the runner and the card timeline says why', async () => {
    const card = await largeCardAtFinalize('Large, owner override');
    await setPolicy(true);
    const from = r.received.length;
    const out = await finalize(card.id);
    expect(out).toMatchObject({ state: 'running', action: 'merge', deskItemId: null });
    expect((await desk()).items.filter((i: any) => i.subkind === 'large_merge')).toHaveLength(0);
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    expect(cmd.payload).toMatchObject({ cardId: card.id, action: 'merge' });
    const d = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(d.testing.finalize.requiresApproval).toBe(false);
    expect(d.activity.map((a: any) => [a.kind, a.summary])).toContainEqual([
      'merge_policy',
      'Large change merged without manager approval (project setting)',
    ]);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc1234567' },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'merged');
    await setPolicy(false);
  });

  it('turning it on leaves an approval already waiting on the desk alone, with a hint; Approve still merges', async () => {
    const card = await largeCardAtFinalize('Large, already waiting');
    const out = await finalize(card.id);
    expect(out.state).toBe('awaiting_approval');
    let item = (await desk()).items.find((i: any) => i.id === out.deskItemId);
    expect(item.hint ?? null).toBeNull();

    await setPolicy(true);
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', finalize_state: 'awaiting_approval' });
    item = (await desk()).items.find((i: any) => i.id === out.deskItemId);
    expect(item.status).toBe('open');
    expect(item.hint).toMatch(/project setting .* now on/);

    const from = r.received.length;
    await ok(
      w.t.req('POST', `/api/desk/${out.deskItemId}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved' },
      }),
    );
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    expect(cmd.payload).toMatchObject({ cardId: card.id, action: 'merge' });
    await setPolicy(false);
  });
});
