import { randomUUID } from 'node:crypto';
import {
  MAIL_DRAFT_OUTCOME,
  MAIL_DRAFT_TTL_HOURS,
  MailDraftDataSchema,
  type MailDraftDto,
  type MailDraftTask,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, forbidden } from '../errors.ts';
import { carrierProject } from '../reporter/tasks.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { replyAddress, resolveThread, revealedMarkers, type ThreadRef } from './mail-reply.ts';
import type { ReportResult } from './shifts.ts';

/**
 * "Draft with BA" for e-mail replies (#15 leftover, #67 D). The person asks; a `mail_reply_draft` BA task writes the reply
 * from the conversation and the card; the draft waits in `mail_reply_drafts` until the person opens the reply box, edits it
 * and sends it. The BA never sends anything, and the existing reveal check still runs on send (and on the draft itself).
 */

type User = AuthSession['user'];

/** Drafts one organisation can ask for per hour: a guard against a stuck button. */
export const MAIL_DRAFTS_PER_ORG_PER_HOUR = 20;
/** A request that is still queued after this long is shown as not delivered (the dispatcher falls back sooner). */
const OPEN_REQUEST_MINUTES = 30;

type DraftRow = Row & { task_status?: string | null };

function toDto(d: DraftRow): MailDraftDto {
  let status: MailDraftDto['status'] =
    d.status === 'done' ? 'done' : d.status === 'failed' ? 'failed' : 'queued';
  let error: string | null = d.error ?? null;
  if (status === 'queued') {
    if (d.task_status === 'running') status = 'running';
    else if (d.task_status && ['failed', 'fallback', 'cancelled'].includes(d.task_status)) {
      status = 'failed';
      error = error ?? 'The BA could not write a draft this time. Try again, or write the reply yourself.';
    }
  }
  return {
    id: d.id,
    status,
    text: status === 'done' ? (d.body_text ?? null) : null,
    subject: status === 'done' ? (d.subject ?? null) : null,
    error: status === 'failed' ? error : null,
    createdAt: iso(d.created_at) as string,
  };
}

const SELECT_DRAFT = `SELECT d.*, t.status AS task_status FROM mail_reply_drafts d LEFT JOIN ba_tasks t ON t.id = d.task_id`;

/** The latest draft this person asked for on the conversation that they have not used (and is not stale), or null. */
export async function currentMailDraft(ctx: Ctx, user: User, by: ThreadRef): Promise<MailDraftDto | null> {
  const { thread } = await resolveThread(ctx, user, by);
  const d = await one<DraftRow>(
    ctx.pool,
    `${SELECT_DRAFT}
      WHERE d.thread_id=$1 AND d.requested_by=$2 AND d.used_at IS NULL AND d.created_at > $3
      ORDER BY d.created_at DESC LIMIT 1`,
    [thread.id, user.id, new Date(ctx.clock.now().getTime() - MAIL_DRAFT_TTL_HOURS * 3_600_000)],
  );
  return d ? toDto(d) : null;
}

