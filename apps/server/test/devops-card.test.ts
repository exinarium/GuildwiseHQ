import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
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

let n = 0;
async function rpc(shiftId: string, method: string, params: Record<string, unknown> = {}) {
  const rpcId = `rpc-card-${++n}`;
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 5000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}

/** Files a DevOps request for `cardId` and returns the running DevOps shift. */
async function devopsShiftFor(cardId: string | undefined, summary: string) {
  const from = r.received.length;
  const created = await ok<any>(
    w.t.req('POST', '/api/devops/requests', {
      cookie: w.owner.cookie,
      body: { workstationId: w.workstationId, summary, ...(cardId ? { cardId } : {}) },
    }),
    201,
  );
  await w.t.app.ctx.services.dispatcher.run();
  const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'devops shift running',
  );
  return { start, requestId: created.request.id as string };
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

describe('a DevOps request filed for a card', () => {
  it('puts the card (fields, project, comments) in the DevOps brief, and reads, comments and updates only that card', async () => {
    const card = await w.card({
      title: 'Needs the app running',
      fields: fullFields({ context: 'Run on :3000' }),
    });
    const other = await w.card({ title: 'Some other card' });
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/comments`, {
        cookie: w.owner.cookie,
        body: { body: 'Please start the stack first' },
      }),
      201,
    );

    const { start } = await devopsShiftFor(card.id, 'start the stack for the card');
    expect(start.devops?.card).toMatchObject({
      ref: card.ref,
      title: 'Needs the app running',
      cardType: 'feature',
      fields: { context: 'Run on :3000' },
    });
    expect(start.devops?.card?.project?.key).toBeTruthy();
    expect(start.devops?.card?.comments?.map((c: any) => c.body)).toContain('Please start the stack first');

    // read: the linked card, by default and by its own ref
    const read = await rpc(start.shiftId, 'card.get', { linked: true });
    expect(read.ok).toBe(true);
    expect(read.result).toMatchObject({ ref: card.ref, fields: { context: 'Run on :3000' } });
    expect((await rpc(start.shiftId, 'card.get', { ref: card.ref.toLowerCase() })).ok).toBe(true);

    // comment
    const c = await rpc(start.shiftId, 'card.comment', { note: 'Stack is up on :3000' });
    expect(c.ok).toBe(true);
    const comments = await q('SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at', [
      card.id,
    ]);
    expect(comments.map((m) => m.body)).toContain('Stack is up on :3000');

    // update fields (merge); a null removes a field
    const upd = await rpc(start.shiftId, 'card.update', {
      ref: card.ref,
      fields: { constraints: 'Needs docker on :3000' },
    });
    expect(upd.ok).toBe(true);
    const row = (await q('SELECT fields, title, stage, status FROM cards WHERE id=$1', [card.id]))[0] as any;
    expect(row.fields).toMatchObject({ context: 'Run on :3000', constraints: 'Needs docker on :3000' });
    expect(row.title).toBe('Needs the app running');

    // not allowed: other fields than `fields`, and an empty patch
    expect((await rpc(start.shiftId, 'card.update', { ref: card.ref, title: 'Renamed' })).ok).toBe(false);
    expect((await rpc(start.shiftId, 'card.update', { ref: card.ref, fields: {} })).ok).toBe(false);

    // refused on every other card
    for (const [method, params] of [
      ['card.get', { ref: other.ref }],
      ['card.comment', { ref: other.ref, note: 'sneaky' }],
      ['card.update', { ref: other.ref, fields: { constraints: 'x' } }],
    ] as const) {
      const bad = await rpc(start.shiftId, method, { ...params });
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(new RegExp(`only read or change that card|this request is for ${card.ref}`));
    }
    const untouched = (await q('SELECT fields FROM cards WHERE id=$1', [other.id]))[0] as any;
    expect(untouched.fields.constraints).not.toBe('x');
    const sneaky = await q('SELECT 1 FROM thread_messages WHERE thread_id=$1 AND body=$2', [
      other.id,
      'sneaky',
    ]);
    expect(sneaky).toHaveLength(0);
    // other card verbs are not available either
    expect((await rpc(start.shiftId, 'card.create', {})).ok).toBe(false);
    await finish(start.shiftId);
  });

  it('a request without a card has no card access, and the brief has no card', async () => {
    const { start } = await devopsShiftFor(undefined, 'free disk space');
    expect(start.devops?.card).toBeUndefined();
    const read = await rpc(start.shiftId, 'card.get', { linked: true });
    expect(read.ok).toBe(false);
    expect(read.error).toMatch(/not filed for a card/);
    expect((await rpc(start.shiftId, 'card.comment', { note: 'x' })).ok).toBe(false);
    await finish(start.shiftId);
  });
});

describe('a DevOps request may only reference what the caller can see', () => {
  const post = (body: Record<string, unknown>) =>
    w.t.req('POST', '/api/devops/requests', {
      cookie: w.owner.cookie,
      body: { workstationId: w.workstationId, summary: 'look at this', ...body },
    });

  /** Another user's own organization, project, repository and card. */
  async function stranger() {
    const u = await w.t.userSession(
      `stranger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
    );
    const proj = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: u.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    );
    const repos = await ok<any>(
      w.t.req('POST', `/api/projects/${proj.project.id}/repos`, {
        cookie: u.cookie,
        body: { name: 'oth', remoteUrl: 'https://example.com/oth.git' },
      }),
      201,
    );
    const card = await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: u.cookie,
        body: {
          projectId: proj.project.id,
          title: 'Secret',
          cardType: 'feature',
          fields: fullFields(),
          completionAction: 'merge',
          specify: true,
        },
      }),
      201,
    );
    return {
      projectId: proj.project.id as string,
      repoId: repos.repos[0].id as string,
      cardId: card.card.id as string,
    };
  }

  it('refuses a card, project or repository the caller cannot see with 404', async () => {
    const o = await stranger();
    expect((await post({ cardId: o.cardId })).status).toBe(404);
    expect((await post({ context: { cardId: o.cardId } })).status).toBe(404);
    expect((await post({ context: { projectId: o.projectId } })).status).toBe(404);
    expect((await post({ context: { repoId: o.repoId } })).status).toBe(404);
    expect((await post({ context: { workstationId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(
      404,
    );
    expect((await post({ context: { deskItemId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(
      404,
    );
    const n = await q('SELECT count(*)::int AS n FROM devops_requests WHERE summary=$1', ['look at this']);
    expect((n[0] as any).n).toBe(0);
  });

  it("accepts the caller's own card, project and repository", async () => {
    const card = await w.card({ title: 'Mine' });
    const res = await post({
      cardId: card.id,
      context: { cardId: card.id, projectId: w.projectId, repoId: w.repoId, workstationId: w.workstationId },
    });
    expect(res.status).toBe(201);
  });
});
