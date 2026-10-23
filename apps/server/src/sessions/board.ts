import { randomUUID } from 'node:crypto';
import {
  assembleMinutes,
  BOARD_TURN_MAX_CHARS,
  type BoardCastDto,
  type BoardConfig,
  type BoardPlan,
  type BoardRoom,
  type BoardRpcMethod,
  type BoardStateDto,
  buildCastTurn,
  buildChairTurn,
  buildMinutesTurn,
  buildSpeakerTurn,
  builtinCapabilities,
  CAST_SEAT_DEFAULT,
  CHAIR_SEAT,
  type CreateBoardRequest,
  chooseSpeakers,
  documentSlug,
  handlesOf,
  isBoardRpc,
  isOrgManager,
  type ModelChoice,
  type ParticipantInput,
  type PatchBoardRequest,
  type PromptBoardNote,
  parseBoardConfig,
  parseMentions,
  participantSlug,
  type SaveBoardRoomRequest,
  type SessionTurnDto,
  type StartBoardRequest,
  type SuggestCastRequest,
  seedPrdFromMinutes,
  streamId,
  type ThreadMessageDto,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { effectiveRegistry, resolvePersona } from '../capabilities/registry.ts';
import { orgScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { scopeOfDoc, versionEvent } from '../commands/documents.ts';
import {
  addParticipant,
  assertSessionManager,
  createSession,
  isAdHocPersona,
  listParticipants,
  loadSession,
  postSessionMessage,
  sessionScope,
} from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import type { AppendInput, StoredEvent } from '../eventstore/types.ts';
import {
  boardState,
  castKey,
  castOf,
  chairOf,
  defaultModelFor,
  listBoardNotes,
  listDecisions,
  listDisagreements,
  type ModelRole,
} from './board-state.ts';
import { boardVerb } from './board-verbs.ts';
import { sessionCost } from './cost.ts';
import { availableCeo } from './discovery-state.ts';
import { providersOf, runtimeReports } from './offer.ts';

/** Why a queue attempt was refused for a reason the owner can fix: the session waits and the sweep retries. */
const BLOCKING_CODES = new Set([
  'session_budget_exceeded',
  'project_paused',
  'project_budget_paused',
  'no_workstation',
  'runtime_unavailable',
]);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const assertBoard = (t: Row): void => {
  if (t.kind !== 'boardroom') throw notFound('session not found');
};

/** `ad-hoc-<slug>` for a persona cast from a brief. */
export const adHocKey = (name: string): string => `ad-hoc-${participantSlug(name) || 'guest'}`;

const MAX_SPOKEN_CONTEXT = 40;

/**
 * Boardroom orchestrator (docs/ARCHITECTURE.md section 38.2, phase C). The state lives in events and projections: the thread's
 * `session_config` (stage, round, plan, pause, mentions, minutes) and the whiteboard, round, disagreement and decision tables.
 * `advance` is the one step function: from the stored state alone it queues whatever turn is due next, so a restart, a raised
 * budget or a resumed session continues exactly where it stopped.
 */
export class BoardService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(readonly ctx: Ctx) {}

  serialized<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      threadId,
      next.catch(() => undefined),
    );
    return next;
  }

  // ----------------------------------------------------------------------------------------------- fan-out to the browser

  registerHook(): () => void {
    return this.ctx.store.subscribe(async (e: StoredEvent) => {
      const ids = await this.threadsOf(e).catch(() => [] as string[]);
      for (const id of ids) await this.touch(id);
    });
  }

  private async threadsOf(e: StoredEvent): Promise<string[]> {
    const type = e.event.type;
    const p = e.event.payload as unknown as Record<string, unknown>;
    if (
      type.startsWith('Board') ||
      type === 'SessionThreadUpdated' ||
      type === 'SessionTurnQueued' ||
      type === 'SessionTurnStarted' ||
      type === 'SessionTurnRequeued' ||
      type === 'SessionTurnCompleted' ||
      type === 'DelegateCompleted' ||
      type === 'SessionTurnFailed' ||
      type === 'ThreadMessagePosted' ||
      type === 'ThreadParticipantAdded'
    ) {
      const id = p.threadId as string | undefined;
      if (!id || type === 'BoardRoomSaved' || type === 'BoardRoomDeleted') return [];
      return (await one(this.ctx.pool, `SELECT 1 FROM threads WHERE id=$1 AND kind='boardroom'`, [id]))
        ? [id]
        : [];
    }
    return [];
  }

  private async touch(threadId: string): Promise<void> {
    const t = await one(this.ctx.pool, 'SELECT created_by FROM threads WHERE id=$1', [threadId]);
    const p = await rows(
      this.ctx.pool,
      `SELECT ref_id FROM thread_participants WHERE thread_id=$1 AND kind='user' AND removed_at IS NULL`,
      [threadId],
    );
    const users = new Set([
      ...(t?.created_by ? [t.created_by as string] : []),
      ...p.map((r) => r.ref_id as string),
    ]);
    for (const id of users) this.ctx.services.browser.sendToUser(id, { type: 'discovery.updated', threadId });
  }

  // ----------------------------------------------------------------------------------------------- the runner's rpc

  async rpc(
    turn: Row,
    method: string,
    params: Record<string, unknown>,
  ): Promise<[boolean, unknown?, string?]> {
    if (turn.status !== 'running') return [false, undefined, 'this turn is over'];
    if (!isBoardRpc(method)) return [false, undefined, `${method} is not available in a boardroom turn`];
    return boardVerb(this, this.ctx, turn, method as BoardRpcMethod, params);
  }

  // ----------------------------------------------------------------------------------------------- events

  configEvent(
    t: Row,
    config: Record<string, unknown>,
    actor: AppendInput['actor'] = SYSTEM_ACTOR,
  ): AppendInput {
    return {
      streamId: streamId.thread(t.id),
      event: { type: 'SessionThreadUpdated', payload: { threadId: t.id, config } },
      actor,
      scope: sessionScope(t),
    };
  }

  systemMessage(t: Row, body: string, data: Record<string, unknown> = {}): AppendInput {
    return {
      streamId: streamId.thread(t.id),
      event: {
        type: 'ThreadMessagePosted',
        payload: {
          threadId: t.id,
          messageId: randomUUID(),
          authorKind: 'system',
          kind: 'system',
          body,
          data: { board: true, ...data },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: sessionScope(t),
    };
  }

  /** The session for an action only its creator, an Owner or an Admin may take (participants may still post messages). */
  private async loadManaged(userId: string, threadId: string): Promise<Row> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertBoard(t);
    await assertSessionManager(this.ctx.pool, userId, t);
    return t;
  }

  private async fresh(threadId: string): Promise<Row | undefined> {
    return one(
      this.ctx.pool,
      `SELECT * FROM threads WHERE id=$1 AND kind='boardroom' AND deleted_at IS NULL`,
      [threadId],
    );
  }

  async state(userId: string, threadId: string): Promise<BoardStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertBoard(t);
    return boardState(this.ctx, t, userId);
  }

  // ----------------------------------------------------------------------------------------------- creating

  private participantsFor(req: { cast: CreateBoardRequest['cast'] }): ParticipantInput[] {
    return req.cast.map((m) => ({
      kind: m.kind,
      refId: m.refId,
      seat: m.seat ?? CAST_SEAT_DEFAULT,
      ...(m.stance ? { stance: m.stance } : {}),
      ...(m.displayName ? { displayName: m.displayName } : {}),
    }));
  }

  private castModels(req: { cast: CreateBoardRequest['cast'] }): Record<string, ModelChoice> {
    const out: Record<string, ModelChoice> = {};
    for (const m of req.cast) if (m.model) out[castKey(m.kind, m.refId)] = m.model;
    return out;
  }

  private assertCast(cast: CreateBoardRequest['cast']): void {
    const seen = new Set<string>();
    for (const m of cast) {
      const k = castKey(m.kind, m.refId);
      if (seen.has(k)) throw badRequest('duplicate_participant', 'a seat is listed twice');
      seen.add(k);
      if (m.kind === 'persona' && ['chair', 'analyst'].includes(m.refId))
        throw badRequest('bad_cast', 'the chair runs the room and does not take a seat');
    }
  }

  async create(who: Who, req: CreateBoardRequest): Promise<BoardStateDto> {
    this.assertCast(req.cast);
    const config: Record<string, unknown> = {
      board: true,
      topic: req.topic,
      brief: req.brief,
      format: req.format,
      roundCap: req.roundCap,
      models: req.models,
      castModels: this.castModels(req),
      stage: 'setup',
      ...(req.budgetUsd ? { budgetUsd: req.budgetUsd } : {}),
      ...(req.roomId ? { roomId: req.roomId } : {}),
    };
    const session = await createSession(this.ctx, who, {
      kind: 'boardroom',
      title: req.title ?? `Boardroom: ${clip(req.topic.split('\n')[0] ?? req.topic, 80)}`,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      participants: [{ kind: 'persona', refId: 'chair', seat: CHAIR_SEAT }, ...this.participantsFor(req)],
      ...(req.workstationId ? { workstationId: req.workstationId } : {}),
      config,
    });
    await this.serialized(session.threadId, () => this.begin(session.threadId));
    return this.state(who.userId, session.threadId);
  }

  /** "Suggest a cast": a session in setup with only the Chair, whose first turn proposes voices for the topic. */
  async suggest(who: Who, req: SuggestCastRequest): Promise<BoardStateDto> {
    const session = await createSession(this.ctx, who, {
      kind: 'boardroom',
      title: `Boardroom: ${clip(req.topic.split('\n')[0] ?? req.topic, 80)}`,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      participants: [{ kind: 'persona', refId: 'chair', seat: CHAIR_SEAT }],
      ...(req.workstationId ? { workstationId: req.workstationId } : {}),
      config: {
        board: true,
        topic: req.topic,
        brief: req.brief,
        format: req.format,
        stage: 'setup',
        suggestState: 'asking',
      },
    });
    await this.serialized(session.threadId, () => this.queueCast(session.threadId));
    return this.state(who.userId, session.threadId);
  }

  private async queueCast(threadId: string): Promise<void> {
    const t = await this.fresh(threadId);
    if (!t) return;
    const cfg = parseBoardConfig(t.session_config);
    const chair = await chairOf(this.ctx.pool, threadId);
    if (!chair) return;
    const reg = await effectiveRegistry(this.ctx.pool, t.org_id, { kind: 'persona', usableOnly: true });
    const agents = await rows(
      this.ctx.pool,
      `SELECT name, role_key FROM agents WHERE org_id=$1 AND status='active' ORDER BY name LIMIT 20`,
      [t.org_id],
    );
    const built = buildCastTurn({
      topic: cfg.topic,
      brief: cfg.brief,
      format: cfg.format,
      personas: reg.items
        .filter((p) => !['chair', 'analyst'].includes(p.key))
        .map((p) => ({ key: p.key, name: p.name, description: p.description })),
      agents: agents.map((a) => ({ name: a.name, role: a.role_key })),
    });
    const ok = await this.tryQueue(t, cfg, {
      participantId: chair.id,
      message: built.message,
      model: await this.modelFor(t, cfg, 'chair'),
      context: { mode: 'none' },
      meta: { purpose: 'board_cast' },
    });
    if (!ok) await this.ctx.store.append([this.configEvent(t, { suggestState: 'failed' })]);
  }

  async start(userId: string, threadId: string, req: StartBoardRequest): Promise<BoardStateDto> {
    this.assertCast(req.cast);
    const t0 = await loadSession(this.ctx.pool, userId, threadId);
    assertBoard(t0);
    await assertSessionManager(this.ctx.pool, userId, t0);
    if (parseBoardConfig(t0.session_config).stage !== 'setup')
      throw conflict('already_started', 'This boardroom has already started.');
    for (const p of this.participantsFor(req)) await addParticipant(this.ctx, userId, threadId, p);
    const t = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row;
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'SessionThreadUpdated',
          payload: {
            threadId,
            title: req.title ?? `Boardroom: ${clip(req.topic.split('\n')[0] ?? req.topic, 80)}`,
            config: {
              topic: req.topic,
              brief: req.brief,
              format: req.format,
              roundCap: req.roundCap,
              models: req.models,
              castModels: this.castModels(req),
              suggestState: null,
              ...(req.budgetUsd ? { budgetUsd: req.budgetUsd } : {}),
              ...(req.roomId ? { roomId: req.roomId } : {}),
            },
          },
        },
        actor: userActor(userId),
        scope: sessionScope(t),
      },
    ]);
    await this.serialized(threadId, () => this.begin(threadId));
    return this.state(userId, threadId);
  }

  /** Posts the topic as the owner's first message and plans round 1: every seat answers on its own. */
  private async begin(threadId: string): Promise<void> {
    const t = await this.fresh(threadId);
    if (!t) return;
    const cfg = parseBoardConfig(t.session_config);
    if (cfg.stage !== 'setup') return;
    const cast = await castOf(this.ctx.pool, threadId);
    if (!cast.length) return;
    const msg = await postSessionMessage(this.ctx, t.created_by, threadId, {
      body: cfg.brief.trim() ? `${cfg.topic}\n\n${cfg.brief.trim()}` : cfg.topic,
      kind: 'chat',
      data: { board: true, brief: true },
    });
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'BoardRoundPlanned',
          payload: {
            threadId,
            round: 1,
            kind: 'independent',
            speakers: cast.map((c) => ({ participantId: c.id, name: c.display_name })),
            reason: 'Everyone answers on their own first; the answers are revealed together.',
            instruction: '',
            source: 'independent',
          },
        },
        actor: SYSTEM_ACTOR,
        scope: sessionScope(t),
      },
      this.configEvent(t, {
        stage: 'round',
        round: 1,
        revealedRound: 0,
        briefMessageId: msg.id,
        plan: {
          round: 1,
          kind: 'independent',
          speakers: cast.map((c) => c.id),
          reason: 'Everyone answers on their own first; the answers are revealed together.',
          instruction: '',
          source: 'independent',
        },
      }),
      this.systemMessage(t, `Round 1: every seat answers on its own. The answers are revealed together.`, {
        round: 1,
      }),
    ]);
    await this.advanceLocked(threadId);
  }

  // ----------------------------------------------------------------------------------------------- queueing turns

  private async activeTurn(threadId: string): Promise<Row | undefined> {
    return one(
      this.ctx.pool,
      `SELECT * FROM session_turns WHERE thread_id=$1 AND status IN ('queued','running')
          AND meta->>'purpose' IN ('board_speaker','board_chair','board_cast','board_minutes')
        ORDER BY queued_at LIMIT 1`,
      [threadId],
    );
  }

  /** The model of a role: the owner's choice, else the cheap default of the workstation's runtime. */
  private async modelFor(t: Row, cfg: BoardConfig, role: ModelRole): Promise<ModelChoice> {
    if (cfg.models[role]) return cfg.models[role] as ModelChoice;
    const reports = await runtimeReports(this.ctx.pool, t.workstation_id ?? null);
    return defaultModelFor(
      role,
      reports.filter((r) => r.available !== false).map((r) => r.id),
      providersOf(reports),
    );
  }

  /** The model of a speaker: its own seat choice, else the room's persona model; an agent keeps its own unless chosen. */
  private async speakerModel(t: Row, cfg: BoardConfig, p: Row): Promise<ModelChoice | undefined> {
    const seat = cfg.castModels[castKey(p.kind, p.ref_id)];
    if (seat) return seat;
    if (p.kind === 'agent') return undefined;
    return this.modelFor(t, cfg, 'persona');
  }

  private async tryQueue(
    t: Row,
    cfg: BoardConfig,
    o: {
      participantId: string;
      message: string;
      model: ModelChoice | undefined;
      context: { mode: 'all' | 'selected' | 'none'; messageIds?: string[]; limit?: number };
      round?: number;
      meta: Record<string, unknown>;
    },
  ): Promise<SessionTurnDto | null> {
    try {
      const turn = await this.ctx.services.sessions.queue(
        t.created_by,
        t.id,
        {
          participantId: o.participantId,
          message: o.message,
          context: o.context,
          ...(o.model ? { model: o.model } : {}),
          ...(o.round !== undefined ? { round: o.round } : {}),
        },
        { meta: o.meta },
      );
      if (cfg.blocked || cfg.budgetStopped)
        await this.ctx.store.append([this.configEvent(t, { blocked: null, budgetStopped: null })]);
      return turn;
    } catch (err) {
      if (err instanceof HttpError && BLOCKING_CODES.has(err.code)) {
        if (cfg.blocked !== err.code) {
          await this.ctx.store.append([
            this.configEvent(t, {
              blocked: err.code,
              ...(err.code === 'session_budget_exceeded' ? { budgetStopped: true } : {}),
            }),
            this.systemMessage(t, err.message, { blocked: err.code }),
          ]);
        }
        return null;
      }
      throw err;
    }
  }

  // ----------------------------------------------------------------------------------------------- the step function

  advance(threadId: string): Promise<void> {
    return this.serialized(threadId, () => this.advanceLocked(threadId));
  }

  private async advanceLocked(threadId: string): Promise<void> {
    const t = await this.fresh(threadId);
    if (!t) return;
    const cfg = parseBoardConfig(t.session_config);
    if (cfg.stage === 'setup' || cfg.stage === 'ended' || cfg.stage === 'decision' || cfg.paused) return;
    if (await this.activeTurn(threadId)) return;
    if (cfg.stage === 'round') return this.runRound(t, cfg);
    if (cfg.stage === 'chair') return this.runChair(t, cfg);
    if (cfg.stage === 'minutes') return this.runMinutes(t, cfg);
  }

  private async spokenCounts(threadId: string): Promise<Map<string, number>> {
    const r = await rows(
      this.ctx.pool,
      `SELECT participant_id, count(*)::int AS n FROM session_turns
        WHERE thread_id=$1 AND meta->>'purpose'='board_speaker' AND status='done' GROUP BY participant_id`,
      [threadId],
    );
    return new Map(r.map((x) => [x.participant_id as string, x.n as number]));
  }

  private async lastSpeakerId(threadId: string): Promise<string | null> {
    const r = await one(
      this.ctx.pool,
      `SELECT participant_id FROM session_turns
        WHERE thread_id=$1 AND meta->>'purpose'='board_speaker' AND status='done'
        ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`,
      [threadId],
    );
    return r?.participant_id ?? null;
  }

  private async decisionsTaken(
    threadId: string,
  ): Promise<Array<{ question: string; answer: string | null }>> {
    return (await listDecisions(this.ctx.pool, threadId))
      .filter((d) => d.status === 'resolved')
      .map((d) => ({ question: d.question, answer: d.answer }));
  }

  private async promptNotes(threadId: string): Promise<PromptBoardNote[]> {
    return (await listBoardNotes(this.ctx.pool, threadId)).map((n) => ({
      id: n.id,
      column: n.col,
      text: n.text,
      byName: n.by_name,
      votes: (n.votes as string[]).length,
    }));
  }

  private async runRound(t: Row, cfg: BoardConfig): Promise<void> {
    const plan = cfg.plan;
    if (!plan) {
      await this.ctx.store.append([this.configEvent(t, { stage: 'chair' })]);
      return this.advanceLocked(t.id);
    }
    const cast = await castOf(this.ctx.pool, t.id);
    const have = await rows(
      this.ctx.pool,
      `SELECT participant_id FROM session_turns WHERE thread_id=$1 AND round=$2 AND meta->>'purpose'='board_speaker'`,
      [t.id, plan.round],
    );
    // A seat that left the room (removed, or its agent or persona is gone) is not waited for.
    const missing = plan.speakers.filter(
      (id) => cast.some((c) => c.id === id) && !have.some((h) => h.participant_id === id),
    );
    if (!missing.length) return this.completeRound(t, cfg, plan);
    // The independent round goes out all at once; later rounds one speaker at a time, so each hears the one before.
    const todo = plan.kind === 'independent' ? missing : missing.slice(0, 1);
    let dropped = false;
    for (const id of todo) {
      const p = cast.find((c) => c.id === id) as Row;
      const ok = await this.queueSpeaker(t, cfg, plan, p, cast);
      if (ok === 'blocked') return;
      if (ok === 'gone') dropped = true;
    }
    if (dropped) return this.advanceLocked(t.id);
  }

  private async queueSpeaker(
    t: Row,
    cfg: BoardConfig,
    plan: BoardPlan,
    p: Row,
    cast: Row[],
  ): Promise<'queued' | 'blocked' | 'gone'> {
    let stance: string | null = p.stance ?? null;
    if (!stance && p.kind === 'persona' && !isAdHocPersona(p.ref_id))
      stance = (await resolvePersona(this.ctx.pool, t.org_id, p.ref_id))?.stance ?? null;
    const built = buildSpeakerTurn({
      topic: cfg.topic,
      brief: cfg.brief,
      format: cfg.format,
      round: plan.round,
      roundCap: cfg.roundCap,
      kind: plan.kind,
      instruction: plan.instruction,
      reason: plan.source === 'independent' ? '' : plan.reason,
      speaker: {
        name: p.display_name,
        slug: participantSlug(p.display_name),
        seat: p.seat,
        stance,
        index: Math.max(
          0,
          cast.findIndex((c) => c.id === p.id),
        ),
      },
      total: cast.length,
      decisions: await this.decisionsTaken(t.id),
    });
    const independent = plan.kind === 'independent';
    try {
      const turn = await this.tryQueue(t, cfg, {
        participantId: p.id,
        message: built.message,
        model: await this.speakerModel(t, cfg, p),
        context:
          independent && cfg.briefMessageId
            ? { mode: 'selected', messageIds: [cfg.briefMessageId] }
            : { mode: 'all', limit: MAX_SPOKEN_CONTEXT },
        round: plan.round,
        meta: {
          purpose: 'board_speaker',
          round: plan.round,
          kind: plan.kind,
          maxChars: BOARD_TURN_MAX_CHARS,
        },
      });
      return turn ? 'queued' : 'blocked';
    } catch (err) {
      // The agent was retired or the persona left the registry: the seat is dropped and the round goes on without it.
      if (
        err instanceof HttpError &&
        (err.code === 'agent_unavailable' || err.code === 'persona_unavailable')
      ) {
        await this.ctx.store.append([
          {
            streamId: streamId.thread(t.id),
            event: { type: 'ThreadParticipantRemoved', payload: { threadId: t.id, participantId: p.id } },
            actor: SYSTEM_ACTOR,
            scope: sessionScope(t),
          },
          this.systemMessage(t, `${p.display_name} is no longer available and left the room.`, {
            gone: p.id,
          }),
        ]);
        return 'gone';
      }
      throw err;
    }
  }

  /** Every planned speaker's turn ended: reveal round 1, then end at the cap or hand over to the Chair. */
  private async completeRound(t: Row, cfg: BoardConfig, plan: BoardPlan): Promise<void> {
    const events: AppendInput[] = [];
    const patch: Record<string, unknown> = { revealedRound: Math.max(cfg.revealedRound, plan.round) };
    if (plan.round === 1)
      events.push(
        this.systemMessage(t, 'All the first answers are in. Here they are, revealed together.', {
          revealed: 1,
        }),
      );
    if (plan.round >= cfg.roundCap) {
      await this.ctx.store.append([this.configEvent(t, patch), ...events]);
      return this.beginMinutes(t, 'round_cap');
    }
    patch.stage = 'chair';
    await this.ctx.store.append([this.configEvent(t, patch), ...events]);
    return this.advanceLocked(t.id);
  }

  private async runChair(t: Row, cfg: BoardConfig): Promise<void> {
    const chair = await chairOf(this.ctx.pool, t.id);
    if (!chair) return;
    const cast = await castOf(this.ctx.pool, t.id);
    const counts = await this.spokenCounts(t.id);
    const people = cast.map((c) => ({
      id: c.id,
      name: c.display_name as string,
      slug: participantSlug(c.display_name),
      seat: c.seat as string,
      stance: (c.stance ?? null) as string | null,
      spoken: counts.get(c.id) ?? 0,
    }));
    const lastId = await this.lastSpeakerId(t.id);
    const built = buildChairTurn({
      topic: cfg.topic,
      brief: cfg.brief,
      format: cfg.format,
      round: cfg.round,
      roundCap: cfg.roundCap,
      people,
      lastSpeaker: people.find((p) => p.id === lastId) ?? null,
      mentions: people.filter((p) => cfg.mentions.includes(p.id)),
      dissentNext: cfg.dissentNext,
      dissentNote: cfg.dissentNote,
      notes: await this.promptNotes(t.id),
      disagreements: (await listDisagreements(this.ctx.pool, t.id)).map((d) => ({
        topic: d.topic,
        positions: d.positions,
      })),
      decisions: await this.decisionsTaken(t.id),
      retry: cfg.chairFailures > 0,
    });
    await this.tryQueue(t, cfg, {
      participantId: chair.id,
      message: built.message,
      model: await this.modelFor(t, cfg, 'chair'),
      context: { mode: 'all', limit: 30 },
      round: cfg.round,
      meta: { purpose: 'board_chair', round: cfg.round },
    });
  }

  /**
   * Plans the next round from the Chair's pick (or none): the server applies the rules (mentions first, no repeated speaker,
   * at most three) and records the plan. Used by `aom board next` and by the fallback when the Chair gave no usable pick.
   */
  async planDiscussion(
    t: Row,
    cfg: BoardConfig,
    o: {
      picked: string[];
      reason: string;
      instruction: string;
      source: 'chair' | 'fallback';
      turnId?: string;
    },
  ): Promise<{ round: number; kind: 'discussion' | 'dissent'; speakers: string[]; notes: string[] }> {
    const round = cfg.round + 1;
    if (round > cfg.roundCap) throw conflict('round_cap', 'The round cap is reached.');
    const cast = await castOf(this.ctx.pool, t.id);
    const counts = await this.spokenCounts(t.id);
    const pick = chooseSpeakers({
      candidates: cast.map((c) => ({ id: c.id, spoken: counts.get(c.id) ?? 0 })),
      picked: o.picked,
      mentions: cfg.mentions,
      lastSpeakerId: await this.lastSpeakerId(t.id),
    });
    const kind = cfg.dissentNext ? ('dissent' as const) : ('discussion' as const);
    const reason = o.reason || pick.notes.join(' ');
    await this.ctx.store.append([
      {
        streamId: streamId.thread(t.id),
        event: {
          type: 'BoardRoundPlanned',
          payload: {
            threadId: t.id,
            round,
            kind,
            speakers: pick.speakers.map((id) => ({
              participantId: id,
              name: (cast.find((c) => c.id === id)?.display_name as string) ?? 'Speaker',
            })),
            reason,
            instruction: o.instruction,
            source: o.source,
            ...(o.turnId ? { turnId: o.turnId } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: sessionScope(t),
      },
      this.configEvent(t, {
        stage: 'round',
        round,
        plan: { round, kind, speakers: pick.speakers, reason, instruction: o.instruction, source: o.source },
        mentions: null,
        dissentNext: null,
        dissentNote: null,
        chairFailures: 0,
      }),
    ]);
    return { round, kind, speakers: pick.speakers, notes: pick.notes };
  }

  /**
   * The session moves to 'minutes' first (under the caller's lock), and only then are the turns that have not started
   * cancelled, so a cancellation's follow-up never sees the old stage. An open decision is withdrawn.
   */
  private async beginMinutes(
    t: Row,
    reason: 'owner' | 'round_cap',
    cancelFor?: { userId: string },
  ): Promise<void> {
    const open = await rows(
      this.ctx.pool,
      `SELECT id FROM board_decisions WHERE thread_id=$1 AND status='open'`,
      [t.id],
    );
    await this.ctx.store.append([
      ...open.map(
        (d): AppendInput => ({
          streamId: streamId.thread(t.id),
          event: {
            type: 'BoardDecisionResolved',
            payload: { threadId: t.id, decisionId: d.id, answer: '', withdrawn: true, by: null },
          },
          actor: SYSTEM_ACTOR,
          scope: sessionScope(t),
        }),
      ),
      this.configEvent(t, { stage: 'minutes', endReason: reason, minutesTurnId: null }),
      this.systemMessage(
        t,
        reason === 'owner'
          ? 'The owner ended the session. The Chair is writing the minutes.'
          : 'The round cap is reached. The Chair is writing the minutes.',
        { ended: reason },
      ),
    ]);
    if (cancelFor) {
      // Turns that have not started are cancelled; the ones running finish and stay in the minutes.
      const queued = await rows(
        this.ctx.pool,
        `SELECT id FROM session_turns WHERE thread_id=$1 AND status='queued' AND meta->>'purpose' IN ('board_speaker','board_chair')`,
        [t.id],
      );
      for (const q of queued)
        await this.ctx.services.sessions.cancel(cancelFor.userId, t.id, q.id).catch(() => undefined);
    }
    return this.advanceLocked(t.id);
  }

  private async synthesisTurn(
    t: Row,
    cfg: BoardConfig,
    meta: Record<string, unknown>,
  ): Promise<SessionTurnDto | null> {
    const chair = await chairOf(this.ctx.pool, t.id);
    if (!chair) return null;
    const cast = await castOf(this.ctx.pool, t.id);
    const counts = await this.spokenCounts(t.id);
    const built = buildMinutesTurn({
      topic: cfg.topic,
      format: cfg.format,
      rounds: cfg.round,
      people: cast.map((c) => ({
        id: c.id,
        name: c.display_name,
        slug: participantSlug(c.display_name),
        seat: c.seat,
        stance: c.stance ?? null,
        spoken: counts.get(c.id) ?? 0,
      })),
      notes: await this.promptNotes(t.id),
      disagreements: (await listDisagreements(this.ctx.pool, t.id)).map((d) => ({
        topic: d.topic,
        positions: d.positions,
      })),
      decisions: await this.decisionsTaken(t.id),
      endReason:
        cfg.endReason === 'owner'
          ? 'ended by the owner'
          : cfg.endReason === 'round_cap'
            ? 'round cap reached'
            : 'on demand',
    });
    return this.tryQueue(t, cfg, {
      participantId: chair.id,
      message: built.message,
      model: await this.modelFor(t, cfg, 'synthesis'),
      context: { mode: 'all', limit: 80 },
      meta: { purpose: 'board_minutes', ...meta },
    });
  }

  private async runMinutes(t: Row, cfg: BoardConfig): Promise<void> {
    if (!cfg.minutesTurnId) {
      const turn = await this.synthesisTurn(t, cfg, {});
      if (turn) {
        await this.ctx.store.append([this.configEvent(t, { minutesTurnId: turn.id })]);
        return;
      }
      // Only a used-up session budget ends the session without the synthesis; any other block (paused project, no
      // workstation, runtime unavailable) leaves the session in 'minutes' with `blocked` set, and the sweep retries.
      const cur = parseBoardConfig(((await this.fresh(t.id)) ?? t).session_config);
      if (cur.blocked && cur.blocked !== 'session_budget_exceeded') return;
      await this.ctx.store.append([
        this.systemMessage(
          t,
          "The session budget is used up, so the minutes are written from the session data without the Chair's synthesis.",
          { minutesWithoutSynthesis: true },
        ),
      ]);
      await this.saveMinutes(t, '', { kind: 'system', id: null }, SYSTEM_ACTOR, null);
      await this.finishEnd(t);
      return;
    }
    const turn = await one(this.ctx.pool, 'SELECT * FROM session_turns WHERE id=$1', [cfg.minutesTurnId]);
    if (turn && (turn.status === 'done' || turn.status === 'failed'))
      await this.afterMinutes(t, turn, turn.status);
  }

  private async finishEnd(t: Row): Promise<void> {
    const f = (await this.fresh(t.id)) ?? t;
    if (parseBoardConfig(f.session_config).stage === 'ended') return;
    await this.ctx.store.append([
      this.configEvent(f, { stage: 'ended', plan: null, minutesRequested: null }),
      this.systemMessage(f, 'The session is over. The minutes are ready.', { minutes: true }),
    ]);
  }

  // ----------------------------------------------------------------------------------------------- minutes

  /** Creates or versions the session's minutes document: exact sections from the data, the rest from the synthesis. */
  async saveMinutes(
    t: Row,
    synthesis: string,
    savedBy: { kind: 'user' | 'agent' | 'persona' | 'system'; id: string | null },
    actor: AppendInput['actor'],
    turnId: string | null,
  ): Promise<{ docId: string; version: number }> {
    const cfg = parseBoardConfig((await this.fresh(t.id))?.session_config ?? t.session_config);
    const cast = await castOf(this.ctx.pool, t.id);
    const [notes, disagreements, decisions, cost] = await Promise.all([
      this.promptNotes(t.id),
      listDisagreements(this.ctx.pool, t.id),
      this.decisionsTaken(t.id),
      sessionCost(this.ctx.pool, t),
    ]);
    const content = assembleMinutes({
      topic: cfg.topic,
      format: cfg.format,
      brief: cfg.brief,
      startedAt: iso(t.created_at) as string,
      rounds: cfg.round,
      endReason:
        cfg.endReason === 'owner'
          ? 'by the owner'
          : cfg.endReason === 'round_cap'
            ? 'at the round cap'
            : 'minutes taken on demand',
      people: cast.map((c) => ({ name: c.display_name, seat: c.seat, kind: c.kind })),
      synthesis,
      disagreements: disagreements.map((d) => ({ topic: d.topic, positions: d.positions })),
      decisions,
      notes,
      costUsd: cost.costUsd,
    });
    const note = turnId ? `Chair synthesis (turn ${turnId})` : 'Minutes';
    const scope = this.docScope(t);
    const existing = cfg.minutesDocId
      ? await one(this.ctx.pool, 'SELECT * FROM documents WHERE id=$1 AND org_id=$2', [
          cfg.minutesDocId,
          t.org_id,
        ])
      : undefined;
    if (existing && (existing.status === 'draft' || existing.status === 'in_review')) {
      const cur = await one(
        this.ctx.pool,
        'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2',
        [existing.id, existing.current_version],
      );
      if (cur?.content === content) return { docId: existing.id, version: existing.current_version };
      await this.ctx.store.append([
        versionEvent(existing.id, existing.current_version + 1, content, savedBy, scope, actor, {
          note,
          sourceThreadIds: [t.id],
        }),
      ]);
      return { docId: existing.id, version: existing.current_version + 1 };
    }
    const docId = await this.createDoc(
      t,
      'minutes',
      `Minutes: ${clip(cfg.topic.split('\n')[0] ?? cfg.topic, 120)}`,
      content,
      note,
      savedBy,
      actor,
    );
    await this.ctx.store.append([this.configEvent(t, { minutesDocId: docId })]);
    return { docId, version: 1 };
  }

  private docScope(t: Row) {
    return scopeOfDoc({ org_id: t.org_id, project_id: t.project_id ?? null });
  }

  /** A new document linked to the session (slug unique per organization/project). */
  private async createDoc(
    t: Row,
    kind: 'minutes' | 'prd' | 'brief',
    title: string,
    content: string,
    note: string,
    savedBy: { kind: 'user' | 'agent' | 'persona' | 'system'; id: string | null },
    actor: AppendInput['actor'],
    docId: string = randomUUID(),
  ): Promise<string> {
    const base = documentSlug(title);
    let slug = base;
    for (
      let n = 2;
      await one(
        this.ctx.pool,
        'SELECT 1 FROM documents WHERE org_id=$1 AND project_id IS NOT DISTINCT FROM $2 AND slug=$3',
        [t.org_id, t.project_id ?? null, slug],
      );
      n++
    )
      slug = `${base.slice(0, 56)}-${n}`;
    const scope = this.docScope(t);
    await this.ctx.store.append([
      {
        streamId: streamId.document(docId),
        event: {
          type: 'DocumentCreated',
          payload: {
            docId,
            orgId: t.org_id,
            ...(t.project_id ? { projectId: t.project_id } : {}),
            kind,
            title,
            slug,
            createdBy: t.created_by,
            sourceThreadIds: [t.id],
          },
        },
        actor,
        scope,
      },
      versionEvent(docId, 1, content, savedBy, scope, actor, { note }),
    ]);
    return docId;
  }

  /** A synthesis turn ended: save what it wrote (or its reply text), and close the session if it was waiting for the minutes. */
  private async afterMinutes(t: Row, turn: Row, status: 'done' | 'failed'): Promise<void> {
    const f = (await this.fresh(t.id)) ?? t;
    const cfg = parseBoardConfig(f.session_config);
    const saved = cfg.minutesDocId
      ? await one(this.ctx.pool, `SELECT 1 FROM document_versions WHERE document_id=$1 AND note LIKE $2`, [
          cfg.minutesDocId,
          `%${turn.id}%`,
        ])
      : undefined;
    if (!saved) {
      let synthesis = '';
      if (status === 'done' && turn.message_id) {
        const m = await one(this.ctx.pool, 'SELECT body FROM thread_messages WHERE id=$1', [turn.message_id]);
        const body = String(m?.body ?? '');
        if (/^##\s+/m.test(body)) synthesis = body;
      }
      await this.saveMinutes(
        f,
        synthesis,
        { kind: 'persona', id: 'chair' },
        SYSTEM_ACTOR,
        status === 'done' ? turn.id : null,
      );
    }
    if (cfg.stage === 'minutes' && cfg.minutesTurnId === turn.id) await this.finishEnd(f);
  }

  /** On demand: the Chair writes minutes now and the session carries on. */
  async requestMinutes(userId: string, threadId: string): Promise<BoardStateDto> {
    await this.loadManaged(userId, threadId);
    await this.serialized(threadId, async () => {
      const t = await this.fresh(threadId);
      if (!t) throw notFound('session not found');
      const cfg = parseBoardConfig(t.session_config);
      if (cfg.stage === 'setup') throw conflict('not_started', 'The boardroom has not started yet.');
      if (cfg.stage === 'decision')
        throw conflict('decision_open', 'Answer the open decision first: the minutes would miss it.');
      if (cfg.stage === 'minutes')
        throw conflict('minutes_running', 'The session is already writing its minutes.');
      if (cfg.paused) throw conflict('paused', 'Resume the session first.');
      if (cfg.round < 1) throw conflict('nothing_to_minute', 'Nothing has been said yet.');
      const busy = await one(
        this.ctx.pool,
        `SELECT 1 FROM session_turns WHERE thread_id=$1 AND status IN ('queued','running') AND meta->>'purpose'='board_minutes'`,
        [threadId],
      );
      if (busy) throw conflict('minutes_running', 'The minutes are already being written.');
      const turn = await this.synthesisTurn(t, cfg, { onDemand: true });
      if (!turn) throw conflict('blocked', 'The minutes cannot be written right now: check the budget.');
    });
    return this.state(userId, threadId);
  }

  // ----------------------------------------------------------------------------------------------- when a turn ends

  onTurnEnded(threadId: string, turnId: string, status: 'done' | 'failed'): Promise<void> {
    return this.serialized(threadId, async () => {
      const turn = await one(this.ctx.pool, 'SELECT * FROM session_turns WHERE id=$1', [turnId]);
      const purpose = (turn?.meta as { purpose?: string } | null)?.purpose;
      if (!turn || !purpose?.startsWith('board_')) return;
      const t = await this.fresh(threadId);
      if (!t) return;
      const cancelled = status === 'failed' && /^cancel/i.test(String(turn.error ?? ''));
      if (purpose === 'board_speaker') {
        if (status === 'failed' && !cancelled)
          await this.ctx.store.append([
            this.systemMessage(
              t,
              `${turn.speaker_name} could not answer this round (${clip(String(turn.error ?? 'error'), 160)}).`,
              {
                failedTurn: turnId,
              },
            ),
          ]);
        return this.advanceLocked(threadId);
      }
      if (purpose === 'board_chair')
        return cancelled ? this.advanceLocked(threadId) : this.afterChair(t, status);
      if (purpose === 'board_cast') {
        const cfg = parseBoardConfig(t.session_config);
        await this.ctx.store.append([
          this.configEvent(t, {
            suggestState: status === 'done' && cfg.suggestions.length ? 'done' : 'failed',
          }),
        ]);
        return;
      }
      if (purpose === 'board_minutes') {
        await this.afterMinutes(t, turn, status);
        return this.advanceLocked(threadId);
      }
    });
  }

  private async afterChair(t: Row, status: 'done' | 'failed'): Promise<void> {
    const cfg = parseBoardConfig(t.session_config);
    if (cfg.stage !== 'chair') {
      // The Chair planned a round or paused for a decision.
      if (cfg.chairFailures) await this.ctx.store.append([this.configEvent(t, { chairFailures: null })]);
      return this.advanceLocked(t.id);
    }
    const failures = cfg.chairFailures + 1;
    if (failures < 2) {
      await this.ctx.store.append([this.configEvent(t, { chairFailures: failures })]);
      return this.advanceLocked(t.id);
    }
    // The Chair twice gave no usable pick: the server picks, by the same rules.
    const fresh = (await this.fresh(t.id)) as Row;
    await this.planDiscussion(fresh, cfg, {
      picked: [],
      reason: status === 'failed' ? 'The Chair was unavailable: the least heard voices speak.' : '',
      instruction: '',
      source: 'fallback',
    });
    await this.ctx.store.append([
      this.systemMessage(
        fresh,
        'The Chair did not choose speakers, so the server picked the least heard voices.',
        {
          fallback: true,
        },
      ),
    ]);
    return this.advanceLocked(t.id);
  }

  /** On startup and on the scheduler's pass: a session that was waiting (restart, budget raised elsewhere) goes on. */
  async sweep(): Promise<void> {
    const list = await rows(
      this.ctx.pool,
      `SELECT id FROM threads WHERE kind='boardroom' AND deleted_at IS NULL
          AND session_config->>'stage' IN ('round','chair','minutes')
          AND session_config->>'paused' IS DISTINCT FROM 'true'`,
    );
    for (const { id } of list)
      await this.advance(id).catch((err) =>
        this.ctx.log.error({ err, threadId: id }, 'boardroom sweep failed'),
      );
  }

  // ----------------------------------------------------------------------------------------------- the owner's actions

  private async userName(userId: string): Promise<string> {
    const u = await one(this.ctx.pool, 'SELECT display_name FROM users WHERE id=$1', [userId]);
    return u?.display_name ?? 'Owner';
  }

  /** The owner writes in the room. Anyone they @mention speaks in the next round. */
  async say(
    userId: string,
    threadId: string,
    body: string,
  ): Promise<{ message: ThreadMessageDto; mentioned: string[]; state: BoardStateDto }> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertBoard(t);
    const cfg = parseBoardConfig(t.session_config);
    if (cfg.stage === 'setup') throw conflict('not_started', 'The boardroom has not started yet.');
    if (cfg.stage === 'ended') throw conflict('session_ended', 'The session is over.');
    const cast = await castOf(this.ctx.pool, threadId);
    const mentioned = parseMentions(
      body,
      cast.map((c) => ({
        id: c.id,
        handles: handlesOf({ displayName: c.display_name, refId: c.ref_id, seat: c.seat, kind: c.kind }),
      })),
      cast.map((c) => c.id),
    );
    const message = await postSessionMessage(this.ctx, userId, threadId, {
      body,
      kind: 'chat',
      data: { board: true, ...(mentioned.length ? { mentions: mentioned } : {}) },
    });
    if (mentioned.length)
      await this.serialized(threadId, async () => {
        const f = (await this.fresh(threadId)) as Row;
        const cur = parseBoardConfig(f.session_config).mentions;
        await this.ctx.store.append([
          this.configEvent(f, { mentions: [...new Set([...cur, ...mentioned])] }, userActor(userId)),
        ]);
      });
    await this.advance(threadId);
    return { message, mentioned, state: await this.state(userId, threadId) };
  }

  async pause(userId: string, threadId: string): Promise<BoardStateDto> {
    const t = await this.loadManaged(userId, threadId);
    await this.ctx.store.append([this.configEvent(t, { paused: true }, userActor(userId))]);
    return this.state(userId, threadId);
  }

  async resume(userId: string, threadId: string): Promise<BoardStateDto> {
    const t = await this.loadManaged(userId, threadId);
    await this.ctx.store.append([this.configEvent(t, { paused: null }, userActor(userId))]);
    await this.advance(threadId);
    return this.state(userId, threadId);
  }

  /** "Carry on": a nudge after a failure, a restart or a raised budget. */
  async continue(userId: string, threadId: string): Promise<BoardStateDto> {
    const t = await this.loadManaged(userId, threadId);
    await this.ctx.store.append([
      this.configEvent(t, { chairFailures: null, blocked: null }, userActor(userId)),
    ]);
    await this.advance(threadId);
    return this.state(userId, threadId);
  }

  async end(userId: string, threadId: string): Promise<BoardStateDto> {
    await this.loadManaged(userId, threadId);
    await this.serialized(threadId, async () => {
      const f = await this.fresh(threadId);
      if (!f) throw notFound('session not found');
      const cfg = parseBoardConfig(f.session_config);
      if (cfg.stage === 'setup') throw conflict('not_started', 'The boardroom has not started yet.');
      if (cfg.stage === 'ended' || cfg.stage === 'minutes') return;
      await this.beginMinutes(f, 'owner', { userId });
    });
    return this.state(userId, threadId);
  }

  async patch(userId: string, threadId: string, req: PatchBoardRequest): Promise<BoardStateDto> {
    let raised = false;
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertBoard(t);
      await assertSessionManager(tx, userId, t);
      const cfg = parseBoardConfig(t.session_config);
      const patch: Record<string, unknown> = {};
      if (req.budgetUsd !== undefined) {
        patch.budgetUsd = req.budgetUsd;
        patch.budgetStopped = null;
        patch.blocked = null;
        raised = true;
      }
      if (req.roundCap !== undefined) {
        if (req.roundCap < cfg.round)
          throw badRequest('round_cap_low', `The session is already in round ${cfg.round}.`);
        patch.roundCap = req.roundCap;
      }
      if (req.models) patch.models = { ...cfg.models, ...req.models };
      if (!Object.keys(patch).length) return;
      await this.ctx.store.append([this.configEvent(t, patch, userActor(userId))], { tx });
    });
    if (raised) await this.advance(threadId);
    return this.state(userId, threadId);
  }

  async resolveDecision(
    userId: string,
    threadId: string,
    decisionId: string,
    req: { answer: string; optionId?: string | undefined },
  ): Promise<BoardStateDto> {
    await this.loadManaged(userId, threadId);
    // Under the session's lock: a double click, or an answer arriving after the session ended, finds the stage changed.
    await this.serialized(threadId, async () => {
      const t = await this.fresh(threadId);
      if (!t) throw notFound('session not found');
      if (parseBoardConfig(t.session_config).stage !== 'decision')
        throw conflict('not_in_decision', 'The session is not waiting for a decision.');
      const d = await one(this.ctx.pool, 'SELECT * FROM board_decisions WHERE id=$1 AND thread_id=$2', [
        decisionId,
        threadId,
      ]);
      if (!d) throw notFound('decision not found');
      if (d.status !== 'open') throw conflict('decision_closed', 'That decision was already taken.');
      const label = req.optionId
        ? (d.options as Array<{ id: string; label: string }>).find((o) => o.id === req.optionId)?.label
        : undefined;
      if (req.optionId && !label) throw badRequest('unknown_option', 'Pick one of the options.');
      const answer = [label, req.answer.trim()].filter(Boolean).join(': ');
      if (!answer) throw badRequest('empty_answer', 'Say what you decide.');
      const name = await this.userName(userId);
      await this.ctx.store.append([
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'BoardDecisionResolved',
            payload: {
              threadId,
              decisionId,
              answer,
              ...(req.optionId ? { optionId: req.optionId } : {}),
              by: userId,
            },
          },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'BoardNoteAdded',
            payload: {
              threadId,
              noteId: randomUUID(),
              column: 'decisions',
              text: clip(`${d.question} -> ${answer}`, 600),
              by: { kind: 'user', id: userId, name },
              round: null,
            },
          },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
        this.configEvent(t, { stage: 'chair', chairFailures: null }, userActor(userId)),
      ]);
      await postSessionMessage(this.ctx, userId, threadId, {
        body: `Decision on "${clip(d.question, 200)}": ${answer}`,
        kind: 'chat',
        data: { board: true, decisionId },
      });
    });
    await this.advance(threadId);
    return this.state(userId, threadId);
  }

  // ----------------------------------------------------------------------------------------------- the whiteboard

  async addNote(userId: string, threadId: string, column: string, text: string): Promise<BoardStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertBoard(t);
    const name = await this.userName(userId);
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'BoardNoteAdded',
          payload: {
            threadId,
            noteId: randomUUID(),
            column: column as never,
            text,
            by: { kind: 'user', id: userId, name },
            round: null,
          },
        },
        actor: userActor(userId),
        scope: sessionScope(t),
      },
    ]);
    return this.state(userId, threadId);
  }

  private async note(threadId: string, noteId: string): Promise<Row> {
    const n = await one(
      this.ctx.pool,
      'SELECT * FROM board_notes WHERE id=$1 AND thread_id=$2 AND removed_at IS NULL',
      [noteId, threadId],
    );
    if (!n) throw notFound('note not found');
    return n;
  }

  async patchNote(
    userId: string,
    threadId: string,
    noteId: string,
    patch: { column?: string | undefined; text?: string | undefined },
  ): Promise<BoardStateDto> {
    const t = await this.loadManaged(userId, threadId);
    await this.note(threadId, noteId);
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'BoardNoteUpdated',
          payload: {
            threadId,
            noteId,
            ...(patch.text ? { text: patch.text } : {}),
            ...(patch.column ? { column: patch.column as never } : {}),
          },
        },
        actor: userActor(userId),
        scope: sessionScope(t),
      },
    ]);
    return this.state(userId, threadId);
  }

  async mergeNotes(
    userId: string,
    threadId: string,
    noteIds: string[],
    text?: string,
  ): Promise<BoardStateDto> {
    const t = await this.loadManaged(userId, threadId);
    const ids = [...new Set(noteIds)];
    if (ids.length < 2) throw badRequest('merge_needs_two', 'Pick at least two notes to merge.');
    const found = await rows(
      this.ctx.pool,
      'SELECT * FROM board_notes WHERE thread_id=$1 AND removed_at IS NULL AND id = ANY($2::uuid[])',
      [threadId, ids],
    );
    if (found.length !== ids.length) throw notFound('note not found');
    const [into, ...rest] = ids as [string, ...string[]];
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'BoardNoteMerged',
          payload: {
            threadId,
            intoNoteId: into,
            noteIds: rest,
            ...(text ? { text } : {}),
            mergedTexts: rest.map((id) => clip(found.find((f) => f.id === id)?.text ?? '', 600)),
          },
        },
        actor: userActor(userId),
        scope: sessionScope(t),
      },
    ]);
    return this.state(userId, threadId);
  }

  async removeNote(userId: string, threadId: string, noteId: string): Promise<BoardStateDto> {
    const t = await this.loadManaged(userId, threadId);
    await this.note(threadId, noteId);
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: { type: 'BoardNoteRemoved', payload: { threadId, noteId } },
        actor: userActor(userId),
        scope: sessionScope(t),
      },
    ]);
    return this.state(userId, threadId);
  }

  /** +1 from this person; voting again takes it back. */
  async voteNote(userId: string, threadId: string, noteId: string): Promise<BoardStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertBoard(t);
    const n = await this.note(threadId, noteId);
    const has = (n.votes as string[]).includes(userId);
    await this.ctx.store.append([
      {
        streamId: streamId.thread(threadId),
        event: { type: 'BoardNoteVoted', payload: { threadId, noteId, userId, voted: !has } },
        actor: userActor(userId),
        scope: sessionScope(t),
      },
    ]);
    return this.state(userId, threadId);
  }

  // ----------------------------------------------------------------------------------------------- Pull into PRD

  /**
   * "Pull into PRD": a Discovery session in the capture phase (with the CEO in joint mode when the organization has one),
   * its PRD draft seeded from the minutes, the decisions and the whiteboard. Both sessions link to each other.
   */
  async pullIntoPrd(
    who: Who,
    threadId: string,
  ): Promise<{ discoveryId: string; docId: string; state: BoardStateDto }> {
    const t0 = await loadSession(this.ctx.pool, who.userId, threadId);
    assertBoard(t0);
    if (t0.org_id !== who.orgId) throw notFound('session not found');
    if (!isOrgManager({ orgRole: who.role }))
      throw forbidden('only an Owner or an Admin can start a discovery session');
    const out = await this.serialized(threadId, async () => {
      const t = await this.fresh(threadId);
      if (!t) throw notFound('session not found');
      if (t.org_id !== who.orgId) throw notFound('session not found');
      const cfg = parseBoardConfig(t.session_config);
      if (cfg.stage !== 'ended')
        throw conflict('session_running', 'End the session first: the PRD is seeded from its final minutes.');
      if (!cfg.minutesDocId)
        throw conflict('no_minutes', 'Write the minutes first: the PRD is seeded from them.');
      if (cfg.prdSessionId) throw conflict('already_pulled', 'These minutes were already pulled into a PRD.');
      const notes = await listBoardNotes(this.ctx.pool, threadId);
      const decided = await this.decisionsTaken(threadId);
      const col = (c: string) => notes.filter((n) => n.col === c).map((n) => n.text as string);
      const prd = builtinCapabilities().find((c) => c.kind === 'playbook' && c.key === 'prd');
      const title = `PRD: ${clip(cfg.topic.split('\n')[0] ?? cfg.topic, 100)}`;
      const content = seedPrdFromMinutes({
        title: cfg.topic.split('\n')[0] ?? cfg.topic,
        topic: cfg.topic,
        minutesDocId: cfg.minutesDocId,
        decisions: [...new Set([...decided.map((d) => `${d.question} -> ${d.answer}`), ...col('decisions')])],
        ideas: col('ideas'),
        risks: col('risks'),
        questions: col('questions'),
        parked: col('parked'),
        template: prd?.kind === 'playbook' ? (prd.files['assets/prd-template.md'] ?? '') : '',
      });
      const actor = userActor(who.userId);
      // Reserve the document id first: a retry after a failure reuses the document and any session already made for it.
      const docId = cfg.prdPullDocId ?? randomUUID();
      if (!cfg.prdPullDocId)
        await this.ctx.store.append([this.configEvent(t, { prdPullDocId: docId }, actor)]);
      const existing = await one(this.ctx.pool, 'SELECT 1 FROM documents WHERE id=$1', [docId]);
      if (!existing)
        await this.createDoc(
          t,
          'prd',
          title,
          content,
          'Seeded from the boardroom minutes',
          { kind: 'user', id: who.userId },
          actor,
          docId,
        );
      const ceo = await availableCeo(this.ctx.pool, who.orgId);
      const seeded: Array<{
        section: 'ideas' | 'assumptions' | 'open_questions' | 'decisions' | 'parked';
        text: string;
      }> = [
        ...[...decided.map((d) => `${d.question} -> ${d.answer}`), ...col('decisions')].map((text) => ({
          section: 'decisions' as const,
          text,
        })),
        ...col('ideas').map((text) => ({ section: 'ideas' as const, text })),
        ...col('risks').map((text) => ({ section: 'assumptions' as const, text: `Risk: ${text}` })),
        ...col('questions').map((text) => ({ section: 'open_questions' as const, text })),
        ...col('parked').map((text) => ({ section: 'parked' as const, text })),
      ];
      const made = await one(
        this.ctx.pool,
        `SELECT id FROM threads WHERE kind='discovery' AND org_id=$1 AND deleted_at IS NULL
            AND session_config->>'prdDocId'=$2 ORDER BY created_at LIMIT 1`,
        [who.orgId, docId],
      );
      const discoveryId =
        (made?.id as string | undefined) ??
        (
          await this.ctx.services.discovery.create(
            who,
            {
              title: `Discovery: ${clip(cfg.topic.split('\n')[0] ?? cfg.topic, 100)}`,
              ...(t.project_id ? { projectId: t.project_id } : {}),
              stance: 'facilitator',
              ceoMode: ceo ? 'joint' : 'owner_only',
              playbook: 'prd',
              idea: clip(`From the boardroom "${cfg.topic}". Minutes: document ${cfg.minutesDocId}.`, 3900),
            },
            { prdDocId: docId, notes: seeded.slice(0, 60).map((n) => ({ ...n, text: clip(n.text, 1900) })) },
          )
        ).threadId;
      // The Discovery session must be among the document's source sessions, or its facilitator cannot propose edits to it.
      const doc = await one(
        this.ctx.pool,
        'SELECT current_version, source_thread_ids FROM documents WHERE id=$1',
        [docId],
      );
      const sources = (doc?.source_thread_ids as string[] | undefined) ?? [];
      if (doc && !sources.includes(discoveryId)) {
        const body = await one(
          this.ctx.pool,
          'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2',
          [docId, doc.current_version],
        );
        await this.ctx.store.append([
          versionEvent(
            docId,
            Number(doc.current_version) + 1,
            String(body?.content ?? content),
            { kind: 'system', id: null },
            this.docScope(t),
            actor,
            {
              note: 'Linked to the Discovery session',
              sourceThreadIds: [...sources, discoveryId].slice(0, 20),
            },
          ),
        ]);
      }
      await this.ctx.store.append([
        this.configEvent(t, { prdSessionId: discoveryId, prdPullDocId: null }, actor),
        this.systemMessage(t, 'The minutes were pulled into a PRD. Continue in the Discovery session.', {
          discoveryId,
          docId,
        }),
      ]);
      return { discoveryId, docId };
    });
    return { ...out, state: await this.state(who.userId, threadId) };
  }

  // ----------------------------------------------------------------------------------------------- rooms

  private assertManager(who: Who): void {
    if (!isOrgManager({ orgRole: who.role }))
      throw forbidden('only an Owner or an Admin can manage boardroom casts');
  }

  async listRooms(who: Who): Promise<BoardRoom[]> {
    this.assertManager(who);
    const list = await rows(
      this.ctx.pool,
      'SELECT * FROM board_rooms WHERE org_id=$1 AND deleted_at IS NULL ORDER BY created_at, id',
      [who.orgId],
    );
    return list.map((r) => ({
      id: r.id,
      name: r.name,
      format: r.format,
      roundCap: r.round_cap,
      cast: r.members,
      models: r.models ?? {},
      createdAt: iso(r.created_at) as string,
    }));
  }

  async saveRoom(who: Who, req: SaveBoardRoomRequest): Promise<BoardRoom> {
    this.assertManager(who);
    this.assertCast(req.cast);
    const roomId = randomUUID();
    await this.ctx.store.append([
      {
        streamId: streamId.boardRooms(who.orgId),
        event: {
          type: 'BoardRoomSaved',
          payload: {
            roomId,
            orgId: who.orgId,
            name: req.name,
            format: req.format,
            roundCap: req.roundCap,
            cast: req.cast,
            models: req.models,
            createdBy: who.userId,
          },
        },
        actor: userActor(who.userId),
        scope: orgScope(who.orgId),
      },
    ]);
    return (await this.listRooms(who)).find((r) => r.id === roomId) as BoardRoom;
  }

  async deleteRoom(who: Who, roomId: string): Promise<void> {
    this.assertManager(who);
    const r = await one(
      this.ctx.pool,
      'SELECT id FROM board_rooms WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL',
      [roomId, who.orgId],
    );
    if (!r) throw notFound('room not found');
    await this.ctx.store.append([
      {
        streamId: streamId.boardRooms(who.orgId),
        event: { type: 'BoardRoomDeleted', payload: { roomId, orgId: who.orgId } },
        actor: userActor(who.userId),
        scope: orgScope(who.orgId),
      },
    ]);
  }
}

export type { BoardCastDto };
