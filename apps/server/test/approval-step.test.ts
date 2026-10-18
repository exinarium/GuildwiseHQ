import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveApprover } from '../src/commands/approval.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, roleInput } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, type Member } from './helpers/members.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Approval steps (backlog #16) and QA steps in custom workflows: a card that reaches a person's step waits for them on the
 * desk; approve moves it on, send back returns it to the earlier step as rework with the comment.
 */
let w: World;
let d: ReturnType<typeof designer>;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let member: Member;
let other: Member;

const outcome = (id: string, to: string, kind: 'success' | 'failure' = 'success', over = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...over,
});
const terminal = (id: string) => ({
  id,
  label: id,
  column: id,
  kind: 'terminal',
  claimRole: null,
  doneCriteria: '',
  outcomes: [],
});
const intake = (to: string) => ({
  id: 'intake',
  label: 'Intake',
  column: 'Intake',
  kind: 'manual',
  claimRole: null,
  doneCriteria: 'Intake',
  outcomes: [outcome('ready', to, 'success', { event: 'CardSpecified' })],
});
const work = (to: string) => ({
  id: 'work',
  label: 'Work',
  column: 'Work',
  kind: 'agent',
  claimRole: 'doer',
  doneCriteria: 'It is done.',
  outcomes: [outcome('done', to)],
});
const human = (id: string, cfg: Record<string, unknown>, outs: unknown[], over = {}) => ({
  id,
  label: id === 'approval' ? 'Owner approves' : 'Check',
  column: id === 'approval' ? 'Approval' : 'Check',
  kind: 'human',
  human: cfg,
  claimRole: null,
  doneCriteria: 'A person decides.',
  outcomes: outs,
  ...over,
});
const flow = (key: string, stages: unknown[]) => ({
  key,
  name: key,
  department: 'support',
  fieldSet: 'custom',
  customFields: [
    { key: 'note', label: 'Note', type: 'text', required: false },
    { key: 'needsOk', label: 'Needs approval', type: 'boolean', required: false },
  ],
  cardTypes: ['support'],
  initialStage: 'intake',
  stages,
});
const approvalFlow = (key: string, approver: Record<string, unknown>, over = {}) =>
  flow(key, [
    intake('work'),
    work('approval'),
    human(
      'approval',
      { purpose: 'approval', approver },
      [outcome('approve', 'fin'), outcome('send_back', 'work', 'failure', { rework: true })],
      over,
    ),
    terminal('fin'),
  ]);

const tick = async (n = 4) => {
  for (let i = 0; i < n; i++) await w.t.app.ctx.services.scheduler.run();
};
const enabledKeys = new Set<string>();
const enable = async (...keys: string[]) => {
  for (const k of keys) enabledKeys.add(k);
  const set = [...new Set(['code', ...enabledKeys])];
  await ok(
    w.t.req('PUT', `/api/projects/${w.projectId}/workflows`, {
      cookie: w.owner.cookie,
      body: { enabled: set.map((workflowKey) => ({ workflowKey, defaultCardTypes: [] })) },
    }),
  );
};
const publish = async (wf: { key: string }) => {
  await d.publish('workflows', wf);
  await enable(wf.key);
};
const newCard = async (workflowKey: string) =>
  (
    await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: `Ticket ${workflowKey}`,
          cardType: 'support',
          fields: {},
          specify: true,
          workflowKey,
        },
      }),
      201,
    )
  ).card;
const detail = (id: string, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie }));
const row = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0] as any;
const act = (cookie: string, id: string, path: string, body: unknown = {}) =>
  w.t.req('POST', `/api/cards/${id}/${path}`, { cookie, body });
const desk = async (cookie = w.owner.cookie) =>
  (await ok<any>(w.t.req('GET', '/api/desk', { cookie }))).items as any[];
