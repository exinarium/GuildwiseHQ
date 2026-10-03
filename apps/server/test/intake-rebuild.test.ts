import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let h: ReturnType<typeof shiftHelpers>;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  h = shiftHelpers(w);
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const OPERATIONAL: Record<string, string[]> = {
  users: ['last_login_at'],
  workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
  cards: ['lease_expires_at'],
  shifts: ['progress_tail', 'accepted_at'],
  card_transitions: ['id'],
};
async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
    const list = await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`);
    out[table] = list.map((x) => x.j as string).sort();
  }
  return out;
}

describe('projection rebuild', () => {
  it('reproduces trails, agent answers, question shifts, intakes and their cards', async () => {
    r = await w.connectRunner();
    for (const [name, role, seniority] of [
      ['Bea', 'builder', 'junior'],
      ['Sam', 'builder', 'senior'],
      ['Ben', 'ba', 'senior'],
    ] as const)
      await w.hire(name, role, seniority);
    const card = await w.card();
    const asker = await h.dispatchTo(r, 'Bea');
    await h.startShift(r, asker);
    await h.report(r, asker.shiftId, {
      kind: 'question',
      text: 'Tabs or spaces?',
      options: ['tabs', 'spaces'],
      doing: 'x',
      blocking: true,
    });
    r.ended(asker.shiftId, 'reported');
    const it = (await q('SELECT * FROM desk_items WHERE card_id=$1', [card.id]))[0]!;
    const used = new Set<string>();
    const run = async (name: string, report: Record<string, unknown>) => {
      await h.dispatcher().run();
      const s = (await r.waitFor(
        'shift.start',
        (f) => f.agent.name === name && f.kind === 'question' && !used.has(f.shiftId),
        5000,
      )) as any;
      used.add(s.shiftId);
      await h.startShift(r, s);
      await h.report(r, s.shiftId, report);
      r.ended(s.shiftId, 'reported');
    };
    await run('Sam', { kind: 'escalate', itemId: it.id, note: 'ask the BA' });
    await run('Ben', { kind: 'answer', itemId: it.id, text: 'Tabs.' });
    // an intake with a mapped project and a card
    const from = r.received.length;
    const { intake } = await ok<any>(
      w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'ABC-5' } }),
      201,
    );
    const cs = (await r.waitFor('chat.start', (f) => f.threadId === intake.threadId, 5000, from)) as any;
    const call = async (method: string, params: Record<string, unknown>) => {
      const rpcId = randomUUID();
      const n = r.received.length;
      r.send('rpc.request', { rpcId, shiftId: cs.chatId, method, params });
      return r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 5000, n);
    };
    await call('intake.map', { project: 'TOY' });
    await call('card.create', {
      title: 'From intake',
      completionAction: 'pr',
      repo: 'toy',
      fields: {
        context: 'c',
        requirements: 'r',
        acceptanceCriteria: ['a'],
        affectedAreas: 'x',
        constraints: 'y',
        testPlan: 't',
      },
    });
    await w.t.app.ctx.notifier.flush();
    const before = await snapshot();
    expect(before.intakes).toHaveLength(1);
    expect(before.intake_cards).toHaveLength(1);
    expect(before.desk_items?.[0]).toContain('escalation_trail');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snapshot()).toEqual(before);
  });
});
