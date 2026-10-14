import { randomUUID } from 'node:crypto';
import { parseAddress } from '@aom/shared';
import type { Ctx } from '../../context.ts';
import { one, rows } from '../../db/sql.ts';
import { conflict, notFound } from '../../errors.ts';
import { conversationHeaders, mailDomain, replyAddressFor } from '../threading.ts';
import { bodyText, headerText } from './sanitize.ts';

/**
 * Mail Guildwise sends into a conversation of an organisation's inbox (docs/design/workflow-builder.md D9). It gets a
 * Message-ID that is stored with the thread and a Reply-To of `<inbox address>+<thread token>`, so a reply finds the
 * thread by the plus-address even when the recipient's program drops the threading headers, and by `In-Reply-To`
 * otherwise. Only threads of the given organisation can be written to.
 */
export async function sendInThread(
  ctx: Ctx,
  orgId: string,
  threadId: string,
  mail: { to: string; subject: string; text: string; sentBy?: string },
): Promise<{ messageId: string; id: string; subject: string; text: string }> {
  const thread = await one(ctx.pool, 'SELECT * FROM mail_threads WHERE id=$1 AND org_id=$2', [
    threadId,
    orgId,
  ]);
  if (!thread) throw notFound('conversation not found');
  const addr = await one(ctx.pool, 'SELECT address FROM mail_addresses WHERE inbox_id=$1 AND active', [
    thread.inbox_id,
  ]);
  if (!addr) throw conflict('inbox_has_no_address', 'this inbox has no address');
  // Plain mail from the platform's sending address, under the organisation's own name: nothing in it says who wrote it.
  const org = await one(ctx.pool, 'SELECT name FROM organizations WHERE id=$1', [orgId]);
  const sender = parseAddress(ctx.config.mailFrom);
  const orgName = String(org?.name ?? '')
    .replace(/[<>"\r\n]/g, '')
    .trim();
  const from = sender && orgName ? `"${orgName}" <${sender}>` : undefined;
  const earlier = (
    await rows<{ id: string }>(
      ctx.pool,
      `SELECT id FROM mail_messages WHERE thread_id=$1 AND direction='out' ORDER BY received_at, id`,
      [threadId],
    )
  ).map((r) => r.id);
  const id = randomUUID();
  const headers = conversationHeaders(mailDomain(ctx.config), 'mail', threadId, earlier, id);
  const subject = headerText(mail.subject, 300) || '(no subject)';
  const body = bodyText(mail.text, null, 100_000);
  await ctx.pool.query(
    `INSERT INTO mail_messages (id, org_id, inbox_id, thread_id, direction, message_id, in_reply_to, refs, from_address,
       to_address, subject, body_text, received_at, status, sent_by)
     VALUES ($1,$2,$3,$4,'out',$5,$6,$7,$8,$9,$10,$11,$12,'processed',$13)`,
    [
      id,
      orgId,
      thread.inbox_id,
      threadId,
      headers.messageId,
      headers.inReplyTo ?? null,
      headers.references ?? [],
      sender ?? addr.address,
      mail.to,
      subject,
      body.text,
      ctx.clock.now(),
      mail.sentBy ?? null,
    ],
  );
  try {
    await ctx.mailer.send({
      to: mail.to,
      subject,
      text: body.text,
      ...(from ? { from } : {}),
      replyTo: replyAddressFor(addr.address, thread.token),
      orgId,
      ...headers,
    });
  } catch {
    // Nothing went out: do not keep a sent message in the conversation.
    await ctx.pool.query('DELETE FROM mail_messages WHERE id=$1', [id]);
    throw conflict('mail_send_failed', 'the reply could not be sent; try again in a moment');
  }
  return { messageId: headers.messageId, id, subject, text: body.text };
}
