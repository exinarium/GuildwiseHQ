import { randomUUID } from 'node:crypto';
import type { EscalationStep, QuestionShift, ServerToRunnerOf } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { dedupMatches } from '../queries/ledger.ts';
import { agentSpecFor, buildBrief, shiftVault } from './brief.ts';

type ShiftStartPayload = Omit<ServerToRunnerOf<'shift.start'>, 'v' | 'id' | 'type' | 'ts'>;

export const QUESTION_MAX_SHIFT_MINUTES = 15;

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
  const base = await buildBrief(ctx, {
    ...shift,
    card_id: item.card_id,
    kind: 'question',
    stage: card.stage,
  });
  if (!base) return null;
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
    ledgerMatches: matches.map((m) => ({ id: m.id, scope: m.scope, title: m.title, body: m.body })),
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
    agent: await agentSpecFor(ctx, agent),
    brief,
    worktree: null,
    prepare: { rebase: false },
    maxShiftMinutes: QUESTION_MAX_SHIFT_MINUTES,
    question,
    // The project's vault (read-only), like a card shift of this project on this workstation.
    vault: await shiftVault(ctx, agent, base.project.id),
  };
}
