import { messageIdOf, messageIdsOf, parseAddress } from '@aom/shared';

/** A provider's message in the one shape the rest of the server reads. */
export interface NormalizedInbound {
  /** The Message-ID header with angle brackets, or null (a provider id is used then). */
  messageId: string | null;
  from: string;
  fromName: string | null;
  /** Every address the message was sent to (To, Cc, the envelope recipient), lower case, plus-parts kept. */
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  date: Date | null;
  /** SpamAssassin-style score when the provider gives one. */
  spamScore: number | null;
  spf: 'pass' | 'fail' | 'none';
  dkim: 'pass' | 'fail' | 'none';
  /** An automatic reply, bounce, list or bulk message. */
  automatic: boolean;
  attachments: Array<{ name: string; contentType: string; size: number }>;
  /** Size of the whole message as sent by the provider (attachments included). */
  bytes: number;
}

export class BadInbound extends Error {}

export interface InboundProvider {
  id: 'postmark' | 'sendgrid' | 'fake';
  /** Reads the provider's webhook body. Throws `BadInbound` when it is not a message of this provider. */
  parse(body: unknown): NormalizedInbound | Promise<NormalizedInbound>;
}

/** A `multipart/form-data` webhook body (SendGrid) as the route collects it: text fields, and each file's size only. */
export interface MultipartBody {
  fields: Record<string, string>;
  files: Array<{ field: string; filename: string; contentType: string; size: number }>;
  /** Bytes of every part received (fields, files, attachments); the message's size on the wire. */
  bytes: number;
}

export interface HeaderPair {
  Name?: unknown;
  Value?: unknown;
}

export const headerMap = (headers: unknown): Map<string, string> => {
  const m = new Map<string, string>();
  if (Array.isArray(headers))
    for (const h of headers as HeaderPair[]) {
      if (typeof h?.Name !== 'string' || typeof h.Value !== 'string') continue;
      const k = h.Name.toLowerCase();
      m.set(k, m.has(k) ? `${m.get(k)} ${h.Value}` : h.Value);
    }
  return m;
};

/** SPF and DKIM verdicts from `Received-SPF` and `Authentication-Results` (whichever the provider adds). */
export function authResults(h: Map<string, string>): {
  spf: 'pass' | 'fail' | 'none';
  dkim: 'pass' | 'fail' | 'none';
} {
  const ar = (h.get('authentication-results') ?? '').toLowerCase();
  const rs = (h.get('received-spf') ?? '').toLowerCase().trim();
  const word = (re: RegExp, s: string) => re.exec(s)?.[1];
  const arDkim = word(/dkim=(\w+)/, ar);
  const arSpf = word(/spf=(\w+)/, ar);
  const dkim = arDkim === 'pass' ? 'pass' : arDkim === 'fail' ? 'fail' : 'none';
  const spfWord = arSpf ?? rs.split(/[\s(]/)[0];
  const spf = spfWord === 'pass' ? 'pass' : spfWord === 'fail' || spfWord === 'softfail' ? 'fail' : 'none';
  return { spf, dkim };
}

/** The SpamAssassin score from `X-Spam-Score`, or `X-Spam-Status: Yes, score=7.1 ...`. */
export function spamScoreOf(h: Map<string, string>): number | null {
  const direct = Number.parseFloat(h.get('x-spam-score') ?? '');
  if (Number.isFinite(direct)) return direct;
  const m = /score=(-?\d+(?:\.\d+)?)/i.exec(h.get('x-spam-status') ?? '');
  return m ? Number.parseFloat(m[1] as string) : null;
}

/** Auto-replies, bounces, mailing lists and bulk mail: never turned into cards. */
export function isAutomatic(h: Map<string, string>, from: string): boolean {
  const auto = (h.get('auto-submitted') ?? '').toLowerCase().trim();
  if (auto && auto !== 'no') return true;
  const prec = (h.get('precedence') ?? '').toLowerCase();
  if (/\b(bulk|junk|list|auto_reply)\b/.test(prec)) return true;
  if (h.has('x-autoreply') || h.has('x-autorespond') || h.has('x-auto-response-suppress')) return true;
  if ((h.get('content-type') ?? '').toLowerCase().includes('multipart/report')) return true;
  return /^(mailer-daemon|postmaster)@/.test(from);
}

export const threadHeaders = (h: Map<string, string>) => ({
  messageId: messageIdOf(h.get('message-id')),
  inReplyTo: messageIdOf(h.get('in-reply-to')),
  references: messageIdsOf(h.get('references')),
});

export const addressOf = (raw: unknown): string | null =>
  typeof raw === 'string' ? parseAddress(raw) : null;
