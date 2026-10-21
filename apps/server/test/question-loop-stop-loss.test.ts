import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLoops } from '../src/ceo/detectors.ts';
import { questionShiftCount } from '../src/commands/loop-breaker.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, type World } from './helpers/world.ts';

/** The stop-loss arbitration (asked by the system, answered by the architect) is not the card asking: it does not count toward the question loop. */

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
const agentId = async (name: string) =>
  (await q('SELECT id FROM agents WHERE name=$1', [name]))[0]!.id as string;
const loopsOf = async (cardId: string) =>
  (await detectLoops(w.t.app.ctx.pool)).filter((l) => l.fingerprint === `loop:questions:${cardId}`);
const countNow = (cardId: string) =>
  questionShiftCount(w.t.app.ctx.pool, cardId, new Date(Date.now() - 3_600_000));

const ask = (shiftId: string, over: Record<string, unknown> = {}) =>
  p.report(r, shiftId, {
    kind: 'question',
    text: 'Should the retry delay be 5 seconds or 10 seconds?',
    options: [],
    doing: 'writing the retry loop',
    blocking: true,
    ...over,
  });

async function nextShift(name: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
    await r.barrier();
    await p.dispatcher().run();
    const found = r.received
      .slice(fromFrame)
      .find(
        (f: any) =>
          f.type === 'shift.start' && f.kind === 'card' && !taken.has(f.shiftId) && f.agent.name === name,
      ) as any;
    if (found) {
      taken.add(found.shiftId);
      return found;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for a shift for ${name}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

async function shiftRows(itemId: string, n: number, agent: string) {
  for (let i = 0; i < n; i++)
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, outcome, runtime, model, started_at, ended_at, desk_item_id)
       SELECT $1, org_id, $2, workstation_id, NULL, 'question', 'ended', 'reported', runtime, model, now(), now(), $3 FROM agents WHERE id=$2`,
      [randomUUID(), agent, itemId],
    );
}

describe('the stop-loss arbitration', () => {
  it('does not count for the loop breaker or the detector, and an agent question still does', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Arch', 'architect', 'senior');
    const card = await w.card({ title: 'Stop-loss card' });
    const arch = await agentId('Arch');

    // an answered arbitration, asked by the system (asked_by_kind defaults to 'system'), routed to the architect
    const stopId = randomUUID();
    await q(
      `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, subkind, status, routed_to, routed_agent_id, title, created_at, updated_at)
       SELECT $1, c.org_id, c.project_id, c.id, 'question', 'stop_loss', 'answered', 'agent', $3,
              'used its review rounds budget', now(), now() FROM cards c WHERE c.id = $2`,
      [stopId, card.id, arch],
    );
    await shiftRows(stopId, 5, arch);
    expect(await loopsOf(card.id)).toHaveLength(0);
    expect(await countNow(card.id)).toBe(0);

    // the next question of the builder is accepted, no back-off
    const start = await nextShift('Bea');
    await p.startShift(r, start);
    const res = await ask(start.shiftId, { text: 'Which retry delay do you want for the 4 uploads?' });
    expect(res).toMatchObject({ accepted: true });
    expect((await cardRow(card.id)).retry_failures).toBe(0);
    expect((await itemsOf(card.id)).filter((i) => i.subkind === 'loop_backoff')).toHaveLength(0);

    // control: 5 reported shifts on the builder's own question still trip the detector
    const own = (await itemsOf(card.id)).find((i) => i.asked_by_kind === 'agent')!;
    await shiftRows(own.id, 5, await agentId('Bea'));
    const loops = await loopsOf(card.id);
    expect(loops).toHaveLength(1);
    expect(loops[0]!.count).toBe(5);
  });
});
