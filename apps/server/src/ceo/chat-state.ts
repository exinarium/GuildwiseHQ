import {
  CEO_QUEUE_STALE_HOURS,
  type CeoChatStateDto,
  DIRECT_RUNTIME,
  type ModelChoice,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { defaultChoiceOf, resolveTurnModel } from '../chat/ceo-turns.ts';
import { orgScope, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { CLAUDE_RUNTIME, mainUsable } from '../dispatcher/accounts.ts';
import { conflict, notFound } from '../errors.ts';
import { fullPowerOf } from '../queries/ceo.ts';
import { providersOf, type RuntimeReport, runtimeProblem, runtimeReports } from '../sessions/offer.ts';
import { ensureCeoThread } from './chat.ts';
import { listCorrections } from './corrections.ts';
import { pendingForThread } from './permissions.ts';
import { loadCeo } from './state.ts';

/** What the CEO chat page needs beyond its messages: the model, full power, the queue and the open cards (docs section 5). */
export async function ceoChatState(ctx: Ctx, orgId: string): Promise<CeoChatStateDto> {
  const ceo = await loadCeo(ctx.pool, orgId);
  if (!ceo?.enabled || !ceo.agentId) throw notFound('this organization has no CEO');
  const t = await ensureCeoThread(ctx.pool, orgId);
  // The thread may not exist yet (the page creates it with POST /api/ceo/chat first): an empty state still helps the page.
  const threadId = t.threadId ?? ceo.chatThreadId;
  if (!threadId) throw notFound('the CEO chat does not exist yet');
  const agent = await one(
    ctx.pool,
    `SELECT a.*, w.name AS ws_name, w.runtimes AS ws_runtimes, (w.connected AND w.last_seen_at > $2) AS ws_online
       FROM agents a LEFT JOIN workstations w ON w.id = a.workstation_id WHERE a.id=$1`,
    [ceo.agentId, new Date(ctx.clock.now().getTime() - 45_000)],
  );
  if (!agent) throw notFound('the CEO agent is gone');
  const thread = await one(ctx.pool, 'SELECT model_override, dirs FROM threads WHERE id=$1', [threadId]);
  const runtimes = (agent.ws_runtimes as Array<{ id: string; available?: boolean }> | null) ?? [];
  const running = await one(ctx.pool, `SELECT 1 FROM ceo_turns WHERE thread_id=$1 AND status='running'`, [
    threadId,
  ]);
  const queued = await rows(
    ctx.pool,
    `SELECT t.id, t.message_id, t.queued_at, m.body FROM ceo_turns t LEFT JOIN thread_messages m ON m.id = t.message_id
      WHERE t.thread_id=$1 AND t.status='queued' AND t.mode='owner' ORDER BY t.queued_at`,
    [threadId],
  );
  const now = ctx.clock.now().getTime();
  const confirmations = await rows(
    ctx.pool,
    `SELECT d.id, d.title, d.body, d.data FROM desk_items d
      WHERE d.org_id=$1 AND d.subkind='ceo_recommendation' AND d.status='open' AND d.data->>'inlineTurnId' IS NOT NULL
        AND EXISTS (SELECT 1 FROM ceo_turns t WHERE t.id::text = d.data->>'inlineTurnId' AND t.thread_id=$2)
      ORDER BY d.created_at`,
    [orgId, threadId],
  );
  return {
    threadId,
    agentName: agent.name,
    workstation: agent.workstation_id
      ? { id: agent.workstation_id, name: agent.ws_name ?? 'workstation', online: !!agent.ws_online }
      : null,
    fullPower: await fullPowerOf(ctx, agent),
    model: {
      default: defaultChoiceOf(agent, ceo.settings.models.chat) as ModelChoice,
      thread: (thread?.model_override as ModelChoice | null) ?? null,
      providers: providersOf(runtimes as RuntimeReport[]),
      runtimes: // chats and the CEO run on the workstation's main Claude account: `available` only says some account works
        runtimes
          .filter(
            (r) =>
              r.available !== false &&
              (r.id !== CLAUDE_RUNTIME || mainUsable(runtimes, r.id, ctx.clock.now())),
          )
          .map((r) => r.id),
    },
    cwd: ceo.settings.ownerTurn.cwd,
    busy: !!running || ctx.services.chat.isBusy(threadId),
    queued: queued.map((q) => ({
      turnId: q.id,
      messageId: q.message_id ?? null,
      body: q.body ?? '',
      queuedAt: new Date(q.queued_at).toISOString(),
      stale: now - new Date(q.queued_at).getTime() > CEO_QUEUE_STALE_HOURS * 3_600_000,
    })),
    permissions: await pendingForThread(ctx.pool, threadId),
    confirmations: confirmations.map((c) => ({
      actionId: c.data.actionId,
      deskItemId: c.id,
      title: c.title,
      reason: String(c.body ?? '').split('\n')[0] ?? '',
      turnId: c.data.inlineTurnId ?? null,
    })),
    corrections: await listCorrections(ctx.pool, orgId, { threadId, limit: 10 }),
  };
}

/** The conversation's model: a choice for every message from now on (null: back to the default). */
export async function setThreadModel(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  choice: ModelChoice | null,
): Promise<void> {
  const ceo = await loadCeo(ctx.pool, orgId);
  if (!ceo?.chatThreadId || !ceo.agentId) throw notFound('the CEO chat does not exist yet');
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [ceo.agentId]);
  if (!agent) throw notFound('the CEO agent is gone');
  const reports = await runtimeReports(ctx.pool, agent.workstation_id);
  if (
    choice &&
    (!resolveTurnModel(agent, { model_override: choice }, ceo.settings.models.chat, null, reports) ||
      (choice.runtime === DIRECT_RUNTIME && runtimeProblem(reports, choice)))
  )
    throw conflict('unknown_model', 'that model is not offered');
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(ceo.chatThreadId as string),
          event: {
            type: 'ChatThreadModelSet',
            payload: { threadId: ceo.chatThreadId as string, choice, by: user.id },
          },
          actor: userActor(user.id),
          scope: orgScope(orgId),
        },
      ],
      { tx },
    );
  });
}
