import { randomUUID } from 'node:crypto';
import { FIX_BUDGETS, type FixSize, PLATFORM_DESK_SUBKIND, streamId } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { notifyPlatformDesk } from './desk.ts';
import { getPlatformTeam } from './settings.ts';

/**
 * Stop-loss of a bug-fix card (Lean Team v3, owner decision): small 2 rework rounds / 2 reviews / 10 shifts, medium
 * 3/2/15, large 4/2/25. Over budget the card goes to architect arbitration (one more budget); over that budget again the
 * owner (the platform organisation's desk) decides. S1a builds the generic budgets by card size; this module owns the
 * platform-specific escalation target and keeps the budget lookup behind `platformFixBudget` so the merge can point it
 * at S1a's implementation.
 */
export interface FixBudget {
  reworkRounds: number;
  reviews: number;
  shifts: number;
}

/**
 * The budget of a bug-fix card. The size comes from the platform bug (the architect sets it in triage, default medium);
 * every arbitration or owner extension adds one full budget on top.
 * (S1a's generic per-size budget is not on this branch: this is the minimal local version.)
 */
export function platformFixBudget(card: { fixSize: FixSize; budgetExtra?: number }): FixBudget {
  const b = FIX_BUDGETS[card.fixSize];
  const k = 1 + Math.max(0, card.budgetExtra ?? 0);
  return { reworkRounds: b.reworkRounds * k, reviews: b.reviews * k, shifts: b.shifts * k };
}

export interface FixUsage {
  reworkRounds: number;
  /** Review shifts that did not approve (changes requested, crashed, no report). */
  reviews: number;
  shifts: number;
}

export async function fixUsage(db: Tx | Ctx['pool'], cardId: string): Promise<FixUsage> {
  const c = await one(db, 'SELECT rework_round FROM cards WHERE id=$1', [cardId]);
  const s = await one(
    db,
    `SELECT count(*)::int AS shifts,
            count(*) FILTER (WHERE stage LIKE '%review%' AND status = 'ended'
                               AND report_outcome IS DISTINCT FROM 'approve')::int AS reviews
       FROM shifts WHERE card_id=$1 AND kind='card'`,
    [cardId],
  );
  return {
    reworkRounds: Number(c?.rework_round ?? 0),
    reviews: Number(s?.reviews ?? 0),
    shifts: Number(s?.shifts ?? 0),
  };
}

/** Which budget lines are used up: usage beyond the budget. */
export function overBudget(usage: FixUsage, budget: FixBudget): string[] {
  const out: string[] = [];
  if (usage.reworkRounds > budget.reworkRounds)
    out.push(`${usage.reworkRounds} rework rounds (budget ${budget.reworkRounds})`);
  if (usage.reviews > budget.reviews)
    out.push(`${usage.reviews} reviews that did not approve (budget ${budget.reviews})`);
  if (usage.shifts > budget.shifts) out.push(`${usage.shifts} shifts (budget ${budget.shifts})`);
  return out;
}

/** The architect stage of the card's workflow (agent stage claimed by the architect), if it has one. */
async function architectStage(tx: Tx, card: Row): Promise<string | null> {
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  const st = wf?.definition.stages.find((s) => s.kind === 'agent' && s.claimRole === 'architect');
  return st?.id ?? null;
}

const HOLD_MS = 365 * 24 * 3_600_000;

/**
 * Evaluates every open bug-fix card against its budget (called by the platform pass). Level 0 -> 1: architect
 * arbitration (the card goes back to the architect's stage with one more budget). Level 1 -> 2: over the extended budget
 * the card is held and the owner decides on the platform organisation's desk.
 */
