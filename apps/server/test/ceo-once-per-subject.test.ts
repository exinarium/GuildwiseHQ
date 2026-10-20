import { randomUUID } from 'node:crypto';
import { DEFAULT_CEO_MODELS, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueWake } from '../src/ceo/wakes.ts';
import { migrateCeoModels } from '../src/data-migrations/ceo-models.ts';
import {
  appoint,
  blockingQuestion,
  ceo,
  graduate,
  keepOnline,
  startCeoShift,
  wakeNow,
} from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Lean Team v3 (S1b), section 9: "CEO offline flapping", "CEO repeats reminders"; the CEO models.

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

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const wakes = (status?: string) =>
  q(`SELECT * FROM ceo_wakes ${status ? `WHERE status='${status}'` : ''} ORDER BY created_at`);
async function clean() {
  await q(`TRUNCATE ceo_wakes, ceo_batches, ceo_flags`);
  await q(`DELETE FROM desk_items WHERE subkind IN ('ceo_notice','ceo_report','bug_reported','manual_qa')`);
  await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
  await keepOnline(w);
}
async function finish(shiftId: string) {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'ceo_done',
    note: 'done',
    data: { summary: 'handled' },
  });
  await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(shiftId, 'reported');
  await r.barrier();
}

describe('once per subject', () => {
  it('a subject is woken for once per state: the same key and state is quiet, a new state wakes, a dropped wake is forgotten', async () => {
    await clean();
    const pool = w.t.app.ctx.pool;
    const now = w.t.clock.now();
    const wake = (state: string) =>
      enqueueWake(
        pool,
        w.owner.id,
        {
          reason: 'desk_item',
          urgency: 'normal',
          subjectKind: 'desk',
          subjectId: randomUUID(),
          dedupe: { key: 'card:X:desk:manual_qa', state },
        },
        now,
      );
    expect(await wake('qa/queued')).toBe(true);
    expect(await wake('qa/queued')).toBe(false);
    expect(await wake('qa/queued')).toBe(false);
    expect(await wake('done/done')).toBe(true);
    expect(await wakes()).toHaveLength(2);
    // when the first wake is dropped, the same state may wake again
    await q(`UPDATE ceo_wakes SET status='dropped' WHERE dedupe_state='qa/queued'`);
    expect(await wake('qa/queued')).toBe(true);
  });

  it('a card sitting in Manual QA raises one wake, however many items it raises, until the card moves on', async () => {
    await clean();
    const card = await w.card({ title: 'Waiting for QA' });
    const raise = async () => {
      const id = randomUUID();
      await seed(w, [
        {
          streamId: streamId.desk(id),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId: id,
              kind: 'alert',
              subkind: 'manual_qa',
              title: 'Waiting for QA',
              cardId: card.id,
              projectId: w.projectId,
              askedBy: { kind: 'system' },
            },
          },
          actor: { kind: 'system', id: null },
          scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
        },
      ]);
    };
    await raise();
    await until(async () => (await wakes()).length === 1, 3000, 'first wake');
    await raise();
    await raise();
    await new Promise((x) => setTimeout(x, 250));
    expect(await wakes()).toHaveLength(1);
    await q(`UPDATE cards SET stage='finalize' WHERE id=$1`, [card.id]);
    await raise();
    await until(async () => (await wakes()).length === 2, 3000, 'wake after the card moved');
  });

  it('the notify rpc dedupes by subject and state, not by wording; a changed card is a new subject state', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    const start = await startCeoShift(w, r, r.received.length);
    const { card, id } = await blockingQuestion(w, { title: 'Which cache should we use?' });
    const notify = (text: string) =>
      ceo(r, start.shiftId, { op: 'notify', kind: 'needs_you', text, item: id });
    const first = (await notify('Card is waiting for you, please decide.')) as any;
    expect(first.result.status).toBe('executed');
    const reworded = (await notify('A reminder: this card still needs your decision.')) as any;
    expect(reworded.result.status).toBe('duplicate');
    expect(await q(`SELECT 1 FROM ceo_flags WHERE flag LIKE 'once:card:%'`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_notice'`)).toHaveLength(1);
    // the card moved on: a new state is worth telling
    await q(`UPDATE cards SET stage='review' WHERE id=$1`, [card.id]);
    const again = (await notify('The card moved to review and still waits for you.')) as any;
    expect(again.result.status).toBe('executed');
    // one open desk item, with a counter (the same subject is one item)
    const items = await q(`SELECT repeat_count FROM desk_items WHERE subkind='ceo_notice'`);
    expect(items).toHaveLength(1);
    expect(items[0]?.repeat_count).toBe(2);
    await finish(start.shiftId);
  });
});

