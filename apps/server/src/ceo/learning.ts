import { CLASS_LABEL, type ActionClass, type RecommendationResponse, streamId } from '@aom/shared';
import { orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { addMemoryIn, textHash } from './memory.ts';
import { loadCeo } from './state.ts';

const label = (cls: string): string => CLASS_LABEL[cls as ActionClass] ?? cls;

/** Memory ids an action cited as evidence (`memory:<id>`). */
const citedMemories = (evidence: unknown): string[] =>
  (Array.isArray(evidence) ? evidence : [])
    .map(String)
    .filter((e) => e.startsWith('memory:'))
    .map((e) => e.slice(7));

/**
 * A pattern candidate: the same observation again adds to its count instead of making a second memory. After three
 * consistent observations the candidate shows up in the daily report ("Learned") for the owner to keep, edit or drop;
 * it never becomes active on its own.
 */
async function observe(
  ctx: Ctx,
  orgId: string,
  userId: string | null,
  o: { cls: string; scope: string; text: string; source: 'owner_desk_answer' | 'owner_override' | 'owner_undo' | 'owner_training'; sourceRef: string; kind: 'decision_pattern' | 'correction' },
): Promise<void> {
  const hash = textHash(o.text);
  await withAppendTx(ctx.pool, async (tx) => {
    const same = await one(
      tx,
      `SELECT id, observations, confidence FROM ceo_memories WHERE org_id=$1 AND text_hash=$2 AND scope=$3 AND status IN ('candidate','active') FOR UPDATE`,
      [orgId, hash, o.scope],
    );
    if (same) {
      await ctx.store.append(
        [
          {
            streamId: streamId.ceo(orgId),
            event: {
              type: 'CeoMemoryAdjusted',
              payload: { memoryId: same.id, orgId, confidence: Math.min(0.9, Number(same.confidence) + 0.1), observations: Number(same.observations) + 1, reason: 'observed again' },
            },
            actor: userId ? userActor(userId) : { kind: 'system', id: null },
            scope: orgScope(orgId),
          },
        ],
        { tx },
      );
      return;
    }
    await addMemoryIn(ctx, tx, {
      orgId,
      kind: o.kind,
      scope: o.scope,
      source: o.source,
      sourceRef: o.sourceRef,
      confidence: 0.5,
      status: 'candidate',
      text: o.text,
      cls: o.cls,
      ...(userId ? { byUserId: userId } : {}),
    });
  });
}

/**
 * The owner's response to a recommendation of the CEO: the training observation (accepted, accepted with a change,
 * rejected, answered differently). It feeds the agreement score, and a disagreement becomes a pattern candidate.
 */
export async function recordResponse(
  ctx: Ctx,
  orgId: string,
  userId: string,
  actionId: string,
  response: RecommendationResponse,
  opts: { note?: string | undefined; ownerChoice?: string | undefined; deskItemId?: string | undefined } = {},
): Promise<void> {
  const a = await one(ctx.pool, `SELECT * FROM ceo_actions WHERE id=$1 AND org_id=$2 AND mode='recommended' AND response IS NULL`, [actionId, orgId]);
  if (!a) return;
  await ctx.store.append([
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoRecommendationResponded',
        payload: {
          actionId,
          orgId,
          class: a.class,
          response,
          ...(opts.note ? { note: opts.note.slice(0, 4000) } : {}),
          ...(opts.ownerChoice ? { ownerChoice: opts.ownerChoice.slice(0, 200) } : {}),
          ...(opts.deskItemId ? { deskItemId: opts.deskItemId } : {}),
          by: userId,
        },
      },
      actor: userActor(userId),
      scope: orgScope(orgId),
    },
  ]);
  const cited = citedMemories(a.evidence);
  if (response === 'accepted') {
    for (const id of cited) await bump(ctx, orgId, id, +0.05, 'recommendation accepted');
    return;
  }
  // The owner chose differently: a candidate pattern with the CEO's idea and the owner's choice.
  for (const id of cited) await bump(ctx, orgId, id, -0.1, 'recommendation not followed');
  const chose =
    response === 'rejected'
      ? 'declined'
      : opts.ownerChoice
        ? `chose ${opts.ownerChoice}`
        : 'decided differently';
  await observe(ctx, orgId, userId, {
    cls: a.class,
    scope: a.subject_kind ? `${a.subject_kind}:${a.class}` : 'org',
    text: `${label(a.class)}: the CEO recommended "${String(a.subject_label).slice(0, 120)}" (${String(a.reason).slice(0, 160)}); the owner ${chose}${opts.note ? ` because: ${opts.note.slice(0, 200)}` : ''}.`,
    source: 'owner_training',
    sourceRef: `action:${actionId}`,
    kind: 'decision_pattern',
  });
}

