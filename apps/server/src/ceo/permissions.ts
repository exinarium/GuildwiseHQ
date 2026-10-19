import { createHash, randomUUID } from 'node:crypto';
import {
  CEO_PERMISSION_SUBKIND,
  CEO_PERMISSION_TIMEOUT_MS,
  type CeoPermissionDecision,
  type CeoPermissionDto,
  maskText,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { agentActor, orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';

/**
 * "Authorize this execution" (docs/design/ceo-front-door.md section 14.1). Turns run in auto mode. When the runtime needs a
 * permission it lacks, the runner's relay raises this question on the desk. Any Owner or Admin may Authorize it (once, or for
 * the rest of the turn) or Deny it; no answer in 10 minutes is a Deny. A push notification only points at the desk item.
 */

const ASK_OPTIONS = [
  { id: 'once', label: 'Authorize once', description: 'Run this step only.' },
  { id: 'turn', label: 'Authorize for this turn', description: 'Run this tool for the rest of the turn.' },
  { id: 'deny', label: 'Deny' },
];

const inputHash = (tool: string, input: string): string =>
  createHash('sha256').update(`${tool}\n${input}`).digest('hex').slice(0, 24);

const deskScope = orgScope;

/** The relay asks: raises the desk question (once per tool and input while one is open) and returns its id. */
export async function askPermission(
  ctx: Ctx,
  turn: Row,
  rpc: { tool?: string | undefined; input?: string | undefined; reason?: string | undefined },
): Promise<{ askId: string; deskItemId: string }> {
  const tool = (rpc.tool ?? 'a tool').slice(0, 200);
  // Secrets in the input never reach the desk (the runner redacted it; this is the second pass).
  const input = maskText(rpc.input ?? '').slice(0, 4000);
  const reason = maskText(rpc.reason ?? '').slice(0, 1000);
  const open = await one(
    ctx.pool,
    `SELECT id, desk_item_id FROM ceo_permission_asks WHERE turn_id=$1 AND tool=$2 AND input=$3 AND status='pending'`,
    [turn.id, tool, input],
  );
  if (open) return { askId: open.id, deskItemId: open.desk_item_id };
  const askId = randomUUID();
  const deskItemId = randomUUID();
  const ceo = await one(ctx.pool, 'SELECT agent_id FROM ceo_settings WHERE org_id=$1', [turn.org_id]);
  const agentId = ceo?.agent_id as string | undefined;
  const events: AppendInput[] = [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'approval',
          subkind: CEO_PERMISSION_SUBKIND,
          title: `Authorize this execution? ${tool}`.slice(0, 280),
          body: [
            reason ? `Why: ${reason}` : '',
            input ? `Input: ${input.slice(0, 600)}` : '',
            turn.mode === 'order'
              ? 'This is a standing order running without anyone watching: it does not wait for you, and reports the step as waiting.'
              : 'The CEO waits for your answer in this conversation. No answer in 10 minutes means Deny.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          options: ASK_OPTIONS,
          // An owner turn is stopped until somebody answers; an order turn does not wait.
          blocking: turn.mode === 'owner',
          pinned: turn.mode === 'owner',
          affectedCardIds: [],
          askedBy: agentId ? { kind: 'agent', agentId, role: 'ceo' } : { kind: 'system' },
          subjectKey: `ceo_permission:${askId}`,
          data: {
            askId,
            turnId: turn.id,
            threadId: turn.thread_id,
            tool,
            input,
            reason,
            mode: turn.mode,
            expiresAt: new Date(ctx.clock.now().getTime() + CEO_PERMISSION_TIMEOUT_MS).toISOString(),
            hash: inputHash(tool, input),
          },
        },
      },
      actor: agentId ? agentActor(agentId) : SYSTEM_ACTOR,
      scope: deskScope(turn.org_id),
    },
    {
      streamId: streamId.ceo(turn.org_id),
      event: {
        type: 'CeoPermissionAsked',
        payload: {
          askId,
          orgId: turn.org_id,
          turnId: turn.id,
          threadId: turn.thread_id,
          mode: turn.mode,
          tool,
          input,
          reason,
          deskItemId,
        },
      },
      actor: agentId ? agentActor(agentId) : SYSTEM_ACTOR,
      scope: orgScope(turn.org_id),
    },
  ];
  await ctx.store.append(events);
  return { askId, deskItemId };
}

type Status = 'pending' | 'once' | 'turn' | 'deny' | 'timeout';