/** Queues a draft task for the conversation. Asking again while one is on its way returns that one. */
export async function requestMailDraft(ctx: Ctx, user: User, by: ThreadRef): Promise<MailDraftDto> {
  const { thread, card, canReply, reason } = await resolveThread(ctx, user, by);
  if (!canReply) throw forbidden(reason ?? 'you may not reply to this conversation');
  if (!(await replyAddress(ctx.pool, thread.id)))
    throw conflict('nobody_to_answer', 'there is no accepted message from a sender to answer');
  const now = ctx.clock.now();
  const open = await one<DraftRow>(
    ctx.pool,
    `${SELECT_DRAFT}
      WHERE d.thread_id=$1 AND d.requested_by=$2 AND d.status='queued' AND d.created_at > $3
        AND COALESCE(t.status,'queued') IN ('queued','running')
      ORDER BY d.created_at DESC LIMIT 1`,
    [thread.id, user.id, new Date(now.getTime() - OPEN_REQUEST_MINUTES * 60_000)],
  );
  if (open) return toDto(open);
  const recent = Number(
    (
      await one(ctx.pool, `SELECT count(*) AS n FROM mail_reply_drafts WHERE org_id=$1 AND created_at > $2`, [
        thread.org_id,
        new Date(now.getTime() - 3_600_000),
      ])
    )?.n ?? 0,
  );
  if (recent >= MAIL_DRAFTS_PER_ORG_PER_HOUR)
    throw conflict('draft_rate_limited', 'too many drafts were asked for in the last hour; try again later');
  const ba = await one(
    ctx.pool,
    `SELECT 1 FROM agents WHERE org_id=$1 AND role_key='ba' AND status='active' AND NOT is_devops LIMIT 1`,
    [thread.org_id],
  );
  if (!ba)
    throw conflict(
      'no_ba',
      'There is no business analyst (BA) to write the draft. Hire a BA under Agents, or write the reply yourself.',
    );
  const inbox = await one(ctx.pool, 'SELECT project_id FROM mail_inboxes WHERE id=$1', [thread.inbox_id]);
  const projectId = await carrierProject(
    ctx.pool,
    thread.org_id,
    (card?.project_id as string | undefined) ?? (inbox?.project_id as string | null) ?? null,
  );
  if (!projectId) throw conflict('no_project', 'The organisation needs a project before the BA can work.');

  const id = randomUUID();
  const taskId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await tx.query(
      `INSERT INTO mail_reply_drafts (id, org_id, thread_id, requested_by, task_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [id, thread.org_id, thread.id, user.id, taskId, now],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.baTask(taskId),
          event: {
            type: 'BaTaskQueued',
            payload: {
              taskId,
              projectId,
              kind: 'mail_reply_draft',
              orgLevel: true,
              mailDraftId: id,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(thread.org_id, projectId),
        },
      ],
      { tx },
    );
  });
  return toDto((await one<DraftRow>(ctx.pool, `${SELECT_DRAFT} WHERE d.id=$1`, [id])) as DraftRow);
}

/** The reply was sent from this person's draft: it is not offered again. */
export async function markDraftUsed(
  db: Queryable,
  threadId: string,
  userId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `UPDATE mail_reply_drafts SET used_at=$3, updated_at=$3 WHERE thread_id=$1 AND requested_by=$2 AND used_at IS NULL`,
    [threadId, userId, now],
  );
}

// ------------------------------------------------------------------------------- the BA's side

/** What the BA is given: the conversation (the latest messages), the person who sends, and the card. */
export async function buildMailDraftTask(db: Queryable, task: Row): Promise<MailDraftTask | null> {
  const d = await one(db, 'SELECT * FROM mail_reply_drafts WHERE id=$1', [task.mail_draft_id]);
  if (!d) return null;
  const thread = await one(db, 'SELECT * FROM mail_threads WHERE id=$1', [d.thread_id]);
  if (!thread) return null;
  const org = await one(db, 'SELECT name FROM organizations WHERE id=$1', [d.org_id]);
  const sender = await one(db, 'SELECT display_name FROM users WHERE id=$1', [d.requested_by]);
  const msgs = await rows(
    db,
    `SELECT m.*, u.display_name AS sent_by_name FROM mail_messages m LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.thread_id=$1 AND m.status <> 'skipped' ORDER BY m.received_at DESC, m.id DESC LIMIT 12`,
    [thread.id],
  );
  msgs.reverse();
  const to = await replyAddress(db, thread.id);
  const first = await one(
    db,
    'SELECT subject FROM mail_messages WHERE thread_id=$1 ORDER BY received_at, id LIMIT 1',
    [thread.id],
  );
  const card = thread.card_id
    ? await one(db, 'SELECT * FROM cards WHERE id=$1', [thread.card_id])
    : undefined;
  const text = card
    ? Object.values((card.fields ?? {}) as Record<string, unknown>)
        .filter((v): v is string => typeof v === 'string')
        .join('\n\n')
    : '';
  return {
    draftId: d.id,
    orgName: org?.name ?? 'the organisation',
    senderName: sender?.display_name ?? 'the team',
    to: to ?? '',
    subject: first?.subject ?? '(no subject)',
    messages: msgs.map((m) => ({
      direction: m.direction,
      from: m.from_address,
      fromName: m.direction === 'out' ? (m.sent_by_name ?? null) : (m.from_name ?? null),
      at: iso(m.received_at) as string,
      text: m.body_text ?? '',
    })),
    ...(card
      ? {
          card: {
            ref: card.ref,
            title: card.title,
            status: card.status,
            stage: card.stage ?? null,
            text,
          },
        }
      : {}),
  };
}

const done = (task: Row, status: 'done' | 'failed' | 'fallback', note?: string) => ({
  streamId: streamId.baTask(task.id),
  event: {
    type: 'BaTaskCompleted' as const,
    payload: { taskId: task.id, status, ...(note ? { note } : {}) },
  },
  actor: SYSTEM_ACTOR,
  scope: task.project_id ? projectScope(task.org_id, task.project_id) : orgScope(task.org_id),
});

/** The terminal report of a `mail_reply_draft` shift: the draft (checked for what a client must not see), or "no reply". */
export async function applyMailDraftReport(
  ctx: Ctx,
  tx: Tx,
  task: Row,
  msg: RunnerToServerOf<'shift.report'>,
): Promise<ReportResult> {
  const report = msg.report;
  if (report.kind === 'comment') return { accepted: true };
  if (report.kind !== 'outcome')
    return {
      accepted: false,
      error:
        'there are no questions in a background task: write the draft or report that none can be written',
    };
  const draft = await one(tx, 'SELECT * FROM mail_reply_drafts WHERE id=$1 FOR UPDATE', [task.mail_draft_id]);
  if (!draft) return { accepted: false, error: 'the draft request is gone. Finish now.' };
  const now = ctx.clock.now();
  if (report.outcomeId === MAIL_DRAFT_OUTCOME.fail) {
    const why =
      (report.note ?? '').trim().slice(0, 500) || 'The BA could not write a reply from this conversation.';
    await tx.query(`UPDATE mail_reply_drafts SET status='failed', error=$2, updated_at=$3 WHERE id=$1`, [
      draft.id,
      why,
      now,
    ]);
    await ctx.store.append([done(task, 'done', why)], { tx });
    return { accepted: true };
  }
  if (report.outcomeId !== MAIL_DRAFT_OUTCOME.done)
    return {
      accepted: false,
      error: `outcome '${report.outcomeId}' is not available (allowed: ${MAIL_DRAFT_OUTCOME.done}, ${MAIL_DRAFT_OUTCOME.fail})`,
    };
  const data = MailDraftDataSchema.safeParse(report.data);
  if (!data.success) return { accepted: false, error: `invalid draft: ${data.error.message}` };
  const markers = await revealedMarkers(tx, draft.org_id, data.data.text, data.data.subject ?? '');
  if (markers.length)
    return {
      accepted: false,
      error: `Clients must not see agents, AI or Guildwise. Take out ${markers.map((m) => `"${m}"`).join(', ')} and report again.`,
    };
  await tx.query(
    `UPDATE mail_reply_drafts SET status='done', body_text=$2, subject=$3, error=NULL, updated_at=$4 WHERE id=$1`,
    [draft.id, data.data.text, data.data.subject ?? null, now],
  );
  await ctx.store.append([done(task, 'done')], { tx });
  return { accepted: true };
}

/** No BA took the task in time (or it failed twice): the draft is marked failed and the person writes the reply themselves. */
export async function runMailDraftFallback(ctx: Ctx, tx: Tx, task: Row): Promise<void> {
  const why = 'No BA was available to write the draft. Try again, or write the reply yourself.';
  await tx.query(
    `UPDATE mail_reply_drafts SET status='failed', error=$2, updated_at=$3 WHERE id=$1 AND status='queued'`,
    [task.mail_draft_id, why, ctx.clock.now()],
  );
  await ctx.store.append([done(task, 'fallback', 'no BA was available to write the draft')], { tx });
}
