import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sameJson } from '../src/reporter/same-json.ts';
import { pruneRunnerInbox, RUNNER_INBOX_RETENTION_DAYS } from '../src/runner-gateway/inbox-prune.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

// Lean Team v3 (S1b), section 9: "No-op BaSignalUpdated events" and the other event noise.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('sameJson', () => {
  it('compares deeply and does not depend on key order', () => {
    expect(
      sameJson(
        { a: 1, b: { c: [1, { x: 1, y: 2 }], d: 'e' } },
        { b: { d: 'e', c: [1, { y: 2, x: 1 }] }, a: 1 },
      ),
    ).toBe(true);
    expect(sameJson({ a: 1, u: undefined }, { a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: [] }, { a: {} })).toBe(false);
  });
});

describe('BaSignalUpdated', () => {
  it('a sweep that finds the same condition again writes no event, even when jsonb reordered the keys', async () => {
    const card = await w.card({ title: 'Looping builder' });
    await q(`UPDATE cards SET retry_after=$2, retry_failures=4, retry_episode_id=$3 WHERE id=$1`, [
      card.id,
      new Date(w.t.clock.now().getTime() + 600_000),
      randomUUID(),
    ]);
    const reporter = w.t.app.ctx.services.reporter;
    const count = async (type: string) =>
      Number((await q(`SELECT count(*)::int AS n FROM events WHERE type=$1`, [type]))[0]?.n);
    await reporter.run();
    expect(await count('BaSignalRaised')).toBeGreaterThanOrEqual(1);
    const signal = (await q(`SELECT id, subject FROM ba_signals WHERE status <> 'resolved' LIMIT 1`))[0]!;
    // jsonb keeps its own key order (shorter keys first): the stored subject has a different order than a fresh one
    expect(Object.keys(signal.subject).join()).not.toBe(
      Object.keys({ title: 1, detail: 1, cardId: 1 }).join(),
    );
    const before = await count('BaSignalUpdated');
    await reporter.run();
    await reporter.run();
    expect(await count('BaSignalUpdated')).toBe(before);
  });
});

describe('runner inbox', () => {
  it('rows older than 7 days are pruned, newer ones stay', async () => {
    const day = 86_400_000;
    const at = (days: number) => new Date(w.t.clock.now().getTime() - days * day);
    const ids = { old: randomUUID(), edge: randomUUID(), fresh: randomUUID() };
    for (const [k, days] of [
      ['old', RUNNER_INBOX_RETENTION_DAYS + 1],
      ['edge', RUNNER_INBOX_RETENTION_DAYS - 1],
      ['fresh', 0],
    ] as const)
      await q('INSERT INTO runner_inbox (message_id, workstation_id, received_at) VALUES ($1,$2,$3)', [
        ids[k],
        w.workstationId,
        at(days),
      ]);
    expect(await pruneRunnerInbox(w.t.app.ctx)).toBeGreaterThanOrEqual(1);
    const left = (await q('SELECT message_id FROM runner_inbox')).map((r) => r.message_id);
    expect(left).not.toContain(ids.old);
    expect(left).toContain(ids.edge);
    expect(left).toContain(ids.fresh);
  });
});
