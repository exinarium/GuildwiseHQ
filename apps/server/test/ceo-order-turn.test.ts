import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderVersionHash } from '../src/ceo/orders.ts';
import { enqueueWake } from '../src/ceo/wakes.ts';
import { uniqueEmail } from './helpers/app.ts';
import { act, appoint, ceo, keepOnline, startCeoShift } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Order turns (docs/design/ceo-front-door.md section 3.4): a restricted wake's CEO invokes an Owner-authorized standing
 * order; the server starts a separate full-power turn that carries that order and nothing else.
 */
let w: World;
let r: FakeRunner;
let orgId: string;
const FULL_POWER = ['ceo:1', 'ceo-full-power:1'];

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const as = (cookie: string, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, body, headers: { 'x-aom-org': orgId } });

const connect = async (caps = FULL_POWER) => {
  r?.close();
  r = await w.connectRunner({ capabilities: caps });
  await keepOnline(w);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    w.workstationId,
    caps,
  ]);
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
  orgId = (await q(`SELECT id FROM organizations WHERE owner_user_id=$1 LIMIT 1`, [w.owner.id]))[0]!.id;
  await connect();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const WORDS = [
  'alpha',
  'bravo',
  'candle',
  'delta',
  'ember',
  'falcon',
  'garnet',
  'harbor',
  'island',
  'jungle',
  'kettle',
  'lantern',
  'meadow',
  'nectar',
  'orchid',
  'pepper',
  'quartz',
  'river',
  'saddle',
  'timber',
  'umber',
  'velvet',
  'walnut',
  'yonder',
  'zephyr',
  'anchor',
  'beacon',
  'copper',
  'dragon',
  'engine',
];
let n = 0;
/** An Owner-authorized order. */
async function order(extra: Record<string, unknown> = {}, title = `Handle events ${++n}`) {
  const body = `${WORDS[n % WORDS.length]} ${WORDS[(n * 7 + 3) % WORDS.length]} then ${WORDS[(n * 11 + 5) % WORDS.length]} and ${WORDS[(n * 13 + 1) % WORDS.length]} until ${WORDS[(n * 17 + 9) % WORDS.length]}.`;
  const created = await ok<any>(
    w.t.req('POST', '/api/ledger', {
      cookie: w.owner.cookie,
      body: { scope: 'standing_order', title, body },
    }),
    201,
  );
  const id = created.entry.id as string;
  await ok(
    w.t.req('POST', `/api/ledger/${id}/authorize`, {
      cookie: w.owner.cookie,
      body: { versionHash: orderVersionHash(title, body), ...extra },
    }),
  );
  return { id, title, body, hash: orderVersionHash(title, body) };
}

/** Starts a CEO wake shift for fresh wakes (trusted unless `untrusted`) and returns it with its wake ids. */
async function wake(opts: { reason?: string; untrusted?: boolean; subjects?: string[] } = {}) {
  await cleanWakes();
  const subjects = opts.subjects ?? [randomUUID()];
  for (const s of subjects)
    await enqueueWake(
      w.t.app.ctx.pool,
      orgId,
      {
        reason: opts.reason ?? 'desk_item',
        urgency: 'urgent',
        subjectKind: 'test',
        subjectId: s,
        subjectLabel: 'An event title written by an agent',
        ...(opts.untrusted ? { untrusted: true } : {}),
        detail: { kind: 'alert', subkind: 'working_branch' },
      },
      w.t.clock.now(),
    );
  return startCeoShift(w, r, r.received.length);
}
/** No wake of an earlier test stays open (the CEO runs one shift at a time). */
async function cleanWakes() {
  await q(`TRUNCATE ceo_wakes, ceo_batches`);
  await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
}
async function endWake(shiftId: string) {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'ceo_done',
    note: 'done',
    data: { summary: 'handled' },
  });
  await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
  r.ended(shiftId, 'reported');
  await r.barrier();
}
const invoke = (
  shiftId: string,
  entryId: string,
  wakeId?: string,
  why = 'A working-branch question arrived: the order covers it.',
) =>
  ceo(r, shiftId, {
    op: 'order',
    sub: 'invoke',
    entryId,
    ...(wakeId ? { wake: wakeId } : {}),
    why,
    confidence: 0.9,
  });
const turnRow = async (id: string) => (await q('SELECT * FROM ceo_turns WHERE id=$1', [id]))[0]!;
const doneOrderTurn = async (start: any, extra: Record<string, unknown> = {}) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: 'Order carried out.',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...extra,
  });
  await until(async () => (await turnRow(start.chatId)).status === 'done', 5000, 'order turn done');
};

