import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint, keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * The BA reporter's server sweep lives in `ceo/signals.ts` now (docs/design/ceo-front-door.md step 3): hold release, the
 * detectors and `ba_signals`, the CEO's daily review wake and the research-topics sweep (which blog topics phase 2 hangs
 * off it). One sweep, and the topics hand-off still runs from it.
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  // The owner's organization is the platform organization: it may collect problem notes without a consent step.
  await q(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('platform.team', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [JSON.stringify({ orgId: w.owner.id, projectId: w.projectId })],
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const SYSTEM = { kind: 'system' as const, id: null };
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const sweep = () => w.t.app.ctx.services.signals.run();

describe('one sweep', () => {
  it('releases an expired hold, raises a signal, queues the daily review and collects problem notes', async () => {
    // the owner's clock is past the report time (set first: the events below are stamped with it)
    w.t.clock.setOffset(new Date('2027-01-05T08:30:00Z').getTime() - Date.now());
    w.owner.cookie = await w.t.login(w.owner.email);
    await keepOnline(w);
    // 1. a held item whose deadline passes
    const held = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(held),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: held,
            kind: 'alert',
            subkind: 'bug_reported',
            title: 'Held for the CEO',
            body: '',
            projectId: w.projectId,
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      // 2. a card in rework round 3 (a normal signal) and 4. a job of an unusual kind (a problem note)
      {
        streamId: streamId.ceo(w.owner.id),
        event: {
          type: 'CeoOffboardJobLogged',
          payload: {
            jobId: randomUUID(),
            orgId: w.owner.id,
            kind: 'rotate-certs',
            title: 'Rotate the certificates by hand',
            summary: '',
            costMicros: 0,
            durationMs: 1000,
            auto: false,
          },
        },
        actor: SYSTEM,
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
      },
    ]);
    expect((await q('SELECT triage FROM desk_items WHERE id=$1', [held]))[0]?.triage).toBe('pending');
    const card = await w.card({ title: 'Reworked again' });
    await q(`UPDATE cards SET rework_round = 3 WHERE id=$1`, [card.id]);
    // 3. a day with something to say
    await q(`UPDATE ceo_settings SET report_day=NULL`);

    w.t.clock.advance(11 * 60_000); // past the hold's deadline
    await keepOnline(w);
    const out = await sweep();
    expect(out).toMatchObject({ released: 1, reviews: 1 });
    expect(out.raised).toBeGreaterThanOrEqual(1); // the rework, and whatever the clock jump makes stale
    expect((await q('SELECT triage FROM desk_items WHERE id=$1', [held]))[0]?.triage).toBe('released');
    expect(await q(`SELECT 1 FROM ba_signals WHERE kind='rework' AND status='open'`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM ceo_wakes WHERE reason='daily_review'`)).toHaveLength(1);
    // the research-topics sweep ran from it
    expect(await q(`SELECT 1 FROM ceo_topic_candidates WHERE status='note'`)).toHaveLength(1);
    // nothing is queued for a BA
    expect(await q(`SELECT 1 FROM ba_tasks`)).toHaveLength(0);

    // a second sweep is quiet
    expect(await sweep()).toMatchObject({ released: 0, raised: 0, reviews: 0 });
    w.t.clock.setOffset(0);
  });
});
