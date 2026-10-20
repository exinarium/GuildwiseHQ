import { randomUUID } from 'node:crypto';
import {
  BA_ROLE_KEY,
  BATCH_MAX_TICKETS,
  BATCH_OUTCOME,
  BATCH_QUESTION_SUBKIND,
  BatchAskDataSchema,
  type BatchCounts,
  type BatchDto,
  type BatchItemDto,
  type BatchItemStatus,
  type BatchStatus,
  type BatchSummaryDto,
  type BatchTask,
  type CreateBatchRequest,
  isOrgManager,
  type OrgRole,
  optionId,
  parseBatchTickets,
  parseExternalRef,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { carrierProject } from '../ceo/carrier.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { type Responder, visibleProjects } from './intake.ts';
import { agentBy, systemBy } from './phase-events.ts';
import type { ReportResult } from './shifts.ts';

const COUNT_KEYS: BatchItemStatus[] = [
  'queued',
  'reading',
  'waiting',
  'done',
  'skipped',
  'failed',
  'cancelled',
];

const taskScope = (orgId: string, projectId: string | null) =>
  projectId ? projectScope(orgId, projectId) : orgScope(orgId);

/** `BaTaskQueued` for one batch item. The task is org level: any BA of the organization may take it. */
const queueTaskEvent = (
  orgId: string,
  carrierId: string,
  taskId: string,
  batchId: string,
  itemId: string,
): AppendInput => ({
  streamId: streamId.baTask(taskId),
  event: {
    type: 'BaTaskQueued',
    payload: {
      taskId,
      projectId: carrierId,
      kind: 'batch_intake',
      orgLevel: true,
      batchId,
      batchItemId: itemId,
    },
  },
  actor: SYSTEM_ACTOR,
  scope: projectScope(orgId, carrierId),
});

const completedEvent = (
  task: Row,
  status: 'done' | 'failed' | 'fallback' | 'cancelled',
  note?: string,
): AppendInput => ({
  streamId: streamId.baTask(task.id),
  event: { type: 'BaTaskCompleted', payload: { taskId: task.id, status, ...(note ? { note } : {}) } },
  actor: SYSTEM_ACTOR,
  scope: taskScope(task.org_id, task.project_id),
});

// ------------------------------------------------------------------------------------------- queries

function statusOf(batch: Row, counts: BatchCounts): BatchStatus {
  if (batch.cancelled_at) return 'cancelled';
  return counts.queued + counts.reading + counts.waiting > 0 ? 'running' : 'done';
}

async function summaries(db: Queryable, list: Row[]): Promise<BatchSummaryDto[]> {
  if (list.length === 0) return [];
  const counted = await rows(
    db,
    `SELECT batch_id, status, count(*)::int AS n FROM intake_batch_items WHERE batch_id = ANY($1::uuid[]) GROUP BY 1,2`,
    [list.map((b) => b.id)],
  );
  return list.map((b) => {
    const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as BatchCounts;
    for (const c of counted) if (c.batch_id === b.id) counts[c.status as BatchItemStatus] = c.n;
    const total = COUNT_KEYS.reduce((n, k) => n + counts[k], 0);
    return {
      id: b.id,
      status: statusOf(b, counts),
      projectKey: b.project_key ?? null,
      note: b.note ?? null,
      createdById: b.created_by,
      createdByName: b.created_by_name ?? null,
      total,
      counts,
      createdAt: iso(b.created_at) as string,
      cancelledAt: iso(b.cancelled_at),
    };
  });
}

const BATCH_SELECT = `
SELECT b.*, p.key AS project_key, u.display_name AS created_by_name
  FROM intake_batches b LEFT JOIN projects p ON p.id = b.project_id LEFT JOIN users u ON u.id = b.created_by`;

export async function listBatches(ctx: Ctx, orgId: string): Promise<BatchSummaryDto[]> {
  return summaries(
    ctx.pool,
    await rows(ctx.pool, `${BATCH_SELECT} WHERE b.org_id=$1 ORDER BY b.created_at DESC, b.id LIMIT 50`, [
      orgId,
    ]),
  );
}

export async function getBatch(ctx: Ctx, orgId: string, id: string): Promise<BatchDto> {
  const b = await one(ctx.pool, `${BATCH_SELECT} WHERE b.id=$1 AND b.org_id=$2`, [id, orgId]);
  if (!b) throw notFound('batch not found');
  const [summary] = await summaries(ctx.pool, [b]);
  const items = await rows(
    ctx.pool,
    `SELECT i.*, k.thread_id FROM intake_batch_items i LEFT JOIN intakes k ON k.id = i.intake_id
      WHERE i.batch_id=$1 ORDER BY i.position`,
    [id],
  );
  const made = await rows(
    ctx.pool,
    `SELECT ic.intake_id, c.ref FROM intake_cards ic JOIN cards c ON c.id = ic.card_id
      WHERE ic.intake_id = ANY($1::uuid[]) ORDER BY c.number`,
    [items.map((i) => i.intake_id).filter(Boolean)],
  );
  const refsOf = (i: Row): string[] => [
    ...new Set([
      ...(i.card_refs as string[]),
      ...made.filter((m) => m.intake_id === i.intake_id).map((m) => m.ref),
    ]),
  ];
  const allRefs = [...new Set(items.flatMap(refsOf))];
  const cards = allRefs.length
    ? await rows(
        ctx.pool,
        `SELECT c.ref, c.title, p.key AS project_key FROM cards c JOIN projects p ON p.id = c.project_id
          WHERE c.ref = ANY($1::text[]) AND p.org_id = $2`,
        [allRefs, orgId],
      )
    : [];
  const dtoItems: BatchItemDto[] = items.map((i) => ({
    id: i.id,
    position: i.position,
    externalSystem: i.external_system,
    externalKey: i.external_key,
    url: i.url,
    status: i.status,
    reason: i.reason,
    summary: i.summary,
    cards: refsOf(i).map((ref) => {
      const c = cards.find((x) => x.ref === ref);
      return { ref, title: c?.title ?? null, projectKey: c?.project_key ?? null };
    }),
    deskItemId: i.desk_item_id,
    question: i.question,
    intakeId: i.intake_id,
    threadId: i.thread_id ?? null,
    attempts: i.attempts,
  }));
  return { ...(summary as BatchSummaryDto), items: dtoItems };
}

// -------------------------------------------------------------------------------------------- create

/** Cards and intakes that already cover a ticket, by `externalRef` / external key (same ticket, any spelling). */
async function existingFor(
  db: Queryable,
  userId: string,
  orgId: string,
  keys: string[],
): Promise<Map<string, { cards: string[]; intake: boolean }>> {
  const found = new Map<string, { cards: string[]; intake: boolean }>();
  const slot = (k: string) => {
    const f = found.get(k.toLowerCase()) ?? { cards: [], intake: false };
    found.set(k.toLowerCase(), f);
    return f;
  };
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  const projectIds = (await visibleProjects(db, userId, orgId)).map((p) => p.id);
  const cards = await rows(
    db,
    `SELECT c.ref, c.fields->>'externalRef' AS ext FROM cards c
      WHERE c.project_id = ANY($1::uuid[]) AND coalesce(c.fields->>'externalRef','') <> '' AND c.status <> 'cancelled'
      ORDER BY c.created_at`,
    [projectIds],
  );
  for (const c of cards) {
    const ref = parseExternalRef(String(c.ext));
    const key = ref ? (ref.system === 'jira' ? ref.key.toUpperCase() : ref.key) : String(c.ext).trim();
    if (wanted.has(key.toLowerCase())) slot(key).cards.push(c.ref);
  }
  const intakes = await rows(
    db,
    `SELECT external_key FROM intakes WHERE org_id=$1 AND external_key IS NOT NULL`,
    [orgId],
  );
  for (const i of intakes)
    if (wanted.has(String(i.external_key).toLowerCase())) slot(i.external_key).intake = true;
  return found;
}

/**
 * The owner hands the BA a list of tickets (#63): one item and one `batch_intake` BA task per ticket. A ticket that
 * already has a card (or an intake) is recorded as skipped. Needs a hired BA; if it is offline the items wait.
 */
export async function createBatch(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  req: CreateBatchRequest,
): Promise<BatchDto> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can start a batch intake');
  const parsed = parseBatchTickets(req.tickets);
  if (parsed.invalid.length)
    throw badRequest(
      'invalid_tickets',
      `not a Jira key, GitHub issue or ticket URL: ${parsed.invalid.slice(0, 5).join(', ')}${parsed.invalid.length > 5 ? ` (and ${parsed.invalid.length - 5} more)` : ''}`,
      { invalid: parsed.invalid },
    );
  if (parsed.tickets.length === 0) throw badRequest('no_tickets', 'give at least one ticket');
  if (parsed.tickets.length > BATCH_MAX_TICKETS)
    throw badRequest('too_many_tickets', `a batch holds at most ${BATCH_MAX_TICKETS} tickets`);
  if (req.projectId) {
    const ok = (await visibleProjects(ctx.pool, user.id, org.id)).some((p) => p.id === req.projectId);
    if (!ok) throw badRequest('unknown_project', 'that project is not one you can use');
  }
  const bas = await one(
    ctx.pool,
    `SELECT 1 FROM agents a JOIN workstations ws ON ws.id = a.workstation_id
      WHERE a.org_id=$1 AND a.role_key=$2 AND a.status='active' AND ws.status='active' LIMIT 1`,
    [org.id, BA_ROLE_KEY],
  );
  if (!bas) throw conflict('no_ba', 'Hire a business analyst (BA) first: batch intake is work for the BA.');
  const carrier = await carrierProject(ctx.pool, org.id, req.projectId ?? null);
  if (!carrier) throw conflict('no_project', 'the organization has no active project yet');

  const existing = await existingFor(
    ctx.pool,
    user.id,
    org.id,
    parsed.tickets.map((t) => t.key),
  );
  const batchId = randomUUID();
  const items = parsed.tickets.map((t, position) => {
    const ex = existing.get(t.key.toLowerCase());
    const skipReason = ex?.cards.length
      ? `skipped: already ${ex.cards.join(', ')}`
      : ex?.intake
        ? 'skipped: already taken in an intake'
        : undefined;
    return {
      itemId: randomUUID(),
      taskId: undefined as string | undefined,
      position,
      system: t.system,
      key: t.key,
      ...(t.url ? { url: t.url } : {}),
      ...(skipReason
        ? { skipReason, existingCardRefs: ex?.cards ?? [] }
        : { taskId: randomUUID() as string | undefined }),
    };
  });
  await ctx.store.append([
    {
      streamId: streamId.intakeBatch(batchId),
      event: {
        type: 'IntakeBatchCreated',
        payload: {
          batchId,
          createdBy: user.id,
          ...(req.projectId ? { projectId: req.projectId } : {}),
          ...(req.note?.trim() ? { note: req.note.trim() } : {}),
          items,
        },
      },
      actor: userActor(user.id),
      scope: orgScope(org.id),
    },
    ...items.flatMap((i) => (i.taskId ? [queueTaskEvent(org.id, carrier, i.taskId, batchId, i.itemId)] : [])),
  ]);
  ctx.services.dispatcher.trigger();
  return getBatch(ctx, org.id, batchId);
}

