import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const post = (body: Record<string, unknown>, cookie = w.owner.cookie) =>
  w.t.req('POST', '/api/cards', { cookie, body });

describe('card creation', () => {
  it('creates a draft with a ref, a thread and a transition', async () => {
    const r = await post({ projectId: w.projectId, title: 'First', cardType: 'feature' });
    expect(r.status).toBe(201);
    expect(r.body.card).toMatchObject({
      ref: 'TOY-1',
      number: 1,
      status: 'draft',
      stage: 'spec',
      column: 'Spec',
      workflowKey: 'code',
      workflowVersion: 2,
    });
    expect(r.body.card.repoId).toBe(w.repoId); // single repo defaults
    expect(r.body.missing).toBeUndefined();
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${r.body.card.id}`, { cookie: w.owner.cookie }));
    expect(detail.threadId).toBe(r.body.card.id);
    expect(detail.transitions).toHaveLength(1);
    expect(detail.permissions).toMatchObject({ canEdit: true, canSpecify: true, canComment: true });
  });

  it('increments refs per project and resolves cards by ref', async () => {
    const second = await post({ projectId: w.projectId, title: 'Second', cardType: 'feature' });
    expect(second.body.card.ref).toBe('TOY-2');
    const other = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    );
    const o1 = await post({ projectId: other.project.id, title: 'x', cardType: 'bug' });
    expect(o1.body.card.ref).toBe('OTH-1');
    const byRef = await ok<any>(w.t.req('GET', '/api/cards/TOY-2', { cookie: w.owner.cookie }));
    expect(byRef.card.id).toBe(second.body.card.id);
  });

  it('validates fields per field set and card type', async () => {
    // a research card is allowed in any project; a feed card is not allowed in a code project
    const badType = await post({ projectId: w.projectId, title: 't', cardType: 'feed' });
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe('invalid_card_type');
    const badField = await post({
      projectId: w.projectId,
      title: 't',
      cardType: 'feature',
      fields: { acceptanceCriteria: 'not a list' },
    });
    expect(badField.status).toBe(400);
    expect(badField.body.error.code).toBe('invalid_fields');
    const badMock = await post({
      projectId: w.projectId,
      title: 't',
      cardType: 'feature',
      fields: { mock: { review: ['explode'] } },
    });
    expect(badMock.status).toBe(400);
    const okMock = await post({
      projectId: w.projectId,
      title: 't',
      cardType: 'feature',
      fields: { mock: { review: ['changes', 'ok'] } },
    });
    expect(okMock.status).toBe(201);
    expect(okMock.body.card.fields.mock).toEqual({ review: ['changes', 'ok'] });
  });

  it('create with specify:true and missing fields stays draft and lists the missing keys', async () => {
    const r = await post({
      projectId: w.projectId,
      title: 'Incomplete',
      cardType: 'feature',
      fields: { context: 'c' },
      specify: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.card.status).toBe('draft');
    expect([...r.body.missing].sort()).toEqual(
      ['acceptanceCriteria', 'affectedAreas', 'constraints', 'requirements', 'testPlan'].sort(),
    );
  });

  it('specify returns 422 with the missing keys, then succeeds once complete: queued in build / To do', async () => {
    const c = (await post({ projectId: w.projectId, title: 'Spec me', cardType: 'feature' })).body.card;
    const miss = await w.t.req('POST', `/api/cards/${c.id}/specify`, { cookie: w.owner.cookie });
    expect(miss.status).toBe(422);
    expect(miss.body.error.code).toBe('missing_fields');
    expect(miss.body.error.details.missing).toContain('requirements');
    expect(miss.body.error.details.missing).not.toContain('repoId');

    const patch = await w.t.req('PATCH', `/api/cards/${c.id}`, {
      cookie: w.owner.cookie,
      body: { fields: fullFields(), completionAction: 'pr' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.card.fields.context).toBe('ctx');
    const done = await w.t.req('POST', `/api/cards/${c.id}/specify`, { cookie: w.owner.cookie });
    expect(done.status).toBe(200);
    expect(done.body.card).toMatchObject({ status: 'queued', stage: 'build', column: 'To do' });
    expect(done.body.card.queuedAt).toBeTruthy();
    expect(done.body.transitions.map((t: any) => `${t.fromStage}>${t.toStage}`)).toEqual([
      'null>spec',
      'spec>build',
    ]);
    expect((await w.t.req('POST', `/api/cards/${c.id}/specify`, { cookie: w.owner.cookie })).status).toBe(
      409,
    );
  });

  it('specify:true with all fields queues the card immediately', async () => {
    const card = await w.card({ title: 'Ready' });
    expect(card).toMatchObject({ status: 'queued', stage: 'build' });
  });

  it('keeps the card in the DB consistent with the event log (queued_at set, thread exists)', async () => {
    const rows = await q(
      `SELECT c.status, c.queued_at, t.kind FROM cards c JOIN threads t ON t.card_id = c.id WHERE c.title='Ready'`,
    );
    expect(rows[0]).toMatchObject({ status: 'queued', kind: 'card' });
    expect(rows[0]!.queued_at).toBeTruthy();
  });
});

describe('card management', () => {
  it('comments, edits, moves and cancels with the right permissions', async () => {
    const card = await w.card({ title: 'Manage me' });
    const c = await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/comments`, { cookie: w.owner.cookie, body: { body: 'hello' } }),
      201,
    );
    expect(c.body).toBe('hello');
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.thread.some((m: any) => m.body === 'hello' && m.kind === 'comment' && m.authorName)).toBe(
      true,
    );

    const move = await w.t.req('POST', `/api/cards/${card.id}/move`, {
      cookie: w.owner.cookie,
      body: { toStage: 'spec', reason: 'needs rework of spec' },
    });
    expect(move.status).toBe(200);
    expect(move.body.card).toMatchObject({ stage: 'spec', status: 'draft' });
    expect(
      (
        await w.t.req('POST', `/api/cards/${card.id}/move`, {
          cookie: w.owner.cookie,
          body: { toStage: 'nowhere', reason: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await w.t.req('POST', `/api/cards/${card.id}/release`, { cookie: w.owner.cookie, body: {} })).status,
    ).toBe(409);

    const cancel = await w.t.req('POST', `/api/cards/${card.id}/cancel`, {
      cookie: w.owner.cookie,
      body: { reason: 'dupe' },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.card.status).toBe('cancelled');
    expect(
      (await w.t.req('PATCH', `/api/cards/${card.id}`, { cookie: w.owner.cookie, body: { title: 'x' } }))
        .status,
    ).toBe(409);
    const board = await ok<any>(
      w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
    );
    expect(board.columns.flatMap((c: any) => c.cards.map((x: any) => x.id))).not.toContain(card.id);
  });

  it('non-members cannot see or touch cards', async () => {
    const card = await w.card({ title: 'Private' });
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect((await w.t.req('GET', `/api/cards/${card.id}`, { cookie: stranger.cookie })).status).toBe(404);
    expect((await w.t.req('GET', `/api/cards/${card.ref}`, { cookie: stranger.cookie })).status).toBe(404);
    expect(
      (
        await w.t.req('POST', `/api/cards/${card.id}/comments`, {
          cookie: stranger.cookie,
          body: { body: 'x' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: stranger.cookie })).status,
    ).toBe(404);
    expect(
      (await post({ projectId: w.projectId, title: 'x', cardType: 'feature' }, stranger.cookie)).status,
    ).toBe(404);
  });

  it('board groups cards into the code columns', async () => {
    const board = await ok<any>(
      w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
    );
    expect(board.workflowKey).toBe('code');
    expect(board.columns.map((c: any) => c.name)).toEqual([
      'Spec',
      'To do',
      'Rework',
      'In progress',
      'Blocked',
      'Review',
      'Test',
      'Test (waiting on bug)',
      'Docs',
      'Finalize',
      'Done',
    ]);
    const todo = board.columns.find((c: any) => c.name === 'To do');
    expect(todo.cards.length).toBeGreaterThan(0);
    expect(todo.cards[0]).toMatchObject({ status: 'queued', assignee: null, blocked: false, reworkRound: 0 });
  });
});
