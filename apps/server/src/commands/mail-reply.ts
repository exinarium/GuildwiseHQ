import {
  isOrgManager,
  isProjectMember,
  type MailReplyRequest,
  type MailThreadDto,
  parseAddress,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { sendInThread } from '../mail/inbound/reply.ts';
import { cardMessage, orgScope, userActor } from './common.ts';

/**
 * Replies to an e-mail conversation from inside Guildwise (#15). Who may answer as the organisation: the Owner and
 * Admins, and the owner and managers of the project of the card the conversation made. The reply is stored on the
 * thread, noted on the card, and goes out through the normal mailer; a person always sends it (the BA only drafts).
 */

/** Replies one organisation can send per hour: a guard against a stuck button or a stolen session. */
export const MAIL_REPLIES_PER_ORG_PER_HOUR = 30;

type User = AuthSession['user'];
export type ThreadRef = { threadId: string } | { cardId: string };

/** The thread a reply goes to, found through its card or its id; the viewer must be allowed to see it. */
async function resolveThread(
  ctx: Ctx,
  user: User,
  by: ThreadRef,
): Promise<{ thread: Row; card: Row | null; canReply: boolean; reason: string | null }> {
  if ('cardId' in by) {
    const { card, role } = await loadVisibleCard(ctx.pool, user.id, by.cardId);
    const thread = await one(ctx.pool, 'SELECT * FROM mail_threads WHERE card_id=$1 AND org_id=$2', [
      card.id,
      card.org_id,
    ]);
    if (!thread) throw notFound('this card did not come from an e-mail conversation');
    const orgRole = await orgRoleOf(ctx.pool, user.id, card.org_id);
    const ok = isProjectMember(role) || isOrgManager({ orgRole });
    return {
      thread,
      card,
      canReply: ok,
      reason: ok ? null : 'Only the Owner, Admins and the project owner or managers can reply',
    };
  }
  const thread = await one(ctx.pool, 'SELECT * FROM mail_threads WHERE id=$1', [by.threadId]);
  if (!thread) throw notFound('conversation not found');
  const orgRole = await orgRoleOf(ctx.pool, user.id, thread.org_id);
  // The inbox pages are for the organisation's Owner and Admins; anybody else is told nothing exists.
  if (!isOrgManager({ orgRole })) throw notFound('conversation not found');
  const card = thread.card_id
    ? ((await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [thread.card_id])) ?? null)
    : null;
  return { thread, card, canReply: true, reason: null };
}

/** The sender of the latest message that was accepted (a skipped message is never answered). */
async function replyAddress(db: Queryable, threadId: string): Promise<string | null> {
  const m = await one(
    db,
    `SELECT from_address FROM mail_messages
      WHERE thread_id=$1 AND direction='in' AND status <> 'skipped' ORDER BY received_at DESC, id LIMIT 1`,
    [threadId],
  );
  return m ? (parseAddress(m.from_address) ?? null) : null;
}

export async function getMailThread(ctx: Ctx, user: User, by: ThreadRef): Promise<MailThreadDto> {
  const { thread, card, canReply, reason } = await resolveThread(ctx, user, by);
  const list = await rows(
    ctx.pool,
    `SELECT m.*, u.display_name AS sent_by_name FROM mail_messages m LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.thread_id=$1 AND m.status <> 'skipped' ORDER BY m.received_at, m.id LIMIT 200`,
    [thread.id],
  );
  const to = await replyAddress(ctx.pool, thread.id);
  return {
    id: thread.id,
    inboxId: thread.inbox_id,
    subject: list[0]?.subject ?? '(no subject)',
    cardId: card?.id ?? null,
    cardRef: card?.ref ?? null,
    messages: list.map((m) => ({
      id: m.id,
      direction: m.direction,
      from: m.from_address,
      fromName: m.from_name ?? null,
      to: m.to_address,
      subject: m.subject,
      text: m.body_text,
      at: iso(m.received_at) as string,
      status: m.status,
      sentByName: m.sent_by_name ?? null,
    })),
    replyTo: to,
    canReply: canReply && to !== null,
    cannotReplyReason: !canReply
      ? reason
      : to === null
        ? 'There is no accepted message from a sender in this conversation to answer'
        : null,
  };
}

const withRe = (s: string) => (/^re:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`);

export async function replyToMailThread(
  ctx: Ctx,
  user: User,
  by: ThreadRef,
  req: MailReplyRequest,
): Promise<MailThreadDto> {
  const { thread, card, canReply, reason } = await resolveThread(ctx, user, by);
  if (!canReply) throw forbidden(reason ?? 'you may not reply to this conversation');
  const to = await replyAddress(ctx.pool, thread.id);
  if (!to) throw conflict('nobody_to_answer', 'there is no accepted message from a sender to answer');
  const recent = Number(
    (
      await one(
        ctx.pool,
        `SELECT count(*) AS n FROM mail_messages WHERE org_id=$1 AND direction='out' AND received_at > $2`,
        [thread.org_id, new Date(ctx.clock.now().getTime() - 3_600_000)],
      )
    )?.n ?? 0,
  );
  if (recent >= MAIL_REPLIES_PER_ORG_PER_HOUR)
    throw conflict('reply_rate_limited', 'too many replies were sent in the last hour; try again later');
  const first = await one(
    ctx.pool,
    'SELECT subject FROM mail_messages WHERE thread_id=$1 ORDER BY received_at, id LIMIT 1',
    [thread.id],
  );
  const sent = await sendInThread(ctx, thread.org_id, thread.id, {
    to,
    subject: req.subject ?? withRe(first?.subject ?? '(no subject)'),
    text: req.text,
    sentBy: user.id,
  });
  await withAppendTx(ctx.pool, async (tx) => {
    const events: AppendInput[] = [
      {
        streamId: streamId.mailInbox(thread.inbox_id),
        event: {
          type: 'MailReplySent',
          payload: {
            threadId: thread.id,
            messageId: sent.id,
            inboxId: thread.inbox_id,
            ...(card ? { cardId: card.id } : {}),
            to,
            by: user.id,
            ...(req.draftedBy ? { draftedBy: req.draftedBy } : {}),
          },
        },
        actor: userActor(user.id),
        scope: orgScope(thread.org_id),
      },
    ];
    const full = card ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id]) : undefined;
    if (full)
      events.push(
        cardMessage(
          full,
          { kind: 'user', userId: user.id },
          'comment',
          `E-mail reply sent to ${to}:\n\n${sent.text.slice(0, 8000)}`,
          { source: 'email_reply', direction: 'out', messageId: sent.id, to },
        ),
      );
    await ctx.store.append(events, { tx });
  });
  return getMailThread(ctx, user, by);
}
