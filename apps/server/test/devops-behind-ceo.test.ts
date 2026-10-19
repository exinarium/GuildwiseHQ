import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { act, appoint, ceo, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * DevOps behind the CEO (docs/design/ceo-front-door.md section 8): no new DevOps chats, old ones are read-only, and the
 * CEO files requests by project, environment or workstation and follows them.
 */
let w: World;
let r: FakeRunner;
let wake: any;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await wakeNow(w);
  wake = await startCeoShift(w, r, r.received.length);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

describe('the DevOps chat is retired', () => {
  it('refuses a new chat, and a message in an old one, with devops_via_ceo', async () => {
    const devops = (await q(`SELECT id, org_id FROM agents WHERE is_devops AND status='active' LIMIT 1`))[0]!;
    const res = await owner('POST', '/api/chats', { agentId: devops.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('devops_via_ceo');
    // an old thread (created before) stays readable but takes no message
    const threadId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'ChatThreadCreated',
          payload: { threadId, agentId: devops.id, title: 'Chat with DevOps', createdBy: w.owner.id },
        },
        actor: { kind: 'user', id: w.owner.id },
        scope: { orgId: devops.org_id, projectId: null, audience: 'org' },
      },
    ]);
    expect((await ok<any>(owner('GET', `/api/threads/${threadId}/messages`))).messages).toEqual([]);
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId, body: 'hello DevOps', clientMsgId: 'm1' });
    await b.until(() => b.of('chat.error').length === 1);
    expect(b.of('chat.error')[0]).toMatchObject({ threadId, reason: 'devops_via_ceo' });
    b.close();
  });
});

describe('the CEO calls DevOps', () => {
  it('by project: a request filed by the CEO (origin ceo), with the project as its context, and followed to its end', async () => {
    const res = await act(r, wake.shiftId, 'devops', {
      project: 'TOY',
      text: 'Install pwsh 7.4 and dotnet 9',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.result.status).toBe('executed');
    const requestId = res.result.result.requestId as string;
    const row = (await q('SELECT * FROM devops_requests WHERE id=$1', [requestId]))[0]!;
    expect(row).toMatchObject({ origin: 'ceo', requested_by_kind: 'agent', status: 'queued' });
    expect(row.context).toMatchObject({ projectId: w.projectId });
    // `--wait` polls the status until it is done
    const queued = await ceo(r, wake.shiftId, { op: 'devops_status', requestId });
    expect(queued.result).toMatchObject({ requestId, status: 'queued', done: false });
    // the DevOps engineer takes it and finishes
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = (await r.waitFor('shift.start', (f: any) => f.kind === 'devops', 8000, from)) as any;
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () =>
        (await q(`SELECT status FROM devops_requests WHERE id=$1`, [requestId]))[0]!.status === 'running',
      5000,
      'running',
    );
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'devops_done',
      note: 'done',
      data: { summary: 'pwsh 7.4 and dotnet 9 are installed', commands: [] },
    });
    await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
    r.ended(start.shiftId, 'reported');
    await r.barrier();
    const done = await ceo(r, wake.shiftId, { op: 'devops_status', requestId });
    expect(done.result).toMatchObject({
      requestId,
      status: 'done',
      done: true,
      summary: 'pwsh 7.4 and dotnet 9 are installed',
    });
    expect(Array.isArray(done.result.progress)).toBe(true);
    // another organization's request is unknown to this CEO
    expect((await ceo(r, wake.shiftId, { op: 'devops_status', requestId: randomUUID() })).result.status).toBe(
      'unknown',
    );
  });

  it('by environment (a deploy target of the project), and refuses what it cannot place', async () => {
    await q(
      `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'staging', 'local_docker', $1, now(), now())`,
      [w.owner.id, w.projectId],
    );
    const ok1 = await act(r, wake.shiftId, 'devops', {
      project: 'TOY',
      env: 'staging',
      text: 'Repair the staging compose file',
    });
    expect(ok1.result.status, JSON.stringify(ok1)).toBe('executed');
    const unknown = await act(r, wake.shiftId, 'devops', {
      project: 'TOY',
      env: 'nowhere',
      text: 'Do something here',
    });
    expect(unknown.result.status).toBe('refused');
    expect(unknown.result.message).toContain('no environment named nowhere');
    const nothing = await act(r, wake.shiftId, 'devops', { text: 'Do something somewhere' });
    expect(nothing.result.status).toBe('refused');
    expect(nothing.result.message).toContain('--project');
    const byName = await act(r, wake.shiftId, 'devops', {
      workstation: (await q('SELECT name FROM workstations WHERE id=$1', [w.workstationId]))[0]!.name,
      text: 'Check the docker daemon',
    });
    expect(byName.result.status, JSON.stringify(byName)).toBe('executed');
  });
});
