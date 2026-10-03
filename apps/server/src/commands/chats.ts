import { randomUUID } from 'node:crypto';
import { type ChatDto, type CreateChatRequest, canDirectAgent, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, projectRole, requireProjectMember } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { notFound } from '../errors.ts';
import { orgScope, userActor } from './common.ts';

export function toChatDto(ctx: Ctx, r: Row): ChatDto {
  return {
    threadId: r.id,
    title: r.title,
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentRole: r.agent_role,
    projectId: r.project_id,
    cardId: r.card_id,
    cardRef: r.card_ref,
    workstationOnline:
      r.agent_status === 'active' && !!r.workstation_id && ctx.services.runners.isOnline(r.workstation_id),
    createdAt: iso(r.created_at) as string,
    lastMessageAt: iso(r.last_message_at),
  };
}

const CHAT_SELECT = `
SELECT t.*, a.name AS agent_name, a.role_key AS agent_role, a.status AS agent_status, a.workstation_id,
       c.ref AS card_ref,
       (SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = t.id) AS last_message_at
  FROM threads t JOIN agents a ON a.id = t.agent_id LEFT JOIN cards c ON c.id = t.card_id`;

/** The user's chat threads, most recently active first. */
export async function listChats(ctx: Ctx, userId: string): Promise<ChatDto[]> {
  const list = await rows(
    ctx.pool,
    `${CHAT_SELECT} WHERE t.kind = 'chat' AND t.created_by = $1 AND a.status <> 'retired'
      ORDER BY COALESCE((SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = t.id), t.created_at) DESC, t.id`,
    [userId],
  );
  return list.map((r) => toChatDto(ctx, r));
}

export async function getChat(ctx: Ctx, userId: string, threadId: string): Promise<ChatDto> {
  const r = (
    await rows(ctx.pool, `${CHAT_SELECT} WHERE t.id = $1 AND t.kind = 'chat' AND t.created_by = $2`, [
      threadId,
      userId,
    ])
  )[0];
  if (!r) throw notFound('chat not found');
  return toChatDto(ctx, r);
}

/**
 * Starts a conversation with any non-retired agent the user may direct (docs/ARCHITECTURE.md section 14).
 * The optional project/card context is handed to the agent with every message.
 */
export async function createChat(
  ctx: Ctx,
  user: AuthSession['user'],
  req: CreateChatRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const agent = await one(tx, `SELECT * FROM agents WHERE id=$1 AND status <> 'retired'`, [req.agentId]);
    if (!agent) throw notFound('agent not found');
    const allowed = canDirectAgent({
      userId: user.id,
      orgId: agent.org_id,
      managerUserId: agent.manager_user_id,
      agentProjectId: agent.project_id,
      projectRole: agent.project_id ? await projectRole(tx, user.id, agent.project_id) : null,
    });
    if (!allowed) throw notFound('agent not found');

    let projectId: string | undefined = req.projectId;
    let cardId: string | undefined;
    if (req.cardId) {
      const { card } = await loadVisibleCard(tx, user.id, req.cardId);
      cardId = card.id;
      projectId = card.project_id;
    } else if (projectId) {
      await requireProjectMember(tx, user.id, projectId);
    }
    const threadId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'ChatThreadCreated',
            payload: {
              threadId,
              agentId: agent.id,
              ...(projectId ? { projectId } : {}),
              ...(cardId ? { cardId } : {}),
              title: `Chat with ${agent.name}`,
              createdBy: user.id,
            },
          },
          actor: userActor(user.id),
          scope: orgScope(agent.org_id),
        },
      ],
      { tx },
    );
    return threadId;
  });
}
