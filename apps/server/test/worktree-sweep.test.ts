import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
let runner: FakeRunner;

beforeAll(async () => {
  w = await createWorld();
  runner = await w.connectRunner();
});
afterAll(async () => {
  runner.close();
  await w.t.close();
  await closeAdminPool();
});

async function live(paths: string[]): Promise<string[]> {
  const queryId = randomUUID();
  runner.send('worktrees.query', { queryId, paths });
  const a = await runner.waitFor('worktrees.live', (f) => f.queryId === queryId);
  return a.live;
}

describe('worktrees.query', () => {
  it('answers which worktrees belong to a live card: claimed is live, cancelled and unknown are not', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card({ title: 'In flight' });
    const h = shiftHelpers(w);
    const start = await h.dispatchTo(runner, 'Una');
    await h.startShift(runner, start);
    const path = `/work/${card.ref}`;
    expect(await live([path, '/work/GHOST-1'])).toEqual([path]);

    const cancel = await w.t.req('POST', `/api/cards/${card.id}/cancel`, {
      cookie: w.owner.cookie,
      body: { reason: 'no longer needed' },
    });
    expect(cancel.status).toBe(200);
    expect(await live([path])).toEqual([]);
  });

  it('keeps the worktree of a done card whose finalize is still pending, and of a card sharing it', async () => {
    const card = await w.card({ title: 'Merging' });
    await q(
      `UPDATE cards SET status='done', worktree_path='/work/MERGING', home_workstation_id=$2,
              finalize_state='awaiting_approval' WHERE id=$1`,
      [card.id, w.workstationId],
    );
    expect(await live(['/work/MERGING'])).toEqual(['/work/MERGING']);
    await q(`UPDATE cards SET finalize_state=NULL, finalized_at=now() WHERE id=$1`, [card.id]);
    expect(await live(['/work/MERGING'])).toEqual([]);
    // a live card that reuses the worktree of the finished one keeps it
    const sibling = await w.card({ title: 'Sharer' });
    await q(`UPDATE cards SET worktree_card_id=$2 WHERE id=$1`, [sibling.id, card.id]);
    expect(await live(['/work/MERGING'])).toEqual(['/work/MERGING']);
  });

  it("does not report another workstation's worktrees as live", async () => {
    const card = await w.card({ title: 'Elsewhere' });
    await q(`UPDATE cards SET worktree_path='/work/ELSEWHERE', home_workstation_id=NULL WHERE id=$1`, [
      card.id,
    ]);
    expect(await live(['/work/ELSEWHERE'])).toEqual([]);
  });
});
