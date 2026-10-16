import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint, graduate, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Backlog #82: after the #79 deploy production had 12 failed CEO batches without an outcome (stopped by the old server)
// from the minutes before. They counted against maxWakesPerHour (12), so for an hour the dispatcher started nothing,
// said nothing, and the Overview showed an idle CEO.

let w: World;
let r: FakeRunner;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await graduate(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string) => w.t.req(method, url, { cookie: w.owner.cookie });
const status = () => ok<any>(owner('GET', '/api/ceo/status'));

async function clean() {
  await q(`TRUNCATE ceo_wakes, ceo_batches, ceo_flags`);
  await q(`DELETE FROM desk_items WHERE subkind IN ('ceo_notice','ceo_report')`);
  await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
  await keepOnline(w);
}

/** `n` failed batches started a few minutes ago, as the production table had them. */
async function failedBatches(n: number, outcome: string | null, error: string | null = null) {
  const agentId = (await q(`SELECT agent_id FROM ceo_settings WHERE org_id=$1`, [w.owner.id]))[0]!.agent_id;
  for (let i = 0; i < n; i++)
    await q(
      `INSERT INTO ceo_batches (id, org_id, agent_id, shift_id, purpose, status, attempts, outcome, error, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'wake', 'failed', 0, $3, $4, $5, $5)`,
      [w.owner.id, agentId, outcome, error, new Date(w.t.clock.now().getTime() - (10 + i) * 1000)],
    );
}

describe('the hourly wake limit', () => {
  it('is not used up by batches that were stopped or ended with no recorded outcome (the production state)', async () => {
    await clean();
    await failedBatches(12, null);
    await wakeNow(w, 'desk_item', 'urgent');
    const s = await startCeoShift(w, r, r.received.length); // refused by the cap before the fix
    expect((await status()).waiting).toBeNull();
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });

  it('is not used up by stopped batches either, and they do not raise a failure notice', async () => {
    await clean();
    await failedBatches(12, 'stopped', 'the shift was stopped');
    await wakeNow(w, 'desk_item', 'urgent');
    const s = await startCeoShift(w, r, r.received.length);
    expect((await status()).lastError).toBeNull();
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });

  it('counts batches that really ran, and then says so: the limit and when the next shift may start', async () => {
    await clean();
    await failedBatches(12, 'crashed', 'the agent process crashed');
    await wakeNow(w, 'desk_item', 'urgent');
    const before = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    await r.barrier();
    expect(r.received.slice(before).filter((f: any) => f.type === 'shift.start')).toHaveLength(0);
    const s = await status();
    expect(s.pendingWakes).toBe(1);
    expect(s.waiting.text).toMatch(
      /^waiting: hourly limit reached \(12 of 12 shifts in the last hour\), next shift at \d\d:\d\d UTC$/,
    );
    expect(new Date(s.waiting.until).getTime()).toBeGreaterThan(w.t.clock.now().getTime());
  });

  it('a rejected shift shows the backoff and its end time', async () => {
    await clean();
    await failedBatches(1, 'rejected', 'busy: 4 shifts already running');
    await wakeNow(w, 'desk_item', 'urgent');
    const s = await status();
    expect(s.waiting.text).toMatch(
      /^waiting: backoff until \d\d:\d\d UTC after 1 shift the runner did not start \(busy: 4 shifts already running\)$/,
    );
  });

  it('an old server batch without outcome is neutral: no "unknown reason" failure', async () => {
    await clean();
    await failedBatches(5, null);
    expect((await status()).lastError).toBeNull();
    expect(await q(`SELECT 1 FROM desk_items WHERE title LIKE 'Your CEO cannot start%'`)).toHaveLength(0);
  });
});
