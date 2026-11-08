import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_SMALL, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
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

const lockError = {
  baseRef: 'origin/main',
  command: 'git rebase origin/main',
  exitCode: 1,
  stderr: "fatal: Unable to create '/repo/.git/worktrees/TOY-1/index.lock': File exists.",
};

const thread = async (cardId: string): Promise<Array<{ body: string; data?: Record<string, unknown> }>> =>
  (await ok<any>(w.t.req('GET', `/api/cards/${cardId}`, { cookie: w.owner.cookie }))).thread;

/** No RebaseConflict, no DevOps conflict attempt, no rework round: the card was not sent back as a code conflict. */
async function notAConflict(cardId: string) {
  expect((await eventsOfType('RebaseConflict')).filter((e) => e.cardId === cardId)).toHaveLength(0);
  expect((await eventsOfType('ConflictAttemptStarted')).filter((e) => e.cardId === cardId)).toHaveLength(0);
  expect((await cardRow(cardId)).rework_round).toBe(0);
  for (const m of await thread(cardId)) {
    expect(m.body).not.toMatch(/conflicted/i);
    expect(m.body).not.toContain('could not list the files');
  }
}

async function cardAtFinalize(title: string) {
  await freshState();
  await hireTeam(w, { reviewers: ['Rex'] });
  const card = await w.card({ title });
  await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
  await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  await p.run('Tess', testPass());
  expect((await cardRow(card.id)).stage).toBe('finalize');
  return card;
}

async function finalizeWith(cardId: string, res: Record<string, unknown>) {
  const from = r.received.length;
  await ok<any>(w.t.req('POST', `/api/cards/${cardId}/finalize`, { cookie: w.owner.cookie, body: {} }));
  const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
  r.send('command.result', { commandId: cmd.commandId, ok: true, result: res });
  await until(async () => (await cardRow(cardId)).finalize_state === 'failed', 3000, 'failure recorded');
}

describe('a rebase error is not a conflict', () => {
  it('finalize: ok false with rebaseError stays in Finalize as a failure and quotes git with the base branch', async () => {
    const card = await cardAtFinalize('Lock at finalize');
    await finalizeWith(card.id, {
      ok: false,
      action: 'merge',
      error: 'rebase onto origin/main failed: git rebase origin/main exited 1: ...',
      rebaseError: lockError,
    });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finalize', status: 'queued' });
    await notAConflict(card.id);
    const msg = (await thread(card.id)).find((m) => m.body.startsWith('Finalize (merge) did not land'));
    expect(msg?.body).toContain('main');
    expect(msg?.body).toContain('index.lock');
    expect(msg?.body).toContain('`git rebase origin/main` exited 1');
  });

  it("finalize: an older runner's conflict without files is handled as an error", async () => {
    const card = await cardAtFinalize('Empty conflict at finalize');
    await finalizeWith(card.id, {
      ok: false,
      action: 'merge',
      conflict: true,
      conflictedFiles: [],
      error: 'merge conflict in ',
    });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finalize', status: 'queued' });
    await notAConflict(card.id);
    const msg = (await thread(card.id)).find((m) => m.body.startsWith('Finalize (merge) did not land'));
    expect(msg?.body).toContain('not a code conflict');
  });

  it('shift: worktree_failed with rebaseError backs off without Rework and names the base and git', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Lock before test' });
    await p.toTest('Bea', ['Rex']);
    await p.reject('Tess', 'worktree_failed', {
      detail: 'rebase onto origin/main failed: git rebase origin/main exited 1: ...',
      rebaseError: lockError,
    });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', claim_id: null });
    await notAConflict(card.id);
    const msg = (await thread(card.id)).find((m) => m.body.startsWith('Updating the card branch with'));
    expect(msg?.body).toContain('index.lock');
    expect(msg?.body).toContain('before the test stage');
  });

  it("shift: an older runner's rebase_conflict without files backs off without Rework", async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Empty conflict before test' });
    await p.toTest('Bea', ['Rex']);
    await p.reject('Tess', 'rebase_conflict', { detail: 'rebase conflict in ', conflictedFiles: [] });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test', claim_id: null });
    await notAConflict(card.id);
    const msg = (await thread(card.id)).find((m) => m.body.startsWith('Updating the card branch with'));
    expect(msg?.body).toContain('not a code conflict');
    // held back like any other rejection that will not fix itself
    expect((await cardRow(card.id)).retry_failures).toBeGreaterThan(0);
  });
});
