import { randomUUID } from 'node:crypto';
import { type ChainLevel, DESK_SUBKIND, type DeskActor, streamId } from '@aom/shared';
import { ceoDecisionItemEvents } from '../ceo/decisions.ts';
import { ceoActive, ceoReachable } from '../ceo/state.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, cardMessage, orgScope, projectScope, runnerActor, SYSTEM_ACTOR } from './common.ts';
import type { ReportResult, WsRef } from './shifts.ts';

/**
 * The escalation chain (docs/ARCHITECTURE.md section 15; docs/SPEC.md "Agent communication and escalation"):
 * a question goes to a senior agent of the same role or the card's previous holder (`peer`), then to the BA
 * (`ba`, only when the organization has no active CEO), then the CEO, then to the manager's desk (`desk`). Every step but the last is a `question` shift for the agent it is
 * routed to; that agent answers (`aom answer`) or passes it on (`aom escalate`). Only agents that are online can
 * be asked: with nobody to ask, the question goes straight on.
 */

const ONLINE_WINDOW_MS = 45_000;

/** A question routed to an agent that has not taken it up for this long goes on to the next step (every step has this limit). */
export const QUESTION_STALL_MS = 10 * 60_000;

export interface Route {
  routedTo: 'manager' | 'agent';
  routedAgentId?: string;
  level: ChainLevel;
  /** For messages: who it went to. */
  agentName?: string;
  agentRole?: string;
}

export interface RouteInput {
  orgId: string;
  projectId: string | null;
  cardId: string | null;
  /** The agent that asked (never asked itself). */
  askerAgentId: string | null;
  askerRole: string | null;
  /** The step the question is at now (`raise` for a new question). */
  from: 'raise' | ChainLevel;
  /** Agents that already looked at it. */
  tried: string[];
  /** BA routing (Part B, owner decision B2/B3): `ba` starts a non-blocking question at the BA instead of a peer. */
  via?: 'ba';
  /** Lean Team v3: the topic the asker named (`aom question --topic`); it picks who is asked first. */
  topic?: string | null;
  /** The desk item's subkind: a stop-loss arbitration goes from the architect straight to the owner. */
  subkind?: string | null;
}

/** Active, non-DevOps agents of the org on a connected workstation whose runtime is available, least recently busy first. */
async function onlineAgents(ctx: Ctx, db: Queryable, i: RouteInput): Promise<Row[]> {
  const since = new Date(ctx.clock.now().getTime() - ONLINE_WINDOW_MS);
  const list = await rows(
    db,
    `SELECT a.*, ws.runtimes FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
      WHERE a.org_id = $1 AND a.status = 'active' AND NOT a.is_devops AND ws.status = 'active' AND ws.connected
        AND a.role_key <> 'ceo'
        AND ws.last_seen_at > $2 AND ($3::uuid IS NULL OR ((a.allowed_project_ids IS NULL OR $3::uuid = ANY (a.allowed_project_ids))
             AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $3::uuid AND pm.user_id = ws.user_id
                          AND pm.status = 'active')))
        AND a.id <> ALL($4::uuid[])
      ORDER BY a.last_shift_ended_at NULLS FIRST, a.hired_at, a.id`,
    [i.orgId, since, i.projectId, [...i.tried, ...(i.askerAgentId ? [i.askerAgentId] : [])]],
  );
  return list.filter((a) =>
    (a.runtimes as Array<{ id: string; available: boolean }>).some((r) => r.id === a.runtime && r.available),
  );
}

const asRoute = (a: Row, level: ChainLevel): Route => ({
  routedTo: 'agent',
  routedAgentId: a.id,
  level,
  agentName: a.name,
  agentRole: a.role_key,
});

