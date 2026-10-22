import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

type DiscoveryEventType =
  | 'DiscoveryQuestionAsked'
  | 'DiscoveryQuestionWithdrawn'
  | 'DiscoveryAnswerProposed'
  | 'DiscoveryQuestionAnswered'
  | 'DiscoveryNoteAdded'
  | 'DiscoveryNoteUpdated'
  | 'DiscoveryNoteRemoved'
  | 'DiscoveryProposalRaised'
  | 'DiscoveryProposalResolved'
  | 'DiscoveryPhaseChanged'
  | 'DiscoveryPauseChanged';

const ev = <T extends DiscoveryEventType>(e: StoredEvent) => e.event as EventOf<T>;

/** Discovery Studio: questions, answers, panel notes, proposals and the phase/pause state. Every write uses the event's time and seq. */
export const discoveryProjectors: Record<string, Projector> = {
  DiscoveryQuestionAsked: async (tx, e) => {
    const p = ev<'DiscoveryQuestionAsked'>(e).payload;
    // One question is open at a time; a CEO pre-answer (`proposed`) waits for the owner's review and stays.
    await exec(
      tx,
      `UPDATE discovery_questions SET status='withdrawn' WHERE thread_id=$1 AND status='open' AND id <> $2`,
      [p.threadId, p.questionId],
    );
    await exec(
      tx,
      `INSERT INTO discovery_questions (id, thread_id, org_id, seq, turn_id, asked_by_name, question, why, options, allow_free_text, phase, status, asked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.questionId,
        p.threadId,
        e.scope.orgId,
        e.seq.toString(),
        p.turnId ?? null,
        p.askedByName,
        p.question,
        p.why ?? null,
        JSON.stringify(p.options),
        p.allowFreeText,
        p.phase,
        e.createdAt,
      ],
    );
  },
  DiscoveryQuestionWithdrawn: async (tx, e) => {
    const p = ev<'DiscoveryQuestionWithdrawn'>(e).payload;
    await exec(
      tx,
      `UPDATE discovery_questions SET status='withdrawn' WHERE id=$1 AND status IN ('open','proposed')`,
      [p.questionId],
    );
  },
  DiscoveryAnswerProposed: async (tx, e) => {
    const p = ev<'DiscoveryAnswerProposed'>(e).payload;
    await exec(
      tx,
      `UPDATE discovery_questions SET proposed=$2::jsonb, status = CASE WHEN $3 = 'ceo_prep' THEN 'proposed' ELSE status END
        WHERE id=$1 AND status='open'`,
      [
        p.questionId,
        JSON.stringify({
          text: p.text,
          optionId: p.optionId ?? null,
          rationale: p.rationale ?? null,
          byName: p.by.name,
          mode: p.mode,
          at: e.createdAt.toISOString(),
        }),
        p.mode,
      ],
    );
  },
  DiscoveryQuestionAnswered: async (tx, e) => {
    const p = ev<'DiscoveryQuestionAnswered'>(e).payload;
    await exec(
      tx,
      `UPDATE discovery_questions
          SET status = CASE $2 WHEN 'skip' THEN 'skipped' WHEN 'park' THEN 'parked' ELSE 'answered' END,
              answer = $3::jsonb, answered_at = $4
        WHERE id=$1 AND status IN ('open','proposed')`,
      [
        p.questionId,
        p.kind,
        JSON.stringify({
          kind: p.kind,
          optionId: p.optionId ?? null,
          text: p.text ?? null,
          source: p.source,
        }),
        e.createdAt,
      ],
    );
  },
  DiscoveryNoteAdded: async (tx, e) => {
    const p = ev<'DiscoveryNoteAdded'>(e).payload;
    await exec(
      tx,
      `INSERT INTO discovery_notes (id, thread_id, org_id, seq, section, text, by_kind, by_name, by_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.noteId,
        p.threadId,
        e.scope.orgId,
        e.seq.toString(),
        p.section,
        p.text,
        p.by.kind,
        p.by.name,
        p.by.id,
        e.createdAt,
      ],
    );
  },
  DiscoveryNoteUpdated: async (tx, e) => {
    const p = ev<'DiscoveryNoteUpdated'>(e).payload;
    await exec(
      tx,
      `UPDATE discovery_notes SET text = COALESCE($2, text), section = COALESCE($3, section), updated_at = $4
        WHERE id=$1 AND removed_at IS NULL`,
      [p.noteId, p.text ?? null, p.section ?? null, e.createdAt],
    );
  },
  DiscoveryNoteRemoved: async (tx, e) => {
    const p = ev<'DiscoveryNoteRemoved'>(e).payload;
    await exec(tx, `UPDATE discovery_notes SET removed_at=$2 WHERE id=$1 AND removed_at IS NULL`, [
      p.noteId,
      e.createdAt,
    ]);
  },
  DiscoveryProposalRaised: async (tx, e) => {
    const p = ev<'DiscoveryProposalRaised'>(e).payload;
    await exec(
      tx,
      `INSERT INTO discovery_proposals (id, thread_id, org_id, seq, turn_id, title, change, rationale, doc_id, section, status, asked_by_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open',$11,$12)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.proposalId,
        p.threadId,
        e.scope.orgId,
        e.seq.toString(),
        p.turnId ?? null,
        p.title,
        p.change,
        p.rationale,
        p.docId ?? null,
        p.section ?? null,
        p.askedByName,
        e.createdAt,
      ],
    );
  },
  DiscoveryProposalResolved: async (tx, e) => {
    const p = ev<'DiscoveryProposalResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE discovery_proposals SET status=$2, resolution_text=$3, resolved_at=$4 WHERE id=$1 AND status='open'`,
      [p.proposalId, p.resolution, p.text ?? null, e.createdAt],
    );
  },
  DiscoveryPhaseChanged: async (tx, e) => {
    const p = ev<'DiscoveryPhaseChanged'>(e).payload;
    await exec(
      tx,
      `UPDATE threads SET session_config = jsonb_set(session_config, '{phase}', to_jsonb($2::text)) WHERE id=$1`,
      [p.threadId, p.to],
    );
  },
  DiscoveryPauseChanged: async (tx, e) => {
    const p = ev<'DiscoveryPauseChanged'>(e).payload;
    await exec(
      tx,
      `UPDATE threads SET session_config = jsonb_strip_nulls(session_config ||
              jsonb_build_object('paused', $2::boolean, 'elapsedMs', $3::bigint, 'activeSince', $4::text))
        WHERE id=$1`,
      [p.threadId, p.paused, p.elapsedMs, p.paused ? null : e.createdAt.toISOString()],
    );
  },
};
