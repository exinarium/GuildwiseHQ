import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * The BA reporter is retired (docs/design/ceo-front-door.md step 3), but its events are in every organization's history and
 * must still replay: held-item triage, notes, BA tasks of the retired kinds, signal reports, the BA chat link and the
 * old reporting preferences.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const SYSTEM = { kind: 'system' as const, id: null };
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });

describe('old reporter events still project, and a rebuild reproduces them', () => {
  it('held items, triage, notes, retired BA tasks, signals and the old preferences', async () => {
    const held = randomUUID();
    const passed = randomUUID();
    const signalId = randomUUID();
    const triageTask = randomUUID();
    const alertTask = randomUUID();
    const floorTask = randomUUID();
    const raise = (id: string, title: string) => ({
      streamId: streamId.desk(id),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          kind: 'alert',
          subkind: 'bug_reported',
          title,
          body: '',
          projectId: w.projectId,
          askedBy: { kind: 'system' },
          triage: { deadline: new Date(Date.now() + 600_000).toISOString() },
        },
      },
      actor: SYSTEM,
      scope: scope(),
    });
    await seed(w, [
      raise(held, 'Held for the BA'),
      raise(passed, 'Passed by the BA'),
      {
        streamId: streamId.desk(passed),
        event: {
          type: 'DeskItemTriaged',
          payload: { deskItemId: passed, outcome: 'passed', note: 'looked at', by: { kind: 'system' } },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.desk(passed),
        event: {
          type: 'DeskItemAnnotated',
          payload: {
            deskItemId: passed,
            note: 'asked 3 times',
            by: { kind: 'system' },
            relatedDeskItemIds: [],
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baTask(triageTask),
        event: {
          type: 'BaTaskQueued',
          payload: { taskId: triageTask, projectId: w.projectId, kind: 'desk_triage', deskItemIds: [held] },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baTask(triageTask),
        event: {
          type: 'BaTaskItemsAdded',
          payload: { taskId: triageTask, deskItemIds: [passed], signalIds: [] },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baTask(triageTask),
        event: { type: 'BaTaskCompleted', payload: { taskId: triageTask, status: 'fallback', note: 'old' } },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baSignal(signalId),
        event: {
          type: 'BaSignalRaised',
          payload: {
            signalId,
            projectId: w.projectId,
            kind: 'loop',
            fingerprint: 'loop:card:x',
            urgency: 'urgent',
            subject: { title: 'X keeps failing' },
            evidence: {},
            count: 3,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baTask(alertTask),
        event: {
          type: 'BaTaskQueued',
          payload: { taskId: alertTask, projectId: w.projectId, kind: 'floor_alert', signalIds: [signalId] },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baSignal(signalId),
        event: { type: 'BaSignalReported', payload: { signalId, deskItemId: passed } },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.baTask(floorTask),
        event: {
          type: 'BaTaskQueued',
          payload: {
            taskId: floorTask,
            projectId: w.projectId,
            kind: 'floor_report',
            localDate: '2026-10-01',
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.user(w.owner.id),
        event: {
          type: 'ReportingPrefsChanged',
          payload: { userId: w.owner.id, routeViaBa: true, dailyAt: '07:15' },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    const snap = async () => ({
      desk: (
        await q(`SELECT id, triage, ba_note FROM desk_items WHERE id = ANY($1::uuid[]) ORDER BY id`, [
          [held, passed],
        ])
      ).map((x) => JSON.stringify(x)),
      tasks: (await q(`SELECT id, kind, status, desk_item_ids, signal_ids FROM ba_tasks ORDER BY id`)).map(
        (x) => JSON.stringify(x),
      ),
      signals: (await q(`SELECT id, status, report_desk_item_id FROM ba_signals ORDER BY id`)).map((x) =>
        JSON.stringify(x),
      ),
      user: (await q(`SELECT reporting, floor_report_day FROM users WHERE id=$1`, [w.owner.id])).map((x) =>
        JSON.stringify(x),
      ),
    });
    const before = await snap();
    expect(before.desk.join()).toContain('"triage":"pending"');
    expect(before.desk.join()).toContain('asked 3 times');
    expect(before.tasks.join()).toContain('"kind":"floor_alert"');
    expect(before.signals.join()).toContain('"status":"reported"');
    expect(before.user.join()).toContain('07:15');
    expect(before.user.join()).toContain('2026-10-01');

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
    expect(PROJECTION_TABLES).toContain('ba_signals');
  });
});
