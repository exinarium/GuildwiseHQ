import { randomUUID } from 'node:crypto';
import {
  type AgentRuntimeSpec,
  builtinCapabilities,
  type ChatContext,
  type ChatSegment,
  capChatSegments,
  chatSegmentsText,
  composeTurnMessage,
  getBuiltinRole,
  isKnownChoice,
  type ModelChoice,
  PERSONA_HOST_AGENT_ID,
  type QueueTurnRequest,
  type RunnerToServerOf,
  renderSessionTranscript,
  SESSION_TURN_MAX_ATTEMPTS,
  SESSION_TURN_PER_WORKSTATION,
  SESSION_TURN_STALE_HOURS,
  SESSION_TURNS_CAPABILITY,
  type ServerToBrowser,
  type SessionContext,
  type SessionTurnDto,
  type SessionTurnSpec,
  streamId,
  type ThreadMessageDto,
  type TranscriptLine,
  type Usage,
} from '@aom/shared';
import { resolvePersona } from '../capabilities/registry.ts';
import { agentActor, runnerActor, userActor } from '../commands/common.ts';
import { isAdHocPersona, listParticipants, loadSession, sessionScope } from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { threadMessageById } from '../queries/threads.ts';
import { agentSpecFor } from '../runner-gateway/brief.ts';

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const ORPHAN_MS = 30 * 60_000;

/** The reasons a runner gives when it drops a turn because the connection or the runner went away: the turn is retried. */
export function isTransientTurnError(error: string): boolean {
  return error.startsWith('workstation offline') || error === 'runner stopped';
}

export function turnDto(r: Row): SessionTurnDto {
  return {
    id: r.id,
    threadId: r.thread_id,
    participantId: r.participant_id ?? null,
    speakerName: r.speaker_name,
    status: r.status,
    attempts: r.attempts,
    round: r.round ?? null,
    replyToMessageId: r.reply_to_message_id ?? null,
    messageId: r.message_id ?? null,
    error: r.error ?? null,
    workstationId: r.workstation_id ?? null,
    queuedAt: iso(r.queued_at) as string,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  };
}

/** What a terminal frame produced, for the browser after the transaction committed. */
export interface SessionTerminal {
  threadId: string;
  turnId: string;
  participantId: string | null;
  messageId?: string;
  message?: ThreadMessageDto;
  error?: string;
  requeued?: boolean;
  workstationId: string | null;
}

/** The persona of a speaker as a (synthetic) agent the runner can run read-only. */
function personaSpec(name: string, choice: ModelChoice, skills: string[]): AgentRuntimeSpec {
  return {
    agentId: PERSONA_HOST_AGENT_ID,
    name,
    roleKey: 'persona',
    seniority: 'senior',
    runtime: choice.runtime,
    model: choice.model,
    ...(choice.effort ? { effort: choice.effort } : {}),
    skills,
    permissions: {
      allowedTools: ['read'],
      deniedShellPatterns: [],
      writableGlobs: [],
      mayCommit: false,
      browser: false,
      riskTiers: ['small', 'large'],
      readOrgRepos: false,
      repoIds: [],
    },
    isDevops: false,
  };
}

/**
 * Durable turns of discovery and boardroom sessions (docs/ARCHITECTURE.md "Sessions"). A turn is persisted
 * (`SessionTurnQueued`) before it is sent; the dispatcher sends it with the usual `chat.start` (plus a `session` block)
 * when its workstation is online, and puts it back in the queue when the workstation lost it (a runner restart, a dropped
 * connection). The reply is stored as a thread message written by the speaker. Chat, card and CEO threads never come here.
 */
export class SessionTurns {
  /** turn id -> workstation, for the turns this process sent and has not heard the end of. */
  private readonly inflight = new Map<string, { workstationId: string; userIds: string[] }>();
  private readonly dispatching = new Set<string>();

  constructor(private readonly ctx: Ctx) {}

