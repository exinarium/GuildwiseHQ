import {
  BOARD_ROUND_CAP_DEFAULT,
  type BoardCastDto,
  type BoardDecisionDto,
  type BoardDisagreementDto,
  type BoardNoteDto,
  type BoardRoundDto,
  type BoardStateDto,
  CHAIR_SEAT,
  DEFAULT_BOARD_MODELS,
  estimateNextRound,
  handlesOf,
  MODEL_CHOICES,
  type ModelChoice,
  parseBoardConfig,
  participantSlug,
} from '@aom/shared';
import { resolvePersona } from '../capabilities/registry.ts';
import { isAdHocPersona, listParticipants } from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { sessionCost } from './cost.ts';
import { availableCeo, sessionDocs } from './discovery-state.ts';
import { turnDto } from './turns.ts';

/** The purposes of board turns, as `session_turns.meta.purpose`. */
export const BOARD_PURPOSES = ['board_speaker', 'board_chair', 'board_cast', 'board_minutes'] as const;
export type BoardPurpose = (typeof BOARD_PURPOSES)[number];
export const isBoardPurpose = (p: unknown): p is BoardPurpose =>
  typeof p === 'string' && (BOARD_PURPOSES as readonly string[]).includes(p);

export const castKey = (kind: string, refId: string): string => `${kind}:${refId}`;

/** Runtimes a workstation reports as usable (empty: unknown, so anything goes). */
export async function workstationRuntimes(db: Queryable, workstationId: string | null): Promise<string[]> {
  if (!workstationId) return [];
  const w = await one(db, 'SELECT runtimes FROM workstations WHERE id=$1', [workstationId]);
  const list = (w?.runtimes ?? []) as Array<{ id?: string; available?: boolean }>;
  return list.filter((r) => r.id && r.available !== false).map((r) => r.id as string);
}

export type ModelRole = 'persona' | 'chair' | 'synthesis';

/**
 * The model a role runs on when the owner chose nothing: the cheap defaults of `DEFAULT_BOARD_MODELS`, or, when the
 * workstation does not offer that runtime, the first runtime it does offer (cheapest model for personas, the strongest for the
 * synthesis). This is the one place phase D (other providers) changes how a seat picks its runtime and model.
 */
export function defaultModelFor(role: ModelRole, runtimes: readonly string[]): ModelChoice {
  const d = DEFAULT_BOARD_MODELS[role];
  if (!runtimes.length || runtimes.includes(d.runtime)) return d;
  const runtime = runtimes.find((r) => MODEL_CHOICES[r]) ?? runtimes[0] ?? d.runtime;
  const models = MODEL_CHOICES[runtime] ?? [];
  if (!models.length) return d;
  const pick =
    role === 'persona'
      ? models[0]
      : role === 'chair'
        ? models[Math.min(1, models.length - 1)]
        : models.at(-1);
  return { runtime, model: (pick ?? models[0])?.id ?? d.model };
}

