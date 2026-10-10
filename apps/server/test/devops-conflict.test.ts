import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline } from './helpers/pipeline.ts';
import { createWorld, until, type World } from './helpers/world.ts';

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
const seen = new Set<string>();
/** A runner rejection puts the agent on a 30 s cooldown; the tests do not wait for it. */
const reject = async (...a: Parameters<typeof p.reject>) => {
  const s = await p.reject(...a);
  dispatcher().cooldown.clear();
  return s;
};

/** Like freshState but keeps the workstation's DevOps engineer (auto-hired at pairing). */
async function freshState() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, devops_requests, runner_commands, runner_inbox CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
}

/** The DevOps engineer takes the queued request and finishes it. */
async function finishDevopsRequest(summary: string) {
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
    note: summary,
    data: { summary, commands: [] },
  });
  await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(start.shiftId, 'reported');
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [start.shiftId]))[0],
    3000,
    'devops ended',
  );
  return start;
}
const conflictRequests = (cardId: string) =>
  q(
    `SELECT id, status, summary FROM devops_requests WHERE card_id=$1 AND origin='conflict' ORDER BY created_at`,
    [cardId],
  );
const deskOf = (subkind: string, cardId: string) =>
  q(`SELECT status, kind FROM desk_items WHERE subkind=$1 AND card_id=$2`, [subkind, cardId]);

describe('DevOps tries to resolve a rebase conflict first (G-Q2)', () => {
  it('parks the card on a DevOps attempt with a notice; two failed attempts go to the desk', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Conflicting' });
    await p.toTest('Bea', ['Rex']);

    // attempt 1: the rebase before the test conflicts
    await reject('Tess', 'rebase_conflict', { conflictedFiles: ['src/a.ts'] });
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', park_problem: 'conflict' });
    const first = await conflictRequests(card.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.summary).toContain('attempt 1 of 2');
    expect(first[0]!.summary).toContain('src/a.ts');
    expect(await deskOf('conflict_attempt', card.id)).toEqual([{ status: 'open', kind: 'alert' }]);
    const thread = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at`, [
      card.id,
    ]);
    expect(thread.map((m) => m.body).join('\n')).toContain('DevOps is trying to resolve the conflict');

    // DevOps finishes: the card goes on to Rework (review and test run again afterwards)
    await finishDevopsRequest('Resolved: kept both changes');
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).parked_request_id === null, 5000, 'unparked');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build', status: 'queued' });
    const after = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at`, [
      card.id,
    ]);
    expect(after.map((m) => m.body).join('\n')).toContain('DevOps finished its conflict attempt');

    // attempt 2 after the same conflict again
    await p.toTest('Bea', ['Rex']);
    await reject('Tess', 'rebase_conflict', { conflictedFiles: ['src/a.ts'] });
    expect(await conflictRequests(card.id)).toHaveLength(2);
    await finishDevopsRequest('Not resolved: tests fail');
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).parked_request_id === null, 5000, 'unparked 2');

    // the third conflict is not tried again: it goes to the desk and the card is in Rework as before
    await p.toTest('Bea', ['Rex']);
    await reject('Tess', 'rebase_conflict', { conflictedFiles: ['src/a.ts'] });
    expect(await conflictRequests(card.id)).toHaveLength(2);
    expect(await deskOf('conflict_unresolved', card.id)).toEqual([{ status: 'open', kind: 'escalation' }]);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build', status: 'queued' });
  });
});