/** The agent that made the card's design (latest architect handoff), or the card's builder, by role. */
async function cardHolderOf(
  db: Queryable,
  cardId: string,
  role: 'architect' | 'builder',
): Promise<string | undefined> {
  if (role === 'builder') {
    const c = await one<{ original_builder_agent_id: string | null }>(
      db,
      'SELECT original_builder_agent_id FROM cards WHERE id=$1',
      [cardId],
    );
    if (c?.original_builder_agent_id) return c.original_builder_agent_id;
  }
  return (
    await one<{ agent_id: string }>(
      db,
      `SELECT h.agent_id FROM card_handoffs h JOIN agents a ON a.id = h.agent_id
        WHERE h.card_id=$1 AND a.role_key=$2 ORDER BY h.created_at DESC, h.event_seq DESC LIMIT 1`,
      [cardId, role],
    )
  )?.agent_id;
}

/**
 * The agent a topic names, when it is online: dependency, order and design go to the card's architect, requirements
 * to the BA, code to the card's builder. An architect or builder who is not reachable is replaced by another online
 * agent of that role (a senior first); nobody online means the normal chain.
 */
async function topicRoute(
  db: Queryable,
  i: RouteInput,
  agents: Row[],
  /** An active CEO decides in the BA's place: a `requirements` topic is not routed to the BA then. */
  ceoDecides = false,
): Promise<Route | undefined> {
  const topic = i.topic;
  if (!topic) return undefined;
  if (topic === 'requirements') {
    if (ceoDecides) return undefined;
    const ba = agents.find((a) => a.role_key === 'ba');
    return ba ? asRoute(ba, 'ba') : undefined;
  }
  const role =
    topic === 'dependency' || topic === 'order' || topic === 'design'
      ? 'architect'
      : topic === 'code'
        ? 'builder'
        : undefined;
  if (!role) return undefined;
  const own = i.cardId ? await cardHolderOf(db, i.cardId, role) : undefined;
  const named = agents.find((a) => a.id === own && a.role_key === role);
  const pick =
    named ??
    agents.find((a) => a.role_key === role && a.seniority === 'senior') ??
    agents.find((a) => a.role_key === role);
  return pick ? asRoute(pick, 'peer') : undefined;
}

/** The card's architect for a stop-loss arbitration (an online one), else the manager's desk. */
export async function architectRoute(ctx: Ctx, db: Queryable, card: Row): Promise<Route> {
  const input: RouteInput = {
    orgId: card.org_id,
    projectId: card.project_id,
    cardId: card.id,
    askerAgentId: null,
    askerRole: null,
    from: 'raise',
    tried: [],
    topic: 'design',
  };
  const agents = await onlineAgents(ctx, db, input);
  return (await topicRoute(db, input, agents)) ?? { routedTo: 'manager', level: 'desk' };
}

/**
 * The organization's CEO as the step before the desk, whenever it is active (enabled, not paused, its agent active) and
 * can run a shift now. An active CEO that is not reachable (offline workstation, runtime signed out) cannot answer: the
 * question goes to the owner's desk at once, never to the BA and not after a wait (owner decision, 22 Oct: the BA does
 * not decide because the CEO was slow).
 */
async function ceoRoute(
  ctx: Ctx,
  db: Queryable,
  i: RouteInput,
): Promise<{ route?: Route; unreachable?: boolean }> {
  if (i.askerRole === 'ceo') return {};
  const ceo = await ceoActive(db, i.orgId);
  if (!ceo?.agentId || ceo.agentId === i.askerAgentId || i.tried.includes(ceo.agentId)) return {};
  if (!(await ceoReachable(db, i.orgId, ctx.clock.now())).ok) return { unreachable: true };
  const a = await one(db, 'SELECT * FROM agents WHERE id=$1', [ceo.agentId]);
  return a ? { route: asRoute(a, 'ceo') } : {};
}

/**
 * Who gets the question next (docs/ARCHITECTURE.md section 15). Pure of side effects. A named topic is asked first
 * (the card's architect, BA or builder); then the card's previous holder and the asker's seniors; then the CEO when the
 * organization has an active one (the BA is skipped then), else the BA; then the manager's desk. A stop-loss arbitration (the architect decides,
 * else the owner) goes from the architect straight to the desk. Environment, sandbox and tooling questions are not
 * routed here: they become a DevOps request (`commands/questions.ts`).
 */
