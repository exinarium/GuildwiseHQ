import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLoops } from '../src/ceo/detectors.ts';
import { questionShiftCount } from '../src/commands/loop-breaker.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, type World } from './helpers/world.ts';

/** One question passed on from the architect to the BA is one question for the loop breaker, not one per hop. */

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let fromFrame = 0;
const taken = new Set<string>();
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, project: {} });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

async function reset() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, runner_commands, runner_inbox, devops_requests, ceo_settings CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
  await q('UPDATE projects SET stop_loss = NULL');
  fromFrame = r.received.length;
}

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const itemsOf = (cardId: string) =>
  q('SELECT * FROM desk_items WHERE card_id=$1 ORDER BY created_at', [cardId]);

const ask = (shiftId: string, n: number) =>
  p.report(r, shiftId, {
    kind: 'question',
    topic: 'design',
    text: `Which layout does screen number ${n} use for its totals row, and why does it differ from the others?`,
    options: [],
    doing: `building screen ${n}`,
    blocking: false,
  });

/** The next shift of `kind` for `name` that nobody took yet, started. */
async function nextShift(name: string, kind: 'card' | 'question') {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
    await r.barrier();
    await p.dispatcher().run();
    const found = r.received
      .slice(fromFrame)
      .find(
        (f: any) =>
          f.type === 'shift.start' && f.kind === kind && f.agent.name === name && !taken.has(f.shiftId),
      ) as any;
    if (found) {
      taken.add(found.shiftId);
      await p.startShift(r, found);
      return found;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a ${kind} shift for ${name}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

describe('a question passed on between agents', () => {
  it('counts once, however many agents it passes through', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Ari', 'architect', 'senior');
    await w.hire('Ann', 'ba', 'senior');
    const card = await w.card({ title: 'Many questions' });
    const bea = await nextShift('Bea', 'card');

    for (let n = 1; n <= 3; n++) {
      expect(await ask(bea.shiftId, n)).toMatchObject({ accepted: true });
      const item = (await itemsOf(card.id)).at(-1)!;
      const ari = await nextShift('Ari', 'question');
      await p.report(r, ari.shiftId, { kind: 'escalate', itemId: item.id, note: 'not mine to decide' });
      r.ended(ari.shiftId, 'reported');
      const ann = await nextShift('Ann', 'question');
      await p.report(r, ann.shiftId, { kind: 'answer', itemId: item.id, text: 'Use the compact layout.' });
      r.ended(ann.shiftId, 'reported');
    }

    const hops = await q(
      `SELECT count(*)::int AS n FROM shifts WHERE kind='question' AND outcome='reported'`,
    );
    expect(hops[0]!.n).toBe(6);
    expect(await questionShiftCount(w.t.app.ctx.pool, card.id, new Date(0))).toBe(3);
    expect(
      (await detectLoops(w.t.app.ctx.pool)).filter((l) => l.fingerprint === `loop:questions:${card.id}`),
    ).toHaveLength(0);

    expect(await ask(bea.shiftId, 4)).toMatchObject({ accepted: true });
    expect((await cardRow(card.id)).retry_failures).toBe(0);
    expect((await itemsOf(card.id)).filter((i) => i.subkind === 'loop_backoff')).toHaveLength(0);
    r.ended(bea.shiftId, 'stopped');
  });
});
