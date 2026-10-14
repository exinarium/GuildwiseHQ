import { messageIdOf, messageIdsOf } from '@aom/shared';
import { addressOf, BadInbound, type InboundProvider, type NormalizedInbound } from './types.ts';

/**
 * The `fake` provider (development and tests): a plain JSON message. Everything is optional but `from` and `to`.
 * `{from, fromName?, to: string | string[], subject, text, html?, messageId?, inReplyTo?, references?, date?,
 *   spamScore?, spf?, dkim?, automatic?, attachments?: [{name, contentType, size}], bytes?}`
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const verdict = (v: unknown): 'pass' | 'fail' | 'none' => (v === 'pass' || v === 'fail' ? v : 'none');

export const fakeProvider: Omit<InboundProvider, 'parse'> & { parse(body: unknown): NormalizedInbound } = {
  id: 'fake',
  parse(body: unknown): NormalizedInbound {
    if (!body || typeof body !== 'object') throw new BadInbound('not a message');
    const b = body as Record<string, any>;
    const from = addressOf(b.from);
    const to = (Array.isArray(b.to) ? b.to : [b.to]).map(addressOf).filter((a): a is string => a !== null);
    if (!from || to.length === 0) throw new BadInbound('a message needs from and to');
    const date = b.date ? new Date(str(b.date)) : null;
    const text = str(b.text);
    const html = str(b.html);
    return {
      messageId: messageIdOf(str(b.messageId)),
      from,
      fromName: str(b.fromName).trim() || null,
      recipients: to,
      subject: str(b.subject),
      text,
      html,
      inReplyTo: messageIdOf(str(b.inReplyTo)),
      references: messageIdsOf(Array.isArray(b.references) ? b.references.join(' ') : str(b.references)),
      date: date && !Number.isNaN(date.getTime()) ? date : null,
      spamScore: typeof b.spamScore === 'number' ? b.spamScore : null,
      spf: verdict(b.spf),
      dkim: verdict(b.dkim),
      automatic: b.automatic === true,
      attachments: (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 50).map((a: any) => ({
        name: str(a?.name).slice(0, 200),
        contentType: str(a?.contentType).slice(0, 100),
        size: typeof a?.size === 'number' ? a.size : 0,
      })),
      bytes: typeof b.bytes === 'number' ? b.bytes : text.length + html.length,
    };
  },
};