// ------------------------------------------------------------------------------------ cancel / retry

async function lockBatch(tx: Tx, orgId: string, id: string): Promise<Row> {
  const b = await one(tx, 'SELECT * FROM intake_batches WHERE id=$1 AND org_id=$2 FOR UPDATE', [id, orgId]);
  if (!b) throw notFound('batch not found');
  return b;
}

/** Cancel: queued and waiting items stop (their tasks and desk questions are closed); items a BA is reading finish. */
export async function cancelBatch(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  id: string,
): Promise<BatchDto> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can cancel a batch intake');
  await withAppendTx(ctx.pool, async (tx) => {
    const batch = await lockBatch(tx, org.id, id);
    if (batch.cancelled_at) throw conflict('already_cancelled', 'this batch is already cancelled');
    const open = await rows(
      tx,
      `SELECT * FROM intake_batch_items WHERE batch_id=$1 AND status IN ('queued','waiting')`,
      [id],
    );
    const events: AppendInput[] = [
      {
        streamId: streamId.intakeBatch(id),
        event: { type: 'IntakeBatchCancelled', payload: { batchId: id, cancelledBy: user.id } },
        actor: userActor(user.id),
        scope: orgScope(org.id),
      },
    ];
    for (const i of open) {
      if (i.status === 'queued' && i.task_id) {
        const task = await one(tx, `SELECT * FROM ba_tasks WHERE id=$1 AND status='queued' FOR UPDATE`, [
          i.task_id,
        ]);
        if (task) events.push(completedEvent(task, 'cancelled', 'the batch was cancelled'));
      }
      if (i.status === 'waiting' && i.desk_item_id) {
        const d = await one(tx, `SELECT id FROM desk_items WHERE id=$1 AND status='open'`, [i.desk_item_id]);
        if (d)
          events.push({
            streamId: streamId.desk(d.id),
            event: {
              type: 'DeskItemResolved',
              payload: {
                deskItemId: d.id,
                resolution: 'dismissed',
                note: 'the batch was cancelled',
                by: systemBy,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(org.id),
          });
      }
    }
    await ctx.store.append(events, { tx });
  });
  return getBatch(ctx, org.id, id);
}

/** Retry a failed item: a new BA task for the same ticket (the cards it created before stay and are shown to the BA). */
export async function retryBatchItem(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  id: string,
  itemId: string,
): Promise<BatchDto> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can retry a batch item');
  await withAppendTx(ctx.pool, async (tx) => {
    const batch = await lockBatch(tx, org.id, id);
    if (batch.cancelled_at) throw conflict('cancelled', 'this batch was cancelled');
    const item = await one(tx, 'SELECT * FROM intake_batch_items WHERE id=$1 AND batch_id=$2 FOR UPDATE', [
      itemId,
      id,
    ]);
    if (!item) throw notFound('item not found');
    if (item.status !== 'failed')
      throw conflict('not_failed', `only a failed item can be retried (it is ${item.status})`);
    const carrier = await carrierProject(tx, org.id, batch.project_id);
    if (!carrier) throw conflict('no_project', 'the organization has no active project yet');
    const taskId = randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.intakeBatch(id),
          event: {
            type: 'IntakeBatchItemRequeued',
            payload: { batchId: id, itemId, taskId, reason: 'retry' },
          },
          actor: userActor(user.id),
          scope: orgScope(org.id),
        },
        queueTaskEvent(org.id, carrier, taskId, id, itemId),
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
  return getBatch(ctx, org.id, id);
}

// --------------------------------------------------------------------------------- desk question hooks

/**
 * The owner answered the desk question of a waiting item: the item gets a new BA task that carries the answer. Runs in the
 * answer transaction. Returns true when a task was queued (the caller wakes the dispatcher).
 */
export async function batchAnsweredEvents(
  tx: Tx,
  desk: Row,
  answer: string,
): Promise<{ events: AppendInput[]; queued: boolean }> {
  const itemId = (desk.data as { itemId?: string } | null)?.itemId;
  const item = itemId
    ? await one(tx, 'SELECT * FROM intake_batch_items WHERE id=$1 FOR UPDATE', [itemId])
    : undefined;
  if (!item || item.status !== 'waiting' || item.desk_item_id !== desk.id)
    return { events: [], queued: false };
  const batch = await one(tx, 'SELECT * FROM intake_batches WHERE id=$1', [item.batch_id]);
  if (!batch || batch.cancelled_at) return { events: [], queued: false };
  const carrier = await carrierProject(tx, batch.org_id, batch.project_id);
  if (!carrier) return { events: [], queued: false };
  const taskId = randomUUID();
  return {
    queued: true,
    events: [
      {
        streamId: streamId.intakeBatch(batch.id),
        event: {
          type: 'IntakeBatchItemRequeued',
          payload: { batchId: batch.id, itemId: item.id, taskId, reason: 'answered', answer },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(batch.org_id),
      },
      queueTaskEvent(batch.org_id, carrier, taskId, batch.id, item.id),
    ],
  };
}

/** The owner dismissed the question instead of answering it: the item fails (Retry asks the BA again). */
export async function batchDismissedEvents(tx: Tx, desk: Row): Promise<AppendInput[]> {
  const itemId = (desk.data as { itemId?: string } | null)?.itemId;
  const item = itemId ? await one(tx, 'SELECT * FROM intake_batch_items WHERE id=$1', [itemId]) : undefined;
  if (!item || item.status !== 'waiting' || item.desk_item_id !== desk.id) return [];
  return [
    {
      streamId: streamId.intakeBatch(item.batch_id),
      event: {
        type: 'IntakeBatchItemResolved',
        payload: {
          batchId: item.batch_id,
          itemId: item.id,
          outcome: 'failed',
          cardRefs: [],
          reason: 'the question was dismissed without an answer',
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(desk.org_id),
    },
  ];
}

// ------------------------------------------------------------------------------- the BA shift side

/** What the BA is given for a `batch_intake` task. */
export async function buildBatchTask(db: Queryable, task: Row): Promise<BatchTask | null> {
  const item = await one(db, 'SELECT * FROM intake_batch_items WHERE id=$1', [task.batch_item_id]);
  const batch = item ? await one(db, 'SELECT * FROM intake_batches WHERE id=$1', [item.batch_id]) : undefined;
  if (!item || !batch) return null;
  const projects = await visibleProjects(db, batch.created_by, batch.org_id);
  const project = projects.find((p) => p.id === batch.project_id);
  const cards = item.intake_id
    ? await rows(
        db,
        `SELECT c.ref, c.title, c.status FROM intake_cards ic JOIN cards c ON c.id = ic.card_id
          WHERE ic.intake_id=$1 ORDER BY c.number`,
        [item.intake_id],
      )
    : [];
  return {
    batchId: batch.id,
    itemId: item.id,
    system: item.external_system,
    ticketKey: item.external_key,
    ...(item.url ? { ticketUrl: item.url } : {}),
    ...(project ? { projectKey: project.key } : {}),
    ...(batch.note ? { note: batch.note } : {}),
    projects: projects.map((p) => ({ key: p.key, name: p.name, repos: p.repos })),
    cards: cards.map((c) => ({ ref: c.ref, title: c.title, status: c.status })),
    answers: (item.qa as Array<{ question: string; answer: string | null }>).map((a) => ({
      question: a.question,
      answer: a.answer ?? null,
    })),
  };
}

/**
 * The intake a `batch_intake` shift works in (created with the first card verb, like a chat that turns into an
 * intake): it carries the ticket key, the batch creator's rights and the links to the cards. A later task for the same
 * item (after an answer, or a retry) continues in the same intake.
 */
export async function batchIntakeOf(ctx: Ctx, shift: Row): Promise<Responder | null> {
  const task = await one(
    ctx.pool,
    `SELECT * FROM ba_tasks WHERE shift_id=$1 AND kind='batch_intake' AND status='running'`,
    [shift.id],
  );
  const agent = task ? await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]) : undefined;
  if (!task || !agent) return null;
  const intake = await withAppendTx(ctx.pool, async (tx) => {
    const item = await one(tx, 'SELECT * FROM intake_batch_items WHERE id=$1 FOR UPDATE', [
      task.batch_item_id,
    ]);
    const batch = item
      ? await one(tx, 'SELECT * FROM intake_batches WHERE id=$1', [item.batch_id])
      : undefined;
    if (!item || !batch) return undefined;
    if (item.intake_id) return one(tx, 'SELECT * FROM intakes WHERE id=$1', [item.intake_id]);
    const intakeId = randomUUID();
    const threadId = randomUUID();
    const scope = orgScope(batch.org_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.intake(intakeId),
        event: {
          type: 'IntakeStarted',
          payload: {
            intakeId,
            threadId,
            externalSystem: item.external_system,
            externalKey: item.external_key,
            startedBy: batch.created_by,
            baAgentId: agent.id,
            note: `Batch intake of ${item.external_key}${batch.note ? `: ${batch.note}` : ''}`.slice(
              0,
              20000,
            ),
          },
        },
        actor: userActor(batch.created_by),
        scope,
      },
      {
        streamId: streamId.intakeBatch(batch.id),
        event: { type: 'IntakeBatchItemLinked', payload: { batchId: batch.id, itemId: item.id, intakeId } },
        actor: agentActor(agent.id),
        scope,
      },
    ];
    if (batch.project_id)
      events.push({
        streamId: streamId.intake(intakeId),
        event: { type: 'TicketMapped', payload: { intakeId, projectId: batch.project_id, unmapped: false } },
        actor: agentActor(agent.id),
        scope,
      });
    await ctx.store.append(events, { tx });
    return one(tx, 'SELECT * FROM intakes WHERE id=$1', [intakeId]);
  });
  return intake ? { intake, agent } : null;
}

/** Intake verbs in a batch shift: the project the owner chose for the batch cannot be changed by the BA. */
export async function batchRpcGuard(
  ctx: Ctx,
  shift: Row,
  method: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  if (method === 'intake.unmapped')
    return 'there is no conversation in a batch: if no project fits, ask the owner with `aom batch ask --text "<question>"` and end the shift';
  if (method !== 'intake.map') return null;
  const row = await one(
    ctx.pool,
    `SELECT p.key FROM ba_tasks t JOIN intake_batches b ON b.id = t.batch_id JOIN projects p ON p.id = b.project_id
      WHERE t.shift_id=$1`,
    [shift.id],
  );
  if (row && String(params.project ?? '').toUpperCase() !== row.key)
    return `the owner chose project ${row.key} for this batch: cards go there`;
  return null;
}

/** Terminal reports of a `batch_intake` shift (`aom batch done|ask|skip|fail`). */
export async function applyBatchReport(
  ctx: Ctx,
  tx: Tx,
  shift: Row,
  task: Row,
  report: RunnerToServerOf<'shift.report'>['report'],
): Promise<ReportResult> {
  if (report.kind === 'comment') return { accepted: true };
  if (report.kind !== 'outcome')
    return {
      accepted: false,
      error:
        'there are no questions in a background task: end the shift with `aom batch ask --text "<question>"`',
    };
  const bad = (m: string): ReportResult => ({ accepted: false, error: m });
  const item = await one(tx, 'SELECT * FROM intake_batch_items WHERE id=$1 FOR UPDATE', [task.batch_item_id]);
  const batch = item ? await one(tx, 'SELECT * FROM intake_batches WHERE id=$1', [item.batch_id]) : undefined;
  if (!item || !batch) {
    await ctx.store.append([completedEvent(task, 'cancelled', 'the batch item is gone')], { tx });
    return bad('this batch item is gone. Finish now.');
  }
  const scope = orgScope(task.org_id);
  const resolved = (
    outcome: 'done' | 'skipped' | 'failed' | 'cancelled',
    extra: { cardRefs?: string[]; summary?: string; reason?: string } = {},
  ): AppendInput => ({
    streamId: streamId.intakeBatch(batch.id),
    event: {
      type: 'IntakeBatchItemResolved',
      payload: { batchId: batch.id, itemId: item.id, outcome, cardRefs: extra.cardRefs ?? [], ...extra },
    },
    actor: agentActor(shift.agent_id),
    scope,
  });
  const cardsOf = async () =>
    item.intake_id
      ? await rows(
          tx,
          `SELECT c.ref, c.status FROM intake_cards ic JOIN cards c ON c.id = ic.card_id
            WHERE ic.intake_id=$1 ORDER BY c.number`,
          [item.intake_id],
        )
      : [];
  const note = report.note?.trim() ?? '';

  switch (report.outcomeId) {
    case BATCH_OUTCOME.done: {
      const cards = await cardsOf();
      if (cards.length === 0 && item.card_refs.length === 0)
        return bad(
          'you created no card for this ticket: create and specify the cards first, or end with `aom batch skip` / `aom batch ask`',
        );
      const drafts = cards.filter((c) => c.status === 'draft').map((c) => c.ref);
      if (drafts.length)
        return bad(
          `${drafts.join(', ')} ${drafts.length === 1 ? 'is' : 'are'} still a draft: \`aom card specify <REF>\` when complete, or ask the owner what is missing with \`aom batch ask\``,
        );
      await ctx.store.append(
        [
          resolved('done', { cardRefs: cards.map((c) => c.ref), ...(note ? { summary: note } : {}) }),
          completedEvent(task, 'done'),
        ],
        { tx },
      );
      return { accepted: true };
    }
    case BATCH_OUTCOME.skip:
      await ctx.store.append(
        [
          resolved('skipped', { reason: note ? `skipped: ${note}` : 'skipped by the BA' }),
          completedEvent(task, 'done'),
        ],
        { tx },
      );
      return { accepted: true };
    case BATCH_OUTCOME.fail:
      await ctx.store.append(
        [
          resolved('failed', { reason: note || 'the BA could not turn this ticket into cards' }),
          completedEvent(task, 'done'),
        ],
        { tx },
      );
      return { accepted: true };
    case BATCH_OUTCOME.ask: {
      const data = BatchAskDataSchema.safeParse({ question: report.data?.question ?? note, ...report.data });
      if (!data.success) return bad(`invalid question: ${data.error.message}`);
      if (batch.cancelled_at) {
        await ctx.store.append(
          [resolved('cancelled', { reason: 'the batch was cancelled' }), completedEvent(task, 'done')],
          { tx },
        );
        return bad('the batch was cancelled. Finish now.');
      }
      const q = data.data;
      if (q.recommend !== undefined && q.recommend >= q.options.length)
        return bad(`--recommend ${q.recommend} does not match an --option (the first option is 0)`);
      const deskItemId = randomUUID();
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'QuestionRaised',
              payload: {
                deskItemId,
                askedBy: agentBy(shift.agent_id),
                doing: `Batch intake of ${item.external_key} (ticket ${item.position + 1} of the batch started ${iso(batch.created_at)?.slice(0, 16).replace('T', ' ')})`,
                question: `${item.external_key}: ${q.question}`.slice(0, 20000),
                options: q.options.map((label, i) => ({ id: optionId(i), label })),
                ...(q.recommend !== undefined ? { recommendation: optionId(q.recommend) } : {}),
                blocking: false,
                routedTo: 'manager',
                chainLevel: 'desk',
                dedupLedgerIds: [],
                affectedCardIds: [],
                pinned: false,
                subkind: BATCH_QUESTION_SUBKIND,
                data: { batchId: batch.id, itemId: item.id, ticketKey: item.external_key },
              },
            },
            actor: agentActor(shift.agent_id),
            scope,
          },
          {
            streamId: streamId.intakeBatch(batch.id),
            event: {
              type: 'IntakeBatchItemWaiting',
              payload: { batchId: batch.id, itemId: item.id, deskItemId, question: q.question },
            },
            actor: agentActor(shift.agent_id),
            scope,
          },
          completedEvent(task, 'done', 'waiting for the owner'),
        ],
        { tx },
      );
      return { accepted: true };
    }
    default:
      return bad(
        `outcome '${report.outcomeId}' is not available (allowed: ${Object.values(BATCH_OUTCOME).join(', ')})`,
      );
  }
}
