import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { cardRow, DIFF_SMALL, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

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

const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
  put: (url: string, body: unknown = {}) => w.t.req('PUT', url, { cookie, body }),
});
const owner = () => as(w.owner.cookie);
const setQa = (enabled: boolean) =>
  ok<any>(owner().put(`/api/projects/${w.projectId}/manual-qa`, { enabled }));
const qaPost = (cardId: string, action: string, body: unknown = {}, who = owner()) =>
  who.post(`/api/cards/${cardId}/qa/${action}`, body);
const finalized = (note = 'ready') => ({ kind: 'outcome', outcomeId: 'finalized', note, data: {} });
const stepsReport = (note: string) => ({ kind: 'outcome', outcomeId: 'steps', note, data: {} });
const STEPS = [
  '## Happy path',
  '- [ ] Open the export and tick "Archived items"; expect them in the file',
  '## Edge cases',
  '- [ ] Export an empty project; expect an empty file, no error',
].join('\n');

const rpc = async (shiftId: string, params: Record<string, unknown>) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method: 'outbound.draft', params });
  return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 15_000, from)) as any;
};
const draftRows = async (cardId: string) =>
  q('SELECT id, status, desk_item_id FROM outbound_drafts WHERE card_id=$1 ORDER BY created_at', [cardId]);
const qaOf = async (cardId: string) => ((await cardRow(cardId)).qa ?? null) as any;
const desk = async () => (await ok<any>(owner().get('/api/desk'))).items as any[];
const qaItem = async (cardId: string) =>
  (await desk()).find((i) => i.subkind === 'manual_qa' && i.card?.id === cardId);

/** A fresh slate and a team; the card (with a ticket) is in Finalize. `ba`: hire a BA to finalize and draft. */
async function atFinalize(key: string, o: { ba?: boolean; tester?: boolean } = {}) {
  await freshState();
  r.close();
  r = await w.connectRunner();
  p = pipeline(w, r);
  await setQa(true);
  // the full-suite card a finalize spawns would take the tester's shifts in these tests
  await ok(owner().put(`/api/projects/${w.projectId}/full-suite`, { enabled: false }));
  if (o.tester === false) {
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
  } else await hireTeam(w, { reviewers: ['Rex'] });
  if (o.ba !== false) await w.hire('Ben', 'ba', 'senior');
  const card = await w.card({ fields: fullFields({ externalRef: key }), title: `Export ${key}` });
  await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
  await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
  if (o.tester === false) {
    // nobody tests: the manager moves it on
    await q(`UPDATE cards SET stage='finalize', status='queued', queued_at=now() WHERE id=$1`, [card.id]);
  } else await p.run('Tess', testPass());
  expect((await cardRow(card.id)).stage).toBe('finalize');
  return card;
}

/** The BA drafts the ticket comment, finalizes, and the runner reports the merge. */
async function finalizeByBa(cardId: string, o: { draft?: string; mergeCommit?: string } = {}) {
  const from = r.received.length;
  const start = await p.next('Ben');
  await p.startShift(r, start);
  if (o.draft) {
    const d = await rpc(start.shiftId, { kind: 'resolution', body: o.draft });
    expect(d).toMatchObject({ ok: true });
  }
  expect((await p.report(r, start.shiftId, finalized())).accepted).toBe(true);
  r.ended(start.shiftId, 'reported');
  const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 15_000, from);
  r.send('command.result', {
    commandId: cmd.commandId,
    ok: true,
    result: { ok: true, action: 'merge', mergeCommit: o.mergeCommit ?? 'abc1234567' },
  });
  await until(async () => (await cardRow(cardId)).stage !== 'finalize', 5000, 'finalize result applied');
  return cmd;
}

