import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_MIGRATIONS } from '../src/data-migrations/index.ts';
import {
  migrateReporterRetired,
  REPORTER_RETIRED_MIGRATION,
} from '../src/data-migrations/reporter-retired.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * `reporter-retired-2026-10` (docs/design/ceo-front-door.md step 3): queued reporter tasks are cancelled (a schedule's task
 * becomes a CEO wake), held items are released, the owner's report time moves to the CEO, and a second run does nothing.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const SYSTEM = { kind: 'system' as const, id: null };
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const env = () => ({
  pool: w.t.app.ctx.pool,
  store: w.t.app.ctx.store,
  clock: w.t.app.ctx.clock,
  log: () => {},
});

describe('reporter-retired data migration', () => {
  it('is registered', () => {
    expect(DATA_MIGRATIONS.map((m) => m.name)).toContain(REPORTER_RETIRED_MIGRATION);
  });

  it('cancels queued reporter tasks, moves a schedule task to the CEO, releases held items, carries the report time, and is idempotent', async () => {
    // the boot run already recorded itself on an empty database: forget it so this run sees the fixtures
    await q(`DELETE FROM data_migrations WHERE name=$1`, [REPORTER_RETIRED_MIGRATION]);
    const held = randomUUID();
    const triage = randomUUID();
    const floor = randomUUID();
    const brief = randomUUID();
    const review = randomUUID();
    const scheduleId = randomUUID();
    const queued = (taskId: string, payload: Record<string, unknown>) => ({
      streamId: `ba-task-${taskId}`,
      event: { type: 'BaTaskQueued', payload: { taskId, projectId: w.projectId, ...payload } },
      actor: SYSTEM,
      scope: scope(),
    });
    await seed(w, [
      {
        streamId: `desk-${held}`,
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: held,
            kind: 'alert',
            subkind: 'bug_reported',
            title: 'Held for the BA',
            projectId: w.projectId,
            askedBy: { kind: 'system' },
            triage: { deadline: new Date(Date.now() + 3_600_000).toISOString() },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      queued(triage, { kind: 'desk_triage', deskItemIds: [held] }),
      queued(floor, { kind: 'floor_report', localDate: '2026-10-19' }),
      queued(brief, {
        kind: 'scheduled_brief',
        instructions: 'List the open phases',
        deliver: 'chat',
        scheduleId,
        scheduleName: 'Friday review',
      }),
      // the CEO-BA review is a scheduled_brief without a schedule: it keeps running
      queued(review, {
        kind: 'scheduled_brief',
        instructions: 'CEO decision review',
        deliver: 'desk_notice',
      }),
      {
        streamId: `user-${w.owner.id}`,
        event: { type: 'ReportingPrefsChanged', payload: { userId: w.owner.id, dailyAt: '06:45' } },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    const report = await migrateReporterRetired(env());
    expect(report).toMatchObject({ cancelled: 3, briefsToCeo: 1, released: 1, reportAtCarried: 1 });

    const status = async (id: string) =>
      (await q('SELECT status FROM ba_tasks WHERE id=$1', [id]))[0]?.status;
    expect(await status(triage)).toBe('cancelled');
    expect(await status(floor)).toBe('cancelled');
    expect(await status(brief)).toBe('cancelled');
    expect(await status(review)).toBe('queued');
    expect((await q('SELECT triage FROM desk_items WHERE id=$1', [held]))[0]?.triage).toBe('released');
    const wake = (
      await q(`SELECT * FROM ceo_wakes WHERE reason='scheduled_brief' AND detail->>'scheduleId'=$1`, [
        scheduleId,
      ])
    )[0];
    expect(wake).toMatchObject({ urgency: 'scheduled', subject_label: 'Friday review' });
    expect(wake?.detail).toMatchObject({ instructions: 'List the open phases', deliver: 'chat' });
    expect(
      (await q(`SELECT settings->>'reportAt' AS at FROM ceo_settings WHERE org_id=$1`, [w.owner.id]))[0]?.at,
    ).toBe('06:45');

    const events = Number((await q('SELECT count(*) AS n FROM events'))[0]!.n);
    expect(await migrateReporterRetired(env())).toBeNull();
    expect(Number((await q('SELECT count(*) AS n FROM events'))[0]!.n)).toBe(events);
  });
});
