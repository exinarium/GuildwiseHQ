import { randomUUID } from 'node:crypto';
import {
  type AgentRuntimeSpec,
  type EscalationStep,
  type QuestionShift,
  ROUTINE_TOPICS,
  type ServerToRunnerOf,
  type ShiftBrief,
} from '@aom/shared';
import { ceoActive } from '../ceo/state.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { dedupMatches } from '../queries/ledger.ts';
import { agentSpecFor, buildBrief, shiftVault } from './brief.ts';

type ShiftStartPayload = Omit<ServerToRunnerOf<'shift.start'>, 'v' | 'id' | 'type' | 'ts'>;

export const QUESTION_MAX_SHIFT_MINUTES = 15;

/** The slim question brief stays near 20K tokens (about 4 characters each, with room for the fixed prompt). */
const SLIM_BRIEF_CHARS = 48_000;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The answerer's brief (Lean Team v3, design 6.3): the card summary, the last three thread messages and handoffs, the
 * question and, next to it, the three best ledger matches the server attached. No card ledger entries (the matches
 * replace the "ledger search" order), no 30-message thread, long fields clipped.
 */
export function slimQuestionBrief(brief: ShiftBrief): ShiftBrief {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(brief.card.fields ?? {}))
    fields[k] = typeof v === 'string' ? clip(v, 3000) : v;
  const slim: ShiftBrief = {
    ...brief,
    card: { ...brief.card, fields, attachments: [] },
    ledger: [],
    thread: brief.thread.slice(-3).map((m) => ({ ...m, body: clip(m.body, 1000) })),
    handoffs: brief.handoffs.slice(-3).map((h) => ({ ...h, note: clip(h.note, 600) })),
    reviewComments: brief.reviewComments.slice(-1).map((c) => ({ ...c, comments: clip(c.comments, 1500) })),
    standingOrders: brief.standingOrders
      .map((o) => ({ title: o.title, body: clip(o.body, 600) }))
      .slice(0, 20),
  };
  // Still over the cap (a huge card): the thread and handoffs go, the card and the question stay.
  if (JSON.stringify(slim).length > SLIM_BRIEF_CHARS) return { ...slim, thread: [], handoffs: [] };
  return slim;
}

/**
 * Routine and factual questions are answered on Sonnet; design and requirements keep the answerer's model. The CEO
 * answers on its own wake model (Sonnet by default), as a router, unless the topic is design or requirements.
 */
async function questionAgentSpec(
  ctx: Ctx,
  agent: Parameters<typeof agentSpecFor>[1],
  topic: string | null,
): Promise<AgentRuntimeSpec> {
  const spec = await agentSpecFor(ctx, agent);
  if (agent.role_key === 'ceo') {
    const ceo = await ceoActive(ctx.pool, agent.org_id);
    const wake = ceo?.settings.models.wake;
    return wake ? { ...spec, model: wake.model, effort: wake.effort } : { ...spec, model: 'sonnet' };
  }
  const routine = topic ? (ROUTINE_TOPICS as readonly string[]).includes(topic) : false;
  return routine ? { ...spec, model: 'sonnet', effort: 'medium' } : spec;
}
/**
 * The `shift.start` for a question shift (docs/ARCHITECTURE.md section 15): no worktree, no claim. The brief is the
 * card the question is about, seen through the answering agent's role; the question itself travels in `question`.
 */
export async function buildQuestionShiftStart(
  ctx: Ctx,
  deskItemId: string,
  shiftId: string,
): Promise<ShiftStartPayload | null> {
  const item = await one(ctx.pool, 'SELECT * FROM desk_items WHERE id=$1', [deskItemId]);
  const shift = await one(ctx.pool, 'SELECT * FROM shifts WHERE id=$1', [shiftId]);
  if (!item?.card_id || !shift) return null;
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  const card = await one(ctx.pool, 'SELECT stage FROM cards WHERE id=$1', [item.card_id]);
  if (!agent || !card) return null;
  const full = await buildBrief(ctx, {
    ...shift,
    card_id: item.card_id,
    kind: 'question',
    stage: card.stage,
  });
  if (!full) return null;
  const base = slimQuestionBrief(full);
  const trail = (item.escalation_trail ?? []) as EscalationStep[];
  const matches = await dedupMatches(ctx.pool, item.org_id, item.project_id, item.title);
  const level = agent.role_key === 'ba' ? 'ba' : 'peer';
  const question: QuestionShift = {
    deskItemId,
    level,
    text: item.title,
    doing: item.doing ?? '',
    options: (item.options as Array<{ id: string; label: string }>).map((o) => ({
      id: o.id,
      label: o.label,
    })),
    ...(item.recommendation ? { recommendation: item.recommendation } : {}),
    blocking: item.blocking,
    askedBy: {
      name: trail.find((s) => s.step === 'asked')?.agentName ?? 'an agent',
      ...(item.asked_by_role ? { role: item.asked_by_role } : {}),
    },
    trail: trail
      .filter((s) => s.step !== 'asked' && s.agentId !== agent.id && s.agentName)
      .map((s) => `${s.agentName} (${s.role ?? s.step})`),
    ledgerMatches: matches
      .slice(0, 3)
      .map((m) => ({ id: m.id, scope: m.scope, title: m.title, body: clip(m.body, 1500) })),
  };
  const brief = {
    ...base,
    shift: {
      id: shiftId,
      kind: 'question' as const,
      stage: 'question',
      stageLabel: 'Question',
      doneCriteria: 'The question is answered, or passed on with a note on what you checked.',
      outcomes: [],
      maxShiftMinutes: QUESTION_MAX_SHIFT_MINUTES,
    },
  };
  return {
    shiftId,
    claimId: randomUUID(),
    kind: 'question',
    agent: await questionAgentSpec(ctx, agent, item.topic ?? null),
    brief,
    worktree: null,
    prepare: { rebase: false },
    maxShiftMinutes: QUESTION_MAX_SHIFT_MINUTES,
    question,
    // The project's vault (read-only), like a card shift of this project on this workstation.
    vault: await shiftVault(ctx, agent, base.project.id),
  };
}
