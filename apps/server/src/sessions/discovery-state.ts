import {
  type DiscoveryDoc,
  type DiscoveryProposalDto,
  type DiscoveryStateDto,
  discoveryProgress,
  type NoteDto,
  parseDiscoveryConfig,
  type QuestionDto,
} from '@aom/shared';
import { listParticipants } from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { sessionCost } from './cost.ts';
import { turnDto } from './turns.ts';

export const FACILITATOR_SEAT = 'Facilitator';
export const CEO_SEAT = 'CEO';

export const questionDto = (r: Row): QuestionDto => ({
  id: r.id,
  threadId: r.thread_id,
  seq: Number(r.seq),
  question: r.question,
  why: r.why ?? null,
  options: r.options ?? [],
  allowFreeText: r.allow_free_text,
  phase: r.phase,
  status: r.status,
  askedByName: r.asked_by_name,
  answer: r.answer ?? null,
  proposed: r.proposed ?? null,
  askedAt: iso(r.asked_at) as string,
  answeredAt: iso(r.answered_at),
});

export const noteDto = (r: Row): NoteDto => ({
  id: r.id,
  threadId: r.thread_id,
  section: r.section,
  text: r.text,
  byKind: r.by_kind,
  byName: r.by_name,
  createdAt: iso(r.created_at) as string,
  updatedAt: iso(r.updated_at) as string,
});

export const proposalDto = (r: Row): DiscoveryProposalDto => ({
  id: r.id,
  threadId: r.thread_id,
  seq: Number(r.seq),
  title: r.title,
  change: r.change,
  rationale: r.rationale,
  docId: r.doc_id ?? null,
  section: r.section ?? null,
  status: r.status,
  resolutionText: r.resolution_text ?? null,
  askedByName: r.asked_by_name,
  createdAt: iso(r.created_at) as string,
  resolvedAt: iso(r.resolved_at),
});

export const listQuestions = async (db: Queryable, threadId: string) =>
  (await rows(db, 'SELECT * FROM discovery_questions WHERE thread_id=$1 ORDER BY seq', [threadId])).map(
    questionDto,
  );

export const listNotes = async (db: Queryable, threadId: string) =>
  (
    await rows(db, 'SELECT * FROM discovery_notes WHERE thread_id=$1 AND removed_at IS NULL ORDER BY seq', [
      threadId,
    ])
  ).map(noteDto);

export const listProposals = async (db: Queryable, threadId: string) =>
  (await rows(db, 'SELECT * FROM discovery_proposals WHERE thread_id=$1 ORDER BY seq', [threadId])).map(
    proposalDto,
  );

/** The documents of a session: the brief and the PRD it links, and any document that lists it as a source. */
export async function sessionDocs(db: Queryable, t: Row): Promise<DiscoveryDoc[]> {
  const cfg = parseDiscoveryConfig(t.session_config);
  const list = await rows(
    db,
    `SELECT id, kind, title, status, current_version FROM documents
      WHERE org_id=$1 AND (id = ANY($2::uuid[]) OR $3::uuid = ANY(source_thread_ids)) ORDER BY created_at, id`,
    [t.org_id, [cfg.briefDocId, cfg.prdDocId].filter(Boolean), t.id],
  );
  return list.map((d) => ({
    id: d.id,
    kind: d.kind,
    title: d.title,
    status: d.status,
    currentVersion: d.current_version,
  }));
}

/** The organization's CEO when it can take part in a session: enabled, not paused, with an active agent. */
export async function availableCeo(db: Queryable, orgId: string): Promise<Row | undefined> {
  return one(
    db,
    `SELECT a.* FROM ceo_settings cs JOIN agents a ON a.id = cs.agent_id
      WHERE cs.org_id=$1 AND cs.enabled AND NOT cs.paused AND a.status = 'active' AND a.role_key = 'ceo'`,
    [orgId],
  );
}

export async function discoveryState(ctx: Ctx, t: Row, db: Queryable = ctx.pool): Promise<DiscoveryStateDto> {
  const cfg = parseDiscoveryConfig(t.session_config);
  const now = ctx.clock.now();
  const [questions, notes, proposals, documents, turnRows, cost, participants, ceo] = await Promise.all([
    listQuestions(db, t.id),
    listNotes(db, t.id),
    listProposals(db, t.id),
    sessionDocs(db, t),
    rows(db, 'SELECT * FROM session_turns WHERE thread_id=$1 ORDER BY queued_at DESC, id LIMIT 40', [t.id]),
    sessionCost(db, t),
    listParticipants(db, t.id),
    availableCeo(db, t.org_id),
  ]);
  const turns = turnRows.reverse();
  const active = turnRows.find((r) => r.status === 'queued' || r.status === 'running');
  const facilitator = participants.find((p) => p.seat === FACILITATOR_SEAT && p.kind !== 'user');
  const ceoPart = participants.find((p) => p.seat === CEO_SEAT && p.kind === 'agent');
  const open = questions.find((q) => q.status === 'open');
  let waitingFor: DiscoveryStateDto['waitingFor'] = 'nothing';
  if (cfg.paused) waitingFor = 'paused';
  else if (cfg.budgetStopped || cost.exceeded) waitingFor = 'budget';
  else if (active)
    waitingFor =
      (active.meta as { purpose?: string } | null)?.purpose === 'ceo_answer' ? 'ceo' : 'facilitator';
  else if (cfg.ceoPrep?.state === 'review' && questions.some((q) => q.status === 'proposed'))
    waitingFor = 'review';
  else if (open || proposals.some((p) => p.status === 'open')) waitingFor = 'owner';
  return {
    threadId: t.id,
    title: t.title,
    projectId: t.project_id ?? null,
    config: {
      stance: cfg.stance,
      phase: cfg.phase,
      ceoMode: cfg.ceoMode,
      playbook: cfg.playbook,
      templateKey: cfg.templateKey,
      idea: cfg.idea,
      timeBoxMinutes: cfg.timeBoxMinutes,
      paused: cfg.paused,
      model: cfg.model,
      budgetStopped: cfg.budgetStopped,
      ceoPrep: cfg.ceoPrep,
      intakeId: cfg.intakeId,
      prdValidation: cfg.prdValidation,
    },
    progress: discoveryProgress(cfg, now),
    cost,
    ceoAvailable: !!ceo,
    facilitatorName: facilitator?.display_name ?? 'Analyst',
    ceoName: ceoPart?.display_name ?? ceo?.name ?? null,
    workstationOnline: !!t.workstation_id && ctx.services.runners.isOnline(t.workstation_id),
    questions,
    notes,
    proposals,
    documents,
    turns: turns.map(turnDto),
    busy: !!active,
    waitingFor,
    createdAt: iso(t.created_at) as string,
  };
}
