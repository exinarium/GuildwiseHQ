import type { EventOf } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

type Body = Omit<EventOf<'ScheduleCreated'>['payload'], 'interestId'> & { interestId?: string | undefined };

async function upsert(tx: Parameters<Projector>[0], p: Body, at: Date): Promise<void> {
  const proj = await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId]);
  await exec(
    tx,
    `INSERT INTO schedules (id, org_id, project_id, name, kind, cron, timezone, card_template, enabled, next_fire_at,
       created_at, updated_at, interest_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, cron=EXCLUDED.cron,
       timezone=EXCLUDED.timezone, card_template=EXCLUDED.card_template, enabled=EXCLUDED.enabled,
       next_fire_at=EXCLUDED.next_fire_at, updated_at=EXCLUDED.updated_at, fail_count=0, last_error=NULL`,
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
      p.interestId ?? null,
    ],
  );
}

export const scheduleProjectors: Record<string, Projector> = {
  ScheduleCreated: async (tx, e) => upsert(tx, (e.event as EventOf<'ScheduleCreated'>).payload, e.createdAt),
  ScheduleUpdated: async (tx, e) => upsert(tx, (e.event as EventOf<'ScheduleUpdated'>).payload, e.createdAt),
  /** `ScheduleUpdated` never touches `interest_id`, so old and new events replay identically. */
  ScheduleLinked: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleLinked'>).payload;
    await exec(tx, 'UPDATE schedules SET interest_id=$2, updated_at=$3 WHERE id=$1', [
      p.scheduleId,
      p.interestId,
      e.createdAt,
    ]);
    // Back-fill the cards the schedule emitted before it was adopted (deterministic: they are earlier in the log).
    if (p.interestId)
      await exec(tx, 'UPDATE cards SET interest_id=$2 WHERE schedule_id=$1 AND interest_id IS NULL', [
        p.scheduleId,
        p.interestId,
      ]);
  },
  ScheduleDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleDeleted'>).payload;
    await exec(tx, 'DELETE FROM schedules WHERE id=$1', [p.scheduleId]);
  },
  ScheduleFired: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleFired'>).payload;
    await exec(
      tx,
      `UPDATE schedules SET last_fired_at=$2, next_fire_at=$3, last_card_id=$4, updated_at=$2, fail_count=0,
              last_error=NULL, failure_desk_item_id=NULL WHERE id=$1`,
      [p.scheduleId, e.createdAt, p.nextFireAt, p.cardId],
    );
  },
  /** Backs off: the retry time replaces `next_fire_at`; the first failure of a streak remembers its desk notice. */
  ScheduleFireFailed: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleFireFailed'>).payload;
    await exec(
      tx,
      `UPDATE schedules SET next_fire_at=$2, fail_count=$3, last_error=$4,
              failure_desk_item_id = COALESCE($5::uuid, failure_desk_item_id), updated_at=$6 WHERE id=$1`,
      [p.scheduleId, p.nextFireAt, p.attempts, p.error, p.deskItemId ?? null, e.createdAt],
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
