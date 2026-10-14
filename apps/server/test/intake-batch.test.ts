import { randomUUID } from 'node:crypto';
import { BATCH_MAX_IN_FLIGHT } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelBatch, createBatch } from '../src/commands/intake-batch.ts';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await freshState();
  await q('TRUNCATE intakes, intake_cards, ba_tasks, intake_batches, intake_batch_items CASCADE');
  r = await w.connectRunner();
  for (const n of ['Ben', 'Bea', 'Bob']) await w.hire(n, 'ba', 'senior');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, body }), status);
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const items = async (batchId: string) =>
  (await q('SELECT * FROM intake_batch_items WHERE batch_id=$1 ORDER BY position', [batchId])) as any[];
const statusOf = async (batchId: string, key: string) =>
  (await items(batchId)).find((i) => i.external_key === key)?.status as string;

/** Next `shift.start` of a batch task for `key`, accepted and started like a real runner. */
async function batchShift(key: string, from = 0) {
  await dispatcher().runPass();
  const start = (await r.waitFor(
    'shift.start',
    (f) => f.kind === 'ba_task' && f.baTask?.kind === 'batch_intake' && f.baTask.batch?.ticketKey === key,
    10_000,
    from,
  )) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'shift running',
  );
  return start;
}
async function rpc(shiftId: string, method: string, params: Record<string, unknown> = {}) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}
const report = async (shiftId: string, rep: Record<string, unknown>) => {
  const { reportId } = r.report(shiftId, rep);
  return (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
};
const end = async (shiftId: string) => {
  r.ended(shiftId, 'reported');
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [shiftId]))[0],
    3000,
    'shift ended',
  );
};
const draft = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  cardType: 'feature',
  fields: fullFields(),
  ...extra,
});

