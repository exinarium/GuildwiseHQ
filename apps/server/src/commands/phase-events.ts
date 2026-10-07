import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  type BaTaskKind,
  type DeskActor,
  type FollowupSpecWithId,
  followupLabel,
  isFollowupTerminal,
  memberOutcome,
  PHASE_DESK_SUBKIND,
  type PhaseCardOutcome,
  type PhaseOutstanding,
  streamId,
} from '@aom/shared';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

export const systemBy: DeskActor = { kind: 'system' };
export const userBy = (userId: string): DeskActor => ({ kind: 'user', userId });
export const agentBy = (agentId: string, role = BA_ROLE_KEY): DeskActor => ({ kind: 'agent', agentId, role });

/** The event actor for a desk actor. */
export function actorOf(by: DeskActor): AppendInput['actor'] {
  if (by.kind === 'user' && by.userId) return userActor(by.userId);
  if (by.kind === 'agent' && by.agentId) return agentActor(by.agentId);
  return SYSTEM_ACTOR;
}

export const phaseScope = (phase: Row) => projectScope(phase.org_id, phase.project_id);

/** A message on the phase thread (thread id = phase id): the BA's notes and the server's progress notes. */
export function phaseMessage(
  phase: Row,
  author: { kind: 'user'; userId: string } | { kind: 'agent'; agentId: string } | { kind: 'system' },
  body: string,
  data: Record<string, unknown> = {},
): AppendInput {
  return {
    streamId: streamId.thread(phase.id),
    event: {
      type: 'ThreadMessagePosted',
      payload: {
        threadId: phase.id,
        messageId: randomUUID(),
        authorKind: author.kind,
        authorUserId: author.kind === 'user' ? author.userId : undefined,
        authorAgentId: author.kind === 'agent' ? author.agentId : undefined,
        kind: author.kind === 'system' ? 'system' : 'comment',
        body,
        data,
      },
    },
    actor:
      author.kind === 'user'
        ? userActor(author.userId)
        : author.kind === 'agent'
          ? agentActor(author.agentId)
          : SYSTEM_ACTOR,
    scope: phaseScope(phase),
  };
}

export const followupRows = (db: Queryable, phaseId: string): Promise<Row[]> =>
  rows(db, 'SELECT * FROM phase_followups WHERE phase_id=$1 ORDER BY position', [phaseId]);

/** A stored follow-up row as the spec events carry it. */
export function rowToSpec(f: Row): FollowupSpecWithId {
  const base = { id: f.id as string, note: (f.note ?? '') as string };
  if (f.kind === 'deploy') return { ...base, kind: 'deploy', targetId: f.target_id };
  if (f.kind === 'regression')
    return {
      ...base,
      kind: 'regression',
      platform: (f.platform ?? 'web') as 'web' | 'mobile' | 'both',
      ...(f.target_id ? { targetId: f.target_id } : {}),
      ...(f.mock ? { mock: f.mock } : {}),
    };
  return { ...base, kind: 'custom', instruction: f.instruction };
}

