import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Backlog #75: the DevOps engineer was briefed without the standing orders. Every DevOps prompt path now carries the
// organization's orders plus those of the projects involved; chats carry them for every agent.

let w: World;
let r: FakeRunner;
let otherProject: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1'] });
  otherProject = (
    await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    )
  ).project.id;
  const add = (title: string, body: string, projectId?: string) =>
    ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: { scope: 'standing_order', title, body, ...(projectId ? { projectId } : {}) },
      }),
      201,
    );
  await add('Working Branch', 'Always use the repository working branch; never ask which one.');
  await add('Toy rule', 'TOY: run the linter first.', w.projectId);
  await add('Other rule', 'OTH: never touch the staging database.', otherProject);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const titles = (orders: Array<{ title: string }> | undefined) => (orders ?? []).map((o) => o.title).sort();
const EXPECTED = ['TOY: Toy rule', 'Working Branch'];

async function nextDevopsShift(from: number) {
  await w.t.app.ctx.services.dispatcher.run();
  const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'devops shift running',
  );
  return start;
}

const finish = async (shiftId: string) => {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'devops_done',
    note: 'done',
    data: { summary: 'done', commands: [] },
  });
  await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(shiftId, 'reported');
  await until(async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [shiftId, 'ended']))[0]);
};

describe('standing orders in DevOps briefs', () => {
  it('a request filed for a card carries the organization orders and its project orders only', async () => {
    const card = await w.card({ title: 'Needs the stack' });
    const from = r.received.length;
    await ok(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: w.workstationId, summary: 'start the stack', cardId: card.id },
      }),
      201,
    );
    const start = await nextDevopsShift(from);
    expect(titles(start.brief.standingOrders)).toEqual(EXPECTED);
    await finish(start.shiftId);
  });

  it('a request asked from a project page carries that project orders', async () => {
    const from = r.received.length;
    await ok(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: w.workstationId, summary: 'look at it', context: { projectId: otherProject } },
      }),
      201,
    );
    const start = await nextDevopsShift(from);
    expect(titles(start.brief.standingOrders)).toEqual(['OTH: Other rule', 'Working Branch']);
    await finish(start.shiftId);
  });

  it('a request with no project carries the organization orders', async () => {
    const from = r.received.length;
    await ok(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: w.workstationId, summary: 'update the machine' },
      }),
      201,
    );
    const start = await nextDevopsShift(from);
    expect(titles(start.brief.standingOrders)).toEqual(['Working Branch']);
    await finish(start.shiftId);
  });

  it('a run request carries the orders of the project it runs', async () => {
    const from = r.received.length;
    await ok(
      w.t.req('POST', '/api/runs', {
        cookie: w.owner.cookie,
        body: { projectId: w.projectId, workstationId: w.workstationId },
      }),
      201,
    );
    const start = await nextDevopsShift(from);
    expect(start.devops?.run).toBeTruthy();
    expect(titles(start.brief.standingOrders)).toEqual(EXPECTED);
    await finish(start.shiftId);
  });

  it('a hygiene run carries the orders of the projects whose repositories it visits', async () => {
    const from = r.received.length;
    await ok(
      w.t.req('POST', `/api/workstations/${w.workstationId}/hygiene/run`, { cookie: w.owner.cookie }),
      201,
    );
    const start = await nextDevopsShift(from);
    expect(start.devops?.hygiene).toBeTruthy();
    expect(titles(start.brief.standingOrders)).toEqual(EXPECTED);
    await finish(start.shiftId);
  });

  it('an edited order is what the next DevOps brief carries', async () => {
    const id = (await q(`SELECT id FROM ledger_entries WHERE title='Toy rule'`))[0]?.id as string;
    await ok(
      w.t.req('PATCH', `/api/ledger/${id}`, {
        cookie: w.owner.cookie,
        body: { body: 'TOY: run the formatter first.' },
      }),
      200,
    );
    const from = r.received.length;
    await ok(
      w.t.req('POST', '/api/devops/requests', {
        cookie: w.owner.cookie,
        body: { workstationId: w.workstationId, summary: 'again', context: { projectId: w.projectId } },
      }),
      201,
    );
    const start = await nextDevopsShift(from);
    expect(start.brief.standingOrders.find((o: any) => o.title === 'TOY: Toy rule')?.body).toBe(
      'TOY: run the formatter first.',
    );
    await finish(start.shiftId);
  });
});

describe('standing orders in chats', () => {
  const startChat = async (agentId: string, extra: Record<string, unknown>) => {
    const chat = (
      await ok<any>(
        w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId, ...extra } }),
        201,
      )
    ).chat;
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const from = r.received.length;
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'hi', clientMsgId: `m-${from}` });
    const start = await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 5000, from);
    r.send('chat.done', {
      chatId: start.chatId,
      threadId: start.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await b.until(() => b.of('chat.done').length === 1);
    return start;
  };

  it('a project chat carries the organization and project orders', async () => {
    const agent = await w.hire('Vic', 'builder', 'senior');
    const start = await startChat(agent.id, { projectId: w.projectId });
    expect(titles(start.context.standingOrders)).toEqual(EXPECTED.map((t) => t));
  });

  it('a chat with the DevOps engineer, without a project, carries the orders of every project', async () => {
    const devops = (await q(`SELECT id FROM agents WHERE is_devops AND status='active'`))[0]?.id as string;
    const start = await startChat(devops, {});
    expect(titles(start.context.standingOrders)).toEqual([
      'OTH: Other rule',
      'TOY: Toy rule',
      'Working Branch',
    ]);
  });
});
