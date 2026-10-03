import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

type Body = EventOf<'ScheduleCreated'>['payload'];

async function upsert(tx: Parameters<Projector>[0], p: Body, at: Date): Promise<void> {
  const proj = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId]);
  await exec(
    tx,
    `INSERT INTO schedules (id, org_id, project_id, name, kind, cron, timezone, card_template, enabled, next_fire_at,
       created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, cron=EXCLUDED.cron,
       timezone=EXCLUDED.timezone, card_template=EXCLUDED.card_template, enabled=EXCLUDED.enabled,
       next_fire_at=EXCLUDED.next_fire_at, updated_at=EXCLUDED.updated_at`,
    [
      p.scheduleId,
      proj?.org_id,
      p.projectId,
      p.name,
      p.kind,
      p.cron,
      p.timezone,
      JSON.stringify(p.cardTemplate),
      p.enabled,
      p.nextFireAt,
      at,
    ],
  );
}

export const scheduleProjectors: Record<string, Projector> = {
  ScheduleCreated: async (tx, e) => upsert(tx, (e.event as EventOf<'ScheduleCreated'>).payload, e.createdAt),
  ScheduleUpdated: async (tx, e) => upsert(tx, (e.event as EventOf<'ScheduleUpdated'>).payload, e.createdAt),
  ScheduleDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleDeleted'>).payload;
    await exec(tx, 'DELETE FROM schedules WHERE id=$1', [p.scheduleId]);
  },
  ScheduleFired: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleFired'>).payload;
    await exec(
      tx,
      `UPDATE schedules SET last_fired_at=$2, next_fire_at=$3, last_card_id=$4, updated_at=$2 WHERE id=$1`,
      [p.scheduleId, e.createdAt, p.nextFireAt, p.cardId],
    );
  },
  FeedRunRequested: async (tx, e) => {
    const p = (e.event as EventOf<'FeedRunRequested'>).payload;
    if (!p.scheduleId) return;
    await exec(tx, `UPDATE schedules SET last_fired_at=$2, last_card_id=$3, updated_at=$2 WHERE id=$1`, [
      p.scheduleId,
      e.createdAt,
      p.cardId,
    ]);
  },
};
