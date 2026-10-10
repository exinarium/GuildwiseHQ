import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const tileOf = async (cardId: string) => {
  const board = await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }));
  return board.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === cardId);
};
const orgId = async () => (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;

describe('board card notices (T1)', () => {
  it('a plain card carries none of the new fields', async () => {
    const card = await w.card({ title: 'Plain' });
    const t = await tileOf(card.id);
    expect(t.blockedReason ?? null).toBeNull();
    expect(t.hygiene).toBeUndefined();
    expect(t.budget).toBeUndefined();
  });

  it('a blocked card names the open desk item holding it', async () => {
    const card = await w.card({ title: 'Held' });
    const item = randomUUID();
    await q(
      `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, title, blocking, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'question','Which database should it use?',true,now(),now())`,
      [item, await orgId(), w.projectId, card.id],
    );
    await q('INSERT INTO card_blockers (card_id, desk_item_id) VALUES ($1,$2)', [card.id, item]);
    await q(`UPDATE cards SET status='blocked', blocked_since=now() WHERE id=$1`, [card.id]);
    const t = await tileOf(card.id);
    expect(t.blocked).toBe(true);
    expect(t.blockedReason).toMatchObject({
      deskItemId: item,
      kind: 'question',
      title: 'Which database should it use?',
      others: 0,
    });
    // answered items no longer explain anything
    await q(`UPDATE desk_items SET status='answered' WHERE id=$1`, [item]);
    expect((await tileOf(card.id)).blockedReason ?? null).toBeNull();
  });

  it('a card shows the open hygiene findings of its repository, not resolved ones', async () => {
    const card = await w.card({ title: 'Dirty repo' });
    await q('UPDATE cards SET repo_id=$2 WHERE id=$1', [card.id, w.repoId]);
    await q(
      `INSERT INTO hygiene_findings (id, org_id, workstation_id, project_id, subject, subject_name, kind, detail, status, first_seen_at, last_seen_at)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,'toy','conflict','merge conflict in a.ts','open',now(),now())`,
      [await orgId(), w.workstationId, w.projectId, w.repoId],
    );
    expect((await tileOf(card.id)).hygiene).toEqual([
      { kind: 'conflict', repoName: 'toy', detail: 'merge conflict in a.ts' },
    ]);
    await q(`UPDATE hygiene_findings SET status='resolved', resolved_at=now() WHERE project_id=$1`, [w.projectId]);
    expect((await tileOf(card.id)).hygiene).toBeUndefined();
  });

  it('a queued card shows the budget state once the project is at the warning level or beyond', async () => {
    const hired = await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Budgeted' });
    await q(`UPDATE cards SET status='queued', queued_at=now() WHERE id=$1`, [card.id]);
    await q('UPDATE projects SET budget_micros=10000000 WHERE id=$1', [w.projectId]);
    expect((await tileOf(card.id)).budget).toBeUndefined();
    const spend = async (usd: number) =>
      q(
        `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, cost_usd_micros, ended_at)
         VALUES ($1,$2,$3,$4,'card','sonnet',$5,$6)`,
        [randomUUID(), await orgId(), hired.id, w.projectId, usd, w.t.clock.now()],
      );
    await spend(8_500_000);
    expect((await tileOf(card.id)).budget).toMatchObject({ state: 'warning', canEdit: true });
    await spend(2_000_000);
    expect((await tileOf(card.id)).budget).toMatchObject({ state: 'paused' });
    await q('UPDATE projects SET budget_micros=NULL WHERE id=$1', [w.projectId]);
    expect((await tileOf(card.id)).budget).toBeUndefined();
  });
});
