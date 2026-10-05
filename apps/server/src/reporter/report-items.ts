import { randomUUID } from 'node:crypto';
import {
  type DeskActor,
  type FloorDigest,
  REPORT_DESK_SUBKIND,
  SIGNAL_LABEL,
  type SignalBrief,
  streamId,
} from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { actorOf, agentBy, systemBy } from '../commands/phase-events.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';

export { agentBy, systemBy };

/** The scope of an org-level or project-level report event. */
const scopeOf = (orgId: string, projectId: string | null) =>
  projectId ? projectScope(orgId, projectId) : orgScope(orgId);

/**
 * The standing "BA reports" chat of the organization owner (docs/design/phases.md B6): created with the first report,
 * kept for later ones. Returns its id (null when no BA exists to talk to) and the events that create it.
 */
export async function ensureReportThread(
  db: Queryable,
  orgId: string,
  preferAgentId?: string,
): Promise<{ threadId: string | null; events: AppendInput[] }> {
  const cur = await one<{ ba_chat_thread_id: string | null }>(
    db,
    'SELECT ba_chat_thread_id FROM users WHERE id=$1',
    [orgId],
  );
  if (cur?.ba_chat_thread_id) {
    const alive = await one(
      db,
      `SELECT 1 FROM threads t JOIN agents a ON a.id = t.agent_id WHERE t.id=$1 AND a.status <> 'retired'`,
      [cur.ba_chat_thread_id],
    );
    if (alive) return { threadId: cur.ba_chat_thread_id, events: [] };
  }
  const ba =
    (preferAgentId
      ? await one(db, `SELECT id FROM agents WHERE id=$1 AND role_key='ba' AND status='active'`, [
          preferAgentId,
        ])
      : undefined) ??
    (await one(
      db,
      `SELECT id FROM agents WHERE org_id=$1 AND role_key='ba' AND status='active' AND NOT is_devops
        ORDER BY (project_id IS NULL) DESC, hired_at, id LIMIT 1`,
      [orgId],
    ));
  if (!ba) return { threadId: null, events: [] };
  const threadId = randomUUID();
  return {
    threadId,
    events: [
      {
        streamId: streamId.thread(threadId),
        event: {
          type: 'ChatThreadCreated',
          payload: { threadId, agentId: ba.id, title: 'BA reports', createdBy: orgId },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      },
      {
        streamId: streamId.user(orgId),
        event: { type: 'BaChatLinked', payload: { userId: orgId, threadId } },
        actor: SYSTEM_ACTOR,
        scope: orgScope(orgId),
      },
    ],
  };
}

const signalEvent = (
  orgId: string,
  projectId: string | null,
  signalId: string,
  deskItemId: string,
): AppendInput => ({
  streamId: streamId.baSignal(signalId),
  event: { type: 'BaSignalReported', payload: { signalId, deskItemId } },
  actor: SYSTEM_ACTOR,
  scope: scopeOf(orgId, projectId),
});

/**
 * Reports one signal to the manager: a note on the item it is about (the loop breaker's alert) or a new
 * `alert/ba_report` item with a link to the standing chat. `summary` is the BA's analysis or the server's template.
 */
export async function signalReportEvents(
  db: Queryable,
  signal: Row,
  input: {
    summary: string;
    by: DeskActor;
    annotateItemId?: string | undefined;
    baAgentId?: string | undefined;
  },
): Promise<AppendInput[]> {
  const brief = signal as unknown as { subject: SignalBrief['subject']; kind: SignalBrief['kind'] };
  const orgId = signal.org_id as string;
  const projectId = (signal.project_id as string | null) ?? null;
  const target = input.annotateItemId ?? brief.subject.deskItemId;
  if (target) {
    const item = await one(
      db,
      `SELECT id, project_id FROM desk_items WHERE id=$1 AND org_id=$2 AND status='open'`,
      [target, orgId],
    );
    if (item)
      return [
        {
          streamId: streamId.desk(item.id),
          event: {
            type: 'DeskItemAnnotated',
            payload: {
              deskItemId: item.id,
              note: input.summary,
              by: input.by,
              relatedDeskItemIds: [],
              signalId: signal.id,
            },
          },
          actor: actorOf(input.by),
          scope: scopeOf(orgId, item.project_id),
        },
        signalEvent(orgId, projectId, signal.id, item.id),
      ];
  }
  const thread = await ensureReportThread(db, orgId, input.baAgentId);
  const deskItemId = randomUUID();
  return [
    ...thread.events,
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: REPORT_DESK_SUBKIND.baReport,
          title: `${SIGNAL_LABEL[signal.kind as SignalBrief['kind']]}: ${brief.subject.title}`,
          body: input.summary,
          options: [],
          blocking: false,
          pinned: signal.kind === 'loop',
          affectedCardIds: brief.subject.cardId ? [brief.subject.cardId] : [],
          ...(brief.subject.cardId ? { cardId: brief.subject.cardId } : {}),
          ...(projectId ? { projectId } : {}),
          askedBy: input.by,
          ...(thread.threadId ? { chatThreadId: thread.threadId } : {}),
          data: { signalId: signal.id, kind: signal.kind },
        },
      },
      actor: actorOf(input.by),
      scope: scopeOf(orgId, projectId),
    },
    signalEvent(orgId, projectId, signal.id, deskItemId),
  ];
}

/** The daily floor report item (an org-level `alert`), the digest behind it and the signals it reports. */
export async function floorReportEvents(
  db: Queryable,
  orgId: string,
  input: { report: string; digest: FloorDigest; by: DeskActor; baAgentId?: string | undefined },
): Promise<AppendInput[]> {
  const thread = await ensureReportThread(db, orgId, input.baAgentId);
  const deskItemId = randomUUID();
  const d = input.digest;
  const open = d.signals.filter((s) => s.status === 'open');
  return [
    ...thread.events,
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: REPORT_DESK_SUBKIND.floorReport,
          title: `Floor report ${d.localDate}`,
          body: input.report,
          options: [],
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          askedBy: input.by,
          ...(thread.threadId ? { chatThreadId: thread.threadId } : {}),
          data: d as unknown as Record<string, unknown>,
        },
      },
      actor: actorOf(input.by),
      scope: orgScope(orgId),
    },
    ...open.map((s) => signalEvent(orgId, null, s.id, deskItemId)),
  ];
}
