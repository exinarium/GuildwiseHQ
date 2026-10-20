import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Unread state is a per-user read marker on the server, synced to the user's other sessions. */
let w: World;
let agentId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  agentId = (await w.hire('Reader', 'builder', 'senior')).id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const newChat = async (cookie: string, projectId?: string) =>
  (
    await ok<any>(
      w.t.req('POST', '/api/chats', { cookie, body: { agentId, ...(projectId ? { projectId } : {}) } }),
      201,
    )
  ).chat.threadId as string;
const T0 = Date.parse('2030-01-01T00:00:00.000Z');
const at = (n: number) => new Date(T0 + n * 1000).toISOString();
/** Inserts a chat message at second `n` (author `user` is the owner). */
async function msg(threadId: string, kind: 'agent' | 'user', n: number) {
  await q(
    `INSERT INTO thread_messages (id, thread_id, author_kind, author_user_id, author_agent_id, kind, body, event_seq, created_at)
     VALUES ($1,$2,$3,$4,$5,'chat','hello',0,$6)`,
    [
      randomUUID(),
      threadId,
      kind,
      kind === 'user' ? w.owner.id : null,
      kind === 'agent' ? agentId : null,
      at(n),
    ],
  );
}
const get = async (cookie: string, threadId: string) =>
  (await ok<any>(w.t.req('GET', `/api/chats/${threadId}`, { cookie }))).chat;
const read = (cookie: string, threadId: string, body?: unknown) =>
  w.t.req('POST', `/api/chats/${threadId}/read`, { cookie, ...(body === undefined ? {} : { body }) });

describe('chat read marker', () => {
  it('without a marker counts the agent messages after the user own last message', async () => {
    const t = await newChat(w.owner.cookie);
    await msg(t, 'agent', 1);
    await msg(t, 'user', 2);
    expect((await get(w.owner.cookie, t)).unreadCount).toBeUndefined();
    await msg(t, 'agent', 3);
    await msg(t, 'agent', 4);
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(2);
    const list = (await ok<any>(w.t.req('GET', '/api/chats', { cookie: w.owner.cookie }))).chats;
    expect(list.find((c: any) => c.threadId === t).unreadCount).toBe(2);
  });

  it('marks read (idempotent), counts only newer messages, and the marker never moves back', async () => {
    const t = await newChat(w.owner.cookie);
    for (let i = 1; i <= 3; i++) await msg(t, 'agent', i);
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(3);
    const r1 = await ok<any>(read(w.owner.cookie, t));
    expect(r1.chat.unreadCount).toBeUndefined();
    await ok(read(w.owner.cookie, t));
    expect(
      await q(`SELECT 1 FROM events WHERE type='ChatRead' AND stream_id=$1`, [`thread-${t}`]),
    ).toHaveLength(1);
    await msg(t, 'agent', 4);
    await msg(t, 'agent', 5);
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(2);
    // an older upTo does not move the marker back
    await ok(read(w.owner.cookie, t, { upTo: at(2) }));
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(2);
    expect((await q('SELECT read_up_to FROM chat_reads WHERE thread_id=$1', [t]))[0]!.read_up_to).toEqual(
      new Date(at(3)),
    );
    // upTo in the middle reads part of it; above the newest is clamped
    await ok(read(w.owner.cookie, t, { upTo: at(4) }));
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(1);
    await ok(read(w.owner.cookie, t, { upTo: at(900) }));
    expect((await get(w.owner.cookie, t)).unreadCount).toBeUndefined();
  });

  it('caps the count at 99', async () => {
    const t = await newChat(w.owner.cookie);
    await q(
      `INSERT INTO thread_messages (id, thread_id, author_kind, author_agent_id, kind, body, event_seq, created_at)
       SELECT gen_random_uuid(), $1, 'agent', $2, 'chat', 'x', 0, $3::timestamptz + g * interval '1 second' FROM generate_series(1,120) g`,
      [t, agentId, at(0)],
    );
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(99);
  });

  it('is per user: a project member reading does not clear it for the owner', async () => {
    const member = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    await ok(
      w.t.req('POST', `/api/projects/${w.projectId}/members`, {
        cookie: w.owner.cookie,
        body: { email: member.email },
      }),
      201,
    );
    const t = await newChat(w.owner.cookie, w.projectId);
    await msg(t, 'agent', 1);
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(1);
    expect((await get(member.cookie, t)).unreadCount).toBe(1);
    await ok(read(member.cookie, t));
    expect((await get(member.cookie, t)).unreadCount).toBeUndefined();
    expect((await get(w.owner.cookie, t)).unreadCount).toBe(1);
  });

  it('is refused for a chat the caller cannot see', async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    const t = await newChat(w.owner.cookie);
    await msg(t, 'agent', 1);
    expect((await read(other.cookie, t)).status).toBe(404);
    expect((await w.t.req('POST', `/api/chats/${t}/read`, {})).status).toBe(401);
    expect(await q('SELECT 1 FROM chat_reads WHERE thread_id=$1', [t])).toHaveLength(0);
  });

  it('pushes the read event to the user other sessions and to nobody else', async () => {
    const other = await w.t.userSession(uniqueEmail('bystander'));
    const phone = await Browser.open(w.baseUrl, w.owner.cookie);
    const desktop = await Browser.open(w.baseUrl, w.owner.cookie);
    const stranger = await Browser.open(w.baseUrl, other.cookie);
    for (const b of [phone, desktop, stranger]) await b.hello();
    const t = await newChat(w.owner.cookie);
    await msg(t, 'agent', 1);
    await ok(read(w.owner.cookie, t));
    await desktop.until(() => desktop.events().some((e) => e.type === 'ChatRead'));
    await phone.until(() => phone.events().some((e) => e.type === 'ChatRead'));
    await stranger.barrier();
    expect(stranger.events().some((e) => e.type === 'ChatRead')).toBe(false);
    for (const b of [phone, desktop, stranger]) b.close();
  });
});

describe('archive-all and visibility', () => {
  it('never emits ChatArchived for a chat the caller cannot see', async () => {
    const other = await w.t.userSession(uniqueEmail('stranger'));
    const hidden = await newChat(w.owner.cookie);
    await ok(w.t.req('POST', '/api/chats/archive-all', { cookie: other.cookie, body: {} }));
    const archived = await q(`SELECT 1 FROM events WHERE type='ChatArchived' AND stream_id=$1`, [
      `thread-${hidden}`,
    ]);
    expect(archived).toHaveLength(0);
    expect((await get(w.owner.cookie, hidden)).archived).toBe(false);
  });
});
