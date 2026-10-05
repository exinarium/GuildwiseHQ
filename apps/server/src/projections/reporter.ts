import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

export const reporterProjectors: Record<string, Projector> = {
  UserTimezoneChanged: async (tx, e) => {
    const p = ev<'UserTimezoneChanged'>(e).payload;
    await exec(tx, 'UPDATE users SET timezone=$2 WHERE id=$1', [p.userId, p.timezone]);
  },

  ReportingPrefsChanged: async (tx, e) => {
    const p = ev<'ReportingPrefsChanged'>(e).payload;
    const patch: Record<string, unknown> = {};
    if (p.routeViaBa !== undefined) patch.routeViaBa = p.routeViaBa;
    if (p.dailyAt !== undefined) patch.dailyAt = p.dailyAt;
    await exec(tx, `UPDATE users SET reporting = reporting || $2::jsonb WHERE id=$1`, [
      p.userId,
      JSON.stringify(patch),
    ]);
  },

  BaChatLinked: async (tx, e) => {
    const p = ev<'BaChatLinked'>(e).payload;
    await exec(tx, 'UPDATE users SET ba_chat_thread_id=$2 WHERE id=$1', [p.userId, p.threadId]);
  },

  DeskItemTriaged: async (tx, e) => {
    const p = ev<'DeskItemTriaged'>(e).payload;
    const note = p.note ?? null;
    const status = p.outcome === 'dismissed' ? 'dismissed' : p.outcome === 'merged' ? 'superseded' : null;
    await exec(
      tx,
      `UPDATE desk_items SET triage=$2, superseded_by=COALESCE($3, superseded_by),
              status = COALESCE($4, status), ba_note = COALESCE($5, ba_note),
              ba_note_at = CASE WHEN $5::text IS NULL THEN ba_note_at ELSE $6 END, updated_at=$6
        WHERE id=$1`,
      [p.deskItemId, p.outcome, p.intoDeskItemId ?? null, status, note, e.createdAt],
    );
  },

  DeskItemAnnotated: async (tx, e) => {
    const p = ev<'DeskItemAnnotated'>(e).payload;
    await exec(tx, `UPDATE desk_items SET ba_note=$2, ba_note_at=$3, updated_at=$3 WHERE id=$1`, [
      p.deskItemId,
      p.note,
      e.createdAt,
    ]);
  },

  BaSignalRaised: async (tx, e) => {
    const p = ev<'BaSignalRaised'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ba_signals (id, org_id, project_id, kind, fingerprint, urgency, subject, evidence, count, status,
         first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$10)`,
      [
        p.signalId,
        e.scope.orgId,
        p.projectId ?? null,
        p.kind,
        p.fingerprint,
        p.urgency,
        JSON.stringify(p.subject),
        JSON.stringify(p.evidence),
        p.count,
        e.createdAt,
      ],
    );
  },

  BaSignalUpdated: async (tx, e) => {
    const p = ev<'BaSignalUpdated'>(e).payload;
    await exec(
      tx,
      `UPDATE ba_signals SET count=$2, last_seen_at=$3, urgency=COALESCE($4, urgency),
              subject=COALESCE($5::jsonb, subject), evidence=COALESCE($6::jsonb, evidence)
        WHERE id=$1`,
      [
        p.signalId,
        p.count,
        e.createdAt,
        p.urgency ?? null,
        p.subject ? JSON.stringify(p.subject) : null,
        p.evidence ? JSON.stringify(p.evidence) : null,
      ],
    );
  },

  BaSignalReported: async (tx, e) => {
    const p = ev<'BaSignalReported'>(e).payload;
    await exec(
      tx,
      `UPDATE ba_signals SET status='reported', reported_at=$3, report_desk_item_id=COALESCE($2, report_desk_item_id)
        WHERE id=$1 AND status <> 'resolved'`,
      [p.signalId, p.deskItemId ?? null, e.createdAt],
    );
  },

  BaSignalResolved: async (tx, e) => {
    const p = ev<'BaSignalResolved'>(e).payload;
    await exec(tx, `UPDATE ba_signals SET status='resolved', resolved_at=$2 WHERE id=$1`, [
      p.signalId,
      e.createdAt,
    ]);
  },

  BaTaskItemsAdded: async (tx, e) => {
    const p = ev<'BaTaskItemsAdded'>(e).payload;
    await exec(
      tx,
      `UPDATE ba_tasks SET desk_item_ids = ARRAY(SELECT DISTINCT x FROM unnest(desk_item_ids || $2::uuid[]) AS x),
              signal_ids = ARRAY(SELECT DISTINCT x FROM unnest(signal_ids || $3::uuid[]) AS x), updated_at=$4
        WHERE id=$1`,
      [p.taskId, p.deskItemIds ?? [], p.signalIds ?? [], e.createdAt],
    );
  },
};