export async function targetNames(db: Queryable, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const found = await rows<{ id: string; name: string }>(
    db,
    'SELECT id, name FROM deploy_targets WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return new Map(found.map((t) => [t.id, t.name]));
}

/** One-line label for each follow-up row ("Deploy to staging"). */
export async function labelsFor(db: Queryable, list: Row[]): Promise<string[]> {
  const names = await targetNames(
    db,
    list.flatMap((f) => (f.target_id ? [f.target_id as string] : [])),
  );
  return list.map((f) => followupLabel(rowToSpec(f), f.target_id ? names.get(f.target_id) : null));
}

export const isEmptyList = (list: Row[]): boolean => list.length === 0;
export const hasOpenFollowups = (list: Row[]): boolean => list.some((f) => !isFollowupTerminal(f.status));

// -------------------------------------------------------------------------------- card outcomes

const MEMBER_SELECT = `SELECT c.id, c.ref, c.title, c.stage, c.status, c.card_type, c.phase_assignment, c.finalize_action,
       c.finalize_result, c.merged_into_working_at, c.branch_name, c.finalized_at, c.repo_id, c.home_workstation_id,
       EXISTS (SELECT 1 FROM research_publications rp WHERE rp.card_id = c.id) AS published
  FROM cards c WHERE c.phase_id = $1 ORDER BY c.number`;

export const memberRows = (db: Queryable, phaseId: string): Promise<Row[]> =>
  rows(db, MEMBER_SELECT, [phaseId]);

/** The state `phaseCompletion` / `memberOutcome` need for a member row. */
export const memberState = (c: Row) => ({
  status: c.status as string,
  assignment: c.phase_assignment as 'proposed' | 'confirmed',
  finalized: c.finalize_result !== null && c.finalize_result !== undefined,
  action: c.finalize_action as string | null,
  merged: !!c.merged_into_working_at,
  published: !!c.published,
});

/** The cancel reason of a card (from its event stream). */
async function cancelReason(db: Queryable, cardId: string): Promise<string | undefined> {
  const r = await one<{ reason: string | null }>(
    db,
    `SELECT payload->>'reason' AS reason FROM events WHERE stream_id=$1 AND type='CardCancelled' ORDER BY seq DESC LIMIT 1`,
    [streamId.card(cardId)],
  );
  return r?.reason ?? undefined;
}

/** How each confirmed member ended (the snapshot `PhaseCompleted` carries). */
export async function cardOutcomes(db: Queryable, phaseId: string): Promise<PhaseCardOutcome[]> {
  const out: PhaseCardOutcome[] = [];
  for (const c of await memberRows(db, phaseId)) {
    if (c.phase_assignment !== 'confirmed') continue;
    const kind = memberOutcome(memberState(c));
    if (kind === null || kind === 'waiting_merge') continue;
    const unmerged =
      !c.merged_into_working_at && c.branch_name ? { unmergedBranch: c.branch_name as string } : {};
    if (kind === 'finalized')
      out.push({
        cardId: c.id,
        ref: c.ref,
        title: c.title,
        outcome: 'finalized',
        ...(c.finalize_action ? { action: c.finalize_action } : {}),
        ...(c.finalize_result ? { resultRef: c.finalize_result } : {}),
      });
    else if (kind === 'published')
      out.push({ cardId: c.id, ref: c.ref, title: c.title, outcome: 'published' });
    else if (kind === 'closed_manually')
      out.push({ cardId: c.id, ref: c.ref, title: c.title, outcome: 'closed_manually', ...unmerged });
    else {
      const reason = await cancelReason(db, c.id);
      out.push({
        cardId: c.id,
        ref: c.ref,
        title: c.title,
        outcome: 'cancelled',
        ...(reason ? { reason } : {}),
        ...unmerged,
      });
    }
  }
  return out;
}

export interface SuiteInfo {
  ref: string;
  status: string;
  result?: 'passed' | 'failed' | 'running';
  bugRefs: string[];
}

/** The post-finalize full E2E suite of a member card: running, passed or failed (with its bug cards). */
export async function suiteOf(db: Queryable, cardId: string): Promise<SuiteInfo | undefined> {
  const s = await one(
    db,
    `SELECT id, ref, status FROM cards WHERE parent_card_id=$1 AND origin='full_suite' ORDER BY number DESC LIMIT 1`,
    [cardId],
  );
  if (!s) return undefined;
  const run = await one<{ result: 'passed' | 'failed' }>(
    db,
    'SELECT result FROM test_runs WHERE card_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1',
    [s.id],
  );
  const bugs = await rows<{ ref: string }>(
    db,
    `SELECT ref FROM cards WHERE parent_card_id=$1 AND card_type='bug' ORDER BY number`,
    [s.id],
  );
  return {
    ref: s.ref,
    status: s.status,
    result: s.status === 'done' || s.status === 'cancelled' ? run?.result : 'running',
    bugRefs: bugs.map((b) => b.ref),
  };
}

/** What is still open around a finished phase: kept branches, failed or running full suites. */
export async function computeOutstanding(
  db: Queryable,
  outcomes: PhaseCardOutcome[],
): Promise<PhaseOutstanding[]> {
  const out: PhaseOutstanding[] = [];
  for (const o of outcomes) {
    if (o.unmergedBranch)
      out.push({
        kind: 'unmerged_branch',
        text: `${o.ref}: branch ${o.unmergedBranch} was kept and is not merged (${o.outcome === 'cancelled' ? 'the card was cancelled' : 'the card was closed by hand'})`,
        cardId: o.cardId,
      });
    if (o.outcome !== 'finalized') continue;
    const suite = await suiteOf(db, o.cardId);
    if (!suite) continue;
    if (suite.result === 'running')
      out.push({
        kind: 'suite_running',
        text: `The full E2E suite ${suite.ref} after ${o.ref} is still running`,
        cardId: o.cardId,
      });
    else if (suite.result === 'failed')
      out.push({
        kind: 'suite_failed',
        text: `The full E2E suite ${suite.ref} after ${o.ref} failed${suite.bugRefs.length ? ` (bug ${suite.bugRefs.join(', ')})` : ''}`,
        cardId: o.cardId,
      });
  }
  return out;
}

// ------------------------------------------------------------------------------------- BA tasks

/** The intake's BA, when it is still active: the preferred agent of the phase's background tasks. */
export async function preferredBa(db: Queryable, phase: Row): Promise<string | undefined> {
  if (!phase.intake_id) return undefined;
  const a = await one<{ id: string }>(
    db,
    `SELECT a.id FROM intakes i JOIN agents a ON a.id = i.ba_agent_id AND a.status = 'active' WHERE i.id=$1`,
    [phase.intake_id],
  );
  return a?.id;
}

export async function queueBaTask(
  db: Queryable,
  phase: Row,
  kind: BaTaskKind,
  followupId?: string,
): Promise<{ taskId: string; event: AppendInput }> {
  const taskId = randomUUID();
  const preferredAgentId = await preferredBa(db, phase);
  return {
    taskId,
    event: {
      streamId: streamId.baTask(taskId),
      event: {
        type: 'BaTaskQueued',
        payload: {
          taskId,
          projectId: phase.project_id,
          phaseId: phase.id,
          ...(followupId ? { followupId } : {}),
          kind,
          ...(preferredAgentId ? { preferredAgentId } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: phaseScope(phase),
    },
  };
}

export function baTaskCompleted(
  phase: Row,
  taskId: string,
  status: 'done' | 'failed' | 'fallback' | 'cancelled',
  note?: string,
): AppendInput {
  return {
    streamId: streamId.baTask(taskId),
    event: { type: 'BaTaskCompleted', payload: { taskId, status, ...(note ? { note } : {}) } },
    actor: SYSTEM_ACTOR,
    scope: phaseScope(phase),
  };
}

// ----------------------------------------------------------------------------------- desk items

export const openItem = (db: Queryable, id: string) =>
  one(db, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [id]);

export function resolveItemEvent(
  phase: Row,
  deskItemId: string,
  resolution: 'approved' | 'rejected' | 'acknowledged' | 'dismissed',
  note: string,
  by: DeskActor = systemBy,
): AppendInput {
  return {
    streamId: streamId.desk(deskItemId),
    event: { type: 'DeskItemResolved', payload: { deskItemId, resolution, note, by } },
    actor: actorOf(by),
    scope: phaseScope(phase),
  };
}

export function createItemEvent(
  phase: Row,
  input: {
    kind: 'approval' | 'alert';
    subkind: string;
    title: string;
    body: string;
    pinned?: boolean;
    askedBy: DeskActor;
    affectedCardIds?: string[];
  },
): { deskItemId: string; event: AppendInput } {
  const deskItemId = randomUUID();
  return {
    deskItemId,
    event: {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: input.kind,
          subkind: input.subkind,
          title: input.title,
          body: input.body,
          options: [],
          blocking: false,
          pinned: input.pinned ?? false,
          projectId: phase.project_id,
          affectedCardIds: input.affectedCardIds ?? [],
          askedBy: input.askedBy,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: phaseScope(phase),
    },
  };
}

/**
 * `PhaseReportPosted` and its desk item: an approval of the follow-ups (title "approve N follow-ups?"), or, when the
 * list is empty, an alert to acknowledge. An older open "phase done" item is dismissed (the list changed shape).
 */
export async function phaseReportEvents(
  db: Queryable,
  phase: Row,
  input: { report: string; outstanding: PhaseOutstanding[]; by: DeskActor },
): Promise<AppendInput[]> {
  const list = await followupRows(db, phase.id);
  const n = list.length;
  const item = createItemEvent(phase, {
    kind: n > 0 ? 'approval' : 'alert',
    subkind: PHASE_DESK_SUBKIND.done,
    title:
      n > 0
        ? `${phase.ref} ${phase.name} is done: approve ${n} follow-up${n === 1 ? '' : 's'}?`
        : `${phase.ref} ${phase.name} is done`,
    body: input.report,
    askedBy: input.by,
  });
  const events: AppendInput[] = [];
  if (phase.report_desk_item_id && (await openItem(db, phase.report_desk_item_id)))
    events.push(
      resolveItemEvent(phase, phase.report_desk_item_id, 'dismissed', 'replaced by an updated report'),
    );
  events.push(item.event, {
    streamId: streamId.phase(phase.id),
    event: {
      type: 'PhaseReportPosted',
      payload: {
        phaseId: phase.id,
        deskItemId: item.deskItemId,
        report: input.report,
        outstanding: input.outstanding,
        by: input.by,
      },
    },
    actor: actorOf(input.by),
    scope: phaseScope(phase),
  });
  return events;
}