/** The agent finishes `work` for the one card that is queued there. */
const doWork = (note = 'done') => p.run('Dan', { kind: 'outcome', outcomeId: 'done', note, data: {} });
/** Cancels the cards of earlier tests that wait for the agent, so the next dispatch is this test's card. */
const clearQueue = async () => {
  for (const c of await q(`SELECT id FROM cards WHERE stage='work' AND status='queued'`))
    await ok(
      w.t.req('POST', `/api/cards/${c.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'tidy' } }),
    );
};

beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
  await d.publish(
    'roles',
    roleInput(
      'doer',
      ['appr-owner', 'appr-member', 'appr-gone', 'appr-guard', 'qa-custom', 'qa-back'].map(
        (k) => [k, '*'] as [string, string],
      ),
    ),
  );
  member = await addMember(w, 'approver');
  other = await addMember(w, 'bystander');
  r = await w.connectRunner();
  p = pipeline(w, r);
  await w.hire('Dan', 'doer', 'junior');
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

describe('an approval step asks the approver on the desk', () => {
  let card: any;

  it('opens when the card reaches it: desk item for the Owner, board lane, card panel', async () => {
    await publish(approvalFlow('appr-owner', { kind: 'org_owner' }));
    card = await newCard('appr-owner');
    await doWork('Built it');
    await tick();
    const c = await row(card.id);
    expect(c).toMatchObject({ stage: 'approval', status: 'waiting' });
    expect(c.approval).toMatchObject({ state: 'open', stageId: 'approval', approverKind: 'org_owner' });
    const item = (await desk()).find((x) => x.card?.id === card.id);
    expect(item).toMatchObject({ subkind: 'approval_step', canAnswer: true, status: 'open' });
    expect(item.options.map((o: any) => o.id)).toEqual(['approve', 'send_back']);
    const dto = (await detail(card.id)).approval;
    expect(dto).toMatchObject({
      state: 'open',
      stageLabel: 'Owner approves',
      canAct: true,
      approveTo: 'fin',
      sendBackTo: 'Work',
      fellBack: false,
    });
    const board = await ok<any>(
      w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
    );
    const col = board.columns.find((x: any) => x.name === 'Approval');
    const onBoard = col.cards.find((x: any) => x.id === card.id);
    expect(onBoard).toMatchObject({
      waitingFor: 'approval_step',
      approval: { stageLabel: 'Owner approves' },
    });
    // asking again changes nothing: one request per entry
    await tick();
    expect(
      (await q(`SELECT 1 FROM events WHERE type='ApprovalRequested' AND payload->>'cardId'=$1`, [card.id]))
        .length,
    ).toBe(1);
  });

  it('is decided on the card, not by answering the desk item', async () => {
    const item = (await desk()).find((x) => x.card?.id === card.id);
    const res = await w.t.req('POST', `/api/desk/${item.id}/answer`, {
      cookie: w.owner.cookie,
      body: { answer: 'ok', optionId: 'approve' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('use_approval_actions');
  });

  it('may not be moved to by hand', async () => {
    const res = await w.t.req('POST', `/api/cards/${card.id}/move`, {
      cookie: w.owner.cookie,
      body: { toStage: 'approval', reason: 'x' },
    });
    expect(res.status).toBe(400);
  });

  it('can only be decided by the approver, the project owner or Owner and Admins', async () => {
    expect((await detail(card.id, other.cookie)).approval.canAct).toBe(false);
    const res = await act(other.cookie, card.id, 'approval/approve');
    expect(res.status).toBe(403);
    expect((await row(card.id)).stage).toBe('approval');
  });

  it('a send back needs a comment, then returns the card to the earlier step as rework with the comment', async () => {
    expect((await act(w.owner.cookie, card.id, 'approval/send-back', { comment: '  ' })).status).toBe(400);
    expect((await act(w.owner.cookie, card.id, 'approval/send-back', {})).status).toBe(400);
    const back = await act(w.owner.cookie, card.id, 'approval/send-back', {
      comment: 'Missing the empty state',
    });
    expect(back.status).toBe(200);
    const c = await row(card.id);
    expect(c).toMatchObject({ stage: 'work', status: 'queued', rework_round: 1 });
    expect(c.approval).toMatchObject({
      state: 'sent_back',
      sentBackCount: 1,
      lastSendBack: { comment: 'Missing the empty state' },
    });
    expect(
      (await desk()).find((x) => x.card?.id === card.id && x.subkind === 'approval_step'),
    ).toBeUndefined();
    const thread = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='comment'`, [
      card.id,
    ]);
    expect(thread.map((t) => t.body).join('\n')).toContain('Missing the empty state');
    // the agent reads the comment as a review comment
    await clearQueue();
    const again = await newCardAgain(card.id);
    expect(again).toBe(true);
  });

  /** The same card goes back to the agent: its brief carries the approver's comment. */
  async function newCardAgain(cardId: string): Promise<boolean> {
    await q(`UPDATE cards SET status='queued' WHERE id=$1`, [cardId]);
    const start = await p.next('Dan');
    const brief = (start as any).brief;
    expect(brief.card.id).toBe(cardId);
    expect(brief.reviewComments[0]).toMatchObject({
      comments: 'Missing the empty state',
      reviewerName: expect.stringContaining('(approval)'),
    });
    // finish this shift the normal way
    await p.startShift(r, start);
    await p.report(r, (start as any).shiftId, {
      kind: 'outcome',
      outcomeId: 'done',
      note: 'fixed',
      data: {},
    });
    r.ended((start as any).shiftId, 'reported');
    await q(`SELECT 1`);
    await tick();
    return true;
  }

  it('asks again on the second entry and approving moves the card on to the end', async () => {
    await tick();
    const c = await row(card.id);
    expect(c).toMatchObject({ stage: 'approval', status: 'waiting' });
    expect(c.approval.state).toBe('open');
    expect(
      (await q(`SELECT 1 FROM events WHERE type='ApprovalRequested' AND payload->>'cardId'=$1`, [card.id]))
        .length,
    ).toBe(2);
    const ok1 = await act(w.owner.cookie, card.id, 'approval/approve', { note: 'Good now' });
    expect(ok1.status).toBe(200);
    const done = await row(card.id);
    expect(done).toMatchObject({ stage: 'fin', status: 'done' });
    expect(done.finalized_at).not.toBeNull();
    expect(done.approval).toMatchObject({
      state: 'approved',
      decision: { kind: 'approved', note: 'Good now' },
    });
    const last = (await detail(card.id)).approval;
    expect(last).toMatchObject({
      state: 'approved',
      decision: { byName: expect.any(String) },
      canAct: false,
    });
    expect((await act(w.owner.cookie, card.id, 'approval/approve')).status).toBe(409);
    expect(
      (
        await q(`SELECT summary FROM card_activity WHERE card_id=$1 AND kind='approval' ORDER BY id`, [
          card.id,
        ])
      ).map((a) => a.summary),
    ).toEqual([
      'Waiting for approval',
      'Sent from the approval step'.replace('Sent from', 'Sent back from'),
      'Waiting for approval',
      'Approved',
    ]);
  });

  it('is rebuilt from the events', async () => {
    const before = (await row(card.id)).approval;
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(PROJECTION_TABLES).toContain('cards');
    expect((await row(card.id)).approval).toEqual(before);
  });
});

