import { randomUUID } from 'node:crypto';
import {
  isKnownChoice,
  type ModelChoice,
  SESSION_TIME_TICK_MAX_MS,
  type SessionDto,
  type SessionTurnDto,
  type StartPersonaChatRequest,
  streamId,
  type ThreadMessageDto,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolvePersona } from '../capabilities/registry.ts';
import { orgScope, userActor } from '../commands/common.ts';
import { HOLDS_PACK_SQL } from '../commands/pack-support.ts';
import {
  assertWorkstation,
  listParticipants,
  loadSession,
  postSessionMessage,
  sessionDto,
} from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { assertSessionMayQueue } from './cost.ts';
import { runtimeProblem, runtimeReports } from './offer.ts';

/**
 * "Chat with persona" (docs/ARCHITECTURE.md section 38.8): a one-to-one session thread (kind `persona_chat`) between the user and a
 * persona that is not hired. It reuses session threads and durable turns, so a turn survives a restart, streams like any session
 * reply, and its cost is booked to the organization's ledger on the thread. It runs on the user's own workstation on the persona's
 * model or the one they chose. The persona has no verb at all (`persona_chat: []` in `SESSION_PURPOSE_VERBS`): only `aom skill`
 * (read) and `aom ledger search` (read) are reachable. A private persona resolves for its owner only.
 */

/**
 * The active time of a persona chat in ms at `now`: the same paused-clock model as a session. The clock runs while the persona is
 * working on a turn (queued turns that never started and a workstation that is offline do not count), and between a reply and the
 * next message only as much as one tick (`SESSION_TIME_TICK_MAX_MS`, as the Boardroom's clock caps a gap), so a chat left alone
 * for a day has not used a day. Derived from the durable turns, so a restart loses nothing.
 */
export async function personaChatElapsedMs(db: Queryable, threadId: string, now: Date): Promise<number> {
  const turns = await rows<{ started: Date | null; finished: Date | null; status: string; queued: Date }>(
    db,
    `SELECT started_at AS started, finished_at AS finished, status, queued_at AS queued
       FROM session_turns WHERE thread_id=$1 AND status IN ('running','done','failed') ORDER BY queued_at`,
    [threadId],
  );
  let ms = 0;
  let prevEnd: number | null = null;
  for (const t of turns) {
    const begin = new Date(t.started ?? t.queued).getTime();
    const end = t.finished ? new Date(t.finished).getTime() : now.getTime();
    if (prevEnd !== null) ms += Math.min(Math.max(0, begin - prevEnd), SESSION_TIME_TICK_MAX_MS);
    ms += Math.max(0, end - begin);
    prevEnd = Math.max(prevEnd ?? 0, end);
  }
  // the gap between the last reply and this moment (the message being sent now), as one tick at most
  if (prevEnd !== null) ms += Math.min(Math.max(0, now.getTime() - prevEnd), SESSION_TIME_TICK_MAX_MS);
  return ms;
}

/** The time limit of a persona chat (minutes of active time). Past it, no new message is taken until the limit is raised. */
export async function assertPersonaChatTime(db: Queryable, t: Row, now: Date): Promise<void> {
  const limit = (t.session_config as { timeLimitMinutes?: number | null } | null)?.timeLimitMinutes;
  if (!limit) return;
  const elapsedMin = (await personaChatElapsedMs(db, t.id, now)) / 60_000;
  if (elapsedMin >= limit)
    throw conflict(
      'session_time_up',
      `This chat has reached its time limit of ${limit} minutes. Raise the limit to continue.`,
      { timeLimitMinutes: limit },
    );
}

/**
 * Retention of persona chats (R3c): a chat nobody wrote in for `days` days is removed from every list and query, like a session
 * its owner deleted (a `SessionThreadDeleted` with reason `retention`; the event log is append-only, see docs/ARCHITECTURE.md
 * section 38.8). The direct-model runtime's own copy of a chat's memory goes by the runner's `directChatRetentionDays` (90 by
 * default), the same period. Returns how many chats were removed. Idempotent.
 */
export async function prunePersonaChats(ctx: Ctx): Promise<number> {
  const days = ctx.config.personaChatRetentionDays;
  if (days <= 0) return 0;
  const cutoff = new Date(ctx.clock.now().getTime() - days * 86_400_000);
  const old = await rows(
    ctx.pool,
    `SELECT t.id, t.org_id, t.project_id, t.created_by FROM threads t
      WHERE t.kind='persona_chat' AND t.deleted_at IS NULL AND t.created_at < $1
        AND COALESCE((SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = t.id), t.created_at) < $1
        AND NOT EXISTS (SELECT 1 FROM session_turns st WHERE st.thread_id = t.id AND st.status IN ('queued','running'))
      LIMIT 200`,
    [cutoff],
  );
  for (const t of old)
    await ctx.store.append([
      {
        streamId: streamId.thread(t.id),
        event: {
          type: 'SessionThreadDeleted',
          payload: { threadId: t.id, by: t.created_by, reason: 'retention' },
        },
        actor: { kind: 'system', id: null },
        scope: orgScope(t.org_id),
      },
    ]);
  return old.length;
}

const ASK = 'Answer the person’s latest message in character, concisely unless they ask for more.';