export async function checkFixStopLoss(ctx: Ctx): Promise<number> {
  const team = await getPlatformTeam(ctx.pool);
  if (!team) return 0;
  const list = await rows(
    ctx.pool,
    `SELECT b.signature FROM platform_bugs b JOIN cards c ON c.id = b.card_id
      WHERE b.status = 'open' AND b.stop_loss_level < 2 AND c.status NOT IN ('done','cancelled')
        AND c.claim_id IS NULL`,
  );
  let n = 0;
  for (const l of list) {
    const acted = await withAppendTx(ctx.pool, async (tx) => {
      const bug = await one(tx, 'SELECT * FROM platform_bugs WHERE signature=$1 FOR UPDATE', [l.signature]);
      if (!bug || bug.stop_loss_level >= 2) return false;
      const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [bug.card_id]);
      if (!card || card.claim_id || ['done', 'cancelled'].includes(card.status)) return false;
      const budget = platformFixBudget({ fixSize: bug.fix_size, budgetExtra: Number(bug.budget_extra) });
      const over = overBudget(await fixUsage(tx, card.id), budget);
      if (over.length === 0) return false;
      const scope = projectScope(card.org_id, card.project_id);
      const events: AppendInput[] = [];
      if (bug.stop_loss_level === 0) {
        const stage = await architectStage(tx, card);
        if (stage && card.stage !== stage)
          events.push({
            streamId: streamId.card(card.id),
            event: {
              type: 'CardMovedByManager',
              payload: {
                cardId: card.id,
                fromStage: card.stage,
                toStage: stage,
                status: 'queued',
                reason: 'fix budget used up: architect arbitration',
              },
            },
            actor: SYSTEM_ACTOR,
            scope,
          });
        events.push(
          cardMessage(
            card,
            { kind: 'system' },
            'system',
            `Fix budget used up (${over.join('; ')}). Architect arbitration: decide whether the approach is wrong, narrow the fix or split it. The card gets one more budget; if that is used up too, the platform owner decides.`,
          ),
        );
        await exec(
          tx,
          'UPDATE platform_bugs SET stop_loss_level=1, budget_extra = budget_extra + 1 WHERE signature=$1',
          [bug.signature],
        );
        await ctx.store.append(events, { tx });
        await notifyPlatformDesk(
          ctx,
          {
            subjectKey: `platform_fix_stop_loss:${bug.signature}`,
            subkind: PLATFORM_DESK_SUBKIND.fixStopLoss,
            title: `${card.ref}: fix budget used up, architect arbitration`,
            body: `${over.join('; ')}. The platform architect decides how to go on. Nothing is needed from you yet.`,
            cardId: card.id,
            projectId: team.projectId,
          },
          { tx },
        );
        return true;
      }
      // Level 1 over the extended budget: hold the card and ask the owner.
      const deskItemId = randomUUID();
      events.push(
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardRetryDeferred',
            payload: {
              cardId: card.id,
              until: new Date(ctx.clock.now().getTime() + HOLD_MS).toISOString(),
              failures: 1,
              episodeId: randomUUID(),
              newEpisode: false,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `Still over budget after arbitration (${over.join('; ')}). The card is held; the platform owner decides on the desk.`,
        ),
        {
          streamId: streamId.desk(deskItemId),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId,
              kind: 'approval',
              subkind: PLATFORM_DESK_SUBKIND.fixStopLoss,
              title: `${card.ref}: the fix keeps failing. Allow another budget?`,
              body: `${bug.title}\n\nUsed: ${over.join('; ')}, even after architect arbitration. Approve to give the fix one more full budget; reject to leave it parked (the affected scope stays paused if the bug is critical).`,
              options: [],
              blocking: true,
              pinned: false,
              cardId: card.id,
              projectId: team.projectId,
              affectedCardIds: [card.id],
              askedBy: { kind: 'system' },
              data: { signature: bug.signature, platformTeam: true },
              subjectKey: `platform_fix_stop_loss_owner:${bug.signature}`,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(team.orgId, team.projectId),
        },
      );
      await exec(tx, 'UPDATE platform_bugs SET stop_loss_level=2, stop_loss_desk_item_id=$2 WHERE signature=$1', [
        bug.signature,
        deskItemId,
      ]);
      await ctx.store.append(events, { tx });
      return true;
    });
    if (acted) n++;
  }
  return n;
}

/**
 * The owner's decision on a stop-loss item (desk `closeItem` hook): approved gives one more budget and releases the
 * card; rejected leaves it parked.
 */
export async function resolveStopLossIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note?: string,
): Promise<void> {
  const bug = await one(tx, 'SELECT * FROM platform_bugs WHERE stop_loss_desk_item_id=$1 FOR UPDATE', [item.id]);
  if (!bug) return;
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [bug.card_id]);
  if (!card) return;
  if (resolution !== 'approved') {
    await ctx.store.append(
      [
        cardMessage(
          card,
          { kind: 'user', userId: user.id },
          'system',
          `The platform owner left the fix parked${note ? `: ${note}` : '.'}`,
        ),
      ],
      { tx },
    );
    return;
  }
  const events: AppendInput[] = [];
  if (card.retry_episode_id && card.retry_after)
    events.push({
      streamId: streamId.card(card.id),
      event: {
        type: 'CardRetryReleased',
        payload: {
          cardId: card.id,
          episodeId: card.retry_episode_id,
          releasedBy: user.id,
          reason: 'platform owner allowed another budget',
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    });
  events.push(
    cardMessage(
      card,
      { kind: 'user', userId: user.id },
      'system',
      `The platform owner allowed one more budget for this fix${note ? `: ${note}` : '.'}`,
    ),
  );
  await exec(
    tx,
    'UPDATE platform_bugs SET stop_loss_level=1, budget_extra = budget_extra + 1, stop_loss_desk_item_id=NULL WHERE signature=$1',
    [bug.signature],
  );
  await ctx.store.append(events, { tx });
}