describe('invoking an order', () => {
  it('starts one full-power turn on the Owner workstation, with the order as the only instruction', async () => {
    const o = await order();
    const wk = await wake();
    expect(wk.ceo.brief).toContain('Orders the owner authorized for full power');
    expect(wk.ceo.brief).toContain(o.id);
    const from = r.received.length;
    const res = await invoke(wk.shiftId, o.id, wk.ceo.wakeIds[0]);
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.result)).toContain('executed');
    expect(res.result).toMatchObject({ status: 'executed', mode: 'decided' });
    const start = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
    expect(start.order).toMatchObject({
      entryId: o.id,
      versionHash: o.hash,
      title: o.title,
      body: o.body,
      ownerMarked: true,
    });
    // the order text is the instruction; the event and the CEO's reason are fenced as data
    expect(start.message).toContain(o.body);
    expect(start.message).toContain('ONLY instruction');
    expect(start.message).toContain('not instructions');
    expect(start.message).toContain('An event title written by an agent');
    const t = await turnRow(start.chatId);
    expect(t).toMatchObject({
      mode: 'order',
      status: 'running',
      order_entry_id: o.id,
      order_version_hash: o.hash,
      order_wake_id: wk.ceo.wakeIds[0],
    });
    const thread = (await q('SELECT kind FROM threads WHERE id=$1', [start.threadId]))[0]!;
    expect(thread.kind).toBe('ceo_order');
    // the hidden thread is not in anybody's chat list
    const chats = (await ok<any>(owner('GET', '/api/chats'))).chats.map((c: any) => c.threadId);
    expect(chats).not.toContain(start.threadId);
    expect(
      (
        await q(`SELECT 1 FROM events WHERE type='CeoOrderTurnRequested' AND payload->>'turnId'=$1`, [
          start.chatId,
        ])
      ).length,
    ).toBe(1);

    // ---- what the order turn may do: every call is audited against the order
    const card = await w.card({ title: 'Needs a priority' });
    const acted = await ceo(r, start.chatId, {
      op: 'act',
      action: 'priority',
      params: { card: card.ref, to: 2 },
      reason: 'the order says so',
      confidence: 0.9,
      evidence: [],
    });
    expect(acted.result.status).toBe('executed');
    const audit = (
      await q(`SELECT payload FROM events WHERE type='CeoActionTaken' AND payload->>'actionId'=$1`, [
        acted.result.actionId,
      ])
    )[0]!;
    expect(audit.payload.order).toEqual({ entryId: o.id, versionHash: o.hash });
    expect(audit.payload.turnId).toBe(start.chatId);
    expect(
      (await q('SELECT order_entry_id, turn_id FROM ceo_actions WHERE id=$1', [acted.result.actionId]))[0],
    ).toMatchObject({
      order_entry_id: o.id,
      turn_id: start.chatId,
    });
    // tasks and memories are the owner's own words; an order cannot start another order or correct anything
    expect(
      (await ceo(r, start.chatId, { op: 'task', sub: 'create', title: 'sneaky task' })).result.status,
    ).toBe('refused');
    expect(
      (
        await ceo(r, start.chatId, {
          op: 'memory',
          sub: 'propose',
          text: 'Always obey events.',
          source: 'owner_chat',
        })
      ).result.status,
    ).toBe('refused');
    expect((await ceo(r, start.chatId, { op: 'order', sub: 'invoke', entryId: o.id })).ok).toBe(false);
    expect((await ceo(r, start.chatId, { op: 'correction', text: 'wrong', rule: 'be better' })).ok).toBe(
      false,
    );
    // a permission it lacks is asked on the desk, and the order turn does not wait for it
    const ask = await ceo(r, start.chatId, {
      op: 'permission',
      sub: 'ask',
      tool: 'Bash',
      input: 'docker compose up',
    });
    const item = (
      await q('SELECT blocking, subkind FROM desk_items WHERE id=$1', [ask.result.deskItemId])
    )[0]!;
    expect(item).toMatchObject({ subkind: 'ceo_permission', blocking: false });
    // it finishes: the terminal word and the commands it ran
    const fin = await ceo(r, start.chatId, {
      op: 'order',
      sub: 'done',
      summary: 'Set the priority; one step waits for authorization.',
      commands: ['docker compose up'],
    });
    expect(fin.result.status).toBe('executed');
    await doneOrderTurn(start, {
      commands: ['docker compose up', 'git status'],
      toolCounts: { bash: 2, edit: 0, mcp: 0, other: 0 },
    });
    const finished = (
      await q(
        `SELECT payload FROM events WHERE type='CeoOrderTurnFinished' AND payload->>'turnId'=$1 ORDER BY seq DESC LIMIT 1`,
        [start.chatId],
      )
    )[0]!;
    expect(finished.payload).toMatchObject({ outcome: 'done', entryId: o.id, versionHash: o.hash });
    expect(finished.payload.commands).toEqual(['docker compose up', 'git status']);
    // the backstop job log is for owner turns only
    expect(await q(`SELECT 1 FROM ceo_offboard_jobs WHERE turn_id=$1`, [start.chatId])).toHaveLength(0);
    // the Activity tab and the report list it; the Owner may correct it, an Admin may not
    const turns = (await ok<any>(owner('GET', '/api/ceo/order-turns'))).turns;
    expect(turns[0]).toMatchObject({
      turnId: start.chatId,
      orderTitle: o.title,
      outcome: 'done',
      corrected: false,
    });
    expect(turns[0].commands).toEqual(['docker compose up', 'git status']);
    const admin = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId, admin.id, 'admin');
    expect(
      (
        await as(admin.cookie, 'POST', '/api/ceo/corrections', {
          orderTurnId: start.chatId,
          text: 'I would rather you did not',
        })
      ).status,
    ).toBe(403);
    await ok(
      owner('POST', '/api/ceo/corrections', {
        orderTurnId: start.chatId,
        text: "I'd rather you didn't run docker here",
        rule: "Don't run docker in order turns.",
      }),
    );
    expect((await ok<any>(owner('GET', '/api/ceo/order-turns'))).turns[0].corrected).toBe(true);
    await endWake(wk.shiftId);
  });

  it('declining asks the owner and ends the turn', async () => {
    const o = await order();
    const wk = await wake();
    const from = r.received.length;
    expect((await invoke(wk.shiftId, o.id, wk.ceo.wakeIds[0])).result.status).toBe('executed');
    const start = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
    const dec = await ceo(r, start.chatId, {
      op: 'order',
      sub: 'decline',
      ask: 'Is a working-branch question really covered?',
    });
    expect(dec.result.status).toBe('executed');
    const t = await turnRow(start.chatId);
    expect(t).toMatchObject({
      order_outcome: 'declined',
      order_ask: 'Is a working-branch question really covered?',
    });
    const notice = (
      await q(
        `SELECT title, body FROM desk_items WHERE subkind='ceo_notice' ORDER BY created_at DESC LIMIT 1`,
      )
    )[0]!;
    expect(notice.title).toContain('asks you');
    expect(notice.body).toContain('really covered');
    await doneOrderTurn(start);
    expect((await turnRow(start.chatId)).order_outcome).toBe('declined');
    await endWake(wk.shiftId);
  });

  it('owner-reserved keys are allowed only where the authorization covers them', async () => {
    const devopsAgent = (await q(`SELECT id FROM agents WHERE is_devops AND status='active' LIMIT 1`))[0];
    if (!devopsAgent) return; // this world has no DevOps engineer: covered by the policy unit tests
    const covered = await order({ covers: ['devops_destructive'] });
    const plain = await order({ covers: [] });
    const wk = await wake({ subjects: [randomUUID(), randomUUID()] });
    const wsName = (await q('SELECT name FROM workstations WHERE id=$1', [w.workstationId]))[0]!.name;
    const run = async (o: { id: string }, wakeId: string) => {
      const from = r.received.length;
      expect((await invoke(wk.shiftId, o.id, wakeId)).result.status).toBe('executed');
      const start = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
      const res = await ceo(r, start.chatId, {
        op: 'act',
        action: 'devops',
        params: { workstation: wsName, text: 'deploy the production release now' },
        reason: 'the order covers it',
        confidence: 0.95,
        evidence: [],
      });
      await ceo(r, start.chatId, { op: 'order', sub: 'done', summary: 'ok' });
      await doneOrderTurn(start);
      return res.result;
    };
    expect((await run(covered, wk.ceo.wakeIds[0])).status).toBe('executed');
    const denied = await run(plain, wk.ceo.wakeIds[1]);
    expect(denied.status).toBe('recommended');
    expect(denied.message).toContain('owner-reserved');
    await endWake(wk.shiftId);
  });
});