  private tell(userIds: string[], msg: ServerToBrowser): void {
    for (const id of new Set(userIds)) this.ctx.services.browser.sendToUser(id, msg);
  }

  /** The people who watch a session: its creator and the user participants. */
  private async audience(db: Queryable, threadId: string): Promise<string[]> {
    const t = await one(db, 'SELECT created_by FROM threads WHERE id=$1', [threadId]);
    const p = await rows(
      db,
      `SELECT ref_id FROM thread_participants WHERE thread_id=$1 AND kind='user' AND removed_at IS NULL`,
      [threadId],
    );
    return [
      ...new Set([...(t?.created_by ? [t.created_by as string] : []), ...p.map((r) => r.ref_id as string)]),
    ];
  }

  private async announce(
    db: Queryable,
    turn: Row,
    status: 'queued' | 'running' | 'done' | 'failed',
    error?: string,
  ) {
    this.tell(await this.audience(db, turn.thread_id), {
      type: 'session.turn',
      threadId: turn.thread_id,
      turnId: turn.id,
      participantId: turn.participant_id ?? null,
      status,
      ...(error ? { error } : {}),
    });
  }

  // ----------------------------------------------------------------------------------------------- queueing

  /** `POST /api/sessions/:id/turns`: persists a turn and tries to send it. */
  async queue(userId: string, threadId: string, req: QueueTurnRequest): Promise<SessionTurnDto> {
    const { ctx } = this;
    const row = await withAppendTx(ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId);
      const part = (await listParticipants(tx, threadId)).find((p) => p.id === req.participantId);
      if (!part) throw notFound('participant not found');
      if (part.kind === 'user')
        throw badRequest('not_a_speaker', 'a person does not take a turn here: post a message instead');
      const context: SessionContext = req.context ?? { mode: 'all' };
      if (context.messageIds?.length || context.upToMessageId) {
        const ids = [
          ...(context.messageIds ?? []),
          ...(context.upToMessageId ? [context.upToMessageId] : []),
        ];
        const found = await rows(
          tx,
          'SELECT id FROM thread_messages WHERE thread_id=$1 AND id = ANY($2::uuid[])',
          [threadId, ids],
        );
        if (found.length !== new Set(ids).size)
          throw badRequest('unknown_message', 'a message of the context is not in this session');
      }
      if (
        req.replyToMessageId &&
        !(await one(tx, 'SELECT 1 FROM thread_messages WHERE id=$1 AND thread_id=$2', [
          req.replyToMessageId,
          threadId,
        ]))
      )
        throw badRequest('unknown_message', 'the message to reply to is not in this session');

      let agent: Row | undefined;
      let instructions = req.instructions;
      let choice: ModelChoice;
      let personaKey: string | undefined;
      const host = t.agent_id ? await one(tx, 'SELECT * FROM agents WHERE id=$1', [t.agent_id]) : undefined;
      if (part.kind === 'agent') {
        agent = await one(tx, `SELECT * FROM agents WHERE id=$1 AND org_id=$2 AND status <> 'retired'`, [
          part.ref_id,
          t.org_id,
        ]);
        if (!agent) throw conflict('agent_unavailable', 'that agent is no longer available');
        choice = {
          runtime: agent.runtime,
          model: agent.model,
          ...(agent.effort ? { effort: agent.effort } : {}),
        };
        instructions ??= defaultAgentInstructions(agent.role_key);
      } else {
        personaKey = part.ref_id as string;
        if (isAdHocPersona(personaKey)) {
          instructions ??= `You are ${part.display_name}. ${part.stance ?? ''}`.trim();
          choice = defaultPersonaChoice(host, undefined);
        } else {
          const persona = await resolvePersona(tx, t.org_id, personaKey);
          if (!persona)
            throw conflict('persona_unavailable', `persona "${personaKey}" is no longer in the registry`);
          // A built-in persona travels with the turn; a vault persona is read by the runner from its clone.
          instructions ??= persona.prompt;
          choice = defaultPersonaChoice(host, persona.model);
        }
      }
      if (req.model) {
        if (!isKnownChoice(req.model)) throw badRequest('unknown_model', 'unknown model choice');
        choice = req.model;
      }
      const workstationId: string | undefined =
        req.workstationId ?? agent?.workstation_id ?? t.workstation_id ?? undefined;
      if (!workstationId) throw conflict('no_workstation', 'this session has no workstation: set one first');
      const ws = await one(tx, `SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
        workstationId,
      ]);
      if (!ws) throw conflict('no_workstation', 'the workstation of this session is not available');

      const turnId = randomUUID();
      await ctx.store.append(
        [
          {
            streamId: streamId.sessionTurn(turnId),
            event: {
              type: 'SessionTurnQueued',
              payload: {
                turnId,
                threadId,
                orgId: t.org_id,
                participantId: part.id,
                speaker: {
                  kind: part.kind,
                  name: part.display_name,
                  ...(agent ? { agentId: agent.id } : {}),
                  ...(personaKey ? { personaKey } : {}),
                  seat: part.seat,
                },
                ...(instructions ? { instructions } : {}),
                message: req.message,
                context,
                model: choice,
                workstationId,
                ...(req.replyToMessageId ? { replyToMessageId: req.replyToMessageId } : {}),
                ...(req.round !== undefined ? { round: req.round } : {}),
                requestedBy: userId,
              },
            },
            actor: userActor(userId),
            scope: sessionScope(t),
          },
        ],
        { tx },
      );
      return (await one(tx, 'SELECT * FROM session_turns WHERE id=$1', [turnId])) as Row;
    });
    await this.announce(ctx.pool, row, 'queued');
    void this.sweep(row.workstation_id).catch((err) =>
      ctx.log.error({ err }, 'session turn dispatch failed'),
    );
    return turnDto(row);
  }

  async list(userId: string, threadId: string): Promise<SessionTurnDto[]> {
    await loadSession(this.ctx.pool, userId, threadId);
    return (
      await rows(this.ctx.pool, 'SELECT * FROM session_turns WHERE thread_id=$1 ORDER BY queued_at, id', [
        threadId,
      ])
    ).map(turnDto);
  }

  /** Cancels a queued turn at once, or asks the runner to stop a running one (it answers with a `cancelled` error). */
  async cancel(userId: string, threadId: string, turnId: string): Promise<SessionTurnDto> {
    const { ctx } = this;
    const t = await loadSession(ctx.pool, userId, threadId);
    const turn = await one(ctx.pool, 'SELECT * FROM session_turns WHERE id=$1 AND thread_id=$2', [
      turnId,
      threadId,
    ]);
    if (!turn) throw notFound('turn not found');
    if (turn.status === 'queued') {
      await ctx.store.append([this.failed(turn, t, 'cancelled', userActor(userId))]);
      await this.announce(ctx.pool, turn, 'failed', 'cancelled');
    } else if (turn.status === 'running' && turn.workstation_id) {
      ctx.services.runners.send(turn.workstation_id, 'chat.cancel', { chatId: turn.id }, ctx.clock.now());
    } else throw conflict('turn_finished', 'that turn already ended');
    return turnDto((await one(ctx.pool, 'SELECT * FROM session_turns WHERE id=$1', [turnId])) as Row);
  }

  // ----------------------------------------------------------------------------------------------- dispatching

  private failed(turn: Row, t: Row, error: string, actor?: AppendInput['actor']): AppendInput {
    return {
      streamId: streamId.sessionTurn(turn.id),
      event: {
        type: 'SessionTurnFailed',
        payload: {
          turnId: turn.id,
          threadId: turn.thread_id,
          error: error.slice(0, 500),
          ...(turn.workstation_id ? { workstationId: turn.workstation_id } : {}),
        },
      },
      actor: actor ?? { kind: 'system', id: null },
      scope: sessionScope(t),
    };
  }

  private async failTurn(turn: Row, error: string): Promise<void> {
    const t = await one(this.ctx.pool, 'SELECT org_id, project_id FROM threads WHERE id=$1', [
      turn.thread_id,
    ]);
    await this.ctx.store.append([
      this.failed(turn, (t as Row) ?? { org_id: turn.org_id, project_id: null }, error),
    ]);
    this.inflight.delete(turn.id);
    await this.announce(this.ctx.pool, turn, 'failed', error);
  }

  /** Starts queued turns whose workstation is online, oldest first, up to the per-workstation limit; ends stale ones. */
  async sweep(workstationId?: string): Promise<number> {
    const { ctx } = this;
    const now = ctx.clock.now();
    // A started turn nobody has heard from for a long time is not running any more (a restart lost it).
    const orphans = await rows(
      ctx.pool,
      `SELECT * FROM session_turns WHERE status='running' AND started_at < $1 ${workstationId ? 'AND workstation_id=$2' : ''}`,
      workstationId
        ? [new Date(now.getTime() - ORPHAN_MS), workstationId]
        : [new Date(now.getTime() - ORPHAN_MS)],
    );
    for (const o of orphans)
      if (!this.inflight.has(o.id)) await this.requeueOrFail(o, 'no answer from the workstation');
    const queued = await rows(
      ctx.pool,
      `SELECT * FROM session_turns WHERE status='queued' ${workstationId ? 'AND workstation_id=$1' : ''} ORDER BY queued_at, id LIMIT 200`,
      workstationId ? [workstationId] : [],
    );
    const running = new Map<string, number>();
    let started = 0;
    for (const turn of queued) {
      if (now.getTime() - new Date(turn.queued_at).getTime() > SESSION_TURN_STALE_HOURS * 3_600_000) {
        await this.failTurn(turn, 'expired: no workstation was available for 24 hours');
        continue;
      }
      const ws = turn.workstation_id as string;
      if (!ctx.services.runners.isOnline(ws)) continue;
      if (!running.has(ws)) {
        const n = await one(
          ctx.pool,
          `SELECT count(*)::int AS n FROM session_turns WHERE workstation_id=$1 AND status='running'`,
          [ws],
        );
        running.set(ws, n?.n ?? 0);
      }
      if ((running.get(ws) ?? 0) >= SESSION_TURN_PER_WORKSTATION) continue;
      if (await this.dispatch(turn.id)) {
        running.set(ws, (running.get(ws) ?? 0) + 1);
        started++;
      }
    }
    return started;
  }

  /** Sends one queued turn to its workstation. False: it stays queued (offline) or it was ended. */
  async dispatch(turnId: string): Promise<boolean> {
    const { ctx } = this;
    if (this.dispatching.has(turnId)) return false;
    this.dispatching.add(turnId);
    try {
      const turn = await one(ctx.pool, 'SELECT * FROM session_turns WHERE id=$1', [turnId]);
      if (!turn || turn.status !== 'queued') return false;
      const wsId = turn.workstation_id as string;
      if (!ctx.services.runners.isOnline(wsId)) return false;
      const thread = await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1', [turn.thread_id]);
      if (!thread || thread.deleted_at) {
        await this.failTurn(turn, 'the session no longer exists');
        return false;
      }
      const caps = await one(
        ctx.pool,
        'SELECT $2 = ANY(capabilities) AS ok FROM workstation_capabilities WHERE workstation_id=$1',
        [wsId, SESSION_TURNS_CAPABILITY],
      );
      if (!caps?.ok) {
        await this.failTurn(
          turn,
          'runner_too_old: update the runner on this workstation to run session turns',
        );
        return false;
      }
      const payload = await this.buildStart(turn, thread);
      if (!payload) {
        await this.failTurn(turn, 'the speaker is no longer available');
        return false;
      }
      // Started first, then sent: a cancel or a lost runner that arrives right after the send finds a running turn.
      this.inflight.set(turn.id, {
        workstationId: wsId,
        userIds: await this.audience(ctx.pool, turn.thread_id),
      });
      const scope = sessionScope(thread);
      await ctx.store.append([
        {
          streamId: streamId.sessionTurn(turn.id),
          event: {
            type: 'SessionTurnStarted',
            payload: {
              turnId: turn.id,
              threadId: turn.thread_id,
              workstationId: wsId,
              attempt: (turn.attempts ?? 0) + 1,
            },
          },
          actor: runnerActor(wsId),
          scope,
        },
      ]);
      const sent = ctx.services.runners.send(wsId, 'chat.start', payload as never, ctx.clock.now());
      if (!sent) {
        // The socket closed between the check and the send: the turn goes back to the queue for the next connection.
        this.inflight.delete(turn.id);
        await ctx.store.append([
          {
            streamId: streamId.sessionTurn(turn.id),
            event: {
              type: 'SessionTurnRequeued',
              payload: {
                turnId: turn.id,
                threadId: turn.thread_id,
                reason: 'the workstation went offline',
                workstationId: wsId,
              },
            },
            actor: { kind: 'system', id: null },
            scope,
          },
        ]);
        return false;
      }
      await this.announce(ctx.pool, turn, 'running');
      return true;
    } finally {
      this.dispatching.delete(turnId);
    }
  }

  /** The history lines of a turn's context, oldest first. */
  private async transcript(turn: Row): Promise<TranscriptLine[]> {
    const ctxSpec = (turn.context ?? { mode: 'all' }) as SessionContext;
    if (ctxSpec.mode === 'none') return [];
    const base = `SELECT m.id, m.body, m.author_kind, m.author_persona_key, u.display_name AS user_name, a.name AS agent_name,
         (SELECT tp.display_name FROM thread_participants tp WHERE m.author_persona_key IS NOT NULL AND tp.thread_id = m.thread_id
            AND tp.kind='persona' AND tp.ref_id = m.author_persona_key ORDER BY tp.added_at LIMIT 1) AS persona_name
       FROM thread_messages m LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id = $1 AND m.kind IN ('chat','comment')`;
    let list: Row[];
    if (ctxSpec.mode === 'selected') {
      list = await rows(
        this.ctx.pool,
        `${base} AND m.id = ANY($2::uuid[]) ORDER BY m.created_at, m.event_seq, m.id`,
        [turn.thread_id, ctxSpec.messageIds ?? []],
      );
    } else {
      list = (
        await rows(
          this.ctx.pool,
          `${base} AND ($2::uuid IS NULL OR (m.created_at, m.event_seq) <= (SELECT c.created_at, c.event_seq FROM thread_messages c WHERE c.id=$2))
            ORDER BY m.created_at DESC, m.event_seq DESC, m.id DESC LIMIT $3`,
          [turn.thread_id, ctxSpec.upToMessageId ?? null, ctxSpec.limit ?? 40],
        )
      ).reverse();
    }
    return list.map((m) => ({
      author:
        m.user_name ?? m.persona_name ?? m.agent_name ?? (m.author_kind === 'user' ? 'Owner' : 'Participant'),
      body: m.body as string,
    }));
  }

  private async buildStart(turn: Row, thread: Row): Promise<Record<string, unknown> | null> {
    const { ctx } = this;
    const choice = turn.model as ModelChoice;
    let spec: AgentRuntimeSpec;
    let skills: string[] = [];
    if (turn.speaker_kind === 'agent') {
      const agent = await one(ctx.pool, `SELECT * FROM agents WHERE id=$1 AND status <> 'retired'`, [
        turn.agent_id,
      ]);
      if (!agent) return null;
      spec = { ...(await agentSpecFor(ctx, agent)), runtime: choice.runtime, model: choice.model };
      if (choice.effort) spec.effort = choice.effort;
      else delete spec.effort;
      skills = spec.skills;
    } else {
      const persona = !isAdHocPersona(turn.persona_key ?? '')
        ? await resolvePersona(ctx.pool, turn.org_id, turn.persona_key)
        : undefined;
      skills = persona?.skills ?? [];
      spec = personaSpec(turn.speaker_name, choice, skills);
    }
    const persona =
      turn.speaker_kind === 'persona' && turn.persona_key && !isAdHocPersona(turn.persona_key)
        ? await resolvePersona(ctx.pool, turn.org_id, turn.persona_key)
        : undefined;
    const roster = (await listParticipants(ctx.pool, turn.thread_id)).map((p) => ({
      name: p.display_name as string,
      kind: p.kind as 'user' | 'agent' | 'persona',
      seat: p.seat as string,
    }));
    const session: SessionTurnSpec = {
      turnId: turn.id,
      kind: thread.kind,
      speaker: {
        kind: turn.speaker_kind,
        name: turn.speaker_name,
        ...(turn.persona_key ? { personaKey: turn.persona_key } : {}),
        ...(turn.seat ? { seat: turn.seat } : {}),
        ...(persona?.stance ? { stance: persona.stance } : {}),
        ...(persona?.voice ? { voice: persona.voice } : {}),
        ...(persona?.icon ? { icon: persona.icon } : {}),
      },
      ...(turn.instructions ? { instructions: turn.instructions } : {}),
      roster,
    };
    const message = composeTurnMessage(renderSessionTranscript(await this.transcript(turn)), turn.message);
    const context: ChatContext = {
      orgId: turn.org_id,
      ...(thread.project_id ? { projectId: thread.project_id } : {}),
    };
    return { chatId: turn.id, threadId: turn.thread_id, agent: spec, message, context, session };
  }

  // ----------------------------------------------------------------------------------------------- the runner's frames

  /** A workstation (re)connected: turns it no longer holds go back to the queue, then queued ones go out. */
  async onReconnect(workstationId: string, held: string[], helloAt: Date): Promise<void> {
    const lost = await rows(
      this.ctx.pool,
      `SELECT * FROM session_turns WHERE workstation_id=$1 AND status='running' AND started_at <= $2`,
      [workstationId, helloAt],
    );
    for (const t of lost) {
      if (held.includes(t.id)) continue;
      this.inflight.delete(t.id);
      await this.requeueOrFail(t, 'the runner restarted before the reply was ready');
    }
    await this.sweep(workstationId);
  }

  private async requeueOrFail(turn: Row, reason: string): Promise<void> {
    const t = (await one(this.ctx.pool, 'SELECT org_id, project_id FROM threads WHERE id=$1', [
      turn.thread_id,
    ])) ?? {
      org_id: turn.org_id,
      project_id: null,
    };
    if ((turn.attempts ?? 0) >= SESSION_TURN_MAX_ATTEMPTS) {
      await this.failTurn(turn, `gave up after ${turn.attempts} attempts: ${reason}`);
      return;
    }
    await this.ctx.store.append([
      {
        streamId: streamId.sessionTurn(turn.id),
        event: {
          type: 'SessionTurnRequeued',
          payload: {
            turnId: turn.id,
            threadId: turn.thread_id,
            reason: reason.slice(0, 300),
            workstationId: turn.workstation_id,
          },
        },
        actor: { kind: 'system', id: null },
        scope: sessionScope(t),
      },
    ]);
    await this.announce(this.ctx.pool, turn, 'queued');
  }

  /** Does the turn belong to this module (a session turn row with this id)? */
  async owns(chatId: string): Promise<boolean> {
    return !!(await one(this.ctx.pool, 'SELECT 1 FROM session_turns WHERE id::text=$1', [chatId]));
  }

  onDelta(workstationId: string, msg: RunnerToServerOf<'chat.delta'>): boolean {
    const c = this.inflight.get(msg.chatId);
    if (!c) return false;
    if (c.workstationId === workstationId)
      this.tell(c.userIds, {
        type: 'chat.delta',
        threadId: msg.threadId,
        text: msg.text,
        turnId: msg.chatId,
      } as ServerToBrowser);
    return true;
  }

  onActivity(workstationId: string, msg: RunnerToServerOf<'chat.activity'>): boolean {
    const c = this.inflight.get(msg.chatId);
    if (!c) return false;
    if (c.workstationId === workstationId)
      this.tell(c.userIds, {
        type: 'chat.activity',
        threadId: msg.threadId,
        seq: msg.seq,
        segment: msg.segment,
        ...(msg.replace ? { replace: true } : {}),
        turnId: msg.chatId,
      } as ServerToBrowser);
    return true;
  }

  /** `chat.done` of a session turn. Runs inside the runner-inbox transaction; undefined: not a session turn. */
  async applyDone(
    workstationId: string,
    msg: RunnerToServerOf<'chat.done'>,
    tx: Tx,
  ): Promise<SessionTerminal | undefined> {
    const turn = await one(tx, 'SELECT * FROM session_turns WHERE id::text=$1 FOR UPDATE', [msg.chatId]);
    if (!turn) return undefined;
    const base = {
      threadId: turn.thread_id,
      turnId: turn.id,
      participantId: turn.participant_id ?? null,
      workstationId,
    };
    if (turn.status === 'done' || turn.status === 'failed')
      return { ...base, ...(turn.message_id ? { messageId: turn.message_id } : {}) };
    const t = await one(tx, 'SELECT * FROM threads WHERE id=$1', [turn.thread_id]);
    if (!t) return { ...base, error: 'the session no longer exists' };
    const messageId = randomUUID();
    const segments: ChatSegment[] | undefined = msg.segments?.length
      ? capChatSegments(msg.segments)
      : undefined;
    const body = (msg.segments && chatSegmentsText(msg.segments)) || msg.messageText;
    const model = turn.model as ModelChoice;
    await this.ctx.store.append(
      [
        {
          streamId: streamId.thread(turn.thread_id),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: turn.thread_id,
              messageId,
              authorKind: 'agent',
              ...(turn.agent_id ? { authorAgentId: turn.agent_id } : {}),
              ...(turn.persona_key ? { authorPersonaKey: turn.persona_key } : {}),
              kind: 'chat',
              body,
              data: {
                turnId: turn.id,
                ...(turn.participant_id ? { participantId: turn.participant_id } : {}),
                ...(turn.seat ? { seat: turn.seat } : {}),
                ...(turn.round !== null && turn.round !== undefined ? { round: turn.round } : {}),
                ...(turn.reply_to_message_id ? { replyToMessageId: turn.reply_to_message_id } : {}),
                usage: msg.usage,
                model,
                ...(segments ? { segments } : {}),
              },
            },
          },
          actor: turn.agent_id ? agentActor(turn.agent_id) : runnerActor(workstationId),
          scope: sessionScope(t),
        },
        {
          streamId: streamId.sessionTurn(turn.id),
          event: {
            type: 'SessionTurnCompleted',
            payload: {
              turnId: turn.id,
              threadId: turn.thread_id,
              messageId,
              usage: msg.usage ?? ZERO_USAGE,
              ...(msg.runtimeSessionId ? { runtimeSessionId: msg.runtimeSessionId } : {}),
            },
          },
          actor: runnerActor(workstationId),
          scope: sessionScope(t),
        },
      ],
      { tx },
    );
    const message = await threadMessageById(tx, messageId);
    return { ...base, messageId, ...(message ? { message } : {}) };
  }

  /** `chat.error` of a session turn: a dropped connection retries the turn, anything else ends it. */
  async applyError(
    workstationId: string,
    msg: RunnerToServerOf<'chat.error'>,
    tx: Tx,
  ): Promise<SessionTerminal | undefined> {
    const turn = await one(tx, 'SELECT * FROM session_turns WHERE id::text=$1 FOR UPDATE', [msg.chatId]);
    if (!turn) return undefined;
    const base = {
      threadId: turn.thread_id,
      turnId: turn.id,
      participantId: turn.participant_id ?? null,
      workstationId,
    };
    if (turn.status === 'done' || turn.status === 'failed') return base;
    const t = (await one(tx, 'SELECT org_id, project_id FROM threads WHERE id=$1', [turn.thread_id])) as
      | Row
      | undefined;
    const scope = sessionScope(t ?? { org_id: turn.org_id, project_id: null });
    if (isTransientTurnError(msg.error) && (turn.attempts ?? 0) < SESSION_TURN_MAX_ATTEMPTS) {
      await this.ctx.store.append(
        [
          {
            streamId: streamId.sessionTurn(turn.id),
            event: {
              type: 'SessionTurnRequeued',
              payload: {
                turnId: turn.id,
                threadId: turn.thread_id,
                reason: msg.error.slice(0, 300),
                workstationId,
              },
            },
            actor: runnerActor(workstationId),
            scope,
          },
        ],
        { tx },
      );
      return { ...base, error: msg.error, requeued: true };
    }
    await this.ctx.store.append(
      [
        {
          streamId: streamId.sessionTurn(turn.id),
          event: {
            type: 'SessionTurnFailed',
            payload: {
              turnId: turn.id,
              threadId: turn.thread_id,
              error: msg.error.slice(0, 500),
              workstationId,
            },
          },
          actor: runnerActor(workstationId),
          scope,
        },
      ],
      { tx },
    );
    return { ...base, error: msg.error };
  }

  /** After the transaction committed: tell the watchers and let the next queued turn go. */
  async notify(t: SessionTerminal | undefined): Promise<void> {
    if (!t) return;
    const c = this.inflight.get(t.turnId);
    const users = c?.userIds ?? (await this.audience(this.ctx.pool, t.threadId));
    this.inflight.delete(t.turnId);
    if (t.messageId) {
      this.tell(users, {
        type: 'chat.done',
        threadId: t.threadId,
        messageId: t.messageId,
        ...(t.message ? { message: t.message } : {}),
        turnId: t.turnId,
        ...(t.participantId ? { participantId: t.participantId } : {}),
      });
      this.tell(users, {
        type: 'session.turn',
        threadId: t.threadId,
        turnId: t.turnId,
        participantId: t.participantId,
        status: 'done',
      });
    } else if (t.requeued) {
      this.tell(users, {
        type: 'session.turn',
        threadId: t.threadId,
        turnId: t.turnId,
        participantId: t.participantId,
        status: 'queued',
      });
    } else if (t.error) {
      this.tell(users, {
        type: 'chat.error',
        threadId: t.threadId,
        reason: t.error,
        turnId: t.turnId,
        ...(t.participantId ? { participantId: t.participantId } : {}),
      });
      this.tell(users, {
        type: 'session.turn',
        threadId: t.threadId,
        turnId: t.turnId,
        participantId: t.participantId,
        status: 'failed',
        error: t.error,
      });
    }
    if (t.workstationId)
      void this.sweep(t.workstationId).catch((err) =>
        this.ctx.log.error({ err }, 'session turn sweep failed'),
      );
  }
}

/** The text an agent speaks from when the caller gave none: a registry persona of its role's key, else the role's instructions. */
function defaultAgentInstructions(roleKey: string): string | undefined {
  const p = builtinCapabilities().find((e) => e.kind === 'persona' && e.key === roleKey);
  if (p) return p.body;
  return getBuiltinRole(roleKey)?.instructions;
}

/** A persona runs on the host agent's runtime; on Claude Code it uses the persona's own (cheap) model. */
function defaultPersonaChoice(host: Row | undefined, personaModel: string | undefined): ModelChoice {
  const runtime = host?.runtime ?? 'claude-code';
  if (runtime === 'claude-code') return { runtime, model: personaModel ?? 'haiku' };
  return { runtime, model: host?.model ?? 'mock' };
}
