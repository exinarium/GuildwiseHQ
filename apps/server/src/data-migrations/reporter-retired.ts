import { streamId } from '@aom/shared';
import { releaseHeldEvents } from '../ceo/signals.ts';
import { loadCeo } from '../ceo/state.ts';
import { enqueueWake } from '../ceo/wakes.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `reporter-retired-2026-10` (docs/design/ceo-front-door.md step 3): the BA reporter is gone, the CEO does its work.
 *
 * - Queued reporter tasks of the BA are cancelled (`BaTaskCancelled` is `BaTaskCompleted` with status `cancelled`). A
 *   queued schedule task (`scheduled_brief` with a schedule) is not lost: it becomes a `scheduled_brief` wake of the CEO.
 *   The CEO-BA review tasks (a `scheduled_brief` of the CEO's correction flow, no schedule) keep running.
 * - Items still held for the BA's triage are released unchanged (the owner sees them).
 * - The report time the owner set for the BA's floor report (`users.reporting.dailyAt`, when it is not the default)
 *   becomes the CEO's `reportAt` where that is not set yet, so the daily report keeps its hour.
 *
 * Recorded once in `data_migrations`; the second boot appends nothing.
 */
export const REPORTER_RETIRED_MIGRATION = 'reporter-retired-2026-10';

export interface ReporterRetiredReport {
  cancelled: number;
  briefsToCeo: number;
  released: number;
  reportAtCarried: number;
}

const RETIRED_KINDS = ['desk_triage', 'urgent_note', 'floor_alert', 'floor_report'];

export async function migrateReporterRetired(env: DataMigrationEnv): Promise<ReporterRetiredReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [REPORTER_RETIRED_MIGRATION]))
    return null;
  const report: ReporterRetiredReport = { cancelled: 0, briefsToCeo: 0, released: 0, reportAtCarried: 0 };
  const now = clock.now();

  // 1. Queued reporter tasks.
  const tasks = await rows(
    pool,
    `SELECT * FROM ba_tasks WHERE status='queued'
        AND (kind = ANY($1::text[]) OR (kind='scheduled_brief' AND schedule_id IS NOT NULL))`,
    [RETIRED_KINDS],
  );
  for (const t of tasks) {
    await withAppendTx(pool, async (tx) => {
      const events: AppendInput[] = [
        {
          streamId: streamId.baTask(t.id),
          event: {
            type: 'BaTaskCompleted',
            payload: { taskId: t.id, status: 'cancelled', note: 'the BA reporter was retired' },
          },
          actor: SYSTEM_ACTOR,
          scope: t.project_id ? projectScope(t.org_id, t.project_id) : orgScope(t.org_id),
        },
      ];
      await store.append(events, { tx });
      if (t.kind === 'scheduled_brief') {
        const woke = await enqueueWake(
          tx,
          t.org_id,
          {
            reason: 'scheduled_brief',
            urgency: 'scheduled',
            subjectKind: 'schedule',
            subjectId: `${t.schedule_id}:${t.id}`,
            subjectLabel: t.schedule_name ?? 'Scheduled task',
            detail: {
              scheduleId: t.schedule_id,
              scheduleName: t.schedule_name ?? 'Scheduled task',
              instructions: t.instructions ?? '',
              deliver: t.deliver === 'chat' ? 'chat' : 'desk_notice',
            },
          },
          now,
        );
        if (woke) report.briefsToCeo++;
      }
      report.cancelled++;
    });
  }

  // 2. Items held for the BA's triage.
  const held = await rows<{ id: string }>(
    pool,
    `SELECT id FROM desk_items WHERE triage='pending' AND status='open'`,
  );
  if (held.length) {
    await withAppendTx(pool, async (tx) => {
      const events = await releaseHeldEvents(
        tx,
        held.map((h) => h.id),
        'the BA reporter was retired',
      );
      await store.append(events, { tx });
      report.released += events.length;
    });
  }

  // 3. The report time moves to the CEO's settings.
  const owners = await rows<{ org_id: string; owner_user_id: string; daily_at: string }>(
    pool,
    `SELECT o.id AS org_id, o.owner_user_id, u.reporting->>'dailyAt' AS daily_at
       FROM organizations o JOIN users u ON u.id = o.owner_user_id
      WHERE u.reporting->>'dailyAt' IS NOT NULL AND u.reporting->>'dailyAt' <> '08:00'`,
  );
  for (const o of owners) {
    await withAppendTx(pool, async (tx) => {
      const ceo = await loadCeo(tx, o.org_id);
      if (!ceo?.enabled || ceo.settings.reportAt) return;
      await store.append(
        [
          {
            streamId: streamId.ceo(o.org_id),
            event: {
              type: 'CeoSettingsChanged',
              payload: {
                orgId: o.org_id,
                settings: { ...ceo.settings, reportAt: o.daily_at },
                by: o.owner_user_id,
              },
            },
            actor: userActor(o.owner_user_id),
            scope: orgScope(o.org_id),
          },
        ],
        { tx },
      );
      report.reportAtCarried++;
    });
  }

  log(
    `${REPORTER_RETIRED_MIGRATION}: ${report.cancelled} task(s) cancelled (${report.briefsToCeo} moved to the CEO), ${report.released} held item(s) released, ${report.reportAtCarried} report time(s) carried over`,
  );
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [REPORTER_RETIRED_MIGRATION, now, JSON.stringify(report)],
  );
  return report;
}
