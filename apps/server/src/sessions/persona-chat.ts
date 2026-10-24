import { randomUUID } from 'node:crypto';
import {
  isKnownChoice,
  type ModelChoice,
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
import { one, type Row } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { runtimeProblem, runtimeReports } from './offer.ts';

/**
 * "Chat with persona" (docs/ARCHITECTURE.md section 38.8): a one-to-one session thread (kind `persona_chat`) between the user and a
 * persona that is not hired. It reuses session threads and durable turns, so a turn survives a restart, streams like any session
 * reply, and its cost is booked to the organization's ledger on the thread. It runs on the user's own workstation on the persona's
 * model or the one they chose. The persona has no verb at all (`persona_chat: []` in `SESSION_PURPOSE_VERBS`): only `aom skill`
 * (read) and `aom ledger search` (read) are reachable. A private persona resolves for its owner only.
 */

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
              config: { personaKey: persona.key, ...(choice ? { model: choice } : {}) },
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
