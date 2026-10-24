import type { EventOf } from '@aom/shared';
import { exec, rows } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

type BoardEventType =
  | 'BoardRoundPlanned'
  | 'BoardNoteAdded'
  | 'BoardNoteUpdated'
  | 'BoardNoteMerged'
  | 'BoardNoteRemoved'
  | 'BoardNoteVoted'
  | 'BoardDisagreementRecorded'
  | 'BoardOptionScored'
  | 'BoardDecisionRaised'
  | 'BoardDecisionResolved'
  | 'BoardRoomSaved'
  | 'BoardRoomDeleted';

const ev = <T extends BoardEventType>(e: StoredEvent) => e.event as EventOf<T>;

/** Boardroom: whiteboard, rounds, disagreements, decision points and saved rooms. Every write uses the event's time and seq. */
export const boardProjectors: Record<string, Projector> = {
  BoardRoundPlanned: async (tx, e) => {
    const p = ev<'BoardRoundPlanned'>(e).payload;
    await exec(
      tx,
      `INSERT INTO board_rounds (thread_id, round, org_id, seq, kind, speakers, reason, instruction, source, planned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (thread_id, round) DO UPDATE SET kind=$5, speakers=$6, reason=$7, instruction=$8, source=$9, seq=$4, planned_at=$10`,
      [
        p.threadId,
        p.round,
        e.scope.orgId,
        e.seq.toString(),
        p.kind,
        JSON.stringify(p.speakers),
        p.reason,
        p.instruction,
        p.source,
        e.createdAt,
      ],
    );
  },
  BoardNoteAdded: async (tx, e) => {
    const p = ev<'BoardNoteAdded'>(e).payload;
    await exec(
      tx,
      `INSERT INTO board_notes (id, thread_id, org_id, seq, col, text, by_kind, by_name, by_id, round, turn_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.noteId,
        p.threadId,
        e.scope.orgId,
        e.seq.toString(),
        p.column,
        p.text,
        p.by.kind,
        p.by.name,
        p.by.id,
        p.round,
        p.turnId ?? null,
        e.createdAt,
      ],
    );
  },
  BoardNoteUpdated: async (tx, e) => {
    const p = ev<'BoardNoteUpdated'>(e).payload;
    await exec(
      tx,
      `UPDATE board_notes SET text = COALESCE($2, text), col = COALESCE($3, col), updated_at = $4
        WHERE id=$1 AND removed_at IS NULL`,
      [p.noteId, p.text ?? null, p.column ?? null, e.createdAt],
    );
  },
  BoardNoteMerged: async (tx, e) => {
    const p = ev<'BoardNoteMerged'>(e).payload;
    const sources = await rows(
      tx,
      `SELECT votes FROM board_notes WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`,
      [p.noteIds],
    );
    const votes = [...new Set(sources.flatMap((r) => r.votes as string[]))];
    await exec(
      tx,
      `UPDATE board_notes SET text = COALESCE($2, text), updated_at = $3,
              votes = ARRAY(SELECT DISTINCT unnest(votes || $4::text[])),
              merged_from = merged_from || $5::jsonb
        WHERE id=$1 AND removed_at IS NULL`,
      [p.intoNoteId, p.text ?? null, e.createdAt, votes, JSON.stringify(p.mergedTexts)],
    );
    await exec(tx, `UPDATE board_notes SET removed_at=$2 WHERE id = ANY($1::uuid[]) AND removed_at IS NULL`, [
      p.noteIds,
      e.createdAt,
    ]);
  },
  BoardNoteRemoved: async (tx, e) => {
    const p = ev<'BoardNoteRemoved'>(e).payload;
    await exec(tx, `UPDATE board_notes SET removed_at=$2 WHERE id=$1 AND removed_at IS NULL`, [
      p.noteId,
      e.createdAt,
    ]);
  },
  BoardNoteVoted: async (tx, e) => {
    const p = ev<'BoardNoteVoted'>(e).payload;
    await exec(
      tx,
      p.voted
        ? `UPDATE board_notes SET votes = CASE WHEN $2 = ANY(votes) THEN votes ELSE array_append(votes, $2) END
            WHERE id=$1 AND removed_at IS NULL`
        : `UPDATE board_notes SET votes = array_remove(votes, $2) WHERE id=$1 AND removed_at IS NULL`,
      [p.noteId, p.userId],
    );
  },
  BoardDisagreementRecorded: async (tx, e) => {
    const p = ev<'BoardDisagreementRecorded'>(e).payload;
    await exec(
      tx,
      `INSERT INTO board_disagreements (id, thread_id, org_id, seq, topic, positions, round, by_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.disagreementId,
        p.threadId,
        e.scope.orgId,
        e.seq.toString(),
        p.topic,
        JSON.stringify(p.positions),
        p.round,
        p.by.name,
        e.createdAt,
      ],
    );
  },
  BoardOptionScored: async (tx, e) => {
    const p = ev<'BoardOptionScored'>(e).payload;
    await exec(
      tx,
      `INSERT INTO board_scores (thread_id, org_id, option_key, option, participant_id, name, score, why, round, seq, updated_at)
       VALUES ($1,$2,lower($3),$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (thread_id, option_key, participant_id)
       DO UPDATE SET score=EXCLUDED.score, why=EXCLUDED.why, round=EXCLUDED.round, name=EXCLUDED.name, seq=EXCLUDED.seq, updated_at=EXCLUDED.updated_at
         WHERE board_scores.seq < EXCLUDED.seq`,
      [
        p.threadId,
        e.scope.orgId,
        p.option,
        p.participantId,
        p.name,
        p.score,
        p.why,
        p.round,
        e.seq.toString(),
        e.createdAt,
      ],
    );
  },
  BoardDecisionRaised: async (tx, e) => {
    const p = ev<'BoardDecisionRaised'>(e).payload;
    await exec(
      tx,
      `UPDATE board_decisions SET status='withdrawn' WHERE thread_id=$1 AND status='open' AND id <> $2`,
      [p.threadId, p.decisionId],
    );
    await exec(
      tx,
      `INSERT INTO board_decisions (id, thread_id, org_id, seq, question, options, round, status, asked_by_name, asked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.decisionId,
        p.threadId,
        e.scope.orgId,
        e.seq.toString(),
        p.question,
        JSON.stringify(p.options),
        p.round,
        p.askedByName,
        e.createdAt,
      ],
    );
  },
  BoardDecisionResolved: async (tx, e) => {
    const p = ev<'BoardDecisionResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE board_decisions SET status=$5, answer=$2, option_id=$3, resolved_at=$4 WHERE id=$1 AND status='open'`,
      [p.decisionId, p.answer, p.optionId ?? null, e.createdAt, p.withdrawn ? 'withdrawn' : 'resolved'],
    );
  },
  BoardRoomSaved: async (tx, e) => {
    const p = ev<'BoardRoomSaved'>(e).payload;
    await exec(
      tx,
      `INSERT INTO board_rooms (id, org_id, name, format, round_cap, members, models, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.roomId,
        p.orgId,
        p.name,
        p.format,
        p.roundCap,
        JSON.stringify(p.cast),
        JSON.stringify(p.models),
        p.createdBy,
        e.createdAt,
      ],
    );
  },
  BoardRoomDeleted: async (tx, e) => {
    const p = ev<'BoardRoomDeleted'>(e).payload;
    await exec(tx, `UPDATE board_rooms SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL`, [
      p.roomId,
      e.createdAt,
    ]);
  },
};