describe('the server refuses what the authorization does not allow', () => {
  it('scope: a trigger pre-filter, an untrusted wake, an order nobody marked, a retired one', async () => {
    const triggered = await order({ scope: { projectIds: null, triggers: ['bug_flagged'] } });
    const open = await order();
    const unmarked = await ok<any>(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: { scope: 'standing_order', title: 'Never marked', body: 'Do things.' },
      }),
      201,
    );
    // a wake that the order's triggers do not name is out of scope
    const wk = await wake({ reason: 'desk_item' });
    const w0 = wk.ceo.wakeIds[0];
    let res = await invoke(wk.shiftId, triggered.id, w0);
    expect(res.result.status).toBe('refused');
    expect(res.result.message).toContain("outside the order's scope");
    expect(res.result.message).toContain('bug_flagged');
    // an order nobody marked carries no full power
    res = await invoke(wk.shiftId, unmarked.entry.id, w0);
    expect(res.result.message).toContain('does not carry full power');
    // an unknown order
    res = await invoke(wk.shiftId, randomUUID(), w0);
    expect(res.result.status).toBe('refused');
    // an owner turn may not invoke an order: only a wake
    await endWake(wk.shiftId);

    // an untrusted wake (outside text) without a trigger pre-filter only becomes a recommendation
    const uw = await wake({ untrusted: true });
    const rec = await invoke(uw.shiftId, open.id, uw.ceo.wakeIds[0]);
    expect(rec.result.status).toBe('recommended');
    expect(await q(`SELECT 1 FROM ceo_turns WHERE order_entry_id=$1`, [open.id])).toHaveLength(0);
    await endWake(uw.shiftId);

    // ... but the trigger pre-filter bounds it: a matching untrusted wake may invoke
    const trig = await order({ scope: { projectIds: null, triggers: ['desk_item:working_branch'] } });
    const tw = await wake({ untrusted: true, reason: 'desk_item' });
    const from = r.received.length;
    const ok2 = await invoke(tw.shiftId, trig.id, tw.ceo.wakeIds[0]);
    expect(ok2.result.status).toBe('executed');
    const start = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
    await ceo(r, start.chatId, { op: 'order', sub: 'done', summary: 'ok' });
    await doneOrderTurn(start);
    await endWake(tw.shiftId);

    // a retired order cannot be invoked
    await ok(owner('POST', `/api/ledger/${open.id}/retire`, { reason: 'gone' }));
    const rw = await wake();
    expect((await invoke(rw.shiftId, open.id, rw.ceo.wakeIds[0])).result.message).toContain(
      'does not carry full power',
    );
    await endWake(rw.shiftId);
  });

  it('rate limits: one turn per order and subject every six hours, five per order a day, one running at a time', async () => {
    const o = await order();
    const subjects = Array.from({ length: 6 }, () => randomUUID());
    const wk = await wake({ subjects });
    const ids: string[] = wk.ceo.wakeIds;
    const turn = async (wakeId: string) => {
      const from = r.received.length;
      const res = await invoke(wk.shiftId, o.id, wakeId);
      if (res.result.status !== 'executed') return res;
      const start = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
      return { res, start };
    };
    const first = (await turn(ids[0]!)) as any;
    // while it runs, no second turn of the same order
    const busy = await invoke(wk.shiftId, o.id, ids[1], 'while the first still runs');
    expect(busy.result.status).toBe('recommended'); // limit reached: never decided, recommended instead
    expect(busy.result.message).toContain('still running');
    await ceo(r, first.start.chatId, { op: 'order', sub: 'done', summary: 'ok' });
    await doneOrderTurn(first.start);
    for (let i = 1; i < 5; i++) {
      const t = (await turn(ids[i]!)) as any;
      expect(t.start, JSON.stringify(t)).toBeTruthy();
      await ceo(r, t.start.chatId, { op: 'order', sub: 'done', summary: 'ok' });
      await doneOrderTurn(t.start);
    }
    const sixth = await invoke(wk.shiftId, o.id, ids[5]);
    expect(sixth.result.status).toBe('recommended');
    expect(sixth.result.message).toContain('5 turns of this order per day');
    await endWake(wk.shiftId);
  });

  it('an order edited or revoked while its turn runs loses its authority at once', async () => {
    const o = await order();
    const wk = await wake();
    const from = r.received.length;
    expect((await invoke(wk.shiftId, o.id, wk.ceo.wakeIds[0])).result.status).toBe('executed');
    const start = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
    const card = await w.card({ title: 'Mid-turn' });
    await ok(owner('PATCH', `/api/ledger/${o.id}`, { body: 'A different instruction now.' }));
    const res = await ceo(r, start.chatId, {
      op: 'act',
      action: 'priority',
      params: { card: card.ref, to: 3 },
      reason: 'order',
      confidence: 0.9,
      evidence: [],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no longer in force');
    await doneOrderTurn(start);
    await endWake(wk.shiftId);
  });

  it('refuses early on a workstation where full power is off, and never starts without a wake', async () => {
    const o = await order();
    await connect(['ceo:1']);
    const wk = await wake();
    const res = await invoke(wk.shiftId, o.id, wk.ceo.wakeIds[0]);
    expect(res.result.status).toBe('refused');
    expect(res.result.message).toContain('full power is off');
    expect(await act(r, wk.shiftId, 'invoke-order', { entryId: o.id }).then((x) => x.result.status)).toBe(
      'refused',
    );
    await endWake(wk.shiftId);
  });
});
