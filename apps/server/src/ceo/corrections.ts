import { randomUUID } from 'node:crypto';
import { type CeoCorrectionDto, type CorrectCeoRequest, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { undoCeoAction } from './commands.ts';
import { citedBy } from './decisions.ts';
import { makeEnv, ownerPrincipal, runAction } from './engine.ts';
import { addMemoryIn, editMemoryTextIn } from './memory.ts';
import { loadCeo } from './state.ts';

/**
 * Corrections are first-class (docs/design/ceo-front-door.md section 7). "You did X, I'd rather Y" from the chat, the Activity
 * tab, the desk or the daily report appends `CeoCorrected` and, in the same append, writes an active `correction` memory
 * that ranks first in every brief. Undo reuses `undoCeoAction`; Redo runs the corrected call with the owner's say-so.
 */

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface CorrectionOutcome {
  correctionId: string;
  memoryId: string | null;
  message: string;
  remedyResult: string | null;
}

/** The class of what is corrected (an action's class, or the order turn's), for the memory's scope. */
async function subjectOf(
  db: Queryable,
  orgId: string,
  req: Pick<CorrectCeoRequest, 'actionId' | 'orderTurnId'>,
): Promise<{ cls: string | null; action: Row | undefined; turn: Row | undefined }> {
  const action = req.actionId
    ? await one(db, 'SELECT * FROM ceo_actions WHERE id=$1 AND org_id=$2', [req.actionId, orgId])
    : undefined;
  if (req.actionId && !action) throw notFound('that action was not found');
  const turn = req.orderTurnId
    ? await one(db, `SELECT * FROM ceo_turns WHERE id=$1 AND org_id=$2 AND mode='order'`, [
        req.orderTurnId,
        orgId,
      ])
    : undefined;
  if (req.orderTurnId && !turn) throw notFound('that order turn was not found');
  return { cls: (action?.class as string | undefined) ?? null, action, turn };
}

/**
 * Records a correction. The Owner may also undo or redo; an Admin records a rule-only correction, and only on actions that
 * were not owner-reserved (and never on an order turn: an order is the Owner's authority).
 */
export async function recordCorrection(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  req: CorrectCeoRequest & { threadId?: string | undefined; viaCeo?: boolean | undefined },
): Promise<CorrectionOutcome> {
  const role = await orgRoleOf(ctx.pool, user.id, orgId);
  if (role !== 'owner' && role !== 'admin') throw forbidden('only the Owner and Admins can correct the CEO');
  const ceo = await loadCeo(ctx.pool, orgId);
  if (!ceo?.agentId) throw conflict('no_ceo', 'there is no CEO');
  const text = req.text.trim();
  const rule = (req.rule ?? text).trim();
  if (role === 'admin') {
    if (req.remedy !== 'none')
      throw forbidden('only the Owner can undo or redo what the CEO did: an Admin records the rule');
    if (req.orderTurnId) throw forbidden('only the Owner can correct a standing order turn');
  }
  const subject = await subjectOf(ctx.pool, orgId, req);
  if (role === 'admin' && subject.action?.cause === 'reserved')
    throw forbidden('this action was owner-reserved: only the Owner can correct it');
  if (req.remedy === 'undo' && !req.actionId) throw badRequest('nothing_to_undo', 'say which action to undo');
  const correctionId = randomUUID();
  const memoryRef = `correction:${correctionId}`;
  const outcome = await withAppendTx(ctx.pool, async (tx: Tx) => {
    let memoryId: string | undefined;
    if (req.makeRule) {
      memoryId = await addMemoryIn(ctx, tx, {
        orgId,
        kind: 'correction',
        scope: subject.cls ? `class:${subject.cls}` : 'org',
        source: 'owner_correction',
        sourceRef: memoryRef,
        confidence: 1.0,
        status: 'active',
        text: subject.action
          ? `${rule} (the owner corrected: ${clip(String(subject.action.subject_label), 160)} was ${clip(String(subject.action.reason), 160)})`
          : rule,
        quote: text.slice(0, 1000),
        ...(subject.cls ? { cls: subject.cls } : {}),
        byUserId: user.id,
      });
    }
    const events: AppendInput[] = [];
    // The memories the corrected action cited lose confidence (the same -0.2 a desk correction gives).
    if (req.actionId)
      for (const mid of await citedBy(tx, orgId, req.actionId)) {
        const m = await one(
          tx,
          `SELECT confidence FROM ceo_memories WHERE id=$1 AND org_id=$2 AND status IN ('active','candidate')`,
          [mid, orgId],
        );
        if (m)
          events.push({
            streamId: streamId.ceo(orgId),
            event: {
              type: 'CeoMemoryAdjusted',
              payload: {
                memoryId: mid,
                orgId,
                confidence: Math.max(0, Number(m.confidence) - 0.2),
                reason: 'the owner corrected a decision that cited it',
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(orgId),
          });
      }
    events.push({
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoCorrected',
        payload: {
          correctionId,
          orgId,
          by: user.id,
          ...(req.actionId ? { actionId: req.actionId } : {}),
          ...(req.orderTurnId ? { orderTurnId: req.orderTurnId } : {}),
          ...(req.chatMessageId ? { chatMessageId: req.chatMessageId } : {}),
          ...(req.deskItemId ? { deskItemId: req.deskItemId } : {}),
          text: text.slice(0, 4000),
          rule: rule.slice(0, 1000),
          ...(memoryId ? { memoryId } : {}),
          remedy: req.remedy,
          ...(req.redo ? { redo: req.redo } : {}),
          ...(subject.cls ? { class: subject.cls } : {}),
        },
      },
      actor: userActor(user.id),
      scope: orgScope(orgId),
    });
    await ctx.store.append(events, { tx });
    return { memoryId };
  });
  // The remedy runs after the correction is on record (an undo that fails must not lose the rule).
  let remedyResult: string | null = null;
  if (req.remedy === 'undo' && req.actionId) {
    try {
      remedyResult = (await undoCeoAction(ctx, user, orgId, req.actionId)).message;
    } catch (err) {
      remedyResult = `Not undone: ${(err as Error).message}`;
    }
  } else if (req.remedy === 'redo' && req.redo) {
    remedyResult = await redoAction(ctx, user, orgId, correctionId, req);
  }
  return {
    correctionId,
    memoryId: outcome.memoryId ?? null,
    message: outcome.memoryId
      ? `Noted: ${rule}${remedyResult ? ` ${remedyResult}` : ''}`
      : `Recorded.${remedyResult ? ` ${remedyResult}` : ''}`,
    remedyResult,
  };
}

/**
 * Redo: the corrected call runs through the engine with `force` (the Owner approved that exact call) and the correction as
 * its cause; an undone action is not undone twice.
 */
async function redoAction(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  correctionId: string,
  req: CorrectCeoRequest,
): Promise<string> {
  const redo = req.redo as { action: string; params: Record<string, unknown> };
  const ceo = await loadCeo(ctx.pool, orgId);
  if (!ceo?.agentId) return 'Not redone: there is no CEO.';
  const agent = await one(ctx.pool, 'SELECT id, name FROM agents WHERE id=$1', [ceo.agentId]);
  if (!agent) return 'Not redone: there is no CEO.';
  const owner = await ownerPrincipal(ctx, orgId);
  const origin = {
    scopeId: correctionId,
    untrusted: false,
    acceptedFrom: correctionId,
    kind: 'owner' as const,
  };
  const env = makeEnv(ctx, ceo, agent as { id: string; name: string }, owner, origin);
  if (req.actionId) {
    const a = await one(ctx.pool, 'SELECT status, inverse FROM ceo_actions WHERE id=$1', [req.actionId]);
    if (a?.status === 'done' && a.inverse) {
      try {
        await undoCeoAction(ctx, user, orgId, req.actionId);
      } catch (err) {
        return `Not redone: the first action could not be undone (${(err as Error).message}).`;
      }
    }
  }
  const r = await runAction(
    env,
    {
      op: 'act',
      action: redo.action as never,
      params: redo.params,
      reason: `The owner corrected an earlier action and asked for this instead: ${clip(req.text, 300)}`,
      confidence: 1,
      evidence: [],
      key: `redo:${correctionId}`,
      dryRun: false,
    },
    origin,
    { force: true },
  );
  return r.status === 'executed' ? `Redone: ${r.message}` : `Not redone: ${r.message}`;
}

/** "Redo it as ..." from the chat card: the corrected call stored with the correction runs with the Owner's say-so. */
export async function redoCorrection(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  correctionId: string,
): Promise<string> {
  const c = await one(ctx.pool, 'SELECT * FROM ceo_corrections WHERE id=$1 AND org_id=$2', [
    correctionId,
    orgId,
  ]);
  if (!c) throw notFound('correction not found');
  if ((await orgRoleOf(ctx.pool, user.id, orgId)) !== 'owner') throw forbidden('only the Owner can redo');
  if (!c.redo) throw conflict('nothing_to_redo', 'this correction has no corrected call to run');
  return redoAction(ctx, user, orgId, correctionId, {
    text: c.text,
    remedy: 'redo',
    redo: c.redo,
    makeRule: false,
    ...(c.action_id ? { actionId: c.action_id } : {}),
  } as CorrectCeoRequest);
}

/** The rule of a correction was edited in the chat card: the memory's text follows. */
export async function editCorrection(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  correctionId: string,
  rule: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const c = await one(tx, 'SELECT * FROM ceo_corrections WHERE id=$1 AND org_id=$2 FOR UPDATE', [
      correctionId,
      orgId,
    ]);
    if (!c) throw notFound('correction not found');
    if ((await orgRoleOf(tx, user.id, orgId)) !== 'owner')
      throw forbidden('only the Owner can edit a correction');
    const events: AppendInput[] = [
      {
        streamId: streamId.ceo(orgId),
        event: { type: 'CeoCorrectionEdited', payload: { correctionId, orgId, rule, by: user.id } },
        actor: userActor(user.id),
        scope: orgScope(orgId),
      },
    ];
    if (c.memory_id) {
      events.push(...(await editMemoryTextIn(tx, orgId, user.id, c.memory_id, rule)));
    }
    await ctx.store.append(events, { tx });
  });
}