describe('who is asked', () => {
  it('a named member gets the item and may approve; the Owner and Admins may act for them', async () => {
    await publish(approvalFlow('appr-member', { kind: 'member', userId: member.id }));
    await clearQueue();
    const card = await newCard('appr-member');
    await doWork();
    await tick();
    const mine = (await desk(member.cookie)).find((x) => x.card?.id === card.id);
    expect(mine).toMatchObject({ subkind: 'approval_step', canAnswer: true });
    expect((await detail(card.id)).approval).toMatchObject({ approverKind: 'member', canAct: true });
    expect((await detail(card.id, member.cookie)).approval).toMatchObject({
      approver: { userId: member.id },
      canAct: true,
    });
    expect((await detail(card.id, other.cookie)).approval.canAct).toBe(false);
    expect((await act(member.cookie, card.id, 'approval/approve')).status).toBe(200);
    expect((await row(card.id)).status).toBe('done');
  });

  it('a named person who is not on the project: the Owner is asked and the card says so', async () => {
    await publish(approvalFlow('appr-gone', { kind: 'member', userId: randomUUID() }));
    await clearQueue();
    const card = await newCard('appr-gone');
    await doWork();
    await tick();
    const dto = (await detail(card.id)).approval;
    expect(dto).toMatchObject({ approverKind: 'member', fellBack: true, approver: { userId: w.owner.id } });
    await act(w.owner.cookie, card.id, 'approval/approve');
  });

  it('a step with a guard is skipped when the guard says so', async () => {
    const guarded = approvalFlow(
      'appr-guard',
      { kind: 'org_owner' },
      { when: { field: 'needsOk', equals: true } },
    );
    await publish(guarded);
    await clearQueue();
    const card = await newCard('appr-guard');
    await doWork();
    await tick();
    expect(await row(card.id)).toMatchObject({ stage: 'fin', status: 'done' });
  });
});

