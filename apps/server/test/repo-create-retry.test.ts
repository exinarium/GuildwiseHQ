import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devopsHireEvent } from '../src/commands/devops.ts';
import { withAppendTx } from '../src/db/tx.ts';
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

describe('repository request retry projection', () => {
  it('a request back to approved (and then created) is reproduced by a rebuild', async () => {
    await setup();
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { start } = await openChat(r, ba.id, w.owner.id, w.owner.cookie);
    await request(r, start.chatId);
    let from = r.received.length;
    await resolve((await deskItems())[0].id, { resolution: 'approved' });
    let cmd = await nextCommand(r, from);
    r.send('command.result', {
      commandId: cmd.commandId ?? cmd.id,
      ok: true,
      result: { ok: false, error: 'gh repo create failed: HTTP 502' },
    });
    await until(
      async () => (await deskItems()).some((i: any) => i.subkind === 'repo_create_failed'),
      5000,
      'alert',
    );
    const alert = (await deskItems()).find((i: any) => i.subkind === 'repo_create_failed');
    from = r.received.length;
    expect((await resolve(alert.id, { resolution: 'approved' })).status).toBe(200);
    cmd = await nextCommand(r, from);
    const cols = 'id, status, workstation_id, error, approved_by, remote_url';
    const approved = await q(`SELECT ${cols} FROM repo_requests`);
    expect(approved[0]).toMatchObject({ status: 'approved', error: null });
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await q(`SELECT ${cols} FROM repo_requests`)).toEqual(approved);
    r.send('command.result', {
      commandId: cmd.commandId ?? cmd.id,
      ok: true,
      result: { ok: true, remoteUrl: 'https://github.com/acme/newrepo.git' },
    });
    await until(
      async () => (await q('SELECT status FROM repo_requests'))[0]?.status === 'created',
      5000,
      'created',
    );
    const done = await q(`SELECT ${cols} FROM repo_requests`);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await q(`SELECT ${cols} FROM repo_requests`)).toEqual(done);
  });
});