const toDto = (c: Row, a?: Row): CeoCorrectionDto => ({
  id: c.id,
  at: new Date(c.created_at).toISOString(),
  text: c.text,
  rule: c.rule,
  memoryId: c.memory_id ?? null,
  actionId: c.action_id ?? null,
  orderTurnId: c.order_turn_id ?? null,
  chatMessageId: c.chat_message_id ?? null,
  deskItemId: c.desk_item_id ?? null,
  remedy: c.remedy,
  // Undo or Redo stays on offer while the action is done and has an inverse (and was not undone since).
  canUndo: !!a && a.status === 'done' && !!a.inverse,
  canRedo: !!a && a.status === 'undone',
});

/** Corrections of an organization (newest first), with what can still be undone or redone. */
export async function listCorrections(
  db: Queryable,
  orgId: string,
  opts: { threadId?: string; limit?: number } = {},
): Promise<CeoCorrectionDto[]> {
  const list = await rows(
    db,
    `SELECT c.*, a.status AS a_status, a.inverse AS a_inverse
       FROM ceo_corrections c LEFT JOIN ceo_actions a ON a.id = c.action_id
      WHERE c.org_id=$1 AND ($2::uuid IS NULL OR c.thread_id = $2 OR c.chat_message_id IN (SELECT id FROM thread_messages WHERE thread_id=$2))
      ORDER BY c.created_at DESC LIMIT $3`,
    [orgId, opts.threadId ?? null, opts.limit ?? 20],
  );
  return list.map((c) => toDto(c, c.action_id ? { status: c.a_status, inverse: c.a_inverse } : undefined));
}