describe('creating a batch', () => {
  it('rejects bad input and non-managers', async () => {
    const bad = await w.t.req('POST', '/api/intake/batches', {
      cookie: w.owner.cookie,
      body: { tickets: ['ABC-1', 'please fix the login'] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code ?? bad.body.code).toBe('invalid_tickets');
    const many = Array.from({ length: 51 }, (_, i) => `MANY-${i + 1}`);
    expect(
      (await w.t.req('POST', '/api/intake/batches', { cookie: w.owner.cookie, body: { tickets: many } }))
        .status,
    ).toBe(400);
    // Same rule as starting an intake chat: Owner and Admins only.
    const m = await addMember(w, 'plain');
    await expect(
      createBatch(
        w.t.app.ctx,
        { id: m.id } as any,
        { id: w.owner.id, role: 'member' },
        { tickets: ['ABC-1'] },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      cancelBatch(w.t.app.ctx, { id: m.id } as any, { id: w.owner.id, role: 'member' }, randomUUID()),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('dedupes, skips tickets that already have a card, and queues one BA task per item', async () => {
    await w.card({ title: 'Existing', fields: fullFields({ externalRef: 'DUP-1' }) });
    const { batch } = await owner(
      'POST',
      '/api/intake/batches',
      {
        tickets: ['ABC-1', 'abc-1', 'ABC-2\nDUP-1', 'https://acme.atlassian.net/browse/ABC-5', 'acme/web#7'],
        note: 'urgent quarter',
      },
      201,
    );
    expect(batch.items.map((i: any) => [i.externalKey, i.status])).toEqual([
      ['ABC-1', 'queued'],
      ['ABC-2', 'queued'],
      ['DUP-1', 'skipped'],
      ['ABC-5', 'queued'],
      ['acme/web#7', 'queued'],
    ]);
    const dup = batch.items.find((i: any) => i.externalKey === 'DUP-1');
    expect(dup.reason).toMatch(/^skipped: already TOY-\d+/);
    expect(batch).toMatchObject({ status: 'running', total: 5, note: 'urgent quarter' });
    expect(batch.counts).toMatchObject({ queued: 4, skipped: 1 });
    const tasks = await q(`SELECT * FROM ba_tasks WHERE batch_id=$1`, [batch.id]);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t: any) => t.kind === 'batch_intake' && t.org_level)).toBe(true);
    const listed = await owner('GET', '/api/intake/batches');
    expect(listed.batches.find((b: any) => b.id === batch.id).counts.queued).toBe(4);
    // Nothing is dispatched for it in the tests below.
    await owner('POST', `/api/intake/batches/${batch.id}/cancel`);
  });
});

describe('processing', () => {
  it('works at most two items of a batch at once, creates cards, asks, resumes and finishes', async () => {
    const { batch } = await owner(
      'POST',
      '/api/intake/batches',
      { tickets: ['PROC-1', 'PROC-2', 'PROC-3', 'PROC-4'], note: 'be quick' },
      201,
    );
    const id = batch.id as string;
    // All four are queued and three BAs are free, but only two items go in flight.
    const from = r.received.length;
    await dispatcher().runPass();
    await r.barrier();
    const running = await q(`SELECT t.id FROM ba_tasks t WHERE t.batch_id=$1 AND t.status='running'`, [id]);
    expect(running).toHaveLength(BATCH_MAX_IN_FLIGHT);
    expect((await items(id)).map((i) => i.status)).toEqual(['reading', 'reading', 'queued', 'queued']);

    // The prompt names the ticket, the note and the projects.
    const s1 = (await r.waitFor(
      'shift.start',
      (f) => f.baTask?.batch?.ticketKey === 'PROC-1',
      10_000,
      from,
    )) as any;
    expect(s1.baTask.batch).toMatchObject({ ticketKey: 'PROC-1', note: 'be quick' });
    expect(s1.baTask.batch.projects.map((p: any) => p.key)).toContain('TOY');
    expect(s1.brief.shift.outcomes.map((o: any) => o.id)).toEqual([
      'batch_done',
      'batch_ask',
      'batch_skip',
      'batch_fail',
    ]);
    r.accepted(s1.shiftId);
    r.started(s1.shiftId);
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [s1.shiftId]))[0],
      3000,
      'running',
    );

    // Same card verbs as the intake chat; completionAction is refused; the project is mapped by the BA.
    expect((await rpc(s1.shiftId, 'card.create', draft('x'))).error).toMatch(/map the ticket to a project/);
    expect((await rpc(s1.shiftId, 'intake.unmapped', { note: 'x' })).error).toMatch(/aom batch ask/);
    expect((await rpc(s1.shiftId, 'intake.map', { project: 'TOY' })).ok).toBe(true);
    expect((await rpc(s1.shiftId, 'card.create', draft('x', { completionAction: 'merge' }))).error).toMatch(
      /completion action/,
    );
    // Done needs a specified card.
    const created = await rpc(s1.shiftId, 'card.create', draft('Implement PROC-1', { designNeeded: true }));
    expect(created.ok).toBe(true);
    expect(
      (await report(s1.shiftId, { kind: 'outcome', outcomeId: 'batch_done', note: 'ok', data: {} })).accepted,
    ).toBe(false);
    expect((await rpc(s1.shiftId, 'card.specify', { ref: created.result.ref })).ok).toBe(true);
    const done = await report(s1.shiftId, {
      kind: 'outcome',
      outcomeId: 'batch_done',
      note: 'one card',
      data: {},
    });
    expect(done.accepted).toBe(true);
    await end(s1.shiftId);
    expect(await statusOf(id, 'PROC-1')).toBe('done');
    const card = (
      await q('SELECT fields, design_needed, origin FROM cards WHERE ref=$1', [created.result.ref])
    )[0] as any;
    expect(card.fields.externalRef).toBe('PROC-1');
    expect(card.design_needed).toBe(true);

    // Item 2 cannot go on: it asks, which puts a desk question naming the ticket and frees its slot.
    const s2 = (await r.waitFor(
      'shift.start',
      (f) => f.baTask?.batch?.ticketKey === 'PROC-2',
      10_000,
      from,
    )) as any;
    r.accepted(s2.shiftId);
    r.started(s2.shiftId);
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [s2.shiftId]))[0],
      3000,
      'running',
    );
    const asked = await report(s2.shiftId, {
      kind: 'outcome',
      outcomeId: 'batch_ask',
      note: 'which?',
      data: { question: 'Web or API?', options: ['Web', 'API'], recommend: 0 },
    });
    expect(asked.accepted).toBe(true);
    await end(s2.shiftId);
    expect(await statusOf(id, 'PROC-2')).toBe('waiting');
    const desk = (
      await q(`SELECT * FROM desk_items WHERE subkind='batch_question' ORDER BY created_at DESC`)
    )[0] as any;
    expect(desk).toMatchObject({ status: 'open', kind: 'question' });
    expect(desk.title).toContain('PROC-2');
    expect(desk.data).toMatchObject({ batchId: id, ticketKey: 'PROC-2' });
    const detail = (await owner('GET', `/api/intake/batches/${id}`)).batch;
    expect(detail.items.find((i: any) => i.externalKey === 'PROC-2')).toMatchObject({
      status: 'waiting',
      deskItemId: desk.id,
      question: 'Web or API?',
    });

    // Other items continue: PROC-3 and PROC-4 take the free slots (and PROC-2 is not in flight).
    const s3 = await batchShift('PROC-3', from);
    const s4 = await batchShift('PROC-4', from);
    expect(await statusOf(id, 'PROC-4')).toBe('reading');
    expect(
      (
        await report(s3.shiftId, {
          kind: 'outcome',
          outcomeId: 'batch_skip',
          note: 'duplicate of PROC-1',
          data: {},
        })
      ).accepted,
    ).toBe(true);
    await end(s3.shiftId);
    expect(
      (await report(s4.shiftId, { kind: 'outcome', outcomeId: 'batch_fail', note: 'no access', data: {} }))
        .accepted,
    ).toBe(true);
    await end(s4.shiftId);
    expect(await statusOf(id, 'PROC-3')).toBe('skipped');
    expect((await items(id)).find((i) => i.external_key === 'PROC-4')).toMatchObject({
      status: 'failed',
      reason: 'no access',
    });

    // The owner's answer on the desk resumes exactly that item, with the answer in the prompt.
    const from2 = r.received.length;
    await owner('POST', `/api/desk/${desk.id}/answer`, { answer: 'API', optionId: 'o2' });
    expect(await statusOf(id, 'PROC-2')).toBe('queued');
    const again = await batchShift('PROC-2', from2);
    expect(again.baTask.batch.answers).toEqual([{ question: 'Web or API?', answer: 'API' }]);
    expect((await rpc(again.shiftId, 'intake.map', { project: 'TOY' })).ok).toBe(true);
    const c2 = await rpc(again.shiftId, 'card.create', draft('Implement PROC-2'));
    await rpc(again.shiftId, 'card.specify', { ref: c2.result.ref });
    expect(
      (await report(again.shiftId, { kind: 'outcome', outcomeId: 'batch_done', note: 'api card', data: {} }))
        .accepted,
    ).toBe(true);
    await end(again.shiftId);

    // Retry of the failed item queues it again.
    const failed = (await items(id)).find((i) => i.external_key === 'PROC-4');
    await owner('POST', `/api/intake/batches/${id}/items/${failed.id}/retry`);
    expect(await statusOf(id, 'PROC-4')).toBe('queued');
    expect((await items(id)).find((i) => i.external_key === 'PROC-4')?.attempts).toBe(1);
    await owner('POST', `/api/intake/batches/${id}/items/${failed.id}/retry`, undefined, 409);
    const retry = await batchShift('PROC-4', from2);
    await report(retry.shiftId, { kind: 'outcome', outcomeId: 'batch_skip', note: 'fine', data: {} });
    await end(retry.shiftId);

    const final = (await owner('GET', `/api/intake/batches/${id}`)).batch;
    expect(final.status).toBe('done');
    expect(final.counts).toMatchObject({ done: 2, skipped: 2 });
    expect(final.items[0].cards[0]).toMatchObject({ projectKey: 'TOY' });
  });

  it('dismissing the question fails the item; cancel stops queued and waiting items but not those in flight', async () => {
    const { batch } = await owner(
      'POST',
      '/api/intake/batches',
      { tickets: ['CAN-1', 'CAN-2', 'CAN-3', 'CAN-4'] },
      201,
    );
    const id = batch.id as string;
    const from = r.received.length;
    const s1 = await batchShift('CAN-1', from);
    const s2 = await batchShift('CAN-2', from);
    await report(s1.shiftId, {
      kind: 'outcome',
      outcomeId: 'batch_ask',
      note: 'q',
      data: { question: 'Which project?' },
    });
    await end(s1.shiftId);
    const desk = (
      await q(
        `SELECT id FROM desk_items WHERE subkind='batch_question' AND status='open' ORDER BY created_at DESC`,
      )
    )[0] as any;
    await owner('POST', `/api/desk/${desk.id}/dismiss`, {});
    expect(await statusOf(id, 'CAN-1')).toBe('failed');

    // CAN-3 starts and asks; CAN-2 is still in flight; CAN-4 is queued.
    const s3 = await batchShift('CAN-3', from);
    await report(s3.shiftId, {
      kind: 'outcome',
      outcomeId: 'batch_ask',
      note: 'q',
      data: { question: 'Again?' },
    });
    await end(s3.shiftId);
    expect(await statusOf(id, 'CAN-3')).toBe('waiting');
    const waitingDesk = (await items(id)).find((i) => i.external_key === 'CAN-3').desk_item_id;

    const cancelled = (await owner('POST', `/api/intake/batches/${id}/cancel`)).batch;
    expect(cancelled.status).toBe('cancelled');
    expect(await statusOf(id, 'CAN-4')).toBe('cancelled');
    expect(await statusOf(id, 'CAN-3')).toBe('cancelled');
    expect(await statusOf(id, 'CAN-2')).toBe('reading');
    expect((await q('SELECT status FROM desk_items WHERE id=$1', [waitingDesk]))[0]?.status).not.toBe('open');
    expect(await q(`SELECT status FROM ba_tasks WHERE batch_id=$1 AND status='queued'`, [id])).toHaveLength(
      0,
    );
    await owner('POST', `/api/intake/batches/${id}/cancel`, undefined, 409);

    // The one in flight finishes and its result counts.
    await rpc(s2.shiftId, 'intake.map', { project: 'TOY' });
    const c = await rpc(s2.shiftId, 'card.create', draft('Implement CAN-2'));
    await rpc(s2.shiftId, 'card.specify', { ref: c.result.ref });
    expect(
      (await report(s2.shiftId, { kind: 'outcome', outcomeId: 'batch_done', note: 'x', data: {} })).accepted,
    ).toBe(true);
    await end(s2.shiftId);
    expect(await statusOf(id, 'CAN-2')).toBe('done');
  });

  it('with a project chosen for the batch every ticket is mapped and the BA cannot change it', async () => {
    const { batch } = await owner(
      'POST',
      '/api/intake/batches',
      { tickets: ['PRJ-1'], projectId: w.projectId },
      201,
    );
    expect(batch.projectKey).toBe('TOY');
    const s = await batchShift('PRJ-1');
    expect(s.baTask.batch.projectKey).toBe('TOY');
    expect((await rpc(s.shiftId, 'intake.map', { project: 'OTHER' })).error).toMatch(/chose project TOY/);
    const c = await rpc(s.shiftId, 'card.create', draft('Implement PRJ-1'));
    expect(c.ok).toBe(true);
    await report(s.shiftId, { kind: 'outcome', outcomeId: 'batch_fail', note: 'stop', data: {} });
    await end(s.shiftId);
  });

  it('a task no BA can take fails its item', async () => {
    const { batch } = await owner('POST', '/api/intake/batches', { tickets: ['NOBA-1'] }, 201);
    await q(`UPDATE ba_tasks SET attempts = 2 WHERE batch_id=$1`, [batch.id]);
    await dispatcher().runPass();
    await until(async () => (await statusOf(batch.id, 'NOBA-1')) === 'failed', 3000, 'failed');
    expect((await items(batch.id))[0].reason).toMatch(/no BA/);
  });
});

describe('rebuild', () => {
  it('reproduces batches and items', async () => {
    const snap = async () => {
      const out: Record<string, string[]> = {};
      for (const t of ['intake_batches', 'intake_batch_items', 'ba_tasks'])
        out[t] = (await q(`SELECT (to_jsonb(t) - 'attempts')::text AS j FROM "${t}" t`))
          .map((x: any) => x.j)
          .sort();
      return out;
    };
    expect(PROJECTION_TABLES).toContain('intake_batch_items');
    const before = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