async function bump(ctx: Ctx, orgId: string, memoryId: string, delta: number, reason: string): Promise<void> {
  const m = await one(ctx.pool, `SELECT confidence FROM ceo_memories WHERE id=$1 AND org_id=$2 AND status IN ('active','candidate')`, [memoryId, orgId]);
  if (!m) return;
  await ctx.store.append([
    {
      streamId: streamId.ceo(orgId),
      event: { type: 'CeoMemoryAdjusted', payload: { memoryId, orgId, confidence: Math.max(0, Math.min(1, Number(m.confidence) + delta)), reason } },
      actor: { kind: 'system', id: null },
      scope: orgScope(orgId),
    },
  ]);
}

/** An undo of a CEO decision: a correction candidate, and the memories it cited lose confidence. */
export async function onUndo(ctx: Ctx, orgId: string, userId: string, a: Row): Promise<void> {
  for (const id of citedMemories(a.evidence)) await bump(ctx, orgId, id, -0.2, 'the decision was undone');
  await observe(ctx, orgId, userId, {
    cls: a.class,
    scope: `${a.subject_kind}:${a.class}`,
    text: `Correction: the owner undid "${label(a.class)}" on "${String(a.subject_label).slice(0, 120)}". The CEO's reason was: ${String(a.reason).slice(0, 200)}`,
    source: 'owner_undo',
    sourceRef: `action:${a.id}`,
    kind: 'correction',
  });
}

/**
 * The owner answered a desk question themselves. If the CEO had put a recommendation on it, that is the training
 * observation (same option: accepted; another: answered differently). Either way the answer is an observation of how
 * the owner decides on that kind of item.
 */
export async function onOwnerAnswer(
  ctx: Ctx,
  orgId: string,
  userId: string,
  item: Row,
  answer: { optionId?: string | undefined; text: string },
): Promise<void> {
  const ceo = await loadCeo(ctx.pool, orgId);
  if (!ceo?.enabled) return;
  const rec = item.ceo_recommendation as { actionId?: string; option?: string | null; text?: string | null } | null;
  if (rec?.actionId) {
    const same = rec.option ? rec.option === answer.optionId : (rec.text ?? '').trim().toLowerCase() === answer.text.trim().toLowerCase();
    const label2 = answer.optionId
      ? ((item.options as Array<{ id: string; label: string }>).find((o) => o.id === answer.optionId)?.label ?? answer.optionId)
      : answer.text.slice(0, 120);
    await recordResponse(ctx, orgId, userId, rec.actionId, same ? 'accepted' : 'different', {
      ownerChoice: label2,
      deskItemId: item.id,
    });
    return;
  }
  if (item.kind === 'question' && !item.ceo_action_id) {
    await observe(ctx, orgId, userId, {
      cls: 'desk.answer_question',
      scope: `subkind:${item.subkind ?? 'question'}`,
      text: `On ${item.subkind ?? 'agent'} questions like "${String(item.title).replace(/\s+/g, ' ').slice(0, 120)}" the owner answered: ${answer.text.replace(/\s+/g, ' ').slice(0, 200)}`,
      source: 'owner_desk_answer',
      sourceRef: `desk:${item.id}`,
      kind: 'decision_pattern',
    });
  }
}
