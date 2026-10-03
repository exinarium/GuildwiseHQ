import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
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
    const rows = await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`);
    out[table] = rows.map((r) => r.j as string).sort();
  }
  return out;
}

describe('projections:rebuild with the decision desk', () => {
  it('replays questions, answers, ledger entries and chat threads into identical tables', async () => {
    const h = shiftHelpers(w);
    const r = await w.connectRunner();
    const agent = await w.hire('Rae', 'builder', 'junior');
    await w.card({ title: 'Asks' });
    await w.card({ title: 'Cancelled with a question' });
    const start = await h.dispatchTo(r, 'Rae');
    await h.startShift(r, start);
    await h.report(r, start.shiftId, {
      kind: 'question',
      text: 'Which cache should we use?',
      options: ['redis', 'memory'],
      recommend: 1,
      doing: 'caching',
      blocking: true,
    });
    r.ended(start.shiftId, 'reported');
    const desk = await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }));
    await ok(
      w.t.req('POST', `/api/desk/${desk.items[0].id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'memory', optionId: 'o2', ledger: { scope: 'decision' } },
      }),
    );
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: {
          scope: 'standing_order',
          title: 'Be kind',
          body: 'Be kind in commit messages.',
          tags: ['tone'],
        },
      }),
      201,
    );
    // A second blocked question whose card is then cancelled (superseded), and a chat thread.
    const second = await h.dispatchTo(r, 'Rae', r.received.length - 1);
    await h.startShift(r, second);
    await h.report(r, second.shiftId, {
      kind: 'question',
      text: 'What colour is the bike shed?',
      options: [],
      doing: '',
      blocking: true,
    });
    await ok(
      w.t.req('POST', `/api/cards/${second.brief.card.id}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'drop' },
      }),
    );
    await ok(w.t.req('POST', '/api/chats', { cookie: w.owner.cookie, body: { agentId: agent.id } }), 201);
    await w.t.app.ctx.notifier.flush();

    const before = await snapshot();
    expect(before.desk_items).toHaveLength(2);
    expect(before.ledger_entries).toHaveLength(2);
    expect(before.threads!.some((t) => t.includes('"kind": "chat"'))).toBe(true);
    expect(before.card_blockers).toHaveLength(0);
    const res = await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(res.events).toBeGreaterThan(20);
    expect(await snapshot()).toEqual(before);
    r.close();
  });
});
