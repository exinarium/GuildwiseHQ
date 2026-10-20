import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  CHAT_ERROR,
  type ChatContext,
  canDirectAgentInOrg,
  type ModelChoice,
  type ReadRepo,
  type RunnerToServerOf,
  type ServerToBrowser,
  streamId,
  summarizeCommandTexts,
  type ToolCounts,
} from '@aom/shared';
import { orgOwnerId, orgRoleOf } from '../auth/org-context.ts';
import { projectRole } from '../authz/scope.ts';
import { closePendingForTurn } from '../ceo/permissions.ts';
import { loadCeo } from '../ceo/state.ts';
import { ownsDevopsMachine, sharesAllowedProject } from '../commands/chats.ts';
import {
  agentActor,
  orgScope,
  projectScope,
  runnerActor,
  SYSTEM_ACTOR,
  userActor,
} from '../commands/common.ts';
import { graphScopeFor } from '../commands/graph.ts';
import { intakeContext } from '../commands/intake.ts';
import { grantedMcpServers, orgGrantedMcpServers } from '../commands/mcp-servers.ts';
import { vaultForConversation } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { isProjectPaused } from '../dispatcher/project-hold.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { notifyUsers } from '../push/notifier.ts';
import { standingOrdersForProjects } from '../queries/ledger.ts';
import { agentSpecFor } from '../runner-gateway/brief.ts';
import { orgReadRepos, projectReadRepos, referenceReadRepos } from '../runner-gateway/read-repos.ts';
import { localReadRepos } from '../runner-gateway/workstation-repos.ts';
import { workstationServesOrg } from '../simulation/fit.ts';
import {
  backstopJobEvents,
  buildChatStart,
  type CeoInflightInfo,
  loadTurn,
  replyData,
  resolveTurnModel,
  STALE_QUEUE_MS,
} from './ceo-turns.ts';

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
  /** A CEO owner or order turn: its state is also persisted in `ceo_turns`, so it survives a restart of the server. */
  ceo?: CeoInflightInfo;
}

