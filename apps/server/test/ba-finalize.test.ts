import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  cardRow,
  DIFF_LARGE,
  DIFF_SMALL,
  eventsOfType,
  hireTeam,
  pipeline,
  testPass,
} from './helpers/pipeline.ts';
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

const desk = () => ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
const finalized = (action: string, note = 'ready') => ({
  kind: 'outcome',
  outcomeId: 'finalized',
  note,
  data: { action },
});
const nextCommand = (from: number, name = 'finalize.execute') =>
  r.waitFor('command', (f) => f.command === name, 5000, from);

/** A card all the way to Finalize with a BA in the org (small tier unless `large`). */
async function cardAtFinalize(over: Record<string, unknown> = {}, large = false) {
  await freshState();
  await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
  await w.hire('Ben', 'ba', 'senior');
  const card = await w.card(over);
  await p.run(
    'Bea',
    { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} },
    large ? DIFF_LARGE : DIFF_SMALL,
  );
  await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  if (large) await p.run('Ria', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  await p.run('Tess', testPass());
  expect((await cardRow(card.id)).stage).toBe('finalize');
  return card;
}

describe('BA finalize', () => {
  it('the BA claims the Finalize stage; a small card is finalized without the manager', async () => {
    const card = await cardAtFinalize();
    const from = r.received.length;
    const start = await p.next('Ben');
    expect(start.brief.shift).toMatchObject({ stage: 'finalize', kind: 'card' });
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['finalized']);
    expect(start.brief.card.completionAction).toBe('merge');
    expect(start.worktree).toMatchObject({ mode: 'reuse' });
    await p.startShift(r, start);
    const res = await p.report(r, start.shiftId, finalized('merge', 'branch is ready'));
    expect(res).toMatchObject({ accepted: true });
    expect(res.message).toMatch(/executing the completion action \(merge\)/);
    r.ended(start.shiftId, 'reported');

    expect(await cardRow(card.id)).toMatchObject({
      status: 'waiting',
      finalize_state: 'running',
      claim_id: null,
    });
    const cmd = await nextCommand(from);
    expect(cmd.payload).toMatchObject({ cardId: card.id, action: 'merge', repoId: w.repoId });
    // never reached the desk
    expect((await desk()).items.filter((i: any) => i.kind === 'approval')).toHaveLength(0);

    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc1234567' },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'card finalized');
    expect((await eventsOfType('CardFinalized')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    const handoff = (
      await q(
        `SELECT agent_id, stage, outcome, data FROM card_handoffs WHERE card_id=$1 AND stage='finalize'`,
        [card.id],
      )
    )[0]!;
    expect(handoff).toMatchObject({ stage: 'finalize', outcome: 'finalized', data: { action: 'merge' } });
    // the full suite follows, as for a manual finalize
    expect(
      await q(`SELECT 1 FROM cards WHERE parent_card_id=$1 AND origin='full_suite'`, [card.id]),
    ).toHaveLength(1);
  });

  it('the BA may revise the completion action before finalizing; the revision is recorded on the card', async () => {
    const card = await cardAtFinalize({ title: 'Revise' });
    const from = r.received.length;
    const out = await p.run('Ben', finalized('pr', 'touches the auth flow: a human should read the diff'));
    expect(out.res).toMatchObject({ accepted: true });
    expect((await cardRow(card.id)).completion_action).toBe('pr');
    const cmd = await nextCommand(from);
    expect(cmd.payload).toMatchObject({ action: 'pr' });
    const msgs = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='comment'`, [card.id]);
    expect(msgs.map((m) => m.body).join('\n')).toMatch(
      /Completion action revised from merge to pr: touches the auth flow/,
    );
    const updated = (await eventsOfType('CardUpdated')).filter(
      (e) => e.cardId === card.id && e.changes.completionAction === 'pr',
    );
    expect(updated).toHaveLength(1);
  });

  it('a large merge waits for the manager even when the BA finalizes', async () => {
    const card = await cardAtFinalize({ title: 'Large' }, true);
    const from = r.received.length;
    const out = await p.run('Ben', finalized('merge'));
    expect(out.res.message).toMatch(/needs the manager/);
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', finalize_state: 'awaiting_approval' });
    await new Promise((x) => setTimeout(x, 200));
    expect(r.received.slice(from).some((f) => f.type === 'command' && f.command === 'finalize.execute')).toBe(
      false,
    );
    const item = (await desk()).items.find((i: any) => i.subkind === 'large_merge');
    expect(item).toMatchObject({ kind: 'approval', status: 'open', pinned: true });
    await ok(
      w.t.req('POST', `/api/desk/${item.id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved' },
      }),
    );
    const cmd = await nextCommand(from);
    expect(cmd.payload).toMatchObject({ action: 'merge' });
  });

  it('refuses an unknown completion action', async () => {
    await cardAtFinalize({ title: 'Bad action' });
    const start = await p.next('Ben');
    await p.startShift(r, start);
    const res = await p.report(r, start.shiftId, finalized('ship_it'));
    expect(res.accepted).toBe(false);
    expect(res.error).toMatch(/invalid data/);
  });

  it('the manager button stays as an override while no BA holds the card', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Override' });
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    const from = r.received.length;
    const out = await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }),
    );
    expect(out).toMatchObject({ state: 'running' });
    expect((await nextCommand(from)).payload).toMatchObject({ cardId: card.id });
  });
});
