import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  CHAT_ERROR,
  type ChatContext,
  canDirectAgentInOrg,
  type ReadRepo,
  type RunnerToServerOf,
  type ServerToBrowser,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { projectRole } from '../authz/scope.ts';
import { buildChatBrief } from '../ceo/brief.ts';
import { loadCeo } from '../ceo/state.ts';
import { ownsDevopsMachine, sharesAllowedProject } from '../commands/chats.ts';
import { agentActor, orgScope, projectScope, runnerActor, userActor } from '../commands/common.ts';
import { intakeContext } from '../commands/intake.ts';
import { grantedMcpServers, orgGrantedMcpServers } from '../commands/mcp-servers.ts';
import { vaultForConversation } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentSpecFor } from '../runner-gateway/brief.ts';
import { orgReadRepos, projectReadRepos, referenceReadRepos } from '../runner-gateway/read-repos.ts';
import { localReadRepos } from '../runner-gateway/workstation-repos.ts';
import { workstationServesOrg } from '../simulation/fit.ts';

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

interface Inflight {
  chatId: string;
  threadId: string;
  userId: string;
  orgId: string;
  /** Set when the thread is tied to a project: its messages are visible to the project's members. */
  projectId: string | null;
  agentId: string;
  workstationId: string;
  startedAt: Date;
}

/** What a terminal chat frame produced, for the notification after the transaction committed. */
export interface ChatTerminal {
  userId: string;
  threadId: string;
  messageId?: string;
  reason?: string;
}

/**
 * Chat relay (docs/ARCHITECTURE.md section 14): browser `chat.send` -> runner `chat.start`; runner `chat.delta`/
 * `chat.done`/`chat.error` -> browser. One headless call per user message on the agent's workstation. If the
 * workstation is offline the user is told at once and nothing is queued. Each conversation is saved to its thread,
 * and the chat counts as a `chat` shift (tokens count toward the agent) that never claims a card.
 */
export class ChatRelay {
  private readonly inflight = new Map<string, Inflight>();
  private readonly byThread = new Map<string, string>();

  constructor(private readonly ctx: Ctx) {}

  private tell(userId: string, msg: ServerToBrowser): void {
    this.ctx.services.browser.sendToUser(userId, msg);
  }

  private fail(userId: string, threadId: string, reason: string): void {
    this.tell(userId, { type: 'chat.error', threadId, reason });
  }

  private release(c: Inflight): void {
    this.inflight.delete(c.chatId);
    if (this.byThread.get(c.threadId) === c.chatId) this.byThread.delete(c.threadId);
  }

