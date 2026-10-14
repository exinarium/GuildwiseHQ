import {
  addressOf,
  authResults,
  BadInbound,
  headerMap,
  type InboundProvider,
  isAutomatic,
  type NormalizedInbound,
  spamScoreOf,
  threadHeaders,
} from './types.ts';

/**
 * Postmark inbound webhook (https://postmarkapp.com/developer/webhooks/inbound-webhook). One POST per message, JSON.
 * The address can only be told from the headers and `ToFull`/`OriginalRecipient`; threading comes from the
 * `Message-ID`, `In-Reply-To` and `References` headers (Postmark's own `MessageID` is its id, not the header).
 */
interface PostmarkAddress {
  Email?: unknown;
}
interface PostmarkAttachment {
  Name?: unknown;
  ContentType?: unknown;
  ContentLength?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const postmarkProvider: Omit<InboundProvider, 'parse'> & { parse(body: unknown): NormalizedInbound } =
  {
    id: 'postmark',
    parse(body: unknown): NormalizedInbound {
      if (!body || typeof body !== 'object') throw new BadInbound('not a Postmark message');
      const b = body as Record<string, any>;
      const from = addressOf(b.FromFull?.Email) ?? addressOf(b.From);
      if (!from || (typeof b.MessageID !== 'string' && !Array.isArray(b.Headers)))
        throw new BadInbound('not a Postmark message');
      const h = headerMap(b.Headers);
      const to = [...(Array.isArray(b.ToFull) ? b.ToFull : []), ...(Array.isArray(b.CcFull) ? b.CcFull : [])]
        .map((a: PostmarkAddress) => addressOf(a?.Email))
        .filter((a): a is string => a !== null);
      const recipients = [...new Set([addressOf(b.OriginalRecipient), ...to, addressOf(b.To)])].filter(
        (a): a is string => a !== null,
      );
      // The mailbox hash is the `+tag` part; ToFull's Email keeps the plus part in most cases, so add it when it does not.
      const attachments = (Array.isArray(b.Attachments) ? b.Attachments : [])
        .slice(0, 50)
        .map((a: PostmarkAttachment) => ({
          name: str(a?.Name).slice(0, 200),
          contentType: str(a?.ContentType).slice(0, 100),
          size: typeof a?.ContentLength === 'number' ? a.ContentLength : 0,
        }));
      const t = threadHeaders(h);
      const date = b.Date ? new Date(str(b.Date)) : null;
      const { spf, dkim } = authResults(h);
      return {
        messageId:
          t.messageId ??
          (typeof b.MessageID === 'string' ? `<postmark-${b.MessageID}@postmarkapp.com>` : null),
        from,
        fromName: str(b.FromName || b.FromFull?.Name).trim() || null,
        recipients,
        subject: str(b.Subject),
        text: str(b.TextBody),
        html: str(b.HtmlBody),
        inReplyTo: t.inReplyTo,
        references: t.references,
        date: date && !Number.isNaN(date.getTime()) ? date : null,
        spamScore: spamScoreOf(h),
        spf,
        dkim,
        automatic: isAutomatic(h, from),
        attachments,
        // Attachment content is base64 in the JSON: the body is the message's size on the wire.
        bytes: JSON.stringify(b).length,
      };
    },
  };
