import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, hireFor } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const post = (url: string, body: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('POST', url, { cookie, body }), status);

async function hangUp(runner: FakeRunner | undefined, workstationId = w.workstationId) {
  if (!runner) return;
  runner.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(workstationId), 3000, 'runner offline');
  await until(
    async () => !(await q('SELECT connected FROM workstations WHERE id=$1', [workstationId]))[0]?.connected,
    3000,
    'disconnect recorded',
  );
}

async function setup() {
  await hangUp(r);
  await freshState();
  await q('TRUNCATE repo_requests CASCADE');
  await q("DELETE FROM project_repos WHERE name <> 'toy'");
  r = await w.connectRunner();
}

/** A desk chat with an agent; returns the runner's `chat.start` (its chat id is the shift id of the rpcs). */
async function openChat(runner: FakeRunner, agentId: string, userId: string, cookie: string) {
  const chat = (await post('/api/chats', { agentId }, 201, cookie)).chat;
  const from = runner.received.length;
  w.t.app.ctx.services.chat.send(userId, {
    threadId: chat.threadId,
    body: 'hello',
    clientMsgId: randomUUID(),
  });
  const start = (await runner.waitFor(
    'chat.start',
    (f) => f.threadId === chat.threadId,
    15_000,
    from,
  )) as any;
  return { chat, start };
}
async function rpc(runner: FakeRunner, shiftId: string, method: string, params: Record<string, unknown>) {
  const rpcId = randomUUID();
  const from = runner.received.length;
  runner.send('rpc.request', { rpcId, shiftId, method, params });
  return (await runner.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}
const request = (runner: FakeRunner, shiftId: string, over: Record<string, unknown> = {}) =>
  rpc(runner, shiftId, 'repo.create', {
    name: 'acme/newrepo',
    visibility: 'private',
    project: 'TOY',
    description: 'A new repo',
    ...over,
  });
const deskItems = async () =>
  (await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }))).items.filter(
    (i: any) => i.subkind === 'repo_create' || i.subkind === 'repo_create_failed',
  ) as any[];
const resolve = (id: string, body: Record<string, unknown>, cookie = w.owner.cookie) =>
  w.t.req('POST', `/api/desk/${id}/resolve`, { cookie, body });
const nextCommand = (runner: FakeRunner, from: number) =>
  runner.waitFor('command', (f: any) => f.command === 'repo.create', 15_000, from) as Promise<any>;
const threadBodies = async (threadId: string) =>
  (
    await q(`SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at, event_seq`, [threadId])
  ).map((m: any) => m.body as string);
const projectRepos = async () =>
  (await q(
    `SELECT name, remote_url, working_branch FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name`,
    [w.projectId],
  )) as any[];

