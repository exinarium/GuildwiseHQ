import { randomUUID } from 'node:crypto';
import { CEO_DIAGNOSTICS_CAPABILITY } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MIN_RUNNER_FOR_CEO_DIAGNOSTICS } from '../src/ceo/diagnostics.ts';
import { orderVersionHash } from '../src/ceo/orders.ts';
import { enqueueWake } from '../src/ceo/wakes.ts';
import { LogRing } from '../src/diagnostics/log-ring.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { appoint, ceo, keepOnline, startCeoShift } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Diagnostics in the CEO's full-power owner turn (docs/investigations/ceo-full-power.md): the server's status and logs and a
 * workstation's logs through its runner, read-only and masked. Every other mode keeps its refusal.
 */
let w: World;
let r: FakeRunner;
let b: Browser;
let threadId: string;
let orgId: string;
let current: any;
const FULL_POWER = ['ceo:1', 'ceo-full-power:1'];
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });

const connect = async (caps: string[] = [...FULL_POWER, CEO_DIAGNOSTICS_CAPABILITY]) => {
  r?.close();
  r = await w.connectRunner({ capabilities: caps });
  await keepOnline(w);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    w.workstationId,
    caps,
  ]);
  await q(`UPDATE workstations SET runner_version='0.1.65', connected=true WHERE id=$1`, [w.workstationId]);
};

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
  orgId = (await q(`SELECT id FROM organizations WHERE owner_user_id=$1 LIMIT 1`, [w.owner.id]))[0]!.id;
  threadId = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId;
  await connect();
  b = await Browser.open(w.baseUrl, w.owner.cookie);
  await b.hello();
});
afterAll(async () => {
  b.close();
  r.close();
  await w.t.close();
  await closeAdminPool();
});

let seq = 0;
async function openTurn() {
  const text = `diag turn ${++seq}`;
  b.send({ type: 'chat.send', threadId, body: text, clientMsgId: `m-${seq}-${Math.random()}` });
  current = (await r.waitFor('chat.start', (f: any) => f.message === text)) as any;
  return current;
}
const finish = async (start: any, extra: Record<string, unknown> = {}) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: 'done',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...extra,
  });
  await until(
    async () =>
      (await q(`SELECT 1 FROM ceo_turns WHERE id=$1 AND status='done'`, [start.chatId])).length === 1,
    5000,
    'turn done',
  );
};
afterEach(async () => {
  if (!current) return;
  if ((await q(`SELECT 1 FROM ceo_turns WHERE id=$1 AND status='running'`, [current.chatId])).length)
    await finish(current).catch(() => undefined);
  current = undefined;
});
const diag = (start: any, params: Record<string, unknown>) => ceo(r, start.chatId, { op: 'diag', ...params });

describe('LogRing', () => {
  it('keeps the newest lines, filters by level and text, and masks secrets when read', () => {
    const ring = new LogRing(5);
    for (let i = 0; i < 20; i++) ring.push(`${JSON.stringify({ level: i % 2 ? 50 : 30, msg: `m${i}` })}\n`);
    ring.push(`${JSON.stringify({ level: 40, msg: 'x', auth: 'Authorization: Bearer abcdefghijklmnop' })}\n`);
    expect(ring.size).toBe(5);
    expect(ring.read({ lines: 100, level: 'error' }).every((l) => l.includes('"level":50'))).toBe(true);
    const warn = ring.read({ lines: 100, level: 'warn' });
    expect(warn.join('\n')).not.toContain('"level":30');
    expect(warn.join('\n')).not.toContain('abcdefghijklmnop');
    expect(ring.read({ lines: 100, level: 'debug', grep: 'M19' })).toHaveLength(1);
    expect(ring.read({ lines: 2, level: 'debug' })).toHaveLength(2);
  });

  it('copies what the logger writes and passes it on', () => {
    const ring = new LogRing();
    const seen: string[] = [];
    ring.tee({ write: (c) => void seen.push(String(c)) }).write('{"level":30,"msg":"hi"}\n');
    expect(seen).toEqual(['{"level":30,"msg":"hi"}\n']);
    expect(ring.read({ lines: 5, level: 'info' })).toEqual(['{"level":30,"msg":"hi"}']);
  });
});