export async function startPersonaChat(
  ctx: Ctx,
  who: Who,
  req: StartPersonaChatRequest,
): Promise<SessionDto> {
  return withAppendTx(ctx.pool, async (tx) => {
    if (req.projectId) {
      const p = await loadVisibleProject(tx, who.userId, req.projectId);
      if (p.org_id !== who.orgId) throw notFound('project not found');
    }
    // the persona must be one this user may use (a private persona resolves for its owner only)
    const persona = await resolvePersona(tx, who.orgId, req.personaKey, req.projectId ?? null, who.userId);
    if (!persona) throw notFound('persona not found');
    const me = await one(
      tx,
      `SELECT id FROM workstations WHERE user_id=$1 AND status='active' AND ($2::uuid IS NULL OR id=$2)
        ORDER BY connected DESC, last_seen_at DESC NULLS LAST, paired_at LIMIT 1`,
      [who.userId, req.workstationId ?? null],
    );
    if (!me) throw badRequest('no_workstation', 'pair one of your own workstations to chat with a persona');
    const workstationId = me.id as string;
    await assertWorkstation(ctx, tx, who.orgId, workstationId, {
      actorId: who.userId,
      creatorId: who.userId,
    });
    // a persona of a pack is on the workstations that hold the pack (a private one only on its owner's)
    if (persona.source === 'pack') {
      const packName = persona.key.split(':')[0];
      const holds = await one(
        tx,
        `SELECT 1 FROM packs p JOIN workstations w ON w.id = $3
          WHERE p.org_id=$1 AND p.name=$2 AND p.removed_at IS NULL AND ${HOLDS_PACK_SQL}
            AND (p.visibility = 'org' OR p.owner_user_id = $4)`,
        [who.orgId, packName, workstationId, who.userId],
      );
      if (!holds)
        throw conflict(
          'persona_not_on_workstation',
          'that workstation does not hold the pack this persona is in',
        );
    }
    let choice: ModelChoice | undefined;
    if (req.model) {
      choice = {
        runtime: req.runtime ?? 'claude-code',
        model: req.model,
        ...(req.effort ? { effort: req.effort } : {}),
      };
      if (!isKnownChoice(choice)) throw badRequest('unknown_model', 'unknown model choice');
      const problem = runtimeProblem(await runtimeReports(tx, workstationId), choice, who.orgId);
      if (problem) throw conflict('runtime_unavailable', problem);
    }
    const threadId = randomUUID();
    const scope = orgScope(who.orgId);
    const part = (
      kind: 'user' | 'persona',
      refId: string,
      seat: string,
      displayName: string,
    ): AppendInput => ({
      streamId: streamId.thread(threadId),
      event: {
        type: 'ThreadParticipantAdded',
        payload: { threadId, participantId: randomUUID(), kind, refId, seat, displayName },
      },
      actor: userActor(who.userId),
      scope,
    });
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'SessionThreadCreated',
            payload: {
              threadId,
              kind: 'persona_chat',
              title: `Chat with ${persona.name}`.slice(0, 200),
              createdBy: who.userId,
              ...(req.projectId ? { projectId: req.projectId } : {}),
              workstationId,
              config: {
                personaKey: persona.key,
                ...(choice ? { model: choice } : {}),
                ...(req.budgetUsd ? { budgetUsd: req.budgetUsd } : {}),
                ...(req.timeLimitMinutes ? { timeLimitMinutes: req.timeLimitMinutes } : {}),
              },
            },
          },
          actor: userActor(who.userId),
          scope,
        },
        part('user', who.userId, 'You', 'You'),
        part('persona', persona.key, 'Persona', persona.name),
      ],
      { tx },
    );
    return sessionDto(ctx, (await one(tx, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row, tx);
  });
}

/** One message to the persona: it is posted and a durable turn is queued on the chat's workstation and model. */
export async function sayToPersona(
  ctx: Ctx,
  userId: string,
  threadId: string,
  body: string,
): Promise<{ message: ThreadMessageDto; turn: SessionTurnDto }> {
  const t = await loadSession(ctx.pool, userId, threadId);
  if (t.kind !== 'persona_chat') throw badRequest('not_a_persona_chat', 'this is not a persona chat');
  const persona = (await listParticipants(ctx.pool, threadId)).find((p) => p.kind === 'persona');
  if (!persona) throw conflict('persona_gone', 'the persona left this chat');
  // the chat's own limits (the session cost limit and, for a chat, a time limit from its start), before anything is posted
  const now = ctx.clock.now();
  await assertSessionMayQueue(ctx.pool, t, now);
  await assertPersonaChatTime(ctx.pool, t, now);
  const message = await postSessionMessage(ctx, userId, threadId, { body, kind: 'chat', data: {} });
  const cfg = (t.session_config ?? {}) as { model?: ModelChoice };
  const turn = await ctx.services.sessions.queue(
    userId,
    threadId,
    {
      participantId: persona.id,
      message: ASK,
      replyToMessageId: message.id,
      ...(cfg.model ? { model: cfg.model } : {}),
      context: { mode: 'all', limit: 40 },
    },
    { meta: { purpose: 'persona_chat' } },
  );
  return { message, turn };
}
