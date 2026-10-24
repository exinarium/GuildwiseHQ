import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

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
beforeEach(async () => {
  await freshState();
  await q('TRUNCATE card_mentions, agent_mention_policy');
});

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };
const comment = (
  cardId: string,
  body: string,
  cookie = w.owner.cookie,
  headers: Record<string, string> = {},
) => w.t.req('POST', `/api/cards/${cardId}/comments`, { cookie, body: { body }, headers });
const thread = async (cardId: string, cookie = w.owner.cookie) =>
  (await ok<any>(w.t.req('GET', `/api/threads/${cardId}/messages`, { cookie }))).messages as any[];
const answer = (start: any, text: string) =>
  r.send('chat.done', { chatId: start.chatId, threadId: start.threadId, messageText: text, usage: USAGE });

describe('@agent in a card comment', () => {
  it('runs a small read-only task, books it to the card and posts the answer as a reply', async () => {
    const agent = await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    const res = await comment(card.id, '@una can you summarise the acceptance criteria?');
    expect(res.status).toBe(201);
    expect(res.body.mentions).toEqual([{ handle: 'una', agentName: 'Una', status: 'started' }]);
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    expect(start.agent).toMatchObject({ name: 'Una' });
    expect(start.message).toContain('mentioned you in a comment on card');
    expect(start.message).toContain('summarise the acceptance criteria');
    expect(start.context).toMatchObject({ cardId: card.id, projectId: w.projectId });
    // a small read-only task: no delegation, no playbook grants
    expect(start.delegation).toBeUndefined();
    expect(start.playbookGrants).toBeUndefined();
    answer(start, 'Three criteria: it works.');
    await until(async () => (await thread(card.id)).some((m) => m.authorKind === 'agent'));
    const reply = (await thread(card.id)).find((m) => m.authorKind === 'agent');
    expect(reply).toMatchObject({ kind: 'comment', authorName: 'Una', body: 'Three criteria: it works.' });
    expect(reply.data.replyTo).toBe(res.body.id);
    // the cost is booked to the card through the shift
    const shift = (await q('SELECT * FROM shifts WHERE id=$1', [start.chatId]))[0]!;
    expect(shift).toMatchObject({
      kind: 'chat',
      status: 'ended',
      outcome: 'reported',
      card_id: card.id,
      agent_id: agent.id,
    });
    expect(Number(shift.tokens_input)).toBe(100);
    const m = (await q('SELECT * FROM card_mentions'))[0]!;
    expect(m).toMatchObject({
      status: 'replied',
      card_id: card.id,
      agent_id: agent.id,
      comment_id: res.body.id,
    });
  });

  it('ignores a handle that is not an agent, and an e-mail address', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    const res = await comment(card.id, 'cc @someone and una@example.com please');
    expect(res.status).toBe(201);
    expect(res.body.mentions).toBeUndefined();
    expect(await q('SELECT 1 FROM card_mentions')).toHaveLength(0);
  });

  it('tells the thread when the agent cannot be started (workstation offline)', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    const res = await comment(card.id, '@una help');
    expect(res.body.mentions[0]).toMatchObject({ status: 'refused' });
    const sys = (await thread(card.id)).filter((m) => m.kind === 'system');
    expect(sys.some((m) => m.body.startsWith('Una was not started'))).toBe(true);
    expect(await q('SELECT 1 FROM card_mentions')).toHaveLength(0);
    r = await w.connectRunner();
  });

  it('posts a failure note and ends the mention when the run errors', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    await comment(card.id, '@una help');
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    r.send('chat.error', { chatId: start.chatId, threadId: start.threadId, error: 'model unavailable' });
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'failed');
    expect(
      (await thread(card.id)).some((m) => m.kind === 'system' && m.body.includes('model unavailable')),
    ).toBe(true);
    // the shift ended, so a new mention can start
    expect((await q('SELECT status FROM shifts WHERE id=$1', [start.chatId]))[0]?.status).toBe('ended');
  });

  it('refuses a second mention while an agent is still answering on the card', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    await comment(card.id, '@una first');
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    const second = await comment(card.id, '@una second');
    expect(second.body.mentions[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('already answering'),
    });
    answer(start, 'done');
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
  });

  it('does not start on a paused project', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    await ok(w.t.req('POST', `/api/projects/${w.projectId}/pause`, { cookie: w.owner.cookie, body: {} }));
    const res = await comment(card.id, '@una help');
    expect(res.body.mentions[0].status).toBe('refused');
    await ok(w.t.req('POST', `/api/projects/${w.projectId}/resume`, { cookie: w.owner.cookie }));
  });

  it('limits mentions per user and card per hour', async () => {
    await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    for (let i = 0; i < 5; i++) {
      const res = await comment(card.id, `@una number ${i}`);
      expect(res.body.mentions[0].status).toBe('started');
      const start = await r.waitFor('chat.start', (f) => f.message.includes(`number ${i}`));
      answer(start, `answer ${i}`);
      await until(
        async () =>
          (await q(`SELECT count(*)::int AS n FROM card_mentions WHERE status='replied'`))[0]?.n === i + 1,
      );
    }
    const sixth = await comment(card.id, '@una number 5');
    expect(sixth.body.mentions[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('too many mentions'),
    });
    // an hour later the window has moved on
    w.t.clock.advance(61 * 60 * 1000);
    const again = await comment(card.id, '@una number 6');
    expect(again.body.mentions[0].status).toBe('started');
    const start = await r.waitFor('chat.start', (f) => f.message.includes('number 6'));
    answer(start, 'ok');
    await until(
      async () =>
        (await q(`SELECT count(*)::int AS n FROM card_mentions WHERE status='replied'`))[0]?.n === 6,
    );
  });

  it('lets a project member mention only an agent whose manager allowed it', async () => {
    const agent = await w.hire('Una', 'builder', 'junior');
    const card = await w.card();
    const m = await addMember(w, 'mem');
    const org = { 'x-aom-org': w.owner.id };
    // not allowed by default: refused, and it is not offered in the box
    const mentionable = await ok<any>(
      w.t.req('GET', `/api/cards/${card.id}/mentionable`, { cookie: m.cookie }),
    );
    expect(mentionable.agents).toEqual([]);
    const denied = await comment(card.id, '@una hello', m.cookie);
    expect(denied.status).toBe(201);
    expect(denied.body.mentions[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('may not mention'),
    });
    expect(await q('SELECT 1 FROM card_mentions')).toHaveLength(0);
    // a member cannot grant it; the owner can
    expect(
      (
        await w.t.req('PUT', `/api/agents/${agent.id}/mention-policy`, {
          cookie: m.cookie,
          headers: org,
          body: { allowMembers: true },
        })
      ).status,
    ).toBe(403);
    expect(
      await ok<any>(
        w.t.req('PUT', `/api/agents/${agent.id}/mention-policy`, {
          cookie: w.owner.cookie,
          body: { allowMembers: true },
        }),
      ),
    ).toEqual({ allowMembers: true });
    expect(
      (await ok<any>(w.t.req('GET', `/api/cards/${card.id}/mentionable`, { cookie: m.cookie }))).agents,
    ).toMatchObject([{ name: 'Una', handle: 'una' }]);
    const allowed = await comment(card.id, '@una hello', m.cookie);
    expect(allowed.body.mentions[0].status).toBe('started');
    const start = await r.waitFor('chat.start', (f) => f.threadId === card.id);
    expect(start.message).toContain('mentioned you');
    answer(start, 'hi');
    await until(async () => (await q(`SELECT status FROM card_mentions`))[0]?.status === 'replied');
    // switched off again: refused again
    await ok(
      w.t.req('PUT', `/api/agents/${agent.id}/mention-policy`, {
        cookie: w.owner.cookie,
        body: { allowMembers: false },
      }),
    );
    expect((await comment(card.id, '@una again', m.cookie)).body.mentions[0].status).toBe('refused');
  });
});