export async function nextRoute(ctx: Ctx, db: Queryable, i: RouteInput): Promise<Route> {
  const desk: Route = { routedTo: 'manager', level: 'desk' };
  if (i.from === 'desk' || i.from === 'ceo' || i.askerRole === 'ceo') return desk;
  if (i.subkind === DESK_SUBKIND.stopLoss && i.from !== 'raise') return desk;
  const agents = await onlineAgents(ctx, db, i);
  const { route: ceo, unreachable } = await ceoRoute(ctx, db, i);
  if (i.from === 'ba' || i.askerRole === 'ba') return ceo ?? desk;
  if (i.from === 'raise') {
    const topic = await topicRoute(db, i, agents, !!ceo || !!unreachable);
    if (topic) return topic;
  }
  if (i.from === 'raise' && i.via !== 'ba') {
    // The card's previous holder (someone else's last handoff), then seniors of the asker's role.
    const prev = i.cardId
      ? await one<{ agent_id: string }>(
          db,
          `SELECT agent_id FROM card_handoffs WHERE card_id=$1 AND agent_id IS NOT NULL AND agent_id IS DISTINCT FROM $2
            ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
          [i.cardId, i.askerAgentId],
        )
      : undefined;
    const holder = agents.find((a) => a.id === prev?.agent_id && a.role_key !== 'ba');
    if (holder) return asRoute(holder, 'peer');
    const senior = agents.find((a) => a.seniority === 'senior' && a.role_key === i.askerRole);
    if (senior) return asRoute(senior, 'peer');
  }
  // With an active CEO the BA is skipped: the CEO decides what the BA used to answer from the ledger.
  if (ceo) return ceo;
  if (unreachable) return desk;
  const ba = agents.find((a) => a.role_key === 'ba');
  return ba ? asRoute(ba, 'ba') : desk;
}

/** Ids of the agents already in the item's trail (they are not asked again). */
export const triedAgents = (item: Row): string[] => [
  ...new Set(
    ((item.escalation_trail ?? []) as Array<{ agentId?: string }>).flatMap((s) =>
      s.agentId ? [s.agentId] : [],
    ),
  ),
];

// ------------------------------------------------------------------------------------- duplicate questions

/** Share of distinct words two questions need in common (Jaccard) to count as the same question. */
export const DUPLICATE_SIMILARITY = 0.8;
const MIN_SHARED_WORDS = 3;
const STOP_WORDS = new Set(
  'the and for are but not you your with that this from have has was were will would could should can how what which who why when where there their its into onto about our out use using used any all'.split(
    ' ',
  ),
);
const wordsOf = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z0-9]{2,}|\d/g) ?? []).filter((w) => !STOP_WORDS.has(w)));
const hasDigit = (w: string): boolean => /\d/.test(w);

/**
 * Word-set similarity of two questions, 0..1. Numbers and identifiers (TOY-14, 300, v2) tell questions apart, so
 * questions that mention different ones are never the same question.
 */
export function questionSimilarity(a: string, b: string): number {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const numX = [...x].filter(hasDigit).sort().join(' ');
  const numY = [...y].filter(hasDigit).sort().join(' ');
  if (numX !== numY) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  if (shared < MIN_SHARED_WORDS) return 0;
  return shared / (x.size + y.size - shared);
}

/**
 * The open question of the same project that `text` duplicates (high word similarity), preferring one that is already
 * on the manager's desk. Mapping questions of an intake never merge.
 */
export async function findOpenDuplicate(
  db: Queryable,
  q: { orgId: string; projectId: string | null; text: string; excludeId?: string },
): Promise<{ id: string; title: string } | undefined> {
  const open = await rows(
    db,
    `SELECT id, title, routed_to FROM desk_items
      WHERE org_id=$1 AND kind='question' AND status='open' AND subkind IS DISTINCT FROM 'unmapped_ticket'
        AND project_id IS NOT DISTINCT FROM $2 AND ($3::uuid IS NULL OR id <> $3) ORDER BY created_at, id`,
    [q.orgId, q.projectId, q.excludeId ?? null],
  );
  let best: { id: string; title: string; score: number } | undefined;
  for (const o of open) {
    const sim = questionSimilarity(q.text, o.title);
    if (sim < DUPLICATE_SIMILARITY) continue;
    const score = sim + (o.routed_to === 'manager' ? 1 : 0);
    if (!best || score > best.score) best = { id: o.id, title: o.title, score };
  }
  return best && { id: best.id, title: best.title };
}

/** Attaches the duplicate `item` (or a question being raised, `cardId`) to the open question `into`. */
export function mergeEvents(
  item: Row,
  card: Row | undefined,
  into: { id: string; title: string },
  byAgentId: string | undefined,
): AppendInput[] {
  const events: AppendInput[] = [
    {
      streamId: streamId.desk(item.id),
      event: {
        type: 'QuestionMerged',
        payload: {
          deskItemId: item.id,
          intoDeskItemId: into.id,
          ...(byAgentId ? { fromAgentId: byAgentId } : {}),
          note: 'the same question is already open',
        },
      },
      actor: byAgentId ? agentActor(byAgentId) : SYSTEM_ACTOR,
      scope: item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id),
    },
  ];
  if (card)
    events.push(
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `The same question is already open ("${into.title}"). This card waits on that one and returns to the queue when it is answered.`,
        { deskItemId: into.id },
      ),
    );
  return events;
}

/** The answer on the thread of every other card that waited on the item (cards of merged duplicates). */
export async function mergedAnswerNotes(
  tx: Tx,
  item: Row,
  blockedCardIds: string[],
  author: Parameters<typeof cardMessage>[1],
  text: string,
  meta: Record<string, unknown>,
): Promise<AppendInput[]> {
  const out: AppendInput[] = [];
  for (const id of blockedCardIds) {
    if (id === item.card_id) continue;
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [id]);
    if (card) out.push(cardMessage(card, author, 'answer', text, { deskItemId: item.id, ...meta }));
  }
  return out;
}

const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

const truncate = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const where = (r: Route): string =>
  r.routedTo === 'manager' ? "the manager's desk" : `${r.agentName} (${r.agentRole})`;

/** `QuestionEscalated` plus a note on the card thread. `by` is the agent passing it on (null: the system). */
export async function escalateEvents(
  ctx: Ctx,
  tx: Tx,
  item: Row,
  by: Row | null,
  note: string,
  /** Skip the chain: the item goes straight to the manager's desk (a paused project never dispatches a question). */
  opts: { toDesk?: boolean } = {},
): Promise<{ events: AppendInput[]; route: Route; mergedInto?: { id: string; title: string } }> {
  const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
  const at: ChainLevel =
    by?.role_key === 'ba'
      ? 'ba'
      : by?.role_key === 'ceo'
        ? 'ceo'
        : item.routed_agent_id
          ? await currentLevel(tx, item.routed_agent_id)
          : 'desk';
  const route: Route = opts.toDesk
    ? { routedTo: 'manager', level: 'desk' }
    : await nextRoute(ctx, tx, {
        orgId: item.org_id,
        projectId: item.project_id,
        cardId: item.card_id,
        askerAgentId: item.asked_by_agent_id,
        askerRole: item.asked_by_role,
        from: at,
        tried: triedAgents(item),
        topic: item.topic ?? null,
        subkind: item.subkind ?? null,
      });
  // A question reaching the BA or the desk that matches an open one is attached to it, not asked a second time.
  if (route.level !== 'peer') {
    const dup = await findOpenDuplicate(tx, {
      orgId: item.org_id,
      projectId: item.project_id,
      text: item.title,
      excludeId: item.id,
    });
    if (dup) return { events: mergeEvents(item, card, dup, by?.id), route, mergedInto: dup };
  }
  const events: AppendInput[] = [
    {
      streamId: streamId.desk(item.id),
      event: {
        type: 'QuestionEscalated',
        payload: {
          deskItemId: item.id,
          ...(by ? { fromAgentId: by.id } : {}),
          routedTo: route.routedTo,
          ...(route.routedAgentId ? { routedAgentId: route.routedAgentId } : {}),
          note,
          chainLevel: route.level,
        },
      },
      actor: by ? agentActor(by.id) : SYSTEM_ACTOR,
      scope: itemScope(item),
    },
  ];
  if (card)
    events.push(
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `${by ? `${by.name} (${by.role_key})` : 'The question'} passed the question on to ${where(route)}: ${note}`,
        { deskItemId: item.id },
      ),
    );
  return { events, route };
}

async function currentLevel(db: Queryable, agentId: string): Promise<ChainLevel> {
  const a = await one<{ role_key: string }>(db, 'SELECT role_key FROM agents WHERE id=$1', [agentId]);
  return a?.role_key === 'ba' ? 'ba' : a?.role_key === 'ceo' ? 'ceo' : 'peer';
}

/** The ShiftEnded of a question shift (the runner's `shift.ended`, a rejection, or the server giving up on it). */
export function endQuestionShift(
  shift: Row,
  outcome: 'rejected' | 'lost' | 'stopped' | 'no_report' | 'crashed' | 'timeout' | 'reported',
  extra: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    exitCode?: number | null;
    guardViolations?: { rule: string; detail: string }[];
    reportOutcome?: string;
  } = {},
): AppendInput[] {
  return [
    {
      streamId: streamId.shift(shift.id),
      event: {
        type: 'ShiftEnded',
        payload: {
          shiftId: shift.id,
          agentId: shift.agent_id,
          outcome,
          ...(extra.reportOutcome ? { reportOutcome: extra.reportOutcome } : {}),
          durationMs: extra.durationMs ?? 0,
          usage: extra.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          exitCode: extra.exitCode,
          guardViolations: extra.guardViolations ?? [],
        },
      },
      actor: runnerActor(shift.workstation_id),
      scope: orgScope(shift.org_id),
    },
  ];
}

/**
 * `aom answer` / `aom escalate` in a question shift. Answering closes the item for every card it blocks and is
 * recorded once as a feature-scope ledger entry attached to the card, attributed to the answering agent, so ledger
 * search and the duplicate check find it (only the manager's answers also become vault decision files);
 * escalating moves it to the next step (or attaches the question to a matching open one).
 */
export async function applyQuestionReport(
  ctx: Ctx,
  tx: Tx,
  _ws: WsRef,
  report: { kind: string; [k: string]: unknown },
  shift: Row,
): Promise<ReportResult> {
  if (report.kind === 'comment') return { accepted: true };
  if (report.kind !== 'answer' && report.kind !== 'escalate')
    return {
      accepted: false,
      error:
        'in a question shift you answer (`aom answer`) or pass it on (`aom escalate`); nothing else is accepted',
    };
  const agent = await one(tx, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!agent) return { accepted: false, error: 'agent not found' };
  const item = await one(tx, 'SELECT * FROM desk_items WHERE id=$1 FOR UPDATE', [report.itemId as string]);
  if (!item || item.id !== shift.desk_item_id)
    return { accepted: false, error: 'this shift was not given that item; use the item id from your prompt' };
  if (item.status !== 'open')
    return {
      accepted: false,
      error: `this question is already ${item.status}; there is nothing left to do. Finish now.`,
    };
  if (item.routed_agent_id !== agent.id)
    return { accepted: false, error: 'this question is no longer routed to you. Finish now.' };

  if (report.kind === 'answer') {
    const optionId = report.optionId as string | undefined;
    const keep = (report.keepBlockedUntil as string | undefined)?.trim() || undefined;
    if (optionId && !(item.options as Array<{ id: string }>).some((o) => o.id === optionId))
      return { accepted: false, error: `--option ${optionId} is not one of the item's options` };
    const blocked = await rows<{ card_id: string }>(
      tx,
      `SELECT b.card_id FROM card_blockers b JOIN cards c ON c.id = b.card_id
        WHERE b.desk_item_id = $1 AND c.status = 'blocked'
          AND NOT EXISTS (SELECT 1 FROM card_blockers o WHERE o.card_id = b.card_id AND o.desk_item_id <> $1)`,
      [item.id],
    );
    const by: DeskActor = { kind: 'agent', agentId: agent.id, role: agent.role_key };
    // A CEO answer says so wherever it shows: the card thread, the ledger entry (tag) and the desk item.
    const isCeo = agent.role_key === 'ceo';
    const threadText = isCeo ? `CEO decision: ${report.text as string}` : (report.text as string);
    const entryId = randomUUID();
    const events: AppendInput[] = [
      {
        streamId: streamId.desk(item.id),
        event: {
          type: 'QuestionAnswered',
          payload: {
            deskItemId: item.id,
            answer: report.text as string,
            ...(optionId ? { answerOption: optionId } : {}),
            answeredBy: by,
            ledgerEntryId: entryId,
            unblockedCardIds: keep ? [] : blocked.map((b) => b.card_id),
            ...(keep ? { keepBlockedUntil: keep } : {}),
          },
        },
        actor: agentActor(agent.id),
        scope: itemScope(item),
      },
      {
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryAdded',
          payload: {
            entryId,
            scope: 'feature',
            ...(item.project_id ? { projectId: item.project_id } : {}),
            ...(item.card_id ? { cardId: item.card_id } : {}),
            title: truncate(item.title, 120),
            body: `Question: ${String(item.title).trim()}\n\n${isCeo ? `Answer (CEO decision, ${agent.name})` : 'Answer'}: ${String(report.text).trim()}`,
            tags: isCeo ? ['ceo-decision'] : [],
            sourceDeskItemId: item.id,
          },
        },
        actor: agentActor(agent.id),
        scope: itemScope(item),
      },
    ];
    const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
    if (card)
      events.push(
        cardMessage(card, { kind: 'agent', agentId: agent.id }, 'answer', threadText, {
          deskItemId: item.id,
          answeredBy: `${agent.name} (${agent.role_key})`,
        }),
      );
    events.push(
      ...(await mergedAnswerNotes(
        tx,
        item,
        blocked.map((b) => b.card_id),
        { kind: 'agent', agentId: agent.id },
        threadText,
        { answeredBy: `${agent.name} (${agent.role_key})` },
      )),
    );
    // The CEO's answer shows on the owner's desk as a decision to acknowledge or correct (informational, no push).
    if (isCeo)
      events.push(
        ...ceoDecisionItemEvents({
          orgId: item.org_id,
          projectId: item.project_id ?? null,
          cardId: item.card_id ?? null,
          ceoAgentId: agent.id,
          ceoName: agent.name,
          cls: 'desk.answer_question',
          source: 'chain',
          question: item.title,
          questionItemId: item.id,
          decision: report.text as string,
          reason: 'The question was routed to the CEO, which answered it.',
        }),
      );
    await ctx.store.append(events, { tx });
    return {
      accepted: true,
      message: keep
        ? `Recorded. The asker gets your answer; the card stays parked until: ${keep}. Finish now.`
        : 'Recorded. The asker gets your answer; the card goes back to the queue. Finish now.',
    };
  }

  const { events, route, mergedInto } = await escalateEvents(ctx, tx, item, agent, report.note as string);
  await ctx.store.append(events, { tx });
  return {
    accepted: true,
    message: mergedInto
      ? `Recorded. The same question is already open, so yours was attached to it: every card waiting on it returns to the queue when it is answered. Finish now.`
      : `Recorded. The question went on to ${where(route)}. Finish now.`,
  };
}

/** Wording of the reply an asker's `aom question` gets, by where the question went. */
export function routedMessage(route: Route, blocking: boolean, seen: string): string {
  if (route.routedTo === 'manager')
    return blocking
      ? `Recorded. The card is now Blocked and your question is on the manager's desk. Finish now; do not make further changes.${seen}`
      : `Recorded. The manager will see your question; carry on with your best assumption.${seen}`;
  return blocking
    ? `Recorded. The card is now Blocked. Your question went to ${where(route)} first; it reaches the manager's desk only if nobody up the chain can answer. Finish now; do not make further changes.${seen}`
    : `Recorded. ${where(route)} was asked; it reaches the manager's desk only if nobody up the chain can answer. Carry on with your best assumption.${seen}`;
}
