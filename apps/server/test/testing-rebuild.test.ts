import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

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

const OPERATIONAL: Record<string, string[]> = {
  users: ['last_login_at'],
  workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
  cards: ['lease_expires_at'],
  shifts: ['progress_tail', 'accepted_at'],
  card_transitions: ['id'],
  test_runs: ['id'],
};
async function snapshot() {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
    out[table] = (await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`))
      .map((x) => x.j as string)
      .sort();
  }
  return out;
}

describe('M4 projections', () => {
  it('rebuild from events equals the live state (bug loop, finalize, suite, regression)', async () => {
    const p = pipeline(w, r);
    await hireTeam(w);
    const card = await w.card({ title: 'Replayed' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testFail('Replay bug'));
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'fix', data: {} });
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    const from = r.received.length;
    await ok(w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc' },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'finalized');
    await p.run('Tess', testFail('Suite bug'));
    await ok(
      w.t.req('POST', `/api/projects/${w.projectId}/regression`, {
        cookie: w.owner.cookie,
        body: { platform: 'both' },
      }),
      201,
    );
    await w.t.app.ctx.notifier.flush();

    const before = await snapshot();
    expect(before.test_runs?.length).toBeGreaterThanOrEqual(3);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await snapshot();
    for (const t of PROJECTION_TABLES) expect(after[t], t).toEqual(before[t]);
  });
});
