import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** "New chat" with the CEO: a fresh standing thread; the earlier one stays in the chat list. */
let w: World;
const owner = (method: string, url: string) => w.t.req(method, url, { cookie: w.owner.cookie });

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('POST /api/ceo/chat/new', () => {
  it('links a new standing thread, archives the old one for the owner and keeps it listed', async () => {
    const first = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId as string;
    const second = (await ok<any>(owner('POST', '/api/ceo/chat/new'))).threadId as string;
    expect(second).not.toBe(first);
    expect((await ok<any>(owner('POST', '/api/ceo/chat'))).threadId).toBe(second);
    const ids = (await ok<any>(owner('GET', '/api/chats'))).chats.map((c: any) => c.threadId);
    expect(ids).toEqual(expect.arrayContaining([first, second]));
    const chats = (await ok<any>(owner('GET', '/api/chats'))).chats;
    expect(chats.find((c: any) => c.threadId === first).archived).toBe(true);
    expect(chats.find((c: any) => c.threadId === second).archived).toBe(false);
  });

  it('is refused with 409 turn_in_flight while a turn of the current thread is queued or running', async () => {
    const cur = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId as string;
    const turnId = randomUUID();
    await q(
      `INSERT INTO ceo_turns (id, org_id, thread_id, mode, status, model, queued_at)
       SELECT $1, org_id, id,'owner','running','{}'::jsonb, now() FROM threads WHERE id=$2`,
      [turnId, cur],
    );
    const res = await owner('POST', '/api/ceo/chat/new');
    expect(res.status).toBe(409);
    expect((res.body as any).error.code).toBe('turn_in_flight');
    expect((await ok<any>(owner('POST', '/api/ceo/chat'))).threadId).toBe(cur);
    await q(`UPDATE ceo_turns SET status='done' WHERE id=$1`, [turnId]);
    const next = (await ok<any>(owner('POST', '/api/ceo/chat/new'))).threadId as string;
    expect(next).not.toBe(cur);
  });

  it('archive-all never archives the live CEO standing chat', async () => {
    const cur = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId as string;
    await ok<any>(owner('POST', '/api/chats/archive-all'));
    const chats = (await ok<any>(owner('GET', '/api/chats'))).chats;
    expect(chats.find((c: any) => c.threadId === cur).archived).toBe(false);
  });

  it('is not open to anonymous callers', async () => {
    const res = await w.t.req('POST', '/api/ceo/chat/new', {});
    expect([401, 403]).toContain(res.status);
  });
});
