import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { approve, cardRow, DIFF_LARGE, DIFF_SMALL, handoff, hireTeam, pipeline } from './helpers/pipeline.ts';
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

const detail = (id: string) =>
  ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie: w.owner.cookie })).then((d) => d.workability);
const tile = async (id: string) => {
  const board = await ok<any>(
    w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
  );
  return board.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === id);
};
const setOnline = (online: boolean) =>
  q('UPDATE workstations SET connected=$2, last_seen_at=$3 WHERE id=$1', [
    w.workstationId,
    online,
    w.t.clock.now(),
  ]);

describe('card workability (could any agent ever take the current stage)', () => {
  it('no builder hired: blocked, with what to hire; a hired builder makes it ok', async () => {
    await freshState();
    await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({ title: 'Nobody builds me' });
    const wk = await detail(card.id);
    expect(wk).toMatchObject({ ok: false, level: 'blocked', hire: { roleKey: 'builder' } });
    expect(wk.reason).toMatch(/^Not workable: no builder is hired/);
    expect((await tile(card.id)).workability).toMatchObject({ ok: false, level: 'blocked' });
    await w.hire('Bea', 'builder', 'junior');
    expect((await detail(card.id)) ?? { ok: true }).toMatchObject({ ok: true });
    expect((await tile(card.id)).workability).toBeUndefined();
  });

  it('one senior reviewer and a large card: blocked before and after the first review', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Big, one reviewer' });
    await p.run('Bea', handoff(), DIFF_LARGE);
    const before = await detail(card.id);
    expect(before).toMatchObject({
      ok: false,
      level: 'blocked',
      hire: { roleKey: 'reviewer', seniority: 'senior' },
    });
    expect(before.reason).toMatch(/needs 2 different senior reviewers/);

    await p.run('Rex', approve());
    const after = await detail(card.id);
    expect(after.reason).toBe(
      'Not workable: this large change needs a second senior reviewer other than Rex. Hire another senior reviewer.',
    );
    expect((await tile(card.id)).workability.level).toBe('blocked');

    // hiring a second reviewer clears it, live: the next read says ok
    await w.hire('Ria', 'reviewer', 'senior');
    expect((await detail(card.id))?.ok ?? true).toBe(true);
    expect((await tile(card.id)).workability).toBeUndefined();
  });

  it('a small card with one reviewer is fine', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Tiny' });
    await p.run('Bea', handoff(), DIFF_SMALL);
    expect((await cardRow(card.id)).stage).toBe('review');
    expect((await detail(card.id))?.ok ?? true).toBe(true);
  });

  it('junior-only reviewers cannot do a senior-only stage', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Needs a senior' });
    await p.run('Bea', handoff(), DIFF_SMALL);
    await q(`UPDATE agents SET seniority='junior' WHERE name='Rex'`);
    const wk = await detail(card.id);
    expect(wk).toMatchObject({
      ok: false,
      level: 'blocked',
      hire: { roleKey: 'reviewer', seniority: 'senior' },
    });
    expect(wk.reason).toMatch(/needs a senior reviewer, but only junior ones are hired \(Rex\)/);
  });

  it("the only reviewer is the card's builder: blocked", async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Built by the reviewer' });
    await p.run('Bea', handoff(), DIFF_SMALL);
    const [rex] = await q(`SELECT id FROM agents WHERE name='Rex'`);
    await q('UPDATE cards SET original_builder_agent_id=$2, excluded_agent_ids=ARRAY[$2::uuid] WHERE id=$1', [
      card.id,
      rex?.id,
    ]);
    const wk = await detail(card.id);
    expect(wk).toMatchObject({ ok: false, level: 'blocked' });
    expect(wk.reason).toMatch(/built this card and cannot review their own work/);
  });

  it('agents exist but are offline: waiting (softer), naming them', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Waiting for Bea' });
    await setOnline(false);
    const wk = await detail(card.id);
    expect(wk).toMatchObject({ ok: false, level: 'waiting', reason: 'Waiting: Builder Bea is offline.' });
    expect(wk.hire).toBeUndefined();
    await setOnline(true);
    expect((await detail(card.id))?.ok ?? true).toBe(true);
  });

  it("agents exist but no workstation holds the card's repo: waiting", async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Repo missing' });
    await q('DELETE FROM workstation_repos WHERE workstation_id=$1', [w.workstationId]);
    const wk = await detail(card.id);
    expect(wk).toMatchObject({ ok: false, level: 'waiting' });
    expect(wk.reason).toMatch(/^Waiting: no workstation with an eligible builder holds repo /);
    await q(
      `INSERT INTO workstation_repos (workstation_id, project_repo_id, local_path, reported_at) VALUES ($1,$2,'/tmp/x',now())`,
      [w.workstationId, w.repoId],
    );
    expect((await detail(card.id))?.ok ?? true).toBe(true);
  });

  it('busy agents are reported only after the card waited a while', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Everyone busy' });
    const other = await w.card({ title: 'Occupies Bea' });
    await q(
      `UPDATE cards SET status='claimed', claim_id=gen_random_uuid(), claimed_by_agent_id=(SELECT id FROM agents WHERE name='Bea') WHERE id=$1`,
      [other.id],
    );
    expect((await detail(card.id))?.ok ?? true).toBe(true);
    await q(`UPDATE cards SET queued_at = now() - interval '30 minutes' WHERE id=$1`, [card.id]);
    expect(await detail(card.id)).toMatchObject({ ok: false, level: 'waiting' });
    expect((await detail(card.id)).reason).toMatch(/Bea is busy/);
  });

  it('claimed and finished cards carry no workability', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Claimed' });
    await until(async () => (await cardRow(card.id)).status !== 'draft', 1000, 'queued').catch(() => {});
    await q(`UPDATE cards SET status='done' WHERE id=$1`, [card.id]);
    expect(await detail(card.id)).toBeUndefined();
  });
});