describe('a QA step in a custom workflow', () => {
  const qaFlow = (key: string) =>
    flow(key, [
      intake('work'),
      work('check'),
      human('check', { purpose: 'qa' }, [
        outcome('pass', 'fin'),
        outcome('skip', 'fin'),
        outcome('send_back', 'work', 'failure', { rework: true }),
      ]),
      terminal('fin'),
    ]);

  it('opens manual QA for the person who started the card; pass ends the card at the final step', async () => {
    await publish(qaFlow('qa-custom'));
    await clearQueue();
    const card = await newCard('qa-custom');
    await doWork();
    await tick();
    const c = await row(card.id);
    expect(c).toMatchObject({ stage: 'check', status: 'waiting' });
    expect(c.qa).toMatchObject({ state: 'open', assigneeUserId: w.owner.id });
    const item = (await desk()).find((x) => x.card?.id === card.id);
    expect(item).toMatchObject({ subkind: 'manual_qa', canAnswer: true });
    expect((await detail(card.id)).qa).toMatchObject({ state: 'open', canAct: true });
    const res = await act(w.owner.cookie, card.id, 'qa/pass', { note: 'Works' });
    expect(res.status).toBe(200);
    expect(await row(card.id)).toMatchObject({ stage: 'fin', status: 'done' });
  });

  it('a send back goes to the step the route names', async () => {
    await publish(qaFlow('qa-back'));
    await clearQueue();
    const card = await newCard('qa-back');
    await doWork();
    await tick();
    expect((await act(w.owner.cookie, card.id, 'qa/send-back', { comment: 'Broken' })).status).toBe(200);
    expect(await row(card.id)).toMatchObject({ stage: 'work', status: 'queued', rework_round: 1 });
  });
});

describe('who the project_owner approver is', () => {
  it('prefers the project creator, then organization Owners, then Admins, however long each has been a member', async () => {
    const card = { id: randomUUID(), org_id: w.owner.id, project_id: w.projectId } as any;
    const pick = async () =>
      (await resolveApprover(w.t.app.ctx.pool, card, { kind: 'project_owner' } as any)).userId;
    const admin = await w.t.userSession(`adm-${randomUUID().slice(0, 6)}@example.test`);
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    // the Admin holds an organization grant on the project and has been there longer than the creator
    await q(
      `UPDATE project_members SET joined_at = '2020-01-01', org_grant = true WHERE project_id=$1 AND user_id=$2`,
      [w.projectId, admin.id],
    );
    await q(`UPDATE project_members SET joined_at = now() WHERE project_id=$1 AND user_id=$2`, [
      w.projectId,
      w.owner.id,
    ]);
    const adminRow = await q(`SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2`, [
      w.projectId,
      admin.id,
    ]);
    expect(adminRow[0]?.role).toBe('owner');
    // 1. the creator (an organization Owner) comes before the longer-standing Admin
    expect(await pick()).toBe(w.owner.id);
    // 2. when an Admin created the project, that Admin is asked first
    await q('UPDATE projects SET created_by=$2 WHERE id=$1', [w.projectId, admin.id]);
    expect(await pick()).toBe(admin.id);
    await q('UPDATE projects SET created_by=$2 WHERE id=$1', [w.projectId, w.owner.id]);
  });
});