describe('server diagnostics in the owner full-power turn', () => {
  it('status and logs answer, with secrets masked', async () => {
    w.t.app.ctx.logRing?.push(
      `${JSON.stringify({ level: 50, msg: 'upload failed', headers: 'Authorization: Bearer abcdefghijklmnop1234' })}\n`,
    );
    const start = await openTurn();
    const status = await diag(start, { target: 'server', kind: 'status' });
    expect(status.ok).toBe(true);
    const s = JSON.parse(status.result.text);
    expect(s).toMatchObject({
      database: 'ok',
      ownerWorkstations: [{ connected: true, canAnswerDiagnostics: true }],
    });
    const logs = await diag(start, { target: 'server', kind: 'logs', level: 'error', grep: 'upload failed' });
    expect(logs.ok).toBe(true);
    expect(logs.result.text).toContain('upload failed');
    expect(logs.result.text).not.toContain('abcdefghijklmnop1234');
    const bad = await diag(start, { target: 'server', kind: 'nope' });
    expect(bad.ok).toBe(false);
    // the turn's finish records the permission mode and the command words (audit)
    await finish(start, {
      permissionMode: 'bypass',
      commands: ['aom graph find X', 'journalctl --user -u y'],
    });
    const fin = (
      await q(`SELECT payload FROM events WHERE type='CeoTurnFinished' AND payload->>'turnId'=$1`, [
        start.chatId,
      ])
    )[0]!.payload;
    expect(fin.permissionMode).toBe('bypass');
    expect(fin.commands).toEqual(expect.arrayContaining(['aom*1', 'journalctl*1']));
    expect(JSON.stringify(fin)).not.toContain('graph find X');
  });

  it('a wake shift (restricted) and a standing-order turn are refused', async () => {
    await q(`TRUNCATE ceo_wakes, ceo_batches`);
    await enqueueWake(
      w.t.app.ctx.pool,
      orgId,
      {
        reason: 'desk_item',
        urgency: 'urgent',
        subjectKind: 'test',
        subjectId: randomUUID(),
        subjectLabel: 't',
      },
      w.t.clock.now(),
    );
    const wake = await startCeoShift(w, r, r.received.length);
    for (const target of ['server', 'workstation']) {
      const res = await ceo(r, wake.shiftId, { op: 'diag', target, ref: 'x' });
      expect(res.ok, target).toBe(false);
      expect(res.error).toMatch(/owner's full-power chat/);
    }
    // an order turn
    const title = 'Look at logs';
    const body = 'alpha bravo then candle and delta until ember.';
    const created = await ok<any>(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: { scope: 'standing_order', title, body },
      }),
      201,
    );
    await ok(
      w.t.req('POST', `/api/ledger/${created.entry.id}/authorize`, {
        cookie: w.owner.cookie,
        body: { versionHash: orderVersionHash(title, body) },
      }),
    );
    const from = r.received.length;
    const inv = await ceo(r, wake.shiftId, {
      op: 'order',
      sub: 'invoke',
      entryId: created.entry.id,
      why: 'the event falls under the order',
      confidence: 0.9,
    });
    expect(inv.ok).toBe(true);
    const orderStart = (await r.waitFor('chat.start', (f: any) => f.ceoMode === 'order', 8000, from)) as any;
    const res = await ceo(r, orderStart.chatId, { op: 'diag', target: 'server', kind: 'logs' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/owner's full-power chat/);
    r.send('chat.done', {
      chatId: orderStart.chatId,
      threadId: orderStart.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await until(
      async () =>
        (await q(`SELECT 1 FROM ceo_turns WHERE id=$1 AND status='done'`, [orderStart.chatId])).length === 1,
      5000,
      'order turn done',
    );
    r.report(wake.shiftId, { kind: 'outcome', outcomeId: 'ceo_done', note: 'done', data: { summary: 'x' } });
    r.ended(wake.shiftId, 'reported');
    await r.barrier();
  });

  it('is refused when full power is off on the CEO workstation, with the reason', async () => {
    const start = await openTurn();
    await q(`UPDATE workstation_capabilities SET capabilities='{ceo:1}' WHERE workstation_id=$1`, [
      w.workstationId,
    ]);
    const res = await diag(start, { target: 'server', kind: 'status' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/full power is off on .* diagnostics are part of full power/);
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      w.workstationId,
      [...FULL_POWER, CEO_DIAGNOSTICS_CAPABILITY],
    ]);
  });
});

describe('workstation diagnostics through the runner', () => {
  const wsName = async () =>
    (await q(`SELECT name FROM workstations WHERE id=$1`, [w.workstationId]))[0]!.name;

  it('asks the runner without waiting for it, then collects its answer, masked again and read once', async () => {
    const start = await openTurn();
    const from = r.received.length;
    const asked = await diag(start, {
      target: 'workstation',
      ref: await wsName(),
      kind: 'service',
      lines: 50,
      grep: 'fail',
    });
    expect(asked.ok).toBe(true);
    expect(asked.result).toMatchObject({ status: 'pending' });
    const cmd = (await r.waitFor(
      'command',
      (f: any) => f.command === 'runner.diagnostics',
      8000,
      from,
    )) as any;
    expect(cmd.commandId).toBe(asked.result.requestId);
    expect(cmd.payload).toMatchObject({ kind: 'service', lines: 50, grep: 'fail' });
    // not answered yet
    expect((await diag(start, { target: 'workstation', requestId: cmd.commandId })).result).toMatchObject({
      status: 'pending',
    });
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        kind: 'service',
        text: 'Oct 31 upload failed token=abcdefghijklmnop1234',
        truncated: false,
        runnerVersion: '0.1.65',
      },
    });
    await until(
      async () =>
        (await q(`SELECT 1 FROM runner_commands WHERE id=$1 AND status='done'`, [cmd.commandId])).length ===
        1,
      5000,
      'answer stored',
    );
    const got = await diag(start, { target: 'workstation', requestId: cmd.commandId });
    expect(got.ok).toBe(true);
    expect(got.result.text).toContain('upload failed');
    expect(got.result.text).toContain('runner 0.1.65');
    expect(got.result.text).not.toContain('abcdefghijklmnop1234');
    // read once: the stored text is gone
    expect(
      (await q(`SELECT result FROM runner_commands WHERE id=$1`, [cmd.commandId]))[0]!.result,
    ).toBeNull();
    expect((await diag(start, { target: 'workstation', requestId: cmd.commandId })).result.text).toContain(
      'already collected',
    );
  });

  it('a runner older than the gate is told to update and nothing is queued; an unknown name lists the machines', async () => {
    const start = await openTurn();
    await q(`UPDATE workstations SET runner_version='0.1.64' WHERE id=$1`, [w.workstationId]);
    await q(`DELETE FROM runner_commands WHERE type='runner.diagnostics'`);
    const res = await diag(start, { target: 'workstation', ref: await wsName() });
    expect(res.ok).toBe(true);
    expect(res.result.text).toContain(`older than ${MIN_RUNNER_FOR_CEO_DIAGNOSTICS}`);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='runner.diagnostics'`)).toHaveLength(0);
    await q(`UPDATE workstations SET runner_version='0.1.65' WHERE id=$1`, [w.workstationId]);
    expect((await diag(start, { target: 'workstation', ref: 'no such machine' })).result.text).toContain(
      'no workstation of the Owner matches',
    );
  });

  it('an offline runner is said to be offline; a runner that fails is reported with its reason', async () => {
    const start = await openTurn();
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    expect((await diag(start, { target: 'workstation', ref: await wsName() })).result.text).toContain(
      'is offline',
    );
    await q(`UPDATE workstations SET connected=true WHERE id=$1`, [w.workstationId]);
    const from = r.received.length;
    const asked = await diag(start, { target: 'workstation', ref: await wsName(), kind: 'status' });
    const cmd = (await r.waitFor(
      'command',
      (f: any) => f.command === 'runner.diagnostics',
      8000,
      from,
    )) as any;
    r.send('command.result', { commandId: cmd.commandId, ok: false, error: 'journalctl is not installed' });
    await until(
      async () =>
        (await q(`SELECT 1 FROM runner_commands WHERE id=$1 AND status='failed'`, [cmd.commandId])).length ===
        1,
      5000,
      'failure stored',
    );
    expect(
      (await diag(start, { target: 'workstation', requestId: asked.result.requestId })).result.text,
    ).toContain('journalctl is not installed');
  });

  it("a CEO that runs on another user's machine (restricted profile) gets no diagnostics at all", async () => {
    const start = await openTurn();
    const row = (await q(`SELECT id FROM runner_commands WHERE type='runner.diagnostics' LIMIT 1`))[0];
    const other = await w.t.userSession(uniqueEmail('other-owner'));
    await q(`UPDATE workstations SET user_id=$2 WHERE id=$1`, [w.workstationId, other.id]);
    const res = await diag(start, { target: 'workstation', requestId: row!.id });
    await q(`UPDATE workstations SET user_id=$2 WHERE id=$1`, [w.workstationId, w.owner.id]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Owner's own workstation only/);
  });
});