  /** `chat.send` from a browser. Errors are reported on the socket, never thrown. */
  async send(userId: string, msg: { threadId: string; body: string; clientMsgId: string }): Promise<void> {
    const { ctx } = this;
    const row = await one(
      ctx.pool,
      `SELECT a.*, t.kind AS thread_kind, t.project_id AS thread_project_id, t.card_id AS thread_card_id, p.key AS project_key, c.ref AS card_ref, c.worktree_path AS card_worktree_path, c.fields->>'externalRef' AS card_external_ref
         FROM threads t JOIN agents a ON a.id = t.agent_id
         LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN cards c ON c.id = t.card_id
        WHERE t.id = $1 AND t.kind IN ('chat','intake') AND t.created_by = $2 AND t.deleted_at IS NULL`,
      [msg.threadId, userId],
    );
    if (!row) return this.fail(userId, msg.threadId, CHAT_ERROR.unknownThread);
    // Rights are re-checked on every send: the thread outlives a removed membership, a re-homed agent or a
    // deactivated account (being its creator is not enough).
    const roleThread = row.thread_project_id
      ? await projectRole(ctx.pool, userId, row.thread_project_id)
      : null;
    const active = await one(ctx.pool, `SELECT 1 FROM users WHERE id=$1 AND status='active'`, [userId]);
    const mayDirect =
      canDirectAgentInOrg({
        orgRole: await orgRoleOf(ctx.pool, userId, row.org_id),
        sharesAllowedProject: await sharesAllowedProject(ctx.pool, userId, row),
      }) || (await ownsDevopsMachine(ctx.pool, userId, row));
    if (!active || !mayDirect || (row.thread_project_id && roleThread === null))
      return this.fail(userId, msg.threadId, CHAT_ERROR.unknownThread);
    // Only the organization Owner talks to the CEO (it holds their rules and acts with their rights).
    const isCeo = row.role_key === 'ceo';
    if (isCeo && (await orgRoleOf(ctx.pool, userId, row.org_id)) !== 'owner')
      return this.fail(userId, msg.threadId, CHAT_ERROR.unknownThread);
    if (this.byThread.has(msg.threadId)) return this.fail(userId, msg.threadId, CHAT_ERROR.busy);
    // Nothing is queued: an offline workstation is reported immediately and the message is not saved.
    if (row.status !== 'active' || !row.workstation_id || !ctx.services.runners.isOnline(row.workstation_id))
      return this.fail(userId, msg.threadId, CHAT_ERROR.workstationOffline);
    // A simulation organization's agents only run on its simulated workstation, a real one never answers for it.
    if (!(await workstationServesOrg(ctx.pool, row.workstation_id, row.org_id)))
      return this.fail(userId, msg.threadId, CHAT_ERROR.simulationWorkstation);

    const prior = await one(
      ctx.pool,
      `SELECT data->>'runtimeSessionId' AS sid FROM thread_messages
        WHERE thread_id = $1 AND author_kind = 'agent' AND data ? 'runtimeSessionId'
        ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
      [msg.threadId],
    );
    const chatId = randomUUID();
    const inflight: Inflight = {
      chatId,
      threadId: msg.threadId,
      userId,
      orgId: row.org_id,
      projectId: row.thread_project_id ?? null,
      agentId: row.id,
      workstationId: row.workstation_id,
      startedAt: ctx.clock.now(),
    };
    this.inflight.set(chatId, inflight);
    this.byThread.set(msg.threadId, chatId);
    try {
      await ctx.store.append([
        {
          streamId: streamId.thread(msg.threadId),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: msg.threadId,
              messageId: randomUUID(),
              ...(row.thread_card_id ? { cardId: row.thread_card_id } : {}),
              authorKind: 'user',
              authorUserId: userId,
              kind: 'chat',
              body: msg.body,
              data: { clientMsgId: msg.clientMsgId },
            },
          },
          actor: userActor(userId),
          scope: row.thread_project_id
            ? projectScope(row.org_id, row.thread_project_id)
            : orgScope(row.org_id),
        },
        {
          streamId: streamId.shift(chatId),
          event: {
            type: 'ShiftStarted',
            payload: {
              shiftId: chatId,
              agentId: row.id,
              workstationId: row.workstation_id,
              ...(row.thread_card_id ? { cardId: row.thread_card_id } : {}),
              kind: 'chat',
              runtime: row.runtime,
              model: row.model,
              overflow: false,
              ...(row.thread_project_id ? { projectId: row.thread_project_id } : {}),
            },
          },
          actor: runnerActor(row.workstation_id),
          scope: orgScope(row.org_id),
        },
      ]);
      const intake = await intakeContext(ctx, msg.threadId);
      // A chat about a project may read the project's own clones and its reference repositories (when this workstation has
      // them); the DevOps engineer reads anywhere anyway.
      // The business analyst never reads code (#47): the Architect investigates the repositories, the BA specifies. A BA chat
      // gets no repository at all, neither the project's, the reference repositories nor a card's worktree.
      const readsCode = row.role_key !== BA_ROLE_KEY && !isCeo;
      const readRepos: ReadRepo[] =
        row.thread_project_id && readsCode
          ? [
              ...(await projectReadRepos(ctx.pool, row.thread_project_id)),
              ...(await referenceReadRepos(ctx.pool, row.thread_project_id)),
            ]
          : [];
      // A role with `readOrgRepos` (the architect) also reads every repository of the organization (read-only).
      if (readsCode && row.permissions?.readOrgRepos === true) {
        const seen = new Set(readRepos.map((r) => r.repoId));
        for (const r of await orgReadRepos(ctx.pool, row.org_id, userId))
          if (!seen.has(r.repoId)) readRepos.push(r);
      }
      const localRepos =
        row.thread_project_id && readsCode
          ? await localReadRepos(ctx.pool, row.thread_project_id, row.workstation_id)
          : [];
      // A chat with no project yet (an intake chat maps the ticket to a project during the chat) gets the servers granted
      // to the organization's projects this user belongs to; the agent's own mcp:<server> permission still applies.
      const mcpGranted = row.thread_project_id
        ? await grantedMcpServers(ctx.pool, row.thread_project_id)
        : await orgGrantedMcpServers(ctx.pool, row.org_id, userId);
      // The knowledge vault this chat may read (read-only): the project's, else the organization's (Owner/Admin workstations).
      const vault = await vaultForConversation(ctx.pool, {
        orgId: row.org_id,
        projectId: row.thread_project_id,
        workstationId: row.workstation_id,
      });
      const ceoState = isCeo ? await loadCeo(ctx.pool, row.org_id) : undefined;
      const context: ChatContext = {
        orgId: row.org_id,
        ...(ceoState ? { ceo: { brief: await buildChatBrief(ctx, ceoState, row) } } : {}),
        ...(row.thread_project_id ? { projectId: row.thread_project_id, projectKey: row.project_key } : {}),
        ...(row.thread_card_id ? { cardId: row.thread_card_id, cardRef: row.card_ref } : {}),
        ...(row.thread_card_id && typeof row.card_external_ref === 'string' && row.card_external_ref
          ? { cardExternalRef: row.card_external_ref }
          : {}),
        ...(readsCode && row.thread_card_id && row.card_worktree_path
          ? { cardWorktreePath: row.card_worktree_path }
          : {}),
        ...(readRepos.length > 0 ? { readRepos } : {}),
        ...(localRepos.length > 0 ? { localReadRepos: localRepos } : {}),
        ...(mcpGranted.length > 0 ? { mcpServers: mcpGranted } : {}),
        ...(vault ? { vault } : {}),
        ...(intake ? { intake } : {}),
      };
      const sent = ctx.services.runners.send(
        row.workstation_id,
        'chat.start',
        {
          chatId,
          threadId: msg.threadId,
          agent: ceoState
            ? { ...(await agentSpecFor(ctx, row)), ...ceoState.settings.models.chat }
            : await agentSpecFor(ctx, row),
          message: msg.body,
          ...(prior?.sid ? { resumeSessionId: prior.sid as string } : {}),
          context,
        },
        ctx.clock.now(),
      );
      if (!sent) await this.finish(inflight, 'rejected', CHAT_ERROR.workstationOffline);
    } catch (err) {
      ctx.log.error({ err }, 'chat.send failed');
      await this.finish(inflight, 'crashed', CHAT_ERROR.runnerError).catch(() => {});
    }
  }

  /** A reply to this thread is being written right now (the next message would be refused as busy). */
  isBusy(threadId: string): boolean {
    return this.byThread.has(threadId);
  }

  /** The thread an in-flight chat belongs to (the chat id is its shift id): chat-scoped rpcs resolve their intake with it. */
  threadOfChat(chatId: string): string | undefined {
    return this.inflight.get(chatId)?.threadId;
  }

  /** The manager who is talking in an in-flight chat. */
  userOfChat(chatId: string): string | undefined {
    return this.inflight.get(chatId)?.userId;
  }

  cancel(userId: string, threadId: string): void {
    const chatId = this.byThread.get(threadId);
    const c = chatId ? this.inflight.get(chatId) : undefined;
    if (!c || c.userId !== userId) return;
    this.ctx.services.runners.send(
      c.workstationId,
      'chat.cancel',
      { chatId: c.chatId },
      this.ctx.clock.now(),
    );
  }

  onDelta(workstationId: string, msg: RunnerToServerOf<'chat.delta'>): void {
    const c = this.inflight.get(msg.chatId);
    if (c && c.workstationId === workstationId)
      this.tell(c.userId, { type: 'chat.delta', threadId: c.threadId, text: msg.text });
  }

  /** The runner finished one reply. Runs inside the runner-inbox transaction; notify afterwards. */
  async applyDone(
    workstationId: string,
    msg: RunnerToServerOf<'chat.done'>,
    tx: Tx,
  ): Promise<ChatTerminal | undefined> {
    const c = this.inflight.get(msg.chatId);
    if (!c || c.workstationId !== workstationId) return undefined;
    const messageId = randomUUID();
    await this.ctx.store.append(
      [
        {
          streamId: streamId.thread(c.threadId),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: c.threadId,
              messageId,
              authorKind: 'agent',
              authorAgentId: c.agentId,
              kind: 'chat',
              body: msg.messageText,
              data: {
                ...(msg.runtimeSessionId ? { runtimeSessionId: msg.runtimeSessionId } : {}),
                usage: msg.usage,
              },
            },
          },
          actor: agentActor(c.agentId),
          scope: c.projectId ? projectScope(c.orgId, c.projectId) : orgScope(c.orgId),
        },
        this.shiftEnded(c, 'reported', msg.usage),
      ],
      { tx },
    );
    this.release(c);
    return { userId: c.userId, threadId: c.threadId, messageId };
  }

  async applyError(
    workstationId: string,
    msg: RunnerToServerOf<'chat.error'>,
    tx: Tx,
  ): Promise<ChatTerminal | undefined> {
    const c = this.inflight.get(msg.chatId);
    if (!c || c.workstationId !== workstationId) return undefined;
    await this.ctx.store.append([this.shiftEnded(c, msg.error === 'cancelled' ? 'stopped' : 'crashed')], {
      tx,
    });
    this.release(c);
    return { userId: c.userId, threadId: c.threadId, reason: msg.error };
  }

  notify(t: ChatTerminal | undefined): void {
    if (!t) return;
    if (t.messageId) this.tell(t.userId, { type: 'chat.done', threadId: t.threadId, messageId: t.messageId });
    else this.fail(t.userId, t.threadId, t.reason ?? CHAT_ERROR.runnerError);
  }

  /** The runner's socket closed: its chats cannot finish (the runner kills them too). */
  async workstationLost(workstationId: string): Promise<void> {
    for (const c of [...this.inflight.values()]) {
      if (c.workstationId !== workstationId) continue;
      await this.finish(c, 'lost', CHAT_ERROR.workstationOffline).catch((err) =>
        this.ctx.log.error({ err }, 'failed to end lost chat'),
      );
    }
  }

  private async finish(c: Inflight, outcome: 'rejected' | 'crashed' | 'lost', reason: string): Promise<void> {
    this.release(c);
    await this.ctx.store.append([this.shiftEnded(c, outcome)]);
    this.fail(c.userId, c.threadId, reason);
  }

  private shiftEnded(
    c: Inflight,
    outcome: 'reported' | 'stopped' | 'crashed' | 'rejected' | 'lost',
    usage = ZERO_USAGE,
  ): AppendInput {
    return {
      streamId: streamId.shift(c.chatId),
      event: {
        type: 'ShiftEnded',
        payload: {
          shiftId: c.chatId,
          agentId: c.agentId,
          outcome,
          durationMs: Math.max(0, this.ctx.clock.now().getTime() - c.startedAt.getTime()),
          usage,
          guardViolations: [],
        },
      },
      actor: runnerActor(c.workstationId),
      scope: orgScope(c.orgId),
    };
  }
}
