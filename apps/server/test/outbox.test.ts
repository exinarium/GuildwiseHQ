import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, type Member } from './helpers/members.ts';
import { cardRow, DIFF_SMALL, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const as = (cookie: string) => ({
  get: (url: string) => w.t.req('GET', url, { cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie, body }),
});
const owner = () => as(w.owner.cookie);

const ticketCard = (key = 'ABC-123', over: Record<string, unknown> = {}) =>
  w.card({ fields: fullFields({ externalRef: key }), ...over });

async function draft(cardId: string, body: string, kind = 'comment', who = owner()) {
  return who.post(`/api/cards/${cardId}/outbound`, { kind, body });
}
const outboundItem = async (cardId: string) =>
  (await ok<any>(owner().get('/api/desk'))).items.find(
    (i: any) => i.subkind === 'outbound' && i.card?.id === cardId && i.status === 'open',
  );
const posts = (rr: FakeRunner, from = 0) =>
  rr.received.slice(from).filter((f: any) => f.type === 'command' && f.command === 'outbound.post') as any[];
const resolve = (id: string, body: Record<string, unknown>, who = owner()) =>
  who.post(`/api/desk/${id}/resolve`, body);
/** The `outbound.post` for one draft (older commands that nobody answered are redelivered on reconnect). */
const nextPost = (rr: FakeRunner, from: number, draftId: string) =>
  rr.waitFor(
    'command',
    (f: any) => f.command === 'outbound.post' && f.payload.draftId === draftId,
    15_000,
    from,
  ) as Promise<any>;
const posted = (rr: FakeRunner, commandId: string, externalRef: string) =>
  rr.send('command.result', { commandId, ok: true, result: { ok: true, externalRef } });
const draftRow = async (id: string) => (await q('SELECT * FROM outbound_drafts WHERE id=$1', [id]))[0]!;
const settle = () => new Promise((x) => setTimeout(x, 250));

describe('the outbox: approve, edit, reject', () => {
  it('a draft lands on the desk as an approval and nothing is posted before it is approved', async () => {
    const card = await ticketCard('ABC-1');
    const from = r.received.length;
    const res = await draft(card.id, 'The export now includes the archived items.', 'resolution');
    expect(res.status).toBe(201);
    expect(res.body.draft).toMatchObject({
      status: 'pending',
      externalSystem: 'jira',
      externalKey: 'ABC-1',
      kind: 'resolution',
    });
    const item = await outboundItem(card.id);
    expect(item).toMatchObject({
      kind: 'approval',
      subkind: 'outbound',
      routedTo: 'manager',
      canAnswer: true,
    });
    expect(item.body).toBe('The export now includes the archived items.');
    await settle();
    expect(posts(r, from)).toHaveLength(0);
    expect((await eventsOfType('OutboundDrafted')).filter((e) => e.cardId === card.id)).toHaveLength(1);
    expect(
      (await eventsOfType('OutboundApproved')).filter((e) => e.draftId === res.body.draft.id),
    ).toHaveLength(0);
  });

  it('approving posts the text exactly; the result is recorded on the card', async () => {
    const card = await ticketCard('ABC-2');
    const from = r.received.length;
    const d = (await draft(card.id, 'Shipped in the next release.')).body.draft;
    const item = await outboundItem(card.id);
    expect((await resolve(item.id, { resolution: 'approved' })).status).toBe(200);
    const cmd = await nextPost(r, from, d.id);
    expect(cmd.payload).toMatchObject({
      draftId: d.id,
      cardId: card.id,
      ref: { system: 'jira', key: 'ABC-2' },
      kind: 'comment',
      body: 'Shipped in the next release.',
    });
    posted(r, cmd.commandId, 'https://jira.example.test/browse/ABC-2?focusedCommentId=1');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
    expect(await draftRow(d.id)).toMatchObject({
      external_ref: 'https://jira.example.test/browse/ABC-2?focusedCommentId=1',
      edited: false,
    });
    const msgs = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    expect(msgs.map((m) => m.body).join('\n')).toMatch(/Posted to Jira ABC-2: https:\/\/jira\.example\.test/);
    const history = await ok<any>(owner().get(`/api/outbound?card=${card.ref}`));
    expect(history.drafts[0]).toMatchObject({
      status: 'posted',
      externalRef: expect.stringContaining('ABC-2'),
    });
    expect((await eventsOfType('OutboundPosted')).filter((e) => e.draftId === d.id)).toHaveLength(1);
  });

  it('an edit is posted as edited, and approving twice posts once', async () => {
    const card = await ticketCard('ABC-3');
    const from = r.received.length;
    const d = (await draft(card.id, 'Original wording.')).body.draft;
    const item = await outboundItem(card.id);
    const edited = 'My own wording, as I would say it.';
    expect((await resolve(item.id, { resolution: 'approved', editedBody: edited })).status).toBe(200);
    expect((await resolve(item.id, { resolution: 'approved' })).status).toBe(409);
    const cmd = await nextPost(r, from, d.id);
    expect(cmd.payload.body).toBe(edited);
    await settle();
    expect(posts(r, from)).toHaveLength(1);
    expect(await draftRow(d.id)).toMatchObject({
      body: 'Original wording.',
      final_body: edited,
      edited: true,
    });
    const ev = (await eventsOfType('OutboundApproved')).find((e) => e.draftId === d.id);
    expect(ev).toMatchObject({ finalBody: edited, edited: true });
    posted(r, cmd.commandId, 'ABC-3#c1');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
  });

  it('a rejected draft is never posted', async () => {
    const card = await ticketCard('ABC-4');
    const from = r.received.length;
    const d = (await draft(card.id, 'Please do not send this.')).body.draft;
    const item = await outboundItem(card.id);
    expect((await resolve(item.id, { resolution: 'rejected', note: 'not for the customer' })).status).toBe(
      200,
    );
    await settle();
    expect(posts(r, from)).toHaveLength(0);
    expect(await draftRow(d.id)).toMatchObject({ status: 'rejected', reject_reason: 'not for the customer' });
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE type='outbound.post' AND payload->>'draftId'=$1`, [d.id]),
    ).toHaveLength(0);
    expect((await resolve(item.id, { resolution: 'approved' })).status).toBe(409);
    // dismissing an approval is a rejection too
    const card2 = await ticketCard('ABC-5');
    const d2 = (await draft(card2.id, 'Another one.')).body.draft;
    const item2 = await outboundItem(card2.id);
    await ok(owner().post(`/api/desk/${item2.id}/dismiss`, {}));
    await settle();
    expect((await draftRow(d2.id)).status).toBe('rejected');
    expect(posts(r, from)).toHaveLength(0);
  });

  it('a card that did not come from a ticket has nothing to update', async () => {
    const card = await w.card({ title: 'No ticket' });
    const res = await draft(card.id, 'Hello');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('no_ticket');
  });

  it('a GitHub ticket is addressed as owner/repo#n', async () => {
    const card = await ticketCard('acme/web#42');
    const res = await draft(card.id, 'Fixed in main.', 'resolution');
    expect(res.body.draft).toMatchObject({ externalSystem: 'github', externalKey: 'acme/web#42' });
  });
});

describe('internal stays internal', () => {
  it('a manager draft or edit that names an agent or internal workings is refused', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    const card = await ticketCard('LEAK-1');
    const bad = await draft(card.id, 'Bea finished this after the reviewer asked for changes.');
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('internal_details');
    expect(bad.body.error.details.matches.join(' ')).toMatch(/Bea/);
    expect(await q('SELECT 1 FROM outbound_drafts WHERE card_id=$1', [card.id])).toHaveLength(0);

    const from = r.received.length;
    const d = (await draft(card.id, 'The fix is in.')).body.draft;
    const item = await outboundItem(card.id);
    const edit = await resolve(item.id, { resolution: 'approved', editedBody: 'Our builder Bea fixed it.' });
    expect(edit.status).toBe(422);
    expect((await draftRow(d.id)).status).toBe('pending');
    await settle();
    expect(posts(r, from)).toHaveLength(0);
    // the same text, cleaned, goes through
    const clean = 'The fix is in, thanks.';
    expect((await resolve(item.id, { resolution: 'approved', editedBody: clean })).status).toBe(200);
    posted(r, (await nextPost(r, from, d.id)).commandId, 'LEAK-1#c1');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
  });

  it('the leak check catches review, bounce and question internals', async () => {
    const card = await ticketCard('LEAK-2');
    for (const text of [
      'It bounced back twice from review.',
      'The review comments asked for more tests.',
      'After an escalation to the desk we decided to wait.',
      'Changes requested were all addressed.',
    ]) {
      const res = await draft(card.id, text);
      expect(res.status, text).toBe(422);
    }
    expect((await draft(card.id, 'The export now handles archived items and has tests.')).status).toBe(201);
  });
});

describe('the card owner posts, with their own access', () => {
  let member: Member;
  let mr: FakeRunner;
  it('only the owner approves; only their workstation receives the post', async () => {
    member = await addMember(w, 'colleague');
    mr = await connectMemberRunner(w, member);
    const card = await ticketCard('OWN-1');
    const fromOwner = r.received.length;
    const fromMember = mr.received.length;
    const d = (await draft(card.id, 'Done.')).body.draft;
    const item = await outboundItem(card.id);
    // a colleague on the shared project sees the item but cannot approve it
    const mine = await as(member.cookie).get('/api/desk');
    expect(mine.body.items.some((i: any) => i.id === item.id)).toBe(true);
    const denied = await resolve(item.id, { resolution: 'approved' }, as(member.cookie));
    expect(denied.status).toBe(403);
    expect((await draftRow(d.id)).status).toBe('pending');
    expect((await resolve(item.id, { resolution: 'approved' })).status).toBe(200);
    const cmd = await nextPost(r, fromOwner, d.id);
    expect(cmd.payload.draftId).toBe(d.id);
    await settle();
    expect(posts(mr, fromMember)).toHaveLength(0);
    // the colleague's runner cannot report the owner's post
    mr.send('command.result', { commandId: randomUUID(), ok: true, result: { ok: true } });
    posted(r, cmd.commandId, 'OWN-1#c1');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
  });

  it('the colleague owns their own cards: their posts go to their workstation, never the first user', async () => {
    const mine = await ok<any>(
      as(member.cookie).post('/api/cards', {
        projectId: w.projectId,
        title: 'Colleague card',
        cardType: 'feature',
        fields: fullFields({ externalRef: 'OWN-2' }),
        completionAction: 'merge',
        specify: true,
      }),
      201,
    );
    const fromOwner = r.received.length;
    const fromMember = mr.received.length;
    const d = (await draft(mine.card.id, 'From the colleague.', 'comment', as(member.cookie))).body.draft;
    const item = (await ok<any>(as(member.cookie).get('/api/desk'))).items.find(
      (i: any) => i.subkind === 'outbound' && i.card?.id === mine.card.id,
    );
    expect((await resolve(item.id, { resolution: 'approved' }, owner())).status).toBe(403);
    expect((await resolve(item.id, { resolution: 'approved' }, as(member.cookie))).status).toBe(200);
    const cmd = await nextPost(mr, fromMember, d.id);
    expect(cmd.payload.draftId).toBe(d.id);
    await settle();
    expect(posts(r, fromOwner)).toHaveLength(0);
    posted(mr, cmd.commandId, 'OWN-2#c1');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
    mr.close();
  });
});

describe('delivery and failures', () => {
  it('an approved draft waits for the owner workstation and is posted once it connects', async () => {
    const card = await ticketCard('OFF-1');
    const d = (await draft(card.id, 'Posted when the laptop is back.')).body.draft;
    r.close();
    await until(
      async () =>
        (await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected ===
        false,
      5000,
      'disconnected',
    );
    const item = await outboundItem(card.id);
    expect((await resolve(item.id, { resolution: 'approved' })).status).toBe(200);
    expect((await draftRow(d.id)).status).toBe('approved');
    r = await w.connectRunner();
    const cmd = await nextPost(r, 0, d.id);
    expect(cmd.payload.draftId).toBe(d.id);
    posted(r, cmd.commandId, 'OFF-1#c1');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
  });

  it('a failed post lands on the desk and can be retried; a repeated answer posts nothing twice', async () => {
    const card = await ticketCard('FAIL-1');
    const d = (await draft(card.id, 'This one fails first.')).body.draft;
    const item = await outboundItem(card.id);
    let from = r.received.length;
    await resolve(item.id, { resolution: 'approved' });
    const cmd = await nextPost(r, from, d.id);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: false, error: 'Jira rejected the token (401)' },
    });
    await until(async () => (await draftRow(d.id)).status === 'failed', 3000, 'failed');
    const alert = (await ok<any>(owner().get('/api/desk'))).items.find(
      (i: any) => i.subkind === 'outbound_failed' && i.card?.id === card.id,
    );
    expect(alert).toMatchObject({ kind: 'alert', status: 'open' });
    expect(alert.body).toMatch(/401/);
    expect(await draftRow(d.id)).toMatchObject({
      error: 'Jira rejected the token (401)',
      final_body: 'This one fails first.',
    });

    from = r.received.length;
    expect((await owner().post(`/api/outbound/${d.id}/retry`)).status).toBe(200);
    const again = await nextPost(r, from, d.id);
    expect(again.payload).toMatchObject({ draftId: d.id, body: 'This one fails first.' });
    // retry again while one is in flight: not failed any more
    expect((await owner().post(`/api/outbound/${d.id}/retry`)).status).toBe(409);
    posted(r, again.commandId, 'FAIL-1#c9');
    await until(async () => (await draftRow(d.id)).status === 'posted', 3000, 'posted');
    // a duplicate answer changes nothing
    posted(r, again.commandId, 'FAIL-1#other');
    await settle();
    expect((await draftRow(d.id)).external_ref).toBe('FAIL-1#c9');
    expect((await eventsOfType('OutboundPosted')).filter((e) => e.draftId === d.id)).toHaveLength(1);
  });

  it('the outbound state is a pure projection of its events', async () => {
    const cols = 'id, status, body, final_body, external_ref, edited, kind, external_key';
    const before = await q(`SELECT ${cols} FROM outbound_drafts ORDER BY id`);
    expect(before.length).toBeGreaterThan(3);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await q(`SELECT ${cols} FROM outbound_drafts ORDER BY id`);
    const ids = new Set(before.map((x) => x.id));
    expect(after.filter((x) => ids.has(x.id))).toEqual(before);
  });
});

describe('the BA drafts the update in its Finalize shift', () => {
  let p: ReturnType<typeof pipeline>;
  const rpc = async (shiftId: string, params: Record<string, unknown>) => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId, method: 'outbound.draft', params });
    return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 15_000, from)) as any;
  };

  /** A clean slate and a fresh runner connection (frames of earlier tests' shifts must not be mistaken for new ones). */
  async function clean() {
    await freshState();
    r.close();
    r = await w.connectRunner();
    p = pipeline(w, r);
  }

  async function atFinalize(key: string) {
    await clean();
    await hireTeam(w, { reviewers: ['Rex'] });
    await w.hire('Ben', 'ba', 'senior');
    const card = await ticketCard(key, { title: 'Export archived items' });
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    expect((await cardRow(card.id)).stage).toBe('finalize');
    return card;
  }

  it('drafts once from its shift; a draft that names an agent is blocked and recorded', async () => {
    const card = await atFinalize('BA-1');
    const start = await p.next('Ben');
    await p.startShift(r, start);
    const leaky = await rpc(start.shiftId, {
      kind: 'resolution',
      body: 'Bea built it and Rex reviewed it, then it bounced once.',
    });
    expect(leaky).toMatchObject({ ok: false });
    expect(leaky.error).toMatch(/internal details/);
    expect(await outboundItem(card.id)).toBeUndefined();
    const blocked = await q(`SELECT status, blocked_matches FROM outbound_drafts WHERE card_id=$1`, [
      card.id,
    ]);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ status: 'blocked' });
    expect((await eventsOfType('OutboundBlocked')).filter((e) => e.cardId === card.id)).toHaveLength(1);

    const good = await rpc(start.shiftId, {
      kind: 'resolution',
      body: 'Archived items are now part of the export.',
    });
    expect(good).toMatchObject({ ok: true });
    const again = await rpc(start.shiftId, {
      kind: 'resolution',
      body: 'Archived items are now part of the export.',
    });
    expect(again.result.draftId).toBe(good.result.draftId);
    const item = await outboundItem(card.id);
    expect(item).toMatchObject({ subkind: 'outbound', askedBy: { agentName: 'Ben', kind: 'agent' } });
    expect(
      await q(`SELECT 1 FROM outbound_drafts WHERE card_id=$1 AND status='pending'`, [card.id]),
    ).toHaveLength(1);
    // the manager may rewrite the BA's draft; it is posted as edited
    const from = r.received.length;
    await resolve(item.id, { resolution: 'approved', editedBody: 'Archived items are included now.' });
    const cmd = await nextPost(r, from, good.result.draftId);
    expect(cmd.payload.body).toBe('Archived items are included now.');
    posted(r, cmd.commandId, 'BA-1#c1');
    await until(async () => (await draftRow(good.result.draftId)).status === 'posted', 3000, 'posted');
  });

  it('only the BA drafts, and only for a real draft', async () => {
    await clean();
    await hireTeam(w);
    await ticketCard('BA-2');
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const asBuilder = await rpc(start.shiftId, { body: 'I am the builder.' });
    expect(asBuilder.ok).toBe(false);
    expect(asBuilder.error).toMatch(/business analyst/);
    expect((await rpc(randomUUID(), { body: 'x' })).ok).toBe(false);
    expect((await rpc(start.shiftId, { body: '' })).ok).toBe(false);
  });
});