describe('manual QA after finalize', () => {
  it('a finalized card goes to QA, not to done; the tester writes the steps and the owner is asked', async () => {
    const card = await atFinalize('QA-1');
    await finalizeByBa(card.id);
    let row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'qa_steps', status: 'queued', finalized_at: null });
    expect(row.workflow_version_id).toBeTruthy();
    const ev = (await eventsOfType('CardFinalized')).find((e) => e.cardId === card.id);
    expect(ev).toMatchObject({ toStage: 'qa_steps' });
    expect(await qaOf(card.id)).toMatchObject({
      state: 'steps',
      assigneeUserId: row.owner_user_id,
      source: 'owner',
    });
    // the desk item is addressed to the assignee
    const item = await qaItem(card.id);
    expect(item).toMatchObject({ kind: 'question', status: 'open', canAnswer: true });
    expect(item.options.map((o: any) => o.id)).toEqual(['pass', 'skip', 'send_back']);

    // the tester (not the BA: a tester is hired) writes the steps in a shift without a worktree
    const start = await p.next('Tess');
    expect(start.brief.shift).toMatchObject({ stage: 'qa_steps' });
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['steps']);
    expect(start.worktree).toBeFalsy();
    await p.startShift(r, start);
    expect((await p.report(r, start.shiftId, stepsReport(STEPS))).accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'manual_qa', 3000, 'steps posted');
    row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'manual_qa', status: 'waiting', claim_id: null });
    expect(await qaOf(card.id)).toMatchObject({ state: 'open', steps: STEPS });
    const detail = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(detail.qa).toMatchObject({ state: 'open', steps: STEPS, canAct: true, sentBackCount: 0 });
    expect(detail.qa.assignee.name).toBeTruthy();
    expect(
      (await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='comment'`, [card.id]))
        .map((m) => m.body)
        .join('\n'),
    ).toMatch(/Manual QA steps/);
    // it is on the board, in the QA column, with who it waits for
    const board = await ok<any>(owner().get(`/api/board?projectId=${w.projectId}`));
    const col = board.columns.find((c: any) => c.name === 'QA');
    expect(col.cards.map((c: any) => c.ref)).toContain(card.ref);
    expect(col.cards.find((c: any) => c.ref === card.ref)).toMatchObject({
      waitingFor: 'qa',
      qa: { state: 'open' },
    });
    // nobody claims a human stage
    await p.next('Ben').then(
      () => {
        throw new Error('the BA must not get a shift for a card in manual QA');
      },
      () => undefined,
    );
  }, 120_000);

  it('pass: the card is done and the held ticket comment goes to the desk for approval', async () => {
    const card = await atFinalize('QA-2');
    await finalizeByBa(card.id, { draft: 'Archived items are now part of the export.' });
    // held: recorded, no desk approval, nothing posted
    expect(await draftRows(card.id)).toMatchObject([{ status: 'held', desk_item_id: null }]);
    expect((await desk()).filter((i) => i.subkind === 'outbound')).toHaveLength(0);
    const from = r.received.length;
    const dKey = (await qaOf(card.id)).deskItemId;
    expect((await qaPost(card.id, 'pass', { note: 'works on my machine' })).status).toBe(200);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect((await cardRow(card.id)).finalized_at).not.toBeNull();
    expect((await cardRow(card.id)).finished_at).not.toBeNull();
    // the pass IS the approval: no second approval on the desk, the owner's workstation posts it at once
    const rows = await draftRows(card.id);
    expect(rows).toMatchObject([{ status: 'approved' }]);
    expect((await desk()).filter((i) => i.subkind === 'outbound')).toHaveLength(0);
    const cmd = await r.waitFor('command', (f: any) => f.command === 'outbound.post', 15_000, from);
    expect(cmd.payload).toMatchObject({
      cardId: card.id,
      kind: 'resolution',
      body: 'Archived items are now part of the export.',
    });
    const approval = (await eventsOfType('OutboundApproved')).find((e) => e.draftId === rows[0]?.id);
    expect(approval).toMatchObject({
      approvedBy: (await cardRow(card.id)).owner_user_id,
      viaManualQa: true,
      edited: false,
    });
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, externalRef: 'QA-2#c1' },
    });
    await until(async () => (await draftRows(card.id))[0]?.status === 'posted', 3000, 'posted');
    // the QA desk item is closed, the decision is on the card, the events are the audit trail
    const closed = await q('SELECT status, answer, answer_option FROM desk_items WHERE id=$1', [dKey]);
    expect(closed[0]).toMatchObject({
      status: 'answered',
      answer: 'works on my machine',
      answer_option: 'approved',
    });
    expect(await qaOf(card.id)).toMatchObject({
      state: 'passed',
      decision: { kind: 'passed', note: 'works on my machine' },
    });
    expect((await eventsOfType('QaPassed')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    // and it cannot be decided twice
    expect((await qaPost(card.id, 'pass')).status).toBe(409);
  }, 120_000);

  it('skip counts as passed, recorded as not tested', async () => {
    const card = await atFinalize('QA-3');
    await finalizeByBa(card.id, { draft: 'Fixed.' });
    expect((await qaPost(card.id, 'skip', { reason: 'no time today' })).status).toBe(200);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect(await qaOf(card.id)).toMatchObject({
      state: 'skipped',
      decision: { kind: 'skipped', note: 'no time today' },
    });
    // a skip approves the held update too
    expect((await draftRows(card.id))[0]).toMatchObject({ status: 'approved' });
    expect((await eventsOfType('OutboundApproved')).find((e) => e.viaManualQa)).toBeTruthy();
    expect((await eventsOfType('QaSkipped')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    const detail = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(detail.qa).toMatchObject({ state: 'skipped', canAct: false });
  }, 120_000);

  it('send back: needs a comment, goes to rework, keeps the comment held, and comes back to QA after another round', async () => {
    const card = await atFinalize('QA-4');
    await finalizeByBa(card.id, { draft: 'All good now.' });
    const empty = await qaPost(card.id, 'send-back', { comment: '  ' });
    expect(empty.status).toBe(400);
    expect((await qaPost(card.id, 'send-back', {})).status).toBe(400);
    expect(
      (await qaPost(card.id, 'send-back', { comment: 'The export is empty for archived items.' })).status,
    ).toBe(200);
    let row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'build', status: 'queued', rework_round: 1, finalized_at: null });
    expect(row.finalize_state).toBeNull();
    // still held, no ticket comment posted, nothing on the desk for it
    expect((await draftRows(card.id))[0]).toMatchObject({ status: 'held' });
    expect((await desk()).filter((i) => i.subkind === 'outbound')).toHaveLength(0);
    expect(
      (await q('SELECT status FROM desk_items WHERE id=$1', [(await qaOf(card.id)).deskItemId]))[0],
    ).toMatchObject({
      status: 'answered',
    });
    expect((await eventsOfType('QaSentBack')).filter((e) => e.cardId === card.id)).toMatchObject([
      { comment: 'The export is empty for archived items.', toStage: 'build' },
    ]);

    // the builder gets the comment as a review comment, in the card's existing worktree (a reuse, not a new copy)
    const start = await p.next('Bea');
    expect(start.brief.shift.stage).toBe('build');
    expect(start.brief.card.reworkRound).toBe(1);
    expect(start.brief.reviewComments).toMatchObject([
      {
        comments: 'The export is empty for archived items.',
        reviewerName: expect.stringMatching(/manual QA/),
      },
    ]);
    expect(start.worktree).toMatchObject({ mode: 'reuse', branchName: row.branch_name });
    await p.startShift(r, start);
    await p.report(
      r,
      start.shiftId,
      { kind: 'outcome', outcomeId: 'handoff', note: 'fixed', data: {} },
      DIFF_SMALL,
    );
    r.ended(start.shiftId, 'reported');
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    expect((await cardRow(card.id)).stage).toBe('finalize');

    // the second finalize: the BA's draft already exists (once per card and kind), the card goes to QA again
    await finalizeByBa(card.id, { mergeCommit: 'def7654321' });
    row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'qa_steps', status: 'queued' });
    expect(await qaOf(card.id)).toMatchObject({ sentBackCount: 1, state: 'steps' });
    expect((await desk()).filter((i) => i.subkind === 'manual_qa' && i.card?.id === card.id)).toHaveLength(1);
    expect((await eventsOfType('CardFinalized')).filter((e) => e.cardId === card.id)).toHaveLength(2);
    // passing now releases the one held comment
    expect((await qaPost(card.id, 'pass')).status).toBe(200);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect((await draftRows(card.id))[0]).toMatchObject({ status: 'approved' });
  }, 180_000);

  it('a failed post of the QA-approved update raises the usual failure item on the desk', async () => {
    const card = await atFinalize('QA-12');
    await finalizeByBa(card.id, { draft: 'Shipped.' });
    const from = r.received.length;
    expect((await qaPost(card.id, 'pass')).status).toBe(200);
    const cmd = await r.waitFor('command', (f: any) => f.command === 'outbound.post', 15_000, from);
    r.send('command.result', { commandId: cmd.commandId, ok: false, error: 'Jira is down' });
    await until(async () => (await draftRows(card.id))[0]?.status === 'failed', 3000, 'failed');
    expect((await desk()).some((i) => i.subkind === 'outbound_failed' && i.card?.id === card.id)).toBe(true);
  }, 120_000);

  it('hand over to another member: a new desk item for them; strangers and non-members are refused', async () => {
    const card = await atFinalize('QA-5');
    await finalizeByBa(card.id);
    const member = await addMember(w, 'tester');
    const outsider = await w.t.userSession(`outsider-${randomUUID().slice(0, 6)}@example.test`);
    expect((await qaPost(card.id, 'assign', { userId: member.id }, as(outsider.cookie))).status).toBe(404);
    expect((await qaPost(card.id, 'assign', { userId: outsider.id })).status).toBe(400);
    const same = await qaPost(card.id, 'assign', { userId: (await cardRow(card.id)).owner_user_id });
    expect(same.status).toBe(400);
    const before = await qaOf(card.id);
    expect((await qaPost(card.id, 'assign', { userId: member.id })).status).toBe(200);
    expect(await qaOf(card.id)).toMatchObject({ assigneeUserId: member.id, source: 'reassigned' });
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [before.deskItemId]))[0]).toMatchObject({
      status: 'dismissed',
    });
    const mine = (await ok<any>(as(member.cookie).get('/api/desk'))).items.find(
      (i: any) => i.subkind === 'manual_qa' && i.card?.id === card.id,
    );
    expect(mine).toMatchObject({ status: 'open', canAnswer: true });
    // the new assignee decides; it is audited
    expect((await qaPost(card.id, 'skip', {}, as(member.cookie))).status).toBe(200);
    expect(await cardRow(card.id)).toMatchObject({ status: 'done' });
    expect((await eventsOfType('QaAssigned')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    expect((await eventsOfType('QaSkipped')).find((e) => e.cardId === card.id)).toMatchObject({
      by: member.id,
    });
  }, 120_000);

  it('the BA writes the steps when no tester is hired', async () => {
    const card = await atFinalize('QA-6', { tester: false });
    await finalizeByBa(card.id);
    expect((await cardRow(card.id)).stage).toBe('qa_steps');
    const start = await p.next('Ben');
    expect(start.brief.shift).toMatchObject({ stage: 'qa_steps' });
    await p.startShift(r, start);
    expect((await p.report(r, start.shiftId, stepsReport(STEPS))).accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'manual_qa', 3000, 'steps posted');
  }, 120_000);

  it('with no agent that can write steps the stage still opens, with the person asked at once', async () => {
    const card = await atFinalize('QA-7', { tester: false, ba: false });
    // the manager finalizes by hand (no BA); the runner reports the merge
    const from = r.received.length;
    expect((await owner().post(`/api/cards/${card.id}/finalize`, {})).status).toBe(200);
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 15_000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc1234567' },
    });
    await until(async () => (await cardRow(card.id)).stage === 'manual_qa', 5000, 'card in QA');
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting' });
    const detail = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(detail.qa).toMatchObject({ state: 'open', steps: null, canAct: true });
    expect((await eventsOfType('CardFinalized')).find((e) => e.cardId === card.id)).toMatchObject({
      toStage: 'manual_qa',
    });
    expect((await qaPost(card.id, 'pass')).status).toBe(200);
  }, 120_000);

  it('with the project setting off a finalized card is done at once and the comment is not held', async () => {
    const card = await atFinalize('QA-8');
    await setQa(false);
    const detail = await ok<any>(owner().get(`/api/projects/${w.projectId}`));
    expect(detail.project.manualQa).toBe(false);
    await finalizeByBa(card.id, { draft: 'No QA here.' });
    expect(await cardRow(card.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect((await draftRows(card.id))[0]).toMatchObject({ status: 'pending' });
    expect(await qaOf(card.id)).toBeNull();
    expect((await eventsOfType('CardFinalized')).find((e) => e.cardId === card.id)).toMatchObject({
      toStage: 'done',
    });
    expect((await qaPost(card.id, 'pass')).status).toBe(409);
    await setQa(true);
  }, 120_000);

  it('a card pinned to an older workflow version moves to the one with QA when it is finalized', async () => {
    const card = await atFinalize('QA-9');
    const v2 = (
      await q(`SELECT id FROM workflow_versions WHERE org_id IS NULL AND key='code' AND version=2`)
    )[0]!;
    await q('UPDATE cards SET workflow_version_id=$2 WHERE id=$1', [card.id, v2.id]);
    await finalizeByBa(card.id);
    const row = await cardRow(card.id);
    expect(row.stage).toBe('qa_steps');
    const v3 = await q('SELECT version FROM workflow_versions WHERE id=$1', [row.workflow_version_id]);
    expect(v3[0]).toMatchObject({ version: 4 }); // the newest built-in version (QA stages plus the integration test guard)
  }, 120_000);

  it('QA is not a stage to move to; moving the card out of it closes the desk item and hides the panel', async () => {
    const card = await atFinalize('QA-11');
    await finalizeByBa(card.id);
    const into = await owner().post(`/api/cards/${card.id}/move`, { toStage: 'manual_qa', reason: 'x' });
    expect(into.status).toBe(400);
    const dKey = (await qaOf(card.id)).deskItemId;
    expect(
      (await owner().post(`/api/cards/${card.id}/move`, { toStage: 'build', reason: 'rework' })).status,
    ).toBe(200);
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [dKey]))[0]).toMatchObject({
      status: 'dismissed',
    });
    const detail = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(detail.qa).toBeNull();
    expect((await qaPost(card.id, 'pass')).status).toBe(409);
  }, 120_000);

  it('only people who may act can decide; the setting is for the project owner', async () => {
    const card = await atFinalize('QA-10');
    await finalizeByBa(card.id);
    const outsider = await w.t.userSession(`out-${randomUUID().slice(0, 6)}@example.test`);
    for (const a of ['pass', 'skip', 'send-back']) {
      expect((await qaPost(card.id, a, { comment: 'x' }, as(outsider.cookie))).status).toBe(404);
    }
    const member = await addMember(w, 'viewer');
    // a member of the project may act (projects have owners and managers only), but not change the setting
    expect(
      (await as(member.cookie).put(`/api/projects/${w.projectId}/manual-qa`, { enabled: false })).status,
    ).toBe(403);
    const detail = await ok<any>(as(member.cookie).get(`/api/cards/${card.id}`));
    expect(detail.qa.canAct).toBe(true);
    expect((await qaPost(card.id, 'pass')).status).toBe(200);
  }, 120_000);
});
