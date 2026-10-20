import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool } from './helpers/db.ts';
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
  it('links a new standing thread and keeps the old one listed', async () => {
    const first = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId as string;
    const second = (await ok<any>(owner('POST', '/api/ceo/chat/new'))).threadId as string;
    expect(second).not.toBe(first);
    expect((await ok<any>(owner('POST', '/api/ceo/chat'))).threadId).toBe(second);
    const ids = (await ok<any>(owner('GET', '/api/chats'))).chats.map((c: any) => c.threadId);
    expect(ids).toEqual(expect.arrayContaining([first, second]));
  });

  it('is not open to anonymous callers', async () => {
    const res = await w.t.req('POST', '/api/ceo/chat/new', {});
    expect([401, 403]).toContain(res.status);
  });
});
