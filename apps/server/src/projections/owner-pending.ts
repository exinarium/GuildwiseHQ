import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/**
 * Owner-pending timers (docs/ARCHITECTURE.md section 45). A reminder is applied only while the row is open, not reminded and
 * its due time equals the event's `firedFor`, so a second event for the same fire, or a replay, changes nothing.
 */
export const ownerPendingProjectors: Record<string, Projector> = {
  OwnerPendingRegistered: async (tx, e) => {
    const p = ev<'OwnerPendingRegistered'>(e).payload;
    await exec(
      tx,
      `INSERT INTO owner_pending_timers (id, org_id, project_id, card_id, kind, subject_id, owner_user_id, title, url,
         timezone, started_at, due_at, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open') ON CONFLICT DO NOTHING`,
      [
        p.timerId,
        p.orgId,
        p.projectId ?? null,
        p.cardId ?? null,
        p.kind,
        p.subjectId,
        p.ownerUserId,
        p.title,
        p.url ?? null,
        p.timezone,
        p.startedAt,
        p.dueAt,
      ],
    );
  },

  OwnerPendingReminded: async (tx, e) => {
    const p = ev<'OwnerPendingReminded'>(e).payload;
    await exec(
      tx,
      `UPDATE owner_pending_timers SET reminded_at=$2, desk_item_id=$3
        WHERE id=$1 AND status='open' AND reminded_at IS NULL AND due_at=$4::timestamptz`,
      [p.timerId, e.createdAt, p.deskItemId, p.firedFor],
    );
  },

  OwnerPendingResolved: async (tx, e) => {
    const p = ev<'OwnerPendingResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE owner_pending_timers SET status='resolved', resolved_at=$2, resolution=$3, resolved_by=$4
        WHERE id=$1 AND status='open'`,
      [p.timerId, e.createdAt, p.reason, p.by ?? null],
    );
  },
};