/** What a terminal chat frame produced, for the notification after the transaction committed. */
export interface ChatTerminal {
  userId: string;
  threadId: string;
  messageId?: string;
  reason?: string;
  /** A CEO thread whose next queued message may start now. */
  ceoThread?: string;
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
  async send(
    userId: string,
    msg: {
      threadId: string;
      body: string;
      clientMsgId: string;
      model?: ModelChoice | undefined;
      modelScope?: 'message' | 'thread' | undefined;
    },
  ): Promise<void> {
    const { ctx } = this;
    const row = await one(
      ctx.pool,
      `SELECT a.*, t.kind AS thread_kind, t.project_id AS thread_project_id, t.card_id AS thread_card_id, p.key AS project_key, c.ref AS card_ref, c.worktree_path AS card_worktree_path, c.fields->>'externalRef' AS card_external_ref,
              t.model_override, t.dirs
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
    // The DevOps engineer works through the CEO now (docs section 8): its old conversations are read-only.
    if (row.is_devops) return this.fail(userId, msg.threadId, CHAT_ERROR.devopsViaCeo);
    // The standing "BA reports" chat (the BA's floor reports) is read-only now: the CEO writes the report.
    if (await one(ctx.pool, 'SELECT 1 FROM users WHERE ba_chat_thread_id=$1', [msg.threadId]))
      return this.fail(userId, msg.threadId, CHAT_ERROR.baReportsRetired);
    if (isCeo) return this.sendCeo(userId, row, msg);
    if (this.byThread.has(msg.threadId)) return this.fail(userId, msg.threadId, CHAT_ERROR.busy);
    // A chat that belongs to a project an Owner or Admin paused does not start (nothing is saved or queued).
    if (row.thread_project_id && (await isProjectPaused(ctx.pool, row.thread_project_id)))
      return this.fail(userId, msg.threadId, CHAT_ERROR.projectPaused);
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
      // Standing orders bind every agent in a conversation (backlog #75).
      const orders = await standingOrdersForProjects(
        ctx.pool,
        row.org_id,
        row.thread_project_id ? [row.thread_project_id] : [],
      );
      // The project's code graph (read-only `aom graph` verbs), when it has one.
      const graph = row.thread_project_id
        ? await graphScopeFor(ctx, row.thread_project_id, row.thread_card_id)
        : undefined;
      const context: ChatContext = {
        ...(orders.length > 0 ? { standingOrders: orders } : {}),
        orgId: row.org_id,
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
        ...(graph ? { graph } : {}),
        ...(intake ? { intake } : {}),
      };
      const sent = ctx.services.runners.send(
        row.workstation_id,
        'chat.start',
        {
          chatId,
          threadId: msg.threadId,
          agent: await agentSpecFor(ctx, row),
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

  // ------------------------------------------------------------------------------------------ the CEO's turns

  /**
   * The owner's message to the CEO (docs/design/ceo-front-door.md section 5). The turn is persisted (`ceo_turns`) before it is
   * sent, so a restart of the server loses nothing; an offline workstation queues the message instead of failing it.
   */
  private async sendCeo(
    userId: string,
    row: Row,
    msg: {
      threadId: string;
      body: string;
      clientMsgId: string;
      model?: ModelChoice | undefined;
      modelScope?: 'message' | 'thread' | undefined;
    },
  ): Promise<void> {
    const { ctx } = this;
    const running = await one(
      ctx.pool,
      `SELECT * FROM ceo_turns WHERE thread_id=$1 AND status='running' LIMIT 1`,
      [msg.threadId],
    );
    if (this.byThread.has(msg.threadId) || running) return this.fail(userId, msg.threadId, CHAT_ERROR.busy);
    const ceo = await loadCeo(ctx.pool, row.org_id);
    if (!ceo?.enabled || ceo.agentId !== row.id)
      return this.fail(userId, msg.threadId, CHAT_ERROR.unknownThread);
    if (row.status !== 'active' || !row.workstation_id)
      return this.fail(userId, msg.threadId, CHAT_ERROR.workstationOffline);
    if (!(await workstationServesOrg(ctx.pool, row.workstation_id, row.org_id)))
      return this.fail(userId, msg.threadId, CHAT_ERROR.simulationWorkstation);
    // The model: this message's choice, else the conversation's, else the default. `thread` scope makes the choice stick.
    const threadChoice = msg.modelScope === 'thread' && msg.model ? msg.model : undefined;
    const resolved = resolveTurnModel(
      row,
      threadChoice ? { ...row, model_override: threadChoice } : row,
      ceo.settings.models.chat,
      msg.modelScope === 'thread' ? undefined : msg.model,
    );
    if (!resolved) return this.fail(userId, msg.threadId, CHAT_ERROR.unknownModel);
    const online = ctx.services.runners.isOnline(row.workstation_id);
    const waiting = await one(
      ctx.pool,
      `SELECT 1 FROM ceo_turns WHERE thread_id=$1 AND status='queued' LIMIT 1`,
      [msg.threadId],
    );
    const queued = !online || !!waiting;
    const turnId = randomUUID();
    const messageId = randomUUID();
    const events: AppendInput[] = [
      ...(threadChoice
        ? [
            {
              streamId: streamId.thread(msg.threadId),
              event: {
                type: 'ChatThreadModelSet' as const,
                payload: { threadId: msg.threadId, choice: threadChoice, by: userId },
              },
              actor: userActor(userId),
              scope: orgScope(row.org_id),
            },
          ]
        : []),
      {
        streamId: streamId.thread(msg.threadId),
        event: {
          type: 'ThreadMessagePosted',
          payload: {
            threadId: msg.threadId,
            messageId,
            authorKind: 'user',
            authorUserId: userId,
            kind: 'chat',
            body: msg.body,
            data: {
              clientMsgId: msg.clientMsgId,
              turnId,
              ...(queued ? { queued: true } : {}),
              ...(resolved.source === 'message' ? { model: resolved.choice } : {}),
            },
          },
        },
        actor: userActor(userId),
        scope: orgScope(row.org_id),
      },
      {
        streamId: streamId.ceo(row.org_id),
        event: {
          type: 'CeoTurnQueued',
          payload: {
            turnId,
            orgId: row.org_id,
            threadId: msg.threadId,
            messageId,
            mode: 'owner',
            model: resolved.choice,
            workstationId: row.workstation_id,
            queued,
          },
        },
        actor: userActor(userId),
        scope: orgScope(row.org_id),
      },
    ];
    try {
      await ctx.store.append(events);
    } catch (err) {
      ctx.log.error({ err }, 'ceo chat.send failed');
      return this.fail(userId, msg.threadId, CHAT_ERROR.runnerError);
    }
    if (queued) {
      const ws = await one(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [row.workstation_id]);
      this.tell(userId, {
        type: 'chat.queued',
        threadId: msg.threadId,
        clientMsgId: msg.clientMsgId,
        ...(ws?.name ? { workstationName: ws.name as string } : {}),
      });
      void notifyUsers(ctx, [userId], {
        category: 'chat_replies',
        subject: `ceo-queue:${msg.threadId}`,
        state: turnId,
        title: 'Queued',
        body: `Queued: ${row.name} answers when ${ws?.name ?? 'the workstation'} is back`,
        url: '/ceo',
        priority: 'normal',
        orgId: row.org_id,
      }).catch(() => {});
      return;
    }
    await this.startCeoTurn(turnId, userId, msg.body);
  }

  /** Sends one persisted turn to its workstation. A refusal ends the turn (the owner sees the error). */
  async startCeoTurn(
    turnId: string,
    userId: string,
    message: string,
    order?: { entryId: string; hash: string },
  ): Promise<boolean> {
    const { ctx } = this;
    const turn = await loadTurn(ctx.pool, turnId);
    if (!turn || (turn.status !== 'queued' && turn.status !== 'running')) return false;
    const agent = await one(
      ctx.pool,
      `SELECT a.* FROM agents a JOIN ceo_settings c ON c.agent_id = a.id WHERE c.org_id=$1`,
      [turn.org_id],
    );
    const thread = await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1', [turn.thread_id]);
    const fail = async (reason: string, status: 'failed' = 'failed') => {
      await ctx.store.append([this.turnFinished(turn, status, reason)]).catch(() => {});
      this.fail(userId, turn.thread_id, reason);
      return false;
    };
    if (!agent || !thread) return fail(CHAT_ERROR.unknownThread);
    // Full power is the Owner's: a message whose author is not the Owner NOW (he transferred the organization while it
    // waited in the queue) is dropped, never run on the new Owner's machine.
    if (turn.mode === 'owner' && userId !== (await orgOwnerId(ctx.pool, turn.org_id))) {
      await ctx.store
        .append([
          this.turnFinished(turn, 'dropped', 'the author is no longer the Owner of this organization'),
        ])
        .catch(() => {});
      this.fail(
        userId,
        turn.thread_id,
        'This message was not sent: you are no longer the Owner of this organization.',
      );
      return false;
    }
    const plan = await buildChatStart(ctx, { turn, agent, thread }, { message, ...(order ? { order } : {}) });
    if (!plan.ok)
      return fail(plan.reason === 'offline' ? CHAT_ERROR.workstationOffline : CHAT_ERROR.runnerError);
    const inflight: Inflight = {
      chatId: turn.id,
      threadId: turn.thread_id,
      userId,
      orgId: turn.org_id,
      projectId: null,
      agentId: agent.id,
      workstationId: plan.workstationId,
      startedAt: ctx.clock.now(),
      ceo: plan.info,
    };
    this.inflight.set(turn.id, inflight);
    this.byThread.set(turn.thread_id, turn.id);
    try {
      await ctx.store.append([
        {
          streamId: streamId.shift(turn.id),
          event: {
            type: 'ShiftStarted',
            payload: {
              shiftId: turn.id,
              agentId: agent.id,
              workstationId: plan.workstationId,
              kind: 'chat',
              runtime: plan.model.runtime,
              model: plan.model.model,
              overflow: false,
              mode: turn.mode,
            },
          },
          actor: runnerActor(plan.workstationId),
          scope: orgScope(turn.org_id),
        },
        {
          streamId: streamId.ceo(turn.org_id),
          event: {
            type: 'CeoTurnStarted',
            payload: {
              turnId: turn.id,
              orgId: turn.org_id,
              threadId: turn.thread_id,
              workstationId: plan.workstationId,
              model: plan.model,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(turn.org_id),
        },
      ]);
      const sent = ctx.services.runners.send(
        plan.workstationId,
        'chat.start',
        plan.payload as never,
        ctx.clock.now(),
      );
      if (!sent) {
        await this.finishCeo(inflight, 'rejected', CHAT_ERROR.workstationOffline);
        return false;
      }
      return true;
    } catch (err) {
      ctx.log.error({ err }, 'ceo turn start failed');
      await this.finishCeo(inflight, 'crashed', CHAT_ERROR.runnerError).catch(() => {});
      return false;
    }
  }

  private turnFinished(
    turn: Row,
    status: 'done' | 'failed' | 'dropped',
    error?: string,
    extra: { degraded?: string; toolCounts?: ToolCounts; model?: ModelChoice } = {},
  ): AppendInput {
    return {
      streamId: streamId.ceo(turn.org_id),
      event: {
        type: 'CeoTurnFinished',
        payload: {
          turnId: turn.id,
          orgId: turn.org_id,
          threadId: turn.thread_id,
          status,
          ...(error ? { error: error.slice(0, 500) } : {}),
          ...(extra.degraded ? { degraded: extra.degraded } : {}),
          ...(extra.toolCounts ? { toolCounts: extra.toolCounts } : {}),
          ...(extra.model ? { model: extra.model } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(turn.org_id),
    };
  }

  /** A turn the server holds as running (after a restart): rebuilt from `ceo_turns`. */
  private async hydrate(chatId: string, workstationId: string): Promise<Inflight | undefined> {
    const turn = await loadTurn(this.ctx.pool, chatId);
    if (!turn || turn.status !== 'running' || turn.workstation_id !== workstationId) return undefined;
    const agent = await one(
      this.ctx.pool,
      `SELECT a.id FROM agents a JOIN ceo_settings c ON c.agent_id = a.id WHERE c.org_id=$1`,
      [turn.org_id],
    );
    if (!agent) return undefined;
    const owner = await orgOwnerId(this.ctx.pool, turn.org_id);
    const c: Inflight = {
      chatId,
      threadId: turn.thread_id,
      userId: owner,
      orgId: turn.org_id,
      projectId: null,
      agentId: agent.id,
      workstationId,
      startedAt: new Date(turn.started_at ?? turn.queued_at),
      ceo: {
        mode: turn.mode,
        model: turn.model,
        queuedAt: new Date(turn.queued_at),
        messageId: turn.message_id ?? null,
        orderEntryId: turn.order_entry_id ?? null,
        orderVersionHash: turn.order_version_hash ?? null,
        runtimeSessionStartedAt: new Date(turn.started_at ?? turn.queued_at),
        cwd: '',
      },
    };
    this.inflight.set(chatId, c);
    this.byThread.set(c.threadId, chatId);
    return c;
  }

  private async applyCeoDone(
    c: Inflight,
    msg: RunnerToServerOf<'chat.done'>,
    tx: Tx,
  ): Promise<ChatTerminal | undefined> {
    const info = c.ceo as CeoInflightInfo;
    const turn = await loadTurn(tx, c.chatId);
    if (!turn) return undefined;
    const messageId = randomUUID();
    const durationMs = Math.max(0, this.ctx.clock.now().getTime() - c.startedAt.getTime());
    const waitedMs = turn.queued
      ? Math.max(0, new Date(turn.started_at ?? c.startedAt).getTime() - new Date(turn.queued_at).getTime())
      : undefined;
    const events: AppendInput[] = [
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
            data: replyData(msg, info, waitedMs),
          },
        },
        actor: agentActor(c.agentId),
        scope: orgScope(c.orgId),
      },
      this.shiftEnded(c, 'reported', msg.usage),
      this.turnFinished(turn, 'done', undefined, {
        ...(msg.degraded ? { degraded: msg.degraded } : {}),
        ...(msg.toolCounts ? { toolCounts: msg.toolCounts } : {}),
        model: info.model,
      }),
      ...(await backstopJobEvents(this.ctx, turn, {
        toolCounts: msg.toolCounts,
        usage: msg.usage,
        durationMs,
        model: info.model.model,
      })),
      ...(await closePendingForTurn(tx, turn)),
    ];
    if (turn.mode === 'order' && turn.order_entry_id) {
      // Only first words and counts are kept (an older runner sends the full text; it is reduced here).
      const commands = summarizeCommandTexts([...(turn.order_commands ?? []), ...(msg.commands ?? [])]);
      events.push({
        streamId: streamId.ceo(c.orgId),
        event: {
          type: 'CeoOrderTurnFinished',
          payload: {
            turnId: turn.id,
            orgId: c.orgId,
            entryId: turn.order_entry_id,
            versionHash: turn.order_version_hash,
            outcome: turn.order_outcome ?? 'done',
            summary: turn.order_summary ?? msg.messageText.slice(0, 1500),
            commands,
            ...(turn.order_ask ? { ask: turn.order_ask } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(c.orgId),
      });
    }
    await this.ctx.store.append(events, { tx });
    this.release(c);
    return { userId: c.userId, threadId: c.threadId, messageId, ceoThread: c.threadId };
  }

  private async applyCeoError(
    c: Inflight,
    msg: RunnerToServerOf<'chat.error'>,
    tx: Tx,
  ): Promise<ChatTerminal | undefined> {
    const turn = await loadTurn(tx, c.chatId);
    if (!turn) return undefined;
    const events: AppendInput[] = [
      this.shiftEnded(c, msg.error === 'cancelled' ? 'stopped' : 'crashed'),
      this.turnFinished(turn, 'failed', msg.error),
      ...(await closePendingForTurn(tx, turn)),
    ];
    if (turn.mode === 'order' && turn.order_entry_id)
      events.push({
        streamId: streamId.ceo(c.orgId),
        event: {
          type: 'CeoOrderTurnFinished',
          payload: {
            turnId: turn.id,
            orgId: c.orgId,
            entryId: turn.order_entry_id,
            versionHash: turn.order_version_hash,
            outcome: 'failed',
            summary: msg.error.slice(0, 1000),
            commands: turn.order_commands ?? [],
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(c.orgId),
      });
    await this.ctx.store.append(events, { tx });
    this.release(c);
    return { userId: c.userId, threadId: c.threadId, reason: msg.error, ceoThread: c.threadId };
  }

  private async finishCeo(
    c: Inflight,
    outcome: 'rejected' | 'crashed' | 'lost',
    reason: string,
  ): Promise<void> {
    this.release(c);
    const turn = await loadTurn(this.ctx.pool, c.chatId);
    await this.ctx.store.append([
      this.shiftEnded(c, outcome),
      ...(turn ? [this.turnFinished(turn, 'failed', reason)] : []),
    ]);
    this.fail(c.userId, c.threadId, reason);
  }

  /** The oldest queued message of a CEO conversation starts when nothing runs and its workstation is online. */
  async drainThread(threadId: string): Promise<void> {
    const { ctx } = this;
    if (this.byThread.has(threadId)) return;
    const running = await one(ctx.pool, `SELECT 1 FROM ceo_turns WHERE thread_id=$1 AND status='running'`, [
      threadId,
    ]);
    if (running) return;
    const next = await one(
      ctx.pool,
      `SELECT * FROM ceo_turns WHERE thread_id=$1 AND status='queued' AND mode='owner' AND queued_at > $2
        ORDER BY queued_at LIMIT 1`,
      [threadId, new Date(ctx.clock.now().getTime() - STALE_QUEUE_MS)],
    );
    if (!next) return;
    const msg = next.message_id
      ? await one(ctx.pool, 'SELECT body, author_user_id FROM thread_messages WHERE id=$1', [next.message_id])
      : undefined;
    if (!msg) {
      await ctx.store.append([this.turnFinished(next, 'dropped', 'the message is gone')]);
      return;
    }
    await this.startCeoTurn(next.id, msg.author_user_id as string, msg.body as string);
  }

  /** A workstation (re)connected: queued messages of the CEOs that live on it go out, in order. */
  async onReconnect(workstationId: string): Promise<void> {
    const threads = await rows(
      this.ctx.pool,
      `SELECT DISTINCT t.thread_id FROM ceo_turns t WHERE t.workstation_id=$1 AND t.status='queued' AND t.mode='owner'`,
      [workstationId],
    );
    for (const t of threads) await this.drainThread(t.thread_id);
  }

  /** The owner's decision on a stale queued message: send it anyway, or drop it. */
  async decideQueued(userId: string, turnId: string, decision: 'send' | 'drop'): Promise<void> {
    const { ctx } = this;
    const turn = await loadTurn(ctx.pool, turnId);
    if (!turn || turn.status !== 'queued' || turn.mode !== 'owner') return;
    if (decision === 'drop') {
      await ctx.store.append([this.turnFinished(turn, 'dropped', 'dropped by the owner')]);
      return;
    }
    if (this.byThread.has(turn.thread_id)) return;
    const msg = turn.message_id
      ? await one(ctx.pool, 'SELECT body, author_user_id FROM thread_messages WHERE id=$1', [turn.message_id])
      : undefined;
    // the message keeps its author's authority: the one who decides "send" does not lend his
    if (msg)
      await this.startCeoTurn(turn.id, (msg.author_user_id as string | null) ?? userId, msg.body as string);
  }

  /** Running CEO turns of a workstation that the runner no longer holds are over (it restarted without them). */
  async reconcileCeoTurns(workstationId: string, held: string[], helloAt: Date): Promise<void> {
    const lost = await rows(
      this.ctx.pool,
      `SELECT * FROM ceo_turns WHERE workstation_id=$1 AND status='running' AND started_at <= $2`,
      [workstationId, helloAt],
    );
    for (const t of lost) {
      if (held.includes(t.id)) continue;
      const c = this.inflight.get(t.id);
      if (c) this.release(c);
      await this.ctx.store
        .append([
          ...(c ? [this.shiftEnded(c, 'lost')] : []),
          this.turnFinished(t, 'failed', 'the runner restarted before the reply was ready'),
          ...(await closePendingForTurn(this.ctx.pool, t)),
        ])
        .catch((err) => this.ctx.log.error({ err }, 'failed to end lost ceo turn'));
      const owner = await orgOwnerId(this.ctx.pool, t.org_id);
      this.fail(owner, t.thread_id, CHAT_ERROR.workstationOffline);
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
    const c = this.inflight.get(msg.chatId) ?? (await this.hydrate(msg.chatId, workstationId));
    if (!c || c.workstationId !== workstationId) return undefined;
    if (c.ceo) return this.applyCeoDone(c, msg, tx);
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
    const c = this.inflight.get(msg.chatId) ?? (await this.hydrate(msg.chatId, workstationId));
    if (!c || c.workstationId !== workstationId) return undefined;
    if (c.ceo) return this.applyCeoError(c, msg, tx);
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
    // The reply is out: the next queued message of a CEO conversation may start.
    if (t.ceoThread)
      void this.drainThread(t.ceoThread).catch((err) =>
        this.ctx.log.error({ err }, 'ceo queue drain failed'),
      );
  }

  /** The runner's socket closed: its chats cannot finish (the runner kills them too). */
  async workstationLost(workstationId: string): Promise<void> {
    for (const c of [...this.inflight.values()]) {
      if (c.workstationId !== workstationId) continue;
      // A CEO owner or order turn survives a dropped connection: the runner keeps it going and delivers the reply on
      // reconnect (`reconcileCeoTurns` fails the turns the runner no longer holds).
      if (c.ceo) continue;
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
