import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let agentId: string;

beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  agentId = (await w.hire('Chatty', 'builder', 'senior')).id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (world: World, method: string, url: string, body?: unknown) =>
  world.t.req(method as 'GET', url, { cookie: world.owner.cookie, ...(body ? { body } : {}) });

async function newProject(world: World, key: string): Promise<string> {
  return (await ok<any>(owner(world, 'POST', '/api/projects', { key, name: key }), 201)).project.id;
}
async function newChat(world: World, agent: string, projectId?: string): Promise<string> {
  return (
    await ok<any>(
      owner(world, 'POST', '/api/chats', { agentId: agent, ...(projectId ? { projectId } : {}) }),
      201,
    )
  ).chat.threadId;
}
const close = (world: World, t: string) => ok(owner(world, 'POST', `/api/chats/${t}/close`));
async function markRead(world: World, t: string) {
  await q(
    `INSERT INTO thread_messages (id, thread_id, author_kind, author_agent_id, kind, body, event_seq, created_at)
     VALUES (gen_random_uuid(), $1, 'agent', $2, 'chat', 'hi', 0, now())`,
    [t, agentId],
  );
  await ok(owner(world, 'POST', `/api/chats/${t}/read`));
}
const archiveAndDelete = async (world: World, id: string, key: string) => {
  await ok(owner(world, 'POST', `/api/projects/${id}/archive`));
  return owner(world, 'POST', `/api/projects/${id}/delete`, { confirmKey: key });
};
const count = async (sql: string, ids: string[]) => (await q(sql, [ids]))[0]!.n as number;
const archivesOf = (ids: string[]) =>
  count('SELECT count(*)::int AS n FROM chat_archives WHERE thread_id = ANY($1::uuid[])', ids);
const readsOf = (ids: string[]) =>
  count('SELECT count(*)::int AS n FROM chat_reads WHERE thread_id = ANY($1::uuid[])', ids);
const threadsOf = (ids: string[]) =>
  count('SELECT count(*)::int AS n FROM threads WHERE id = ANY($1::uuid[])', ids);
const msgsOf = (ids: string[]) =>
  count('SELECT count(*)::int AS n FROM thread_messages WHERE thread_id = ANY($1::uuid[])', ids);
const projectGone = async (id: string) => (await q('SELECT 1 FROM projects WHERE id=$1', [id])).length === 0;

describe('deleting a project with chats', () => {
  let keepProject: string;
  let keepChats: string[] = [];
  let otherOrgChats: string[] = [];
  let orgChat: string;

  it('setup: chats that must survive', async () => {
    keepProject = await newProject(w, 'KEEP');
    const a = await newChat(w, agentId, keepProject);
    await close(w, a);
    await markRead(w, a);
    keepChats = [a];
    orgChat = await newChat(w, agentId);
    await close(w, orgChat);
    await markRead(w, orgChat);
    // a second organisation (its own user and org) with a closed, read chat, written straight into the tables
    const other = await w.t.userSession(uniqueEmail('other'));
    const b = randomUUID();
    await q(
      `INSERT INTO threads (id, org_id, project_id, kind, title, created_by, created_at)
       VALUES ($1,$2,NULL,'chat','Other org chat',$2,now())`,
      [b, other.id],
    );
    await q('INSERT INTO chat_archives (thread_id, user_id, archived_at) VALUES ($1,$2,now())', [
      b,
      other.id,
    ]);
    await q('INSERT INTO chat_reads (thread_id, user_id, read_up_to) VALUES ($1,$2,now())', [b, other.id]);
    otherOrgChats = [b];
  });

  it('deletes a project with a closed chat and a read chat in one step', async () => {
    const id = w.projectId;
    const closed = await newChat(w, agentId, id);
    const read = await newChat(w, agentId, id);
    await close(w, closed);
    await markRead(w, read);
    const ids = [closed, read];
    expect(await archivesOf(ids)).toBe(1);
    expect(await readsOf(ids)).toBe(1);

    const res = await archiveAndDelete(w, id, 'TOY');
    expect(res.status).toBe(200);
    expect(await projectGone(id)).toBe(true);
    expect(await threadsOf(ids)).toBe(0);
    expect(await archivesOf(ids)).toBe(0);
    expect(await readsOf(ids)).toBe(0);
    expect(await msgsOf(ids)).toBe(0);
  });

  it('leaves other projects, the org-level chat and other organisations untouched', async () => {
    const all = [...keepChats, orgChat, ...otherOrgChats];
    expect(await threadsOf(all)).toBe(3);
    expect(await archivesOf(all)).toBe(3);
    expect(await readsOf(all)).toBe(3);
    expect(await projectGone(keepProject)).toBe(false);
  });

  it('still deletes a project with no chats and one with only an open chat', async () => {
    const empty = await newProject(w, 'EMP');
    expect((await archiveAndDelete(w, empty, 'EMP')).status).toBe(200);
    expect(await projectGone(empty)).toBe(true);

    const open = await newProject(w, 'OPN');
    const t = await newChat(w, agentId, open);
    expect((await archiveAndDelete(w, open, 'OPN')).status).toBe(200);
    expect(await projectGone(open)).toBe(true);
    expect(await threadsOf([t])).toBe(0);
  });

  it('is atomic: a failing step deletes nothing and records no event', async () => {
    const id = await newProject(w, 'ATM');
    const t = await newChat(w, agentId, id);
    await close(w, t);
    await markRead(w, t);
    const fn = `fail_${id.replace(/-/g, '')}`;
    await q(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         IF OLD.id = '${id}' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN OLD; END $$`,
    );
    await q(`CREATE TRIGGER ${fn} BEFORE DELETE ON projects FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const res = await archiveAndDelete(w, id, 'ATM');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await projectGone(id)).toBe(false);
      expect(await threadsOf([t])).toBe(1);
      expect(await archivesOf([t])).toBe(1);
      expect(await readsOf([t])).toBe(1);
      expect(
        await q(`SELECT 1 FROM events WHERE type='ProjectDeleted' AND payload->>'projectId'=$1`, [id]),
      ).toHaveLength(0);
    } finally {
      await q(`DROP TRIGGER IF EXISTS ${fn} ON projects`);
      await q(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  it('a projection rebuild replays the deletes without error', async () => {
    await expect(rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store)).resolves.toBeDefined();
    expect(await threadsOf(keepChats)).toBe(1);
  });

  it('deleting a single closed and read chat works and clears its rows', async () => {
    const t = await newChat(w, agentId, keepProject);
    await close(w, t);
    await markRead(w, t);
    const res = await owner(w, 'DELETE', `/api/chats/${t}`);
    expect(res.status).toBe(204);
    expect(await archivesOf([t])).toBe(0);
    expect(await readsOf([t])).toBe(0);
    expect((await q('SELECT deleted_at FROM threads WHERE id=$1', [t]))[0]?.deleted_at).toBeTruthy(); // tombstone stays
  });
});
