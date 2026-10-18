import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  act,
  appoint,
  blockingQuestion,
  graduate,
  keepOnline,
  startCeoShift,
  wakeNow,
} from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** A manually paused project is benched for the CEO too: no wakes, no nagging, no actions on its cards. */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Sam', 'builder', 'senior', { model: 'sonnet' });
  await appoint(w);
  await graduate(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const pause = () =>
  w.t.req('POST', `/api/projects/${w.projectId}/pause`, { cookie: w.owner.cookie, body: {} });
const resume = () =>
  w.t.req('POST', `/api/projects/${w.projectId}/resume`, { cookie: w.owner.cookie, body: {} });
const wakes = () => q(`SELECT * FROM ceo_wakes WHERE reason IN ('desk_item','question') ORDER BY created_at`);

describe('the CEO and a paused project', () => {
  it('a question raised on a paused project does not wake the CEO; the same question on a running project does', async () => {
    await q(`TRUNCATE ceo_wakes, ceo_batches`);
    await ok(pause());
    await blockingQuestion(w, { title: 'Asked while paused' });
    await w.t.app.ctx.notifier.flush();
    await new Promise((res) => setTimeout(res, 300));
    expect(await wakes()).toHaveLength(0);
    await ok(resume());
    await blockingQuestion(w, { title: 'Asked while running' });
    await w.t.app.ctx.notifier.flush();
    await new Promise((res) => setTimeout(res, 300));
    expect((await wakes()).length).toBeGreaterThan(0);
  });

  it('a wake already pending when the project is paused is not taken: no CEO shift starts for it', async () => {
    await q(`TRUNCATE ceo_wakes, ceo_batches`);
    await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
    await keepOnline(w);
    const { card } = await blockingQuestion(w, { title: 'Pending then paused' });
    await w.t.app.ctx.notifier.flush();
    await new Promise((res) => setTimeout(res, 300));
    const pending = await q(`SELECT subject_kind, subject_id FROM ceo_wakes WHERE status='pending'`);
    expect(pending.length).toBeGreaterThan(0);
    await ok(pause());
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    await r.barrier();
    expect(
      r.received.slice(from).filter((f: any) => f.type === 'shift.start' && f.kind === 'ceo'),
    ).toHaveLength(0);
    expect(await q(`SELECT 1 FROM ceo_wakes WHERE status='pending'`)).not.toHaveLength(0);
    expect(card.id).toBeTruthy();
    await ok(resume());
  });

  it('a CEO action on a card of a paused project is refused until the project is resumed', async () => {
    await q(`TRUNCATE ceo_wakes, ceo_batches`);
    await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
    await wakeNow(w);
    const shiftId = (await startCeoShift(w, r)).shiftId;
    const card = await w.card({ title: 'Cancel me maybe' });
    await ok(pause());
    const refused = await act(
      r,
      shiftId,
      'cancel-card',
      { card: card.ref, note: 'obsolete' },
      { key: 'paused-1' },
    );
    expect(refused.result).toMatchObject({ status: 'refused' });
    expect(refused.result.message).toMatch(/paused/);
    expect((await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]?.status).toBe('queued');
    await ok(resume());
    const after = await act(
      r,
      shiftId,
      'cancel-card',
      { card: card.ref, note: 'obsolete' },
      { key: 'paused-2' },
    );
    expect(after.result.status).not.toBe('refused');
  });
});