/** Events that close a question as answered: the audit event and the desk item's resolution. */
function closeEvents(
  ask: Row,
  decision: CeoPermissionDecision,
  by: string | undefined,
  orgId: string,
): AppendInput[] {
  return [
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoPermissionAnswered',
        payload: {
          askId: ask.id,
          orgId,
          turnId: ask.turn_id,
          tool: ask.tool,
          decision,
          ...(by ? { by } : {}),
        },
      },
      actor: by ? userActor(by) : SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
    {
      streamId: streamId.desk(ask.desk_item_id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: ask.desk_item_id,
          resolution: decision === 'once' || decision === 'turn' ? 'approved' : 'rejected',
          note:
            decision === 'timeout'
              ? 'No answer in 10 minutes: denied.'
              : decision === 'turn'
                ? 'Authorized for this turn.'
                : decision === 'once'
                  ? 'Authorized once.'
                  : 'Denied.',
          by: by ? { kind: 'user', userId: by } : { kind: 'system' },
        },
      },
      actor: by ? userActor(by) : SYSTEM_ACTOR,
      scope: deskScope(orgId),
    },
  ];
}

/** The relay polls: the answer, or `timeout` once 10 minutes passed (the question closes itself). */
export async function pollPermission(ctx: Ctx, turn: Row, askId: string): Promise<{ status: Status }> {
  const ask = await one(ctx.pool, 'SELECT * FROM ceo_permission_asks WHERE id=$1 AND turn_id=$2', [
    askId,
    turn.id,
  ]);
  if (!ask) throw notFound('unknown question');
  if (ask.status !== 'pending') return { status: ask.status };
  if (ctx.clock.now().getTime() < new Date(ask.expires_at).getTime()) return { status: 'pending' };
  return withAppendTx(ctx.pool, async (tx) => {
    const cur = await one(tx, 'SELECT * FROM ceo_permission_asks WHERE id=$1 FOR UPDATE', [askId]);
    if (cur?.status !== 'pending') return { status: (cur?.status ?? 'timeout') as Status };
    await ctx.store.append(closeEvents(cur, 'timeout', undefined, turn.org_id), { tx });
    return { status: 'timeout' as Status };
  });
}

/** Owner or Admin presses a button (the web route, or the generic desk resolution of the item). */
export async function answerPermission(
  ctx: Ctx,
  user: AuthSession['user'],
  askId: string,
  decision: Exclude<CeoPermissionDecision, 'timeout'>,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const ask = await one(tx, 'SELECT * FROM ceo_permission_asks WHERE id=$1 FOR UPDATE', [askId]);
    if (!ask) throw notFound('question not found');
    const role = await orgRoleOf(tx, user.id, ask.org_id);
    if (role !== 'owner' && role !== 'admin')
      throw forbidden('only an Owner or an Admin can authorize an execution');
    if (ask.status !== 'pending')
      throw conflict('already_answered', `this question is already ${ask.status}`);
    await ctx.store.append(closeEvents(ask, decision, user.id, ask.org_id), { tx });
  });
}

/** The generic desk resolution of a `ceo_permission` item: approved = once, rejected = deny. */
export async function resolveCeoPermissionItem(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  item: Row,
  resolution: string,
): Promise<boolean> {
  const askId = (item.data as { askId?: string } | null)?.askId;
  if (!askId) return false;
  const ask = await one(tx, 'SELECT * FROM ceo_permission_asks WHERE id=$1 FOR UPDATE', [askId]);
  if (!ask || ask.status !== 'pending') return false;
  const role = await orgRoleOf(tx, user.id, ask.org_id);
  if (role !== 'owner' && role !== 'admin')
    throw forbidden('only an Owner or an Admin can authorize an execution');
  const decision: CeoPermissionDecision = resolution === 'approved' ? 'once' : 'deny';
  // The caller appends DeskItemResolved itself: only the audit event goes here.
  await ctx.store.append(closeEvents(ask, decision, user.id, ask.org_id).slice(0, 1), { tx });
  return true;
}

/** Questions of a finished turn that nobody answered: closed as timed out (no dangling desk items). */
export async function closePendingForTurn(db: Queryable, turn: Row): Promise<AppendInput[]> {
  const pending = await rows(db, `SELECT * FROM ceo_permission_asks WHERE turn_id=$1 AND status='pending'`, [
    turn.id,
  ]);
  return pending.flatMap((a) => closeEvents(a, 'timeout', undefined, turn.org_id));
}

/** The pending questions of a conversation, for the chat. */
export async function pendingForThread(db: Queryable, threadId: string): Promise<CeoPermissionDto[]> {
  const list = await rows(
    db,
    `SELECT * FROM ceo_permission_asks WHERE thread_id=$1 AND status='pending' ORDER BY asked_at`,
    [threadId],
  );
  return list.map((a) => ({
    askId: a.id,
    deskItemId: a.desk_item_id,
    turnId: a.turn_id,
    mode: a.mode,
    tool: a.tool,
    input: a.input,
    reason: a.reason,
    askedAt: new Date(a.asked_at).toISOString(),
    expiresAt: new Date(a.expires_at).toISOString(),
  }));
}