describe('"CEO offline" does not flap', () => {
  it('the notice is raised once until a CEO shift has actually run', async () => {
    await clean();
    const noticeItems = () => q(`SELECT id, repeat_count FROM desk_items WHERE subkind='ceo_notice'`);
    const flag = () => q(`SELECT 1 FROM ceo_flags WHERE flag='offline_notice'`);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    await wakeNow(w, 'signal:loop', 'urgent');
    await dispatcher().run();
    w.t.clock.advance(31 * 60_000);
    await dispatcher().run();
    await dispatcher().run();
    expect(await noticeItems()).toHaveLength(1);
    expect(await flag()).toHaveLength(1);

    // The urgent wake goes away for a moment (handled elsewhere, dropped) and a new one arrives: no second notice.
    await q(`UPDATE ceo_wakes SET status='dropped'`);
    await dispatcher().run();
    expect(await flag()).toHaveLength(1);
    await wakeNow(w, 'signal:loop', 'urgent');
    w.t.clock.advance(31 * 60_000);
    await dispatcher().run();
    await dispatcher().run();
    const items = await noticeItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.repeat_count).toBe(1);

    // The CEO comes back and runs: the episode is over and the flag is cleared.
    await keepOnline(w);
    const start = await startCeoShift(w, r, r.received.length);
    await finish(start.shiftId);
    await dispatcher().run();
    expect(await flag()).toHaveLength(0);
  });
});

describe('"CEO offline" does not flap on workstation reconnects (S1b, production: 33 notices)', () => {
  it('a brief reconnect without a CEO shift keeps the flag; five connect/disconnect cycles raise no second notice', async () => {
    await clean();
    const noticeItems = () => q(`SELECT id, repeat_count FROM desk_items WHERE subkind='ceo_notice'`);
    const flag = () => q(`SELECT 1 FROM ceo_flags WHERE flag='offline_notice'`);
    const shiftCount = async () => (await q(`SELECT 1 FROM shifts WHERE kind='ceo'`)).length;
    const shiftsBefore = await shiftCount();
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    await wakeNow(w, 'signal:loop', 'urgent');
    w.t.clock.advance(31 * 60_000);
    await dispatcher().run();
    await dispatcher().run();
    expect(await flag()).toHaveLength(1);
    expect(await noticeItems()).toHaveLength(1);

    for (let cycle = 0; cycle < 5; cycle++) {
      // The workstation reconnects for a moment; the urgent wake is gone (handled elsewhere): no CEO shift runs.
      await q(`UPDATE ceo_wakes SET status='dropped'`);
      await keepOnline(w);
      await dispatcher().run();
      expect(await flag(), `flag after reconnect ${cycle}`).toHaveLength(1);
      // It drops again with a new urgent wake waiting.
      await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
      await wakeNow(w, 'signal:loop', 'urgent');
      w.t.clock.advance(31 * 60_000);
      await dispatcher().run();
      await dispatcher().run();
      expect(await flag(), `flag after disconnect ${cycle}`).toHaveLength(1);
    }
    const items = await noticeItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.repeat_count).toBe(1);
    expect(await shiftCount()).toBe(shiftsBefore);
  });
});

describe('CEO models', () => {
  it('defaults: Sonnet for wake, review and chat, Opus for the handover', () => {
    expect(DEFAULT_CEO_MODELS.wake.model).toBe('sonnet');
    expect(DEFAULT_CEO_MODELS.review.model).toBe('sonnet');
    expect(DEFAULT_CEO_MODELS.chat.model).toBe('sonnet');
    expect(DEFAULT_CEO_MODELS.handover.model).toBe('opus');
  });

  it('a wake that hands work over runs on the handover model, an ordinary wake on the wake model', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    const plain = await startCeoShift(w, r, r.received.length);
    expect(plain.agent.model).toBe('sonnet');
    await finish(plain.shiftId);
    await wakeNow(w, 'handover:question', 'urgent');
    const handover = await startCeoShift(w, r, r.received.length);
    expect(handover.agent.model).toBe('opus');
    await finish(handover.shiftId);
  });

  it('the data migration moves only settings that still equal the old defaults', async () => {
    const orgId = w.owner.id;
    const row = (await q('SELECT settings FROM ceo_settings WHERE org_id=$1', [orgId]))[0]!;
    const settings = { ...row.settings, models: { ...row.settings.models } };
    delete settings.models.handover;
    settings.models.wake = { model: 'opus', effort: 'high' }; // the owner's own choice: stays
    settings.models.review = { model: 'opus', effort: 'high' }; // the old default: moves
    settings.models.chat = { model: 'opus', effort: 'high' }; // the old default: moves
    await q('UPDATE ceo_settings SET settings=$2 WHERE org_id=$1', [orgId, JSON.stringify(settings)]);
    await q(`DELETE FROM data_migrations WHERE name='ceo-models-2026-10'`);
    const env = { pool: w.t.app.ctx.pool, store: w.t.app.ctx.store, clock: w.t.app.ctx.clock, log: () => {} };
    const report = await migrateCeoModels(env);
    expect(report?.changed).toEqual([{ orgId, purposes: ['review', 'chat', 'handover'] }]);
    const after = (await q('SELECT settings FROM ceo_settings WHERE org_id=$1', [orgId]))[0]!.settings.models;
    expect(after.wake).toEqual({ model: 'opus', effort: 'high' });
    expect(after.review).toEqual(DEFAULT_CEO_MODELS.review);
    expect(after.chat).toEqual(DEFAULT_CEO_MODELS.chat);
    expect(after.handover).toEqual(DEFAULT_CEO_MODELS.handover);
    // run again: recorded, nothing happens
    expect(await migrateCeoModels(env)).toBeNull();
  });
});
