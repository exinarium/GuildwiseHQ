import { randomUUID } from 'node:crypto';
import {
  type AnswerQuestionRequest,
  applyDocSection,
  buildCeoAnswerTurn,
  buildFacilitatorTurn,
  buildHandoffNote,
  builtinCapabilities,
  type CreateDiscoveryRequest,
  DISCOVERY_PHASE_LABEL,
  DISCOVERY_PREP_TURN_CAP,
  type DiscoveryConfig,
  type DiscoveryPhase,
  type DiscoveryStateDto,
  discoveryElapsedMs,
  discoveryProgress,
  type FacilitatorTrigger,
  getBuiltinRole,
  HANDOFF_NOTE_MAX_CHARS,
  isBoardRpc,
  isSessionRpc,
  PANEL_SECTIONS,
  type PanelSection,
  type PatchDiscoveryRequest,
  type PromptDoc,
  type PromptNote,
  type PromptPlaybook,
  type PromptProposal,
  type PromptQuestion,
  parseDiscoveryConfig,
  type ResolveDiscoveryProposalRequest,
  streamId,
  type ThreadMessageDto,
} from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { resolvePersona } from '../capabilities/registry.ts';
import { SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import { scopeOfDoc, versionEvent } from '../commands/documents.ts';
import { startIntakeIn } from '../commands/intake.ts';
import {
  assertSessionManager,
  createSession,
  listParticipants,
  loadSession,
  postSessionMessage,
  sessionScope,
} from '../commands/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import type { AppendInput, StoredEvent } from '../eventstore/types.ts';
import { ledgerSearchRpc } from '../runner-gateway/ledger-rpc.ts';
import {
  availableCeo,
  CEO_SEAT,
  discoveryState,
  FACILITATOR_SEAT,
  listNotes,
  listProposals,
  listQuestions,
  sessionDocs,
} from './discovery-state.ts';
import { sessionVerb } from './discovery-verbs.ts';

/** Why a queue attempt was refused for a reason the owner can fix: the turn waits as a pending trigger. */
const BLOCKING_CODES = new Set([
  'session_budget_exceeded',
  'project_paused',
  'project_budget_paused',
  'no_workstation',
]);

/** A discovery session that starts from a PRD draft and panel notes it was handed (the Boardroom's "Pull into PRD"). */
export interface DiscoverySeed {
  prdDocId: string;
  notes: Array<{ section: PanelSection; text: string }>;
}

const assertDiscovery = (t: Row): void => {
  if (t.kind !== 'discovery') throw notFound('session not found');
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Discovery Studio orchestrator (docs/ARCHITECTURE.md section 38, phase B). The state lives in events and projections: the
 * thread's `session_config` (phase, pause, clock, CEO pre-draft progress, a pending trigger) and the question, note and
 * proposal tables. This class decides what happens next: it queues the facilitator's and the CEO's turns (durable session
 * turns), applies the owner's answers, and handles the facilitator's `aom session ...` verbs.
 */
export class DiscoveryService {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: Ctx) {}

  /** One thing at a time per session (the process is the only writer of facilitation state). */
  serialized<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    return this.serial(threadId, fn);
  }

  private serial<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      threadId,
      next.catch(() => undefined),
    );
    return next;
  }

  // ----------------------------------------------------------------------------------------------- fan-out to the browser

  /** Tells the people in a session that something changed (the page refetches its state). */
  registerHook(): () => void {
    return this.ctx.store.subscribe(async (e: StoredEvent) => {
      const threadIds = await this.threadsOf(e).catch(() => [] as string[]);
      for (const id of threadIds) await this.touch(id);
    });
  }

  private async threadsOf(e: StoredEvent): Promise<string[]> {
    const type = e.event.type;
    const p = e.event.payload as unknown as Record<string, unknown>;
    if (
      type.startsWith('Discovery') ||
      type === 'SessionThreadUpdated' ||
      type === 'SessionTurnQueued' ||
      type === 'SessionTurnStarted' ||
      type === 'SessionTurnRequeued' ||
      type === 'SessionTurnCompleted' ||
      type === 'SessionTurnFailed' ||
      type === 'ThreadMessagePosted'
    ) {
      const id = p.threadId as string | undefined;
      if (!id) return [];
      return (await one(this.ctx.pool, `SELECT 1 FROM threads WHERE id=$1 AND kind='discovery'`, [id]))
        ? [id]
        : [];
    }
    if (type === 'DocumentVersionSaved' || type === 'DocumentStatusChanged') {
      const d = await one(this.ctx.pool, 'SELECT source_thread_ids FROM documents WHERE id=$1', [p.docId]);
      return (d?.source_thread_ids as string[] | undefined) ?? [];
    }
    return [];
  }

  private async touch(threadId: string): Promise<void> {
    const users = await this.audience(threadId);
    for (const id of users) this.ctx.services.browser.sendToUser(id, { type: 'discovery.updated', threadId });
  }

  private async audience(threadId: string): Promise<string[]> {
    const t = await one(this.ctx.pool, 'SELECT created_by FROM threads WHERE id=$1', [threadId]);
    const p = await rows(
      this.ctx.pool,
      `SELECT ref_id FROM thread_participants WHERE thread_id=$1 AND kind='user' AND removed_at IS NULL`,
      [threadId],
    );
    return [
      ...new Set([...(t?.created_by ? [t.created_by as string] : []), ...p.map((r) => r.ref_id as string)]),
    ];
  }

  // ----------------------------------------------------------------------------------------------- the runner's rpc

  /** The running session turn a runner's rpc belongs to (the shift id of the IPC token is the turn id); undefined: not a session turn. */
  async turnOf(workstationId: string, turnId: string): Promise<Row | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(turnId)) return undefined;
    return one(this.ctx.pool, 'SELECT * FROM session_turns WHERE id=$1 AND workstation_id=$2', [
      turnId,
      workstationId,
    ]);
  }

  /** `aom ledger search` and `aom session ...` from a session turn; nothing else reaches the server from one. */
  async rpc(
    turn: Row,
    method: string,
    params: Record<string, unknown>,
  ): Promise<[boolean, unknown?, string?]> {
    if (turn.status !== 'running') return [false, undefined, 'this turn is over'];
    if (method === 'ledger.search')
      return [true, await ledgerSearchRpc(this.ctx, { org_id: turn.org_id } as Row, params)];
    if (isSessionRpc(method)) return sessionVerb(this, this.ctx, turn, method, params);
    if (isBoardRpc(method)) return this.ctx.services.board.rpc(turn, method, params);
    return [false, undefined, `${method} is not available in a session turn`];
  }

  // ----------------------------------------------------------------------------------------------- creating and reading

  async create(who: Who, req: CreateDiscoveryRequest, seed?: DiscoverySeed): Promise<DiscoveryStateDto> {
    const { ctx } = this;
    let ceo: Row | undefined;
    if (req.ceoMode !== 'owner_only') {
      ceo = await availableCeo(ctx.pool, who.orgId);
      if (!ceo)
        throw badRequest(
          'no_ceo',
          'This organization has no CEO that can take part: choose "Owner only", or appoint a CEO first.',
        );
    }
    const analyst = await one(
      ctx.pool,
      `SELECT a.id FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
        WHERE a.org_id=$1 AND a.role_key='analyst' AND a.status='active' AND ws.status='active'
        ORDER BY a.hired_at, a.id LIMIT 1`,
      [who.orgId],
    );
    const now = ctx.clock.now();
    const config: Record<string, unknown> = {
      discovery: true,
      stance: req.stance,
      phase: seed ? 'capture' : 'frame',
      ...(seed ? { prdDocId: seed.prdDocId } : {}),
      ceoMode: req.ceoMode,
      playbook: req.playbook,
      idea: req.idea,
      paused: false,
      elapsedMs: 0,
      activeSince: now.toISOString(),
      ...(req.timeBoxMinutes ? { timeBoxMinutes: req.timeBoxMinutes } : {}),
      ...(req.budgetUsd ? { budgetUsd: req.budgetUsd } : {}),
      ...(req.ceoMode === 'ceo_prep'
        ? { ceoPrep: { state: 'running', turns: 0, cap: DISCOVERY_PREP_TURN_CAP } }
        : {}),
    };
    const session = await createSession(ctx, who, {
      kind: 'discovery',
      title: req.title,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      ...(analyst ? { facilitatorAgentId: analyst.id } : {}),
      participants: [
        ...(analyst ? [] : [{ kind: 'persona' as const, refId: 'analyst', seat: FACILITATOR_SEAT }]),
        ...(ceo ? [{ kind: 'agent' as const, refId: ceo.id as string, seat: CEO_SEAT }] : []),
      ],
      ...(req.workstationId ? { workstationId: req.workstationId } : {}),
      config,
    });
    if (seed?.notes.length) {
      const t = (await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1', [session.threadId])) as Row;
      await ctx.store.append(
        seed.notes.map((n) =>
          this.noteEvent(t, n.section, n.text, { kind: 'system', id: null, name: 'Boardroom' }),
        ),
      );
    }
    await this.requestFacilitator(session.threadId, { kind: 'start' });
    return this.state(who.userId, session.threadId);
  }

  async state(userId: string, threadId: string): Promise<DiscoveryStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertDiscovery(t);
    return discoveryState(this.ctx, t);
  }

  // ----------------------------------------------------------------------------------------------- prompts and turns

  private async playbookFor(
    cfg: DiscoveryConfig,
    trigger: FacilitatorTrigger,
  ): Promise<{
    playbook: PromptPlaybook | null;
    draftKind: 'brief' | 'prd';
  }> {
    const draftKind = cfg.playbook === 'product-brief' ? 'brief' : 'prd';
    const key =
      cfg.phase === 'stress_test'
        ? 'advanced-elicitation'
        : cfg.phase === 'capture'
          ? draftKind === 'brief'
            ? 'product-brief'
            : 'prd'
          : cfg.playbook;
    const pb = builtinCapabilities().find((c) => c.kind === 'playbook' && c.key === key);
    if (!pb || pb.kind !== 'playbook') return { playbook: null, draftKind };
    const assets: PromptPlaybook['assets'] = [];
    const want = (path: string) => {
      const text = pb.files[path];
      if (text) assets.push({ path: `assets/${path.split('/').pop()}`, text: clip(text, 6000) });
    };
    if (key === 'brainstorm') want('assets/techniques.csv');
    if (key === 'advanced-elicitation') want('assets/methods.csv');
    if (key === 'prd' && (cfg.phase === 'capture' || trigger.kind === 'draft'))
      want('assets/prd-template.md');
    return {
      playbook: {
        key,
        body: pb.body,
        steps: pb.steps.map((path) => ({ path, text: clip(pb.files[path] ?? '', 1200) })),
        assets,
      },
      draftKind,
    };
  }

  private async personaPrompt(orgId: string, key: string): Promise<string> {
    const p = await resolvePersona(this.ctx.pool, orgId, key);
    return p?.prompt ?? getBuiltinRole(key)?.instructions ?? '';
  }

  private async promptFacts(t: Row) {
    const [questions, notes, proposals, docs] = await Promise.all([
      listQuestions(this.ctx.pool, t.id),
      listNotes(this.ctx.pool, t.id),
      listProposals(this.ctx.pool, t.id),
      sessionDocs(this.ctx.pool, t),
    ]);
    const pq: PromptQuestion[] = questions.map((q) => ({
      id: q.id,
      question: q.question,
      status: q.status,
      phase: q.phase,
      options: q.options,
      answer: q.answer,
      proposed: q.proposed
        ? { text: q.proposed.text, optionId: q.proposed.optionId, byName: q.proposed.byName }
        : null,
    }));
    const pn: PromptNote[] = notes.map((n) => ({
      id: n.id,
      section: n.section,
      text: n.text,
      byName: n.byName,
    }));
    const pp: PromptProposal[] = proposals.map((p) => ({
      title: p.title,
      status: p.status,
      resolutionText: p.resolutionText,
    }));
    const pd: PromptDoc[] = docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      status: d.status,
      version: d.currentVersion,
    }));
    return { pq, pn, pp, pd };
  }

  /** The sole entry for "the facilitator should take its next turn": queues it now, or keeps the trigger until it can. */
  requestFacilitator(
    threadId: string,
    trigger: FacilitatorTrigger,
  ): Promise<'queued' | 'pending' | 'blocked'> {
    return this.serial(threadId, () => this.queueFacilitator(threadId, trigger));
  }

  private async setPending(t: Row, trigger: FacilitatorTrigger): Promise<void> {
    const cfg = parseDiscoveryConfig(t.session_config);
    const old = cfg.pendingTrigger;
    const detail = [old?.detail, 'detail' in trigger ? trigger.detail : undefined].filter(Boolean).join('\n');
    const kind = trigger.kind === 'answer' && old?.kind === 'message' ? 'message' : trigger.kind;
    await this.ctx.store.append([
      this.configEvent(t, { pendingTrigger: { kind, ...(detail ? { detail: clip(detail, 3500) } : {}) } }),
    ]);
  }

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
          data: { discovery: true, ...data },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: sessionScope(t),
    };
  }

  private async activeTurn(threadId: string): Promise<Row | undefined> {
    return one(
      this.ctx.pool,
      `SELECT * FROM session_turns WHERE thread_id=$1 AND status IN ('queued','running') AND meta->>'purpose' IS NOT NULL
        ORDER BY queued_at LIMIT 1`,
      [threadId],
    );
  }

  private async queueFacilitator(
    threadId: string,
    trigger: FacilitatorTrigger,
  ): Promise<'queued' | 'pending' | 'blocked'> {
    const { ctx } = this;
    const t = await one(
      ctx.pool,
      `SELECT * FROM threads WHERE id=$1 AND kind='discovery' AND deleted_at IS NULL`,
      [threadId],
    );
    if (!t) return 'blocked';
    const cfg = parseDiscoveryConfig(t.session_config);
    if (cfg.paused || (await this.activeTurn(threadId))) {
      await this.setPending(t, trigger);
      return 'pending';
    }
    const participants = await listParticipants(ctx.pool, threadId);
    const fac = participants.find((p) => p.seat === FACILITATOR_SEAT && p.kind !== 'user');
    if (!fac) {
      await this.setPending(t, trigger);
      return 'blocked';
    }
    const facts = await this.promptFacts(t);
    const ceoPart = participants.find((p) => p.seat === CEO_SEAT && p.kind === 'agent');
    const { playbook, draftKind } = await this.playbookFor(cfg, trigger);
    const progress = discoveryProgress(cfg, ctx.clock.now());
    const built = buildFacilitatorTurn({
      title: t.title,
      idea: cfg.idea,
      stance: cfg.stance,
      phase: cfg.phase,
      ceoMode: cfg.ceoMode,
      ceoName: ceoPart?.display_name ?? null,
      timeBox: { elapsedMinutes: progress.elapsedMinutes, remainingMinutes: progress.remainingMinutes },
      trigger,
      questions: facts.pq,
      notes: facts.pn,
      proposals: facts.pp,
      docs: facts.pd,
      playbook,
      draftKind,
      ceoPrep: cfg.ceoPrep,
      persona: await this.personaPrompt(t.org_id, 'analyst'),
    });
    try {
      await ctx.services.sessions.queue(
        t.created_by,
        threadId,
        {
          participantId: fac.id,
          message: built.message,
          instructions: built.instructions,
          context: { mode: 'all', limit: 20 },
        },
        { meta: { purpose: 'facilitator', trigger: trigger.kind } },
      );
    } catch (err) {
      if (err instanceof HttpError && BLOCKING_CODES.has(err.code)) {
        const patch: Record<string, unknown> = {
          pendingTrigger: {
            kind: trigger.kind,
            ...('detail' in trigger && trigger.detail ? { detail: clip(trigger.detail, 3500) } : {}),
          },
        };
        const events: AppendInput[] = [];
        if (err.code === 'session_budget_exceeded' && !cfg.budgetStopped) {
          patch.budgetStopped = true;
          events.push(this.systemMessage(t, err.message, { blocked: err.code }));
        } else if (err.code !== 'session_budget_exceeded') {
          events.push(this.systemMessage(t, err.message, { blocked: err.code }));
        }
        await ctx.store.append([this.configEvent(t, patch), ...events]);
        return 'blocked';
      }
      throw err;
    }
    if (cfg.pendingTrigger || cfg.budgetStopped)
      await ctx.store.append([this.configEvent(t, { pendingTrigger: null, budgetStopped: null })]);
    return 'queued';
  }

  private async queueCeoAnswer(t: Row, q: Row, mode: 'joint' | 'ceo_prep'): Promise<boolean> {
    const { ctx } = this;
    const cfg = parseDiscoveryConfig(t.session_config);
    const participants = await listParticipants(ctx.pool, t.id);
    const ceo = participants.find((p) => p.seat === CEO_SEAT && p.kind === 'agent');
    if (!ceo) return false;
    const facts = await this.promptFacts(t);
    const built = buildCeoAnswerTurn({
      ceoName: ceo.display_name,
      title: t.title,
      idea: cfg.idea,
      phase: cfg.phase,
      mode,
      question: {
        id: q.id,
        question: q.question,
        why: q.why ?? null,
        options: q.options ?? [],
        allowFreeText: q.allow_free_text,
      },
      questions: facts.pq,
      notes: facts.pn,
      persona: '',
    });
    try {
      await ctx.services.sessions.queue(
        t.created_by,
        t.id,
        {
          participantId: ceo.id,
          message: built.message,
          instructions: built.instructions,
          context: { mode: 'all', limit: 12 },
        },
        { meta: { purpose: 'ceo_answer', questionId: q.id, mode } },
      );
      return true;
    } catch (err) {
      if (err instanceof HttpError && BLOCKING_CODES.has(err.code)) {
        await ctx.store.append([
          this.systemMessage(t, `The CEO could not answer: ${err.message}`, { blocked: err.code }),
        ]);
        return false;
      }
      throw err;
    }
  }

  // ----------------------------------------------------------------------------------------------- what happens when a turn ends

  onTurnEnded(threadId: string, turnId: string, status: 'done' | 'failed'): Promise<void> {
    return this.serial(threadId, async () => {
      const turn = await one(this.ctx.pool, 'SELECT * FROM session_turns WHERE id=$1', [turnId]);
      const purpose = (turn?.meta as { purpose?: string } | null)?.purpose;
      if (!turn || !purpose) return;
      const t = await one(
        this.ctx.pool,
        `SELECT * FROM threads WHERE id=$1 AND kind='discovery' AND deleted_at IS NULL`,
        [threadId],
      );
      if (!t) return;
      if (purpose === 'ceo_answer') await this.afterCeoTurn(t, turn, status);
      else await this.afterFacilitatorTurn(t, turn, status);
    });
  }

  private async flushPending(t: Row): Promise<boolean> {
    const fresh = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [t.id])) as Row;
    const cfg = parseDiscoveryConfig(fresh.session_config);
    if (!cfg.pendingTrigger || cfg.paused) return false;
    const pend = cfg.pendingTrigger;
    const trigger = (
      pend.kind === 'message' ||
      pend.kind === 'proposal' ||
      pend.kind === 'phase_override' ||
      pend.kind === 'draft' ||
      pend.kind === 'validate'
        ? { kind: pend.kind, detail: pend.detail ?? '' }
        : pend.kind === 'ceo_answered'
          ? { kind: 'ceo_answered', ...(pend.detail ? { detail: pend.detail } : {}) }
          : pend.kind === 'resume' || pend.kind === 'review_done' || pend.kind === 'start'
            ? { kind: pend.kind }
            : { kind: 'answer', ...(pend.detail ? { detail: pend.detail } : {}) }
    ) as FacilitatorTrigger;
    return (await this.queueFacilitator(t.id, trigger)) === 'queued';
  }

  private async afterFacilitatorTurn(t: Row, turn: Row, status: 'done' | 'failed'): Promise<void> {
    if (await this.flushPending(t)) return;
    if (status !== 'done') return;
    const fresh = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [t.id])) as Row;
    const cfg = parseDiscoveryConfig(fresh.session_config);
    if (cfg.paused) return;
    const open = await one(
      this.ctx.pool,
      `SELECT * FROM discovery_questions WHERE thread_id=$1 AND status='open' ORDER BY seq DESC LIMIT 1`,
      [t.id],
    );
    if (cfg.ceoMode === 'joint' && open && !open.proposed && open.turn_id === turn.id)
      await this.queueCeoAnswer(fresh, open, 'joint');
    else if (cfg.ceoMode === 'ceo_prep' && cfg.ceoPrep?.state === 'running') {
      if (open && open.turn_id === turn.id) {
        if (!(await this.queueCeoAnswer(fresh, open, 'ceo_prep'))) await this.finishPrep(fresh);
      } else await this.finishPrep(fresh);
    }
  }

  private async afterCeoTurn(t: Row, turn: Row, status: 'done' | 'failed'): Promise<void> {
    const meta = turn.meta as { questionId?: string; mode?: 'joint' | 'ceo_prep' };
    const fresh = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [t.id])) as Row;
    const cfg = parseDiscoveryConfig(fresh.session_config);
    if (status === 'done' && meta.questionId) {
      const q = await one(this.ctx.pool, 'SELECT * FROM discovery_questions WHERE id=$1', [meta.questionId]);
      // The CEO answered in prose instead of with the verb: its message is the proposal.
      if (q && q.status === 'open' && !q.proposed && turn.message_id) {
        const m = await one(this.ctx.pool, 'SELECT body FROM thread_messages WHERE id=$1', [turn.message_id]);
        const text = String(m?.body ?? '').trim();
        if (text)
          await this.ctx.store.append([
            this.proposedEvent(
              t,
              q.id,
              { text: clip(text, 4000) },
              turn,
              meta.mode ?? (cfg.ceoMode === 'ceo_prep' ? 'ceo_prep' : 'joint'),
            ),
          ]);
      }
    }
    if (cfg.ceoMode === 'ceo_prep' && cfg.ceoPrep?.state === 'running') {
      if (status !== 'done') return void (await this.finishPrep(fresh));
      const turns = cfg.ceoPrep.turns + 1;
      await this.ctx.store.append([this.configEvent(fresh, { ceoPrep: { ...cfg.ceoPrep, turns } })]);
      if (turns >= cfg.ceoPrep.cap) return void (await this.finishPrep(fresh));
      const q = meta.questionId
        ? await one(this.ctx.pool, 'SELECT * FROM discovery_questions WHERE id=$1', [meta.questionId])
        : undefined;
      await this.queueFacilitator(t.id, {
        kind: 'ceo_answered',
        ...(q?.proposed
          ? {
              detail: `Question "${clip(q.question, 200)}": the CEO answered "${clip(q.proposed.text, 300)}".`,
            }
          : {}),
      });
      return;
    }
    await this.flushPending(t);
  }

  proposedEvent(
    t: Row,
    questionId: string,
    a: { text: string; optionId?: string | undefined; why?: string | undefined },
    turn: Row,
    mode: 'joint' | 'ceo_prep',
  ): AppendInput {
    return {
      streamId: streamId.thread(t.id),
      event: {
        type: 'DiscoveryAnswerProposed',
        payload: {
          threadId: t.id,
          questionId,
          turnId: turn.id,
          text: a.text,
          ...(a.optionId ? { optionId: a.optionId } : {}),
          ...(a.why ? { rationale: a.why } : {}),
          by: { kind: 'agent', id: turn.agent_id ?? 'ceo', name: turn.speaker_name },
          mode,
        },
      },
      actor: turn.agent_id ? { kind: 'agent', id: turn.agent_id } : SYSTEM_ACTOR,
      scope: sessionScope(t),
    };
  }

  /** The CEO's pre-draft is over (cap, nothing more to ask, or a failure): the owner reviews its answers. */
  private async finishPrep(t: Row): Promise<void> {
    const fresh = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [t.id])) as Row;
    const cfg = parseDiscoveryConfig(fresh.session_config);
    if (!cfg.ceoPrep || cfg.ceoPrep.state !== 'running') return;
    const n = await one(
      this.ctx.pool,
      `SELECT count(*)::int AS n FROM discovery_questions WHERE thread_id=$1 AND status='proposed'`,
      [t.id],
    );
    const review = (n?.n ?? 0) > 0;
    await this.ctx.store.append([
      this.configEvent(fresh, { ceoPrep: { ...cfg.ceoPrep, state: review ? 'review' : 'done' } }),
      this.systemMessage(
        fresh,
        review
          ? `The CEO has pre-drafted ${n?.n} answer${n?.n === 1 ? '' : 's'}. Review them: confirm, edit or override each one.`
          : 'The CEO has nothing to pre-draft. Continuing with you.',
      ),
    ]);
    if (!review) await this.queueFacilitator(t.id, { kind: 'review_done' });
  }

  /** On startup and on the scheduler's pass: a trigger that was waiting (restart, budget raised elsewhere) goes out. */
  async sweep(): Promise<void> {
    const list = await rows(
      this.ctx.pool,
      `SELECT id FROM threads WHERE kind='discovery' AND deleted_at IS NULL AND session_config->'pendingTrigger' IS NOT NULL
         AND session_config->>'paused' IS DISTINCT FROM 'true'`,
    );
    for (const { id } of list)
      await this.serial(id, async () => {
        const t = await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [id]);
        if (t && !(await this.activeTurn(id))) await this.flushPending(t);
      }).catch((err) => this.ctx.log.error({ err, threadId: id }, 'discovery sweep failed'));
  }

  // ----------------------------------------------------------------------------------------------- the owner's actions

  private async userName(db: Queryable, userId: string): Promise<string> {
    const u = await one(db, 'SELECT display_name FROM users WHERE id=$1', [userId]);
    return u?.display_name ?? 'Owner';
  }

  async answer(
    userId: string,
    threadId: string,
    questionId: string,
    req: AnswerQuestionRequest,
  ): Promise<DiscoveryStateDto> {
    const { ctx } = this;
    const result = await withAppendTx(ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertDiscovery(t);
      const q = await one(tx, 'SELECT * FROM discovery_questions WHERE id=$1 AND thread_id=$2 FOR UPDATE', [
        questionId,
        threadId,
      ]);
      if (!q) throw notFound('question not found');
      if (q.status !== 'open' && q.status !== 'proposed')
        throw conflict('question_closed', 'That question is no longer open.');
      const options = (q.options ?? []) as Array<{ id: string; label: string }>;
      const prop = q.proposed as { text: string; optionId: string | null } | null;
      let kind: 'pick' | 'text' | 'skip' | 'park';
      let optionId: string | undefined;
      let text: string | undefined;
      let source: 'owner' | 'ceo_confirmed' | 'ceo_edited' | 'owner_override' = prop
        ? 'owner_override'
        : 'owner';
      if (req.kind === 'skip' || req.kind === 'park') kind = req.kind;
      else if (req.kind === 'confirm') {
        if (!prop) throw badRequest('no_proposal', 'There is no CEO proposal to confirm.');
        if (req.edited && req.text?.trim()) {
          source = 'ceo_edited';
          text = req.text.trim();
          optionId = req.optionId ?? undefined;
        } else {
          source = 'ceo_confirmed';
          text = prop.text;
          optionId = prop.optionId ?? undefined;
        }
        kind = optionId ? 'pick' : 'text';
      } else if (req.kind === 'pick') {
        if (!req.optionId || !options.some((o) => o.id === req.optionId))
          throw badRequest('unknown_option', 'Pick one of the options.');
        kind = 'pick';
        optionId = req.optionId;
        text = req.text?.trim() || undefined;
      } else {
        if (!req.text?.trim()) throw badRequest('empty_answer', 'Write an answer, or skip the question.');
        if (!q.allow_free_text && options.length)
          throw badRequest('no_free_text', 'This question only takes one of the options.');
        kind = 'text';
        text = req.text.trim();
      }
      const events: AppendInput[] = [
        {
          streamId: streamId.thread(threadId),
          event: {
            type: 'DiscoveryQuestionAnswered',
            payload: {
              threadId,
              questionId,
              kind,
              ...(optionId ? { optionId } : {}),
              ...(text ? { text } : {}),
              source,
              by: userId,
            },
          },
          actor: userActor(userId),
          scope: sessionScope(t),
        },
      ];
      if (kind === 'park')
        events.push(
          this.noteEvent(t, 'parked', clip(q.question, 300), {
            kind: 'user',
            id: userId,
            name: await this.userName(tx, userId),
          }),
        );
      await ctx.store.append(events, { tx });
      const cfg = parseDiscoveryConfig(t.session_config);
      const left = await one(
        tx,
        `SELECT count(*)::int AS n FROM discovery_questions WHERE thread_id=$1 AND status='proposed'`,
        [threadId],
      );
      const label = optionId ? options.find((o) => o.id === optionId)?.label : undefined;
      return {
        t,
        wasProposedOnly: q.status === 'proposed',
        reviewDone: cfg.ceoPrep?.state === 'review' && (left?.n ?? 0) === 0,
        reviewing: cfg.ceoPrep?.state === 'review',
        detail:
          kind === 'skip'
            ? `The owner skipped "${clip(q.question, 160)}".`
            : kind === 'park'
              ? `The owner parked "${clip(q.question, 160)}" for later.`
              : `Answer to "${clip(q.question, 160)}": ${clip([label, text].filter(Boolean).join(': '), 300)}.`,
      };
    });
    if (result.reviewDone) {
      const fresh = (await one(ctx.pool, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row;
      const cfg = parseDiscoveryConfig(fresh.session_config);
      await ctx.store.append([
        this.configEvent(fresh, { ceoPrep: { ...(cfg.ceoPrep as object), state: 'done' } }),
      ]);
      await this.requestFacilitator(threadId, { kind: 'review_done' });
    } else if (!result.reviewing && !result.wasProposedOnly) {
      await this.requestFacilitator(threadId, { kind: 'answer', detail: result.detail });
    }
    return this.state(userId, threadId);
  }

  /** The owner writes to the facilitator. */
  async say(
    userId: string,
    threadId: string,
    body: string,
  ): Promise<{ message: ThreadMessageDto; state: DiscoveryStateDto }> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertDiscovery(t);
    const message = await postSessionMessage(this.ctx, userId, threadId, { body, kind: 'chat', data: {} });
    await this.requestFacilitator(threadId, { kind: 'message', detail: body });
    return { message, state: await this.state(userId, threadId) };
  }

  noteEvent(
    t: Row,
    section: PanelSection,
    text: string,
    by: { kind: 'user' | 'agent' | 'persona' | 'system'; id: string | null; name: string },
  ): AppendInput {
    return {
      streamId: streamId.thread(t.id),
      event: {
        type: 'DiscoveryNoteAdded',
        payload: { threadId: t.id, noteId: randomUUID(), section, text, by },
      },
      actor:
        by.kind === 'user' && by.id
          ? userActor(by.id)
          : by.kind === 'agent' && by.id
            ? { kind: 'agent', id: by.id }
            : SYSTEM_ACTOR,
      scope: sessionScope(t),
    };
  }

  async addNote(
    userId: string,
    threadId: string,
    section: PanelSection,
    text: string,
  ): Promise<DiscoveryStateDto> {
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId);
      assertDiscovery(t);
      await this.ctx.store.append(
        [
          this.noteEvent(t, section, text, {
            kind: 'user',
            id: userId,
            name: await this.userName(tx, userId),
          }),
        ],
        { tx },
      );
    });
    return this.state(userId, threadId);
  }

  async patchNote(
    userId: string,
    threadId: string,
    noteId: string,
    patch: { section?: PanelSection | undefined; text?: string | undefined },
  ): Promise<DiscoveryStateDto> {
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId);
      assertDiscovery(t);
      const n = await one(
        tx,
        'SELECT id FROM discovery_notes WHERE id=$1 AND thread_id=$2 AND removed_at IS NULL',
        [noteId, threadId],
      );
      if (!n) throw notFound('note not found');
      await this.ctx.store.append(
        [
          {
            streamId: streamId.thread(threadId),
            event: {
              type: 'DiscoveryNoteUpdated',
              payload: {
                threadId,
                noteId,
                ...(patch.text ? { text: patch.text } : {}),
                ...(patch.section ? { section: patch.section } : {}),
                by: { kind: 'user', id: userId, name: await this.userName(tx, userId) },
              },
            },
            actor: userActor(userId),
            scope: sessionScope(t),
          },
        ],
        { tx },
      );
    });
    return this.state(userId, threadId);
  }

  async removeNote(userId: string, threadId: string, noteId: string): Promise<DiscoveryStateDto> {
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId);
      assertDiscovery(t);
      const n = await one(
        tx,
        'SELECT id FROM discovery_notes WHERE id=$1 AND thread_id=$2 AND removed_at IS NULL',
        [noteId, threadId],
      );
      if (!n) throw notFound('note not found');
      await this.ctx.store.append(
        [
          {
            streamId: streamId.thread(threadId),
            event: { type: 'DiscoveryNoteRemoved', payload: { threadId, noteId } },
            actor: userActor(userId),
            scope: sessionScope(t),
          },
        ],
        { tx },
      );
    });
    return this.state(userId, threadId);
  }

  async resolveProposal(
    userId: string,
    threadId: string,
    proposalId: string,
    req: ResolveDiscoveryProposalRequest,
  ): Promise<DiscoveryStateDto> {
    const { ctx } = this;
    if (req.resolution === 'redirect' && !req.text?.trim())
      throw badRequest('redirect_needs_text', 'Say what you want instead.');
    const detail = await withAppendTx(ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertDiscovery(t);
      const p = await one(tx, 'SELECT * FROM discovery_proposals WHERE id=$1 AND thread_id=$2 FOR UPDATE', [
        proposalId,
        threadId,
      ]);
      if (!p) throw notFound('proposal not found');
      if (p.status !== 'open') throw conflict('proposal_closed', 'That proposal was already resolved.');
      const events: AppendInput[] = [];
      let appliedNote = '';
      if (req.resolution === 'apply') {
        if (p.doc_id) {
          const d = await one(tx, 'SELECT * FROM documents WHERE id=$1 AND org_id=$2 FOR UPDATE', [
            p.doc_id,
            t.org_id,
          ]);
          if (!d) throw conflict('document_gone', 'The document of this proposal no longer exists.');
          if (d.status !== 'draft' && d.status !== 'in_review')
            throw conflict(
              'document_locked',
              `The document is ${String(d.status).replace('_', ' ')}: reopen it before applying a change.`,
            );
          const cur = await one(
            tx,
            'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2',
            [d.id, d.current_version],
          );
          const next = applyDocSection(cur?.content ?? '', p.section, p.change);
          if (next !== cur?.content)
            events.push(
              versionEvent(
                d.id,
                d.current_version + 1,
                next,
                { kind: 'user', id: userId },
                scopeOfDoc(d as never),
                userActor(userId),
                {
                  note: `Applied: ${clip(p.title, 120)}`,
                },
              ),
            );
          appliedNote = ` (document updated to version ${d.current_version + 1})`;
        } else {
          const section: PanelSection = (PANEL_SECTIONS as readonly string[]).includes(p.section)
            ? (p.section as PanelSection)
            : 'decisions';
          events.push(
            this.noteEvent(t, section, clip(p.change, 2000), {
              kind: 'user',
              id: userId,
              name: await this.userName(tx, userId),
            }),
          );
        }
      }
      events.push({
        streamId: streamId.thread(threadId),
        event: {
          type: 'DiscoveryProposalResolved',
          payload: {
            threadId,
            proposalId,
            resolution:
              req.resolution === 'apply'
                ? 'applied'
                : req.resolution === 'reject'
                  ? 'rejected'
                  : 'redirected',
            ...(req.text?.trim() ? { text: req.text.trim() } : {}),
            by: userId,
          },
        },
        actor: userActor(userId),
        scope: sessionScope(t),
      });
      await ctx.store.append(events, { tx });
      return req.resolution === 'apply'
        ? `The owner applied your proposal "${clip(p.title, 120)}"${appliedNote}.`
        : req.resolution === 'reject'
          ? `The owner rejected your proposal "${clip(p.title, 120)}".`
          : `The owner redirected your proposal "${clip(p.title, 120)}": "${clip(req.text ?? '', 600)}". Do what they wrote instead.`;
    });
    await this.requestFacilitator(threadId, { kind: 'proposal', detail });
    return this.state(userId, threadId);
  }

  async setPhase(userId: string, threadId: string, phase: DiscoveryPhase): Promise<DiscoveryStateDto> {
    let changed = false;
    let from: DiscoveryPhase = 'frame';
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertDiscovery(t);
      from = parseDiscoveryConfig(t.session_config).phase;
      if (from === phase) return;
      changed = true;
      await this.ctx.store.append(
        [
          {
            streamId: streamId.thread(threadId),
            event: {
              type: 'DiscoveryPhaseChanged',
              payload: {
                threadId,
                from,
                to: phase,
                by: { kind: 'user', id: userId, name: await this.userName(tx, userId) },
              },
            },
            actor: userActor(userId),
            scope: sessionScope(t),
          },
        ],
        { tx },
      );
    });
    if (changed)
      await this.requestFacilitator(threadId, {
        kind: 'phase_override',
        detail: `The owner moved the session from ${DISCOVERY_PHASE_LABEL[from]} to ${DISCOVERY_PHASE_LABEL[phase]}.`,
      });
    return this.state(userId, threadId);
  }

  async pause(userId: string, threadId: string): Promise<DiscoveryStateDto> {
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertDiscovery(t);
      const cfg = parseDiscoveryConfig(t.session_config);
      if (cfg.paused) return;
      await this.ctx.store.append(
        [
          {
            streamId: streamId.thread(threadId),
            event: {
              type: 'DiscoveryPauseChanged',
              payload: {
                threadId,
                paused: true,
                elapsedMs: discoveryElapsedMs(cfg, this.ctx.clock.now()),
                by: userId,
              },
            },
            actor: userActor(userId),
            scope: sessionScope(t),
          },
        ],
        { tx },
      );
    });
    return this.state(userId, threadId);
  }

  async resume(userId: string, threadId: string): Promise<DiscoveryStateDto> {
    let was = false;
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertDiscovery(t);
      const cfg = parseDiscoveryConfig(t.session_config);
      if (!cfg.paused) return;
      was = true;
      await this.ctx.store.append(
        [
          {
            streamId: streamId.thread(threadId),
            event: {
              type: 'DiscoveryPauseChanged',
              payload: { threadId, paused: false, elapsedMs: cfg.elapsedMs, by: userId },
            },
            actor: userActor(userId),
            scope: sessionScope(t),
          },
        ],
        { tx },
      );
    });
    if (was) {
      const open = await one(
        this.ctx.pool,
        `SELECT 1 FROM discovery_questions WHERE thread_id=$1 AND status='open'`,
        [threadId],
      );
      const t = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row;
      const pending = parseDiscoveryConfig(t.session_config).pendingTrigger;
      if (pending) await this.serial(threadId, () => this.flushPending(t));
      else if (!open) await this.requestFacilitator(threadId, { kind: 'resume' });
    }
    return this.state(userId, threadId);
  }

  async patch(userId: string, threadId: string, req: PatchDiscoveryRequest): Promise<DiscoveryStateDto> {
    let raised = false;
    await withAppendTx(this.ctx.pool, async (tx) => {
      const t = await loadSession(tx, userId, threadId, true);
      assertDiscovery(t);
      await assertSessionManager(tx, userId, t);
      const cfg: Record<string, unknown> = {};
      if (req.budgetUsd !== undefined) {
        cfg.budgetUsd = req.budgetUsd;
        cfg.budgetStopped = null;
        raised = true;
      }
      if (req.timeBoxMinutes !== undefined) cfg.timeBoxMinutes = req.timeBoxMinutes;
      if (req.stance) cfg.stance = req.stance;
      if (!Object.keys(cfg).length) return;
      await this.ctx.store.append([this.configEvent(t, cfg, userActor(userId))], { tx });
    });
    if (raised)
      await this.serial(threadId, async () => {
        const t = (await one(this.ctx.pool, 'SELECT * FROM threads WHERE id=$1', [threadId])) as Row;
        await this.flushPending(t);
      });
    return this.state(userId, threadId);
  }

  /** "Draft the brief/PRD now" and "Validate the PRD": a facilitator turn with that one job. */
  async requestDraft(userId: string, threadId: string, kind: 'brief' | 'prd'): Promise<DiscoveryStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertDiscovery(t);
    const cfg = parseDiscoveryConfig(t.session_config);
    const doc = kind === 'prd' ? cfg.prdDocId : cfg.briefDocId;
    if (doc) {
      const d = await one(this.ctx.pool, 'SELECT status FROM documents WHERE id=$1', [doc]);
      if (d && d.status !== 'draft' && d.status !== 'in_review')
        throw conflict(
          'document_locked',
          `The ${kind === 'prd' ? 'PRD' : 'brief'} is ${String(d.status).replace('_', ' ')}: reopen it first.`,
        );
    }
    await this.requestFacilitator(threadId, {
      kind: 'draft',
      detail: kind === 'prd' ? 'PRD' : 'product brief',
    });
    return this.state(userId, threadId);
  }

  async requestValidation(userId: string, threadId: string): Promise<DiscoveryStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertDiscovery(t);
    const cfg = parseDiscoveryConfig(t.session_config);
    if (!cfg.prdDocId) throw conflict('no_prd', 'There is no PRD to validate yet.');
    const d = await one(this.ctx.pool, 'SELECT * FROM documents WHERE id=$1', [cfg.prdDocId]);
    const cur = d
      ? await one(
          this.ctx.pool,
          'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2',
          [d.id, d.current_version],
        )
      : undefined;
    if (!d || !cur) throw conflict('no_prd', 'There is no PRD to validate yet.');
    const prd = builtinCapabilities().find((c) => c.kind === 'playbook' && c.key === 'prd');
    const checklist = prd?.files['assets/prd-checklist.md'] ?? '';
    const detail = [
      `PRD document ${d.id}, version ${d.current_version}:`,
      '',
      clip(cur.content, 60_000),
      '',
      '## Checklist (assets/prd-checklist.md)',
      checklist,
    ].join('\n');
    await this.requestFacilitator(threadId, { kind: 'validate', detail });
    return this.state(userId, threadId);
  }

  /** `POST /api/discovery/:id/continue`: the owner asks the facilitator to carry on (after a failed turn, a restart or a raised budget). */
  async continue(userId: string, threadId: string): Promise<DiscoveryStateDto> {
    const t = await loadSession(this.ctx.pool, userId, threadId);
    assertDiscovery(t);
    if (await this.activeTurn(threadId))
      throw conflict('turn_running', 'The facilitator is already working.');
    const open = await one(
      this.ctx.pool,
      `SELECT 1 FROM discovery_questions WHERE thread_id=$1 AND status='open'`,
      [threadId],
    );
    await this.requestFacilitator(
      threadId,
      open ? { kind: 'resume' } : { kind: 'message', detail: 'Please carry on.' },
    );
    return this.state(userId, threadId);
  }

  /**
   * "Hand to BA": an approved PRD becomes a BA intake with the PRD linked and its text in the first message; cards the BA
   * drafts carry the document in `linkedDocIds`. The document becomes `handed_off`.
   */
  async handToBa(userId: string, threadId: string): Promise<{ intakeId: string; state: DiscoveryStateDto }> {
    const { ctx } = this;
    const t = await loadSession(ctx.pool, userId, threadId);
    assertDiscovery(t);
    await assertSessionManager(ctx.pool, userId, t);
    const cfg = parseDiscoveryConfig(t.session_config);
    if (!cfg.prdDocId) throw conflict('no_prd', 'There is no PRD to hand over yet.');
    if (cfg.intakeId) throw conflict('already_handed_off', 'This PRD was already handed to the BA.');
    const d = await one(ctx.pool, 'SELECT * FROM documents WHERE id=$1 AND org_id=$2', [
      cfg.prdDocId,
      t.org_id,
    ]);
    if (!d || d.status !== 'approved')
      throw conflict('prd_not_approved', 'Approve the PRD first: only an approved PRD goes to the BA.');
    const version = d.approved_version ?? d.current_version;
    const cur = await one(
      ctx.pool,
      'SELECT content FROM document_versions WHERE document_id=$1 AND version=$2',
      [d.id, version],
    );
    const note = buildHandoffNote({
      title: d.title,
      docId: d.id,
      version,
      content: cur?.content ?? '',
      max: HANDOFF_NOTE_MAX_CHARS,
    });
    const intake = await startIntakeIn(
      ctx,
      { id: userId },
      t.org_id,
      { note },
      {
        linkedDocIds: [d.id],
        ...(t.project_id ? { projectId: t.project_id } : {}),
      },
    );
    await ctx.store.append([
      {
        streamId: streamId.document(d.id),
        event: {
          type: 'DocumentStatusChanged',
          payload: {
            docId: d.id,
            from: 'approved',
            to: 'handed_off',
            version,
            by: userId,
            note: 'Handed to the BA',
          },
        },
        actor: userActor(userId),
        scope: scopeOfDoc(d as never),
      },
      this.configEvent(t, { intakeId: intake.id }, userActor(userId)),
      this.systemMessage(t, `The PRD was handed to the BA. Follow it in Intake.`, { intakeId: intake.id }),
    ]);
    return { intakeId: intake.id, state: await this.state(userId, threadId) };
  }
}