describe('approved repository setup', () => {
  it('the BA asks in a desk chat, the owner approves, the owner runner creates it and the project gets the repo', async () => {
    await setup();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { chat, start } = await openChat(r, ba.id, w.owner.id, w.owner.cookie);
    const asked = await request(r, start.chatId);
    expect(asked.ok, asked.error).toBe(true);
    expect(asked.result).toMatchObject({ status: 'pending' });

    const [item] = await deskItems();
    expect(item).toMatchObject({
      kind: 'approval',
      subkind: 'repo_create',
      title: 'Create repository acme/newrepo',
      status: 'open',
    });
    for (const text of ['acme/newrepo', 'private', 'TOY', 'Desk', 'GitHub login'])
      expect(item.body).toContain(text);
    const from = r.received.length;
    expect(r.received.filter((f: any) => f.command === 'repo.create')).toHaveLength(0);

    expect((await resolve(item.id, { resolution: 'approved' })).status).toBe(200);
    const cmd = await nextCommand(r, from);
    expect(cmd.payload).toMatchObject({
      name: 'acme/newrepo',
      visibility: 'private',
      description: 'A new repo',
      projectKey: 'TOY',
      branch: 'main',
    });
    expect(await projectRepos()).toHaveLength(1); // only the toy repo so far
    const reply = (extra: Record<string, unknown> = {}) =>
      r.send('command.result', {
        commandId: cmd.commandId ?? cmd.id,
        ok: true,
        result: {
          ok: true,
          remoteUrl: 'https://github.com/acme/newrepo.git',
          localPath: '/home/me/src/newrepo',
          ...extra,
        },
      });
    reply();
    await until(async () => (await projectRepos()).length === 2, 5000, 'repo added');
    const repos = await projectRepos();
    expect(repos.find((x) => x.name === 'newrepo')).toMatchObject({
      remote_url: 'https://github.com/acme/newrepo.git',
      working_branch: 'main',
    });
    const reqRow = (await q('SELECT status, remote_url, local_path FROM repo_requests'))[0]!;
    expect(reqRow).toMatchObject({ status: 'created', local_path: '/home/me/src/newrepo' });
    const notes = await threadBodies(chat.threadId);
    expect(notes.join('\n')).toMatch(/asked the project owner to create repository acme\/newrepo/);
    expect(notes.join('\n')).toMatch(
      /Repository acme\/newrepo is ready \(https:\/\/github.com\/acme\/newrepo.git\)/,
    );

    // idempotent: a repeated result adds nothing, and asking again reports it as already created
    reply();
    await new Promise((x) => setTimeout(x, 300));
    expect(await projectRepos()).toHaveLength(2);
    expect((await q('SELECT 1 FROM events WHERE type=$1', ['RepoCreateCompleted'])).length).toBe(1);
    const again = await request(r, start.chatId);
    expect(again.ok).toBe(true);
    expect(again.result).toMatchObject({ duplicate: true, status: 'created' });
    expect(await deskItems()).toHaveLength(0); // nothing new is open
    // the repo is usable: the BA's card verbs can name it (mapped project TOY)
    expect((await rpc(r, start.chatId, 'intake.map', { project: 'TOY' })).ok).toBe(true);

    // the projection survives a rebuild
    const before = await q('SELECT id, status, remote_url FROM repo_requests');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await q('SELECT id, status, remote_url FROM repo_requests')).toEqual(before);
  });

  it('a duplicate request while one is pending reuses it (one desk item); the owner can reject it', async () => {
    await setup();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { chat, start } = await openChat(r, ba.id, w.owner.id, w.owner.cookie);
    expect((await request(r, start.chatId)).ok).toBe(true);
    const dup = await request(r, start.chatId, { name: 'ACME/NewRepo' });
    expect(dup.result).toMatchObject({ duplicate: true, status: 'pending' });
    const items = await deskItems();
    expect(items).toHaveLength(1);
    expect((await resolve(items[0].id, { resolution: 'rejected', note: 'not now' })).status).toBe(200);
    expect((await q('SELECT status FROM repo_requests'))[0]).toMatchObject({ status: 'rejected' });
    expect((await threadBodies(chat.threadId)).join('\n')).toMatch(
      /declined creating repository acme\/newrepo: not now/,
    );
    // a rejected request does not block a new one
    expect((await request(r, start.chatId)).result).toMatchObject({ status: 'pending' });
  });

  it('validates the request: names, visibility, project, who may ask', async () => {
    await setup();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const builder = await w.hire('Una', 'builder', 'senior');
    const { start } = await openChat(r, ba.id, w.owner.id, w.owner.cookie);
    for (const name of [
      'noslash',
      'a/b/c',
      'acme/../x',
      'acme/x y',
      'acme/-x',
      'acme/x.git',
      '-acme/x',
      'acme/$(rm)',
      'acme/',
    ])
      expect((await request(r, start.chatId, { name })).ok, name).toBe(false);
    expect((await request(r, start.chatId, { visibility: 'secret' })).ok).toBe(false);
    expect((await request(r, start.chatId, { description: 'two\nlines' })).ok).toBe(false);
    const nope = await request(r, start.chatId, { project: 'NOPE' });
    expect(nope.error).toMatch(/unknown project/);
    expect(await deskItems()).toHaveLength(0);
    const other = await openChat(r, builder.id, w.owner.id, w.owner.cookie);
    const denied = await request(r, other.start.chatId);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/only the BA/);
  });

  it('only the project owner approves; approving needs the owner workstation connected', async () => {
    await setup();
    const m = await addMember(w, 'repomgr');
    const mr = await connectMemberRunner(w, m);
    const ba = await hireFor(w, m, 'Gina', 'ba', 'senior');
    const { start } = await openChat(mr, ba.id, m.id, m.cookie);
    const asked = await request(mr, start.chatId);
    expect(asked.ok, asked.error).toBe(true);
    const items = await deskItems();
    expect(items).toHaveLength(1);
    // the manager sees it but cannot approve (it uses the owner's GitHub login)
    expect((await resolve(items[0].id, { resolution: 'approved' }, m.cookie)).status).toBe(403);
    expect((await q('SELECT status FROM repo_requests'))[0]).toMatchObject({ status: 'pending' });
    // the owner's workstation is offline: approval is refused and the request stays pending
    await hangUp(r);
    const refused = await resolve(items[0].id, { resolution: 'approved' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code ?? refused.body.code).toBe('no_workstation');
    expect((await q('SELECT status FROM repo_requests'))[0]).toMatchObject({ status: 'pending' });
    r = await w.connectRunner();
    const from = r.received.length;
    expect((await resolve(items[0].id, { resolution: 'approved' })).status).toBe(200);
    const cmd = await nextCommand(r, from);
    expect(cmd.payload.name).toBe('acme/newrepo');
    // the command went to the owner's workstation only
    expect(
      (await q('SELECT workstation_id FROM runner_commands WHERE type=$1', ['repo.create']))[0],
    ).toMatchObject({
      workstation_id: w.workstationId,
    });
    mr.close();
  });

  it('a failure goes back to the desk and the thread; the repo is not added and the request can be repeated', async () => {
    await setup();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { chat, start } = await openChat(r, ba.id, w.owner.id, w.owner.cookie);
    await request(r, start.chatId);
    const from = r.received.length;
    await resolve((await deskItems())[0].id, { resolution: 'approved' });
    const cmd = await nextCommand(r, from);
    r.send('command.result', {
      commandId: cmd.commandId ?? cmd.id,
      ok: true,
      result: {
        ok: false,
        error: 'acme/newrepo already exists on GitHub and is not an empty repository of me',
      },
    });
    await until(
      async () => (await deskItems()).some((i: any) => i.subkind === 'repo_create_failed'),
      5000,
      'alert',
    );
    const alert = (await deskItems()).find((i: any) => i.subkind === 'repo_create_failed');
    expect(alert.title).toBe('Could not create repository acme/newrepo');
    expect(alert.body).toContain('already exists');
    expect((await q('SELECT status, error FROM repo_requests'))[0]).toMatchObject({ status: 'failed' });
    expect(await projectRepos()).toHaveLength(1);
    expect((await threadBodies(chat.threadId)).join('\n')).toMatch(
      /Creating repository acme\/newrepo failed: acme\/newrepo already exists/,
    );
    expect((await request(r, start.chatId)).result).toMatchObject({ status: 'pending' });
  });

  it('a result for a request that was not approved, or from another workstation, changes nothing', async () => {
    await setup();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { start } = await openChat(r, ba.id, w.owner.id, w.owner.cookie);
    await request(r, start.chatId);
    const { applyRepoCreateResult } = await import('../src/commands/repo-create.ts');
    const id = (await q('SELECT id FROM repo_requests'))[0]!.id as string;
    await applyRepoCreateResult(
      w.t.app.ctx,
      w.workstationId,
      id,
      true,
      { ok: true, remoteUrl: 'https://github.com/acme/newrepo.git' },
      undefined,
    );
    expect((await q('SELECT status FROM repo_requests'))[0]).toMatchObject({ status: 'pending' });
    expect(await projectRepos()).toHaveLength(1);
  });
});