export const noteDto = (r: Row, userId: string): BoardNoteDto => ({
  id: r.id,
  column: r.col,
  text: r.text,
  byKind: r.by_kind,
  byName: r.by_name,
  round: r.round ?? null,
  votes: (r.votes as string[]).length,
  votedByMe: (r.votes as string[]).includes(userId),
  mergedFrom: r.merged_from ?? [],
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

export const disagreementDto = (r: Row): BoardDisagreementDto => ({
  id: r.id,
  topic: r.topic,
  positions: r.positions,
  round: r.round ?? null,
  byName: r.by_name,
  createdAt: iso(r.created_at) as string,
});

export const decisionDto = (r: Row): BoardDecisionDto => ({
  id: r.id,
  question: r.question,
  options: r.options ?? [],
  round: r.round ?? null,
  status: r.status,
  answer: r.answer ?? null,
  optionId: r.option_id ?? null,
  askedByName: r.asked_by_name,
  askedAt: iso(r.asked_at) as string,
  resolvedAt: iso(r.resolved_at),
});

export const listBoardNotes = (db: Queryable, threadId: string) =>
  rows(db, 'SELECT * FROM board_notes WHERE thread_id=$1 AND removed_at IS NULL ORDER BY seq', [threadId]);

export const listDisagreements = (db: Queryable, threadId: string) =>
  rows(db, 'SELECT * FROM board_disagreements WHERE thread_id=$1 ORDER BY seq', [threadId]);

export const listDecisions = (db: Queryable, threadId: string) =>
  rows(db, 'SELECT * FROM board_decisions WHERE thread_id=$1 ORDER BY seq', [threadId]);

/** The people of the room who speak: everyone but the owner seats and the Chair. */
export async function castOf(db: Queryable, threadId: string): Promise<Row[]> {
  return (await listParticipants(db, threadId)).filter((p) => p.kind !== 'user' && p.seat !== CHAIR_SEAT);
}

export async function chairOf(db: Queryable, threadId: string): Promise<Row | undefined> {
  return (await listParticipants(db, threadId)).find((p) => p.kind !== 'user' && p.seat === CHAIR_SEAT);
}

/** Everything the boardroom page needs besides the messages. `sealed` rounds are hidden from the owner until revealed. */
export async function boardState(ctx: Ctx, t: Row, userId: string): Promise<BoardStateDto> {
  const db = ctx.pool;
  const cfg = parseBoardConfig(t.session_config);
  const [participants, noteRows, disRows, decRows, roundRows, turnRows, cost, docs, ceo, avg] =
    await Promise.all([
      listParticipants(db, t.id),
      listBoardNotes(db, t.id),
      listDisagreements(db, t.id),
      listDecisions(db, t.id),
      rows(db, 'SELECT * FROM board_rounds WHERE thread_id=$1 ORDER BY round', [t.id]),
      rows(db, 'SELECT * FROM session_turns WHERE thread_id=$1 ORDER BY queued_at DESC, id LIMIT 60', [t.id]),
      sessionCost(db, t),
      sessionDocs(db, t),
      availableCeo(db, t.org_id),
      one(
        db,
        `SELECT
         (SELECT avg(sc.cost_usd_micros) FROM shift_costs sc JOIN session_turns st ON st.id = sc.shift_id
           WHERE st.thread_id=$1 AND st.meta->>'purpose'='board_speaker') AS speaker,
         (SELECT avg(sc.cost_usd_micros) FROM shift_costs sc JOIN session_turns st ON st.id = sc.shift_id
           WHERE st.thread_id=$1 AND st.meta->>'purpose'='board_chair') AS chair`,
        [t.id],
      ),
    ]);
  const people = participants.filter((p) => p.kind !== 'user');
  const castRows = people.filter((p) => p.seat !== CHAIR_SEAT);
  const chairRow = people.find((p) => p.seat === CHAIR_SEAT);

  const cast: BoardCastDto[] = [];
  for (const [index, p] of castRows.entries()) {
    const persona =
      p.kind === 'persona' && !isAdHocPersona(p.ref_id)
        ? await resolvePersona(db, t.org_id, p.ref_id)
        : undefined;
    cast.push({
      participantId: p.id,
      kind: p.kind,
      refId: p.ref_id,
      seat: p.seat,
      displayName: p.display_name,
      slug: participantSlug(p.display_name),
      stance: p.stance ?? persona?.stance ?? null,
      icon: persona?.icon ?? null,
      model: cfg.castModels[castKey(p.kind, p.ref_id)] ?? null,
      index,
    });
  }

  const turns = [...turnRows].reverse();
  const boardTurns = (r: Row) => isBoardPurpose((r.meta as { purpose?: string } | null)?.purpose);
  const active = turnRows.find((r) => boardTurns(r) && (r.status === 'queued' || r.status === 'running'));
  const terminal = (r: Row) => r.status === 'done' || r.status === 'failed';
  const speakerTurns = turnRows.filter(
    (r) => (r.meta as { purpose?: string } | null)?.purpose === 'board_speaker',
  );

  const rounds: BoardRoundDto[] = roundRows.map((r) => {
    const speakers = r.speakers as Array<{ participantId: string; name: string }>;
    const done = speakers.every((s) =>
      speakerTurns.some((x) => x.round === r.round && x.participant_id === s.participantId && terminal(x)),
    );
    return {
      round: r.round,
      kind: r.kind,
      speakers,
      reason: r.reason,
      instruction: r.instruction,
      source: r.source,
      plannedAt: iso(r.planned_at) as string,
      status: done ? 'done' : 'running',
    };
  });

  // Round 1 is sealed until every answer is in: the owner sees nobody's words (or notes) before that.
  const sealed = cfg.round >= 1 && cfg.revealedRound < 1 && cfg.stage !== 'setup';
  const round1 = speakerTurns.filter((r) => r.round === 1);
  const sealedMessageIds = sealed
    ? round1.map((r) => r.message_id as string | null).filter((x): x is string => !!x)
    : [];
  const notesAll = noteRows.map((r) => ({ r, dto: noteDto(r, userId) }));
  const visibleNotes = notesAll.filter(({ r }) => !(sealed && r.round === 1 && r.by_kind !== 'user'));
  const plan1 = roundRows.find((r) => r.round === 1);
  const sealedProgress = sealed
    ? {
        done: round1.filter(terminal).length,
        total: ((plan1?.speakers ?? []) as unknown[]).length || castRows.length,
      }
    : null;

  const openDecision = decRows.find((d) => d.status === 'open');
  const nextRound = Math.min(cfg.round + 1, cfg.roundCap);
  const est = estimateNextRound({
    castSize: castRows.length,
    nextRound: cfg.stage === 'setup' ? 1 : nextRound,
    avgSpeakerTurnUsd: avg?.speaker != null ? Number(avg.speaker) / 1_000_000 : null,
    avgChairTurnUsd: avg?.chair != null ? Number(avg.chair) / 1_000_000 : null,
  });

  let waitingFor: BoardStateDto['waitingFor'] = 'nothing';
  const purpose = (active?.meta as { purpose?: string } | null)?.purpose;
  if (cfg.stage === 'ended') waitingFor = 'ended';
  else if (cfg.paused) waitingFor = 'paused';
  else if (cfg.blocked === 'session_budget_exceeded' || cfg.budgetStopped || cost.exceeded)
    waitingFor = 'budget';
  else if (cfg.stage === 'decision' || openDecision) waitingFor = 'decision';
  else if (purpose === 'board_speaker') waitingFor = 'speakers';
  else if (purpose === 'board_chair' || purpose === 'board_cast')
    waitingFor = purpose === 'board_cast' ? 'cast' : 'chair';
  else if (purpose === 'board_minutes' || cfg.stage === 'minutes') waitingFor = 'minutes';
  else if (cfg.stage === 'setup') waitingFor = 'cast';
  else waitingFor = 'owner';

  const plan = cfg.plan;
  const chairStatus =
    cfg.stage === 'ended'
      ? null
      : purpose === 'board_chair'
        ? 'The Chair is choosing the next speakers…'
        : plan && plan.kind !== 'independent'
          ? `Chair picks: ${plan.speakers
              .map((id) => castRows.find((c) => c.id === id)?.display_name ?? 'someone')
              .join(', ')}${plan.reason ? ` — ${plan.reason}` : ''}`
          : null;

  return {
    threadId: t.id,
    title: t.title,
    projectId: t.project_id ?? null,
    config: {
      topic: cfg.topic,
      brief: cfg.brief,
      format: cfg.format,
      roundCap: cfg.roundCap || BOARD_ROUND_CAP_DEFAULT,
      stage: cfg.stage,
      round: cfg.round,
      revealedRound: cfg.revealedRound,
      paused: cfg.paused,
      budgetStopped: cfg.budgetStopped,
      endReason: cfg.endReason,
      models: cfg.models,
      dissentNext: cfg.dissentNext,
      minutesDocId: cfg.minutesDocId,
      prdSessionId: cfg.prdSessionId,
      suggestState: cfg.suggestState,
    },
    cast,
    chair: { participantId: chairRow?.id ?? null, displayName: chairRow?.display_name ?? 'Chair' },
    rounds,
    notes: visibleNotes.map((n) => n.dto),
    hiddenNotes: notesAll.length - visibleNotes.length,
    disagreements: disRows.filter((d) => !(sealed && d.round === 1)).map(disagreementDto),
    decisions: decRows.map(decisionDto),
    suggestions: cfg.suggestions,
    sealedMessageIds,
    sealedProgress,
    documents: docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      status: d.status,
      currentVersion: d.currentVersion,
    })),
    turns: turns.filter(boardTurns).slice(-40).map(turnDto),
    cost,
    estimate: est,
    workstationOnline: !!t.workstation_id && ctx.services.runners.isOnline(t.workstation_id),
    ceoAvailable: !!ceo,
    busy: !!active,
    waitingFor,
    chairStatus,
    createdAt: iso(t.created_at) as string,
  };
}

export { handlesOf };
