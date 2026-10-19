import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLoops } from '../src/reporter/detectors.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Question shifts the runner refused (outcome 'rejected', no agent ran) do not count toward the question loop. */

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

async function shiftRows(itemId: string, n: number, outcome: string) {
  const bea = await agentId('Bea');
  for (let i = 0; i < n; i++)
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, outcome, runtime, model, started_at, ended_at, desk_item_id)
       SELECT $1, org_id, $2, workstation_id, NULL, 'question', 'ended', $4, runtime, model, now(), now(), $3 FROM agents WHERE id=$2`,
      [randomUUID(), bea, itemId, outcome],
    );
}

describe('question shifts the runner refused', () => {
  it('do not count for the loop breaker or the detector', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Refused card' });
    const start = await nextShift('Bea');
    await p.startShift(r, start);
    const res = await ask(start.shiftId, { text: 'Which retry delay do you want for the 5 uploads?' });
    expect(res).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    const [item] = await itemsOf(card.id);
    await shiftRows(item!.id, 5, 'rejected');
    await shiftRows(item!.id, 4, 'reported');
    expect(
      (await detectLoops(w.t.app.ctx.pool)).filter((l) => l.fingerprint === `loop:questions:${card.id}`),
    ).toHaveLength(0);

    await ok(
      w.t.req('POST', `/api/desk/${item!.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Use 10 seconds.' },
      }),
    );
    const next = await nextShift('Bea');
    await p.startShift(r, next);
    const again = await ask(next.shiftId, {
      text: 'Is the cache directory per user or shared across workers?',
    });
    expect(again).toMatchObject({ accepted: true });
    expect((await cardRow(card.id)).retry_failures).toBe(0);
    expect((await itemsOf(card.id)).filter((i) => i.subkind === 'loop_backoff')).toHaveLength(0);
  });
});
