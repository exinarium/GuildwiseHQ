import { randomUUID } from 'node:crypto';
import { type ChatDto, type CreateChatRequest, canDirectAgentInOrg, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, projectRole, requireProjectMember } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { orgScope, projectScope, userActor } from './common.ts';

/** The user talking to the DevOps engineer that lives on their own workstation (workstation-targeted work is theirs). */
export async function ownsDevopsMachine(
  db: Queryable,
  userId: string,
  agent: { is_devops?: boolean; workstation_id?: string | null },
): Promise<boolean> {
  if (!agent.is_devops || !agent.workstation_id) return false;
  return !!(await one(db, `SELECT 1 FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`, [
    agent.workstation_id,
    userId,
  ]));
}

export function toChatDto(ctx: Ctx, r: Row, viewerId: string): ChatDto {
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
    archived: !!r.archived,
    mine: r.created_by === viewerId,
  };
}

/** `$1` is the viewing user: `archived` is whether they closed the chat. */
const CHAT_SELECT = `
SELECT t.*, a.name AS agent_name, a.role_key AS agent_role, a.status AS agent_status, a.workstation_id,
       c.ref AS card_ref,
       EXISTS (SELECT 1 FROM chat_archives x WHERE x.thread_id = t.id AND x.user_id = $1) AS archived,
       (SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = t.id) AS last_message_at
  FROM threads t JOIN agents a ON a.id = t.agent_id LEFT JOIN cards c ON c.id = t.card_id`;

/** The user's chat threads plus chats tied to projects they are an active member of, most recently active first. */
export async function listChats(ctx: Ctx, userId: string): Promise<ChatDto[]> {
  const list = await rows(
    ctx.pool,
    `${CHAT_SELECT} WHERE t.kind = 'chat' AND t.deleted_at IS NULL AND (t.created_by = $1 OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active')) AND a.status <> 'retired'
      ORDER BY COALESCE((SELECT max(m.created_at) FROM thread_messages m WHERE m.thread_id = t.id), t.created_at) DESC, t.id`,
    [userId],
  );
  return list.map((r) => toChatDto(ctx, r, userId));
}

export async function getChat(ctx: Ctx, userId: string, threadId: string): Promise<ChatDto> {
  const r = (
    await rows(
      ctx.pool,
      `${CHAT_SELECT} WHERE t.id = $2 AND t.kind = 'chat' AND t.deleted_at IS NULL AND (t.created_by = $1 OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'))`,
      [userId, threadId],
    )
  )[0];
  if (!r) throw notFound('chat not found');
  return toChatDto(ctx, r, userId);
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
    const allowed =
      canDirectAgentInOrg({
        orgRole: await orgRoleOf(tx, user.id, agent.org_id),
        agentProjectId: agent.project_id,
        projectMember: agent.project_id ? !!(await projectRole(tx, user.id, agent.project_id)) : false,
      }) || (await ownsDevopsMachine(tx, user.id, agent));
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
          scope: projectId ? projectScope(agent.org_id, projectId) : orgScope(agent.org_id),
        },
      ],
      { tx },
    );
    return threadId;
  });
}

async function getChatRow(db: Queryable, userId: string, threadId: string): Promise<Row | undefined> {
  return (
    await rows(
      db,
      `${CHAT_SELECT} WHERE t.id = $2 AND t.kind = 'chat' AND t.deleted_at IS NULL AND (t.created_by = $1 OR t.project_id IN (SELECT project_id FROM project_members WHERE user_id = $1 AND status = 'active'))`,
      [userId, threadId],
    )
  )[0];
}

const chatScope = (r: Row) => (r.project_id ? projectScope(r.org_id, r.project_id) : orgScope(r.org_id));

/** Close (archive) or restore a chat for the user: it leaves, or returns to, their list. Anyone who can see the chat may. */
export async function setChatArchived(
  ctx: Ctx,
  user: AuthSession['user'],
  threadId: string,
  archived: boolean,
): Promise<ChatDto> {
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await getChatRow(tx, user.id, threadId);
    if (!r) throw notFound('chat not found');
    if (!!r.archived === archived) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: archived ? 'ChatArchived' : 'ChatRestored',
            payload: { threadId, userId: user.id },
          },
          actor: userActor(user.id),
          scope: chatScope(r),
        },
      ],
      { tx },
    );
  });
  return getChat(ctx, user.id, threadId);
}

/**
 * Delete a chat for good (its messages are removed). Only the person who started it may. A chat linked to a card is
 * refused (409 `chat_in_card_history`): its messages are part of that card's history, so the answer there is Close.
 */
export async function deleteChat(ctx: Ctx, user: AuthSession['user'], threadId: string): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await getChatRow(tx, user.id, threadId);
    if (!r || r.created_by !== user.id) throw notFound('chat not found');
    if (r.card_id)
      throw conflict(
        'chat_in_card_history',
        `this chat is linked to ${r.card_ref ?? 'a card'} and stays in its history: close it instead`,
      );
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(threadId),
          event: { type: 'ChatDeleted', payload: { threadId, deletedBy: user.id } },
          actor: userActor(user.id),
          scope: chatScope(r),
        },
      ],
      { tx },
    );
  });
}
