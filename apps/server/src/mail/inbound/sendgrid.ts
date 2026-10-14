import PostalMime, { type Address } from 'postal-mime';
import {
  addressOf,
  authResults,
  BadInbound,
  type InboundProvider,
  isAutomatic,
  type MultipartBody,
  type NormalizedInbound,
  spamScoreOf,
  threadHeaders,
} from './types.ts';

/**
 * SendGrid Inbound Parse (https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook).
 * One `multipart/form-data` POST per message, in one of two modes (a setting of the parse host):
 *  - raw ("POST the raw, full MIME message"): the field `email` holds the whole RFC 822 message, parsed here, plus the
 *    envelope, `dkim`, `SPF` and `spam_score` fields. Full fidelity (Message-ID, In-Reply-To, References, charsets): recommended.
 *  - parsed (default): `headers` (the raw header block), `text`, `html`, `subject`, `from`, `to`, `cc`, `envelope`,
 *    `charsets`, `attachment-info` and the attachments as files `attachment1..N`.
 * The route turns the form into a `MultipartBody`; attachments are only counted, never kept.
 */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const latin1Bytes = (s: string): Buffer => Buffer.from(s, 'latin1');

/** Form fields arrive decoded as latin-1 (the route sets that on the form parser) so no byte is lost; decode with the stated charset. */
function decodeField(raw: string | undefined, charset: string | undefined): string {
  if (!raw) return '';
  try {
    return new TextDecoder(charset || 'utf-8').decode(latin1Bytes(raw));
  } catch {
    return new TextDecoder('utf-8').decode(latin1Bytes(raw));
  }
}

const json = (raw: string | undefined): Record<string, any> => {
  try {
    const v = JSON.parse(raw ?? '');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** The raw header block of the parsed mode, unfolded, as the same lower-case map the other providers build. */
function headerBlock(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    m.set(k, m.has(k) ? `${m.get(k)} ${v}` : v);
  }
  return m;
}

const flatten = (list: Address[] | undefined): string[] =>
  (list ?? []).flatMap((a) => (a.group ? a.group.map((g) => g.address) : a.address ? [a.address] : []));

/** Every address in a `To`/`Cc` style value, "Name <a@b>, c@d" included. */
const addressesIn = (raw: string): string[] =>
  (raw.match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? []).map(addressOf).filter((a): a is string => a !== null);

/** `{@acme.com : pass}` style (one entry per signature), or plain `pass`/`none`. */
function dkimVerdict(raw: string): 'pass' | 'fail' | 'none' {
  const s = raw.toLowerCase();
  if (/:\s*pass/.test(s) || s.trim() === 'pass') return 'pass';
  if (/:\s*(fail|permerror)/.test(s) || s.trim() === 'fail') return 'fail';
  return 'none';
}
function spfVerdict(raw: string): 'pass' | 'fail' | 'none' {
  const s = raw.toLowerCase().trim();
  return s === 'pass' ? 'pass' : s === 'fail' || s === 'softfail' ? 'fail' : 'none';
}

export const sendgridProvider: InboundProvider = {
  id: 'sendgrid',
  async parse(body: unknown): Promise<NormalizedInbound> {
    const b = body as Partial<MultipartBody> | null;
    if (!b || typeof b !== 'object' || !b.fields || typeof b.fields !== 'object' || !Array.isArray(b.files))
      throw new BadInbound('not a SendGrid Inbound Parse post');
    const f = b.fields;
    const charsets = json(f.charsets);
    const envelope = json(f.envelope);
    const envelopeTo = (Array.isArray(envelope.to) ? envelope.to : [envelope.to])
      .map(addressOf)
      .filter((a): a is string => a !== null);
    const bytes = typeof b.bytes === 'number' ? b.bytes : 0;

    let h: Map<string, string>;
    let subject: string;
    let text: string;
    let html: string;
    let from: string | null;
    let fromName: string | null;
    let to: string[];
    let date: Date | null = null;
    let attachments: NormalizedInbound['attachments'];
    let t: ReturnType<typeof threadHeaders>;

    if (typeof f.email === 'string' && f.email !== '') {
      // Raw mode.
      let mail: Awaited<ReturnType<typeof PostalMime.parse>>;
      try {
        mail = await PostalMime.parse(latin1Bytes(f.email));
      } catch {
        throw new BadInbound('the raw message cannot be parsed');
      }
      h = new Map<string, string>();
      for (const x of mail.headers) h.set(x.key, h.has(x.key) ? `${h.get(x.key)} ${x.value}` : x.value);
      const sender = mail.from && !mail.from.group ? mail.from : undefined;
      from = addressOf(sender?.address) ?? addressOf(envelope.from) ?? null;
      fromName = sender?.name?.trim() || null;
      to = [...flatten(mail.to), ...flatten(mail.cc)].map(addressOf).filter((a): a is string => a !== null);
      subject = mail.subject ?? '';
      text = mail.text ?? '';
      html = mail.html ?? '';
      t = threadHeaders(h);
      const d = mail.date ? new Date(mail.date) : null;
      date = d && !Number.isNaN(d.getTime()) ? d : null;
      attachments = mail.attachments.slice(0, 50).map((a) => ({
        name: (a.filename ?? '').slice(0, 200),
        contentType: a.mimeType.slice(0, 100),
        size:
          typeof a.content === 'string'
            ? Buffer.byteLength(a.content)
            : (a.content as ArrayBuffer | Uint8Array).byteLength,
      }));
    } else if (
      f.headers !== undefined ||
      f.text !== undefined ||
      f.html !== undefined ||
      f.from !== undefined
    ) {
      // Parsed mode.
      h = headerBlock(decodeField(f.headers, charsets.headers));
      const fromRaw = decodeField(f.from, charsets.from);
      from = addressOf(fromRaw) ?? addressesIn(fromRaw)[0] ?? addressOf(envelope.from) ?? null;
      const nameMatch = /^\s*"?([^"<]*?)"?\s*</.exec(fromRaw);
      fromName = nameMatch?.[1]?.trim() || null;
      to = [...addressesIn(decodeField(f.to, charsets.to)), ...addressesIn(decodeField(f.cc, charsets.cc))];
      subject = decodeField(f.subject, charsets.subject);
      text = decodeField(f.text, charsets.text);
      html = decodeField(f.html, charsets.html);
      t = threadHeaders(h);
      const d = h.get('date') ? new Date(h.get('date') as string) : null;
      date = d && !Number.isNaN(d.getTime()) ? d : null;
      const info = json(f['attachment-info']);
      attachments = b.files.slice(0, 50).map((file) => {
        const meta = info[file.field] ?? {};
        return {
          name: str(meta.filename || meta.name || file.filename).slice(0, 200),
          contentType: str(meta.type || file.contentType).slice(0, 100),
          size: file.size,
        };
      });
    } else {
      throw new BadInbound('not a SendGrid Inbound Parse post');
    }

    if (!from) throw new BadInbound('no sender');
    const recipients = [...new Set([...envelopeTo, ...to])];
    if (recipients.length === 0) throw new BadInbound('no recipient');

    // SendGrid's own checks come as fields in both modes; fall back to the message's headers.
    const own = authResults(h);
    const spamField = Number.parseFloat(f.spam_score ?? '');
    return {
      messageId: t.messageId,
      from,
      fromName,
      recipients,
      subject,
      text,
      html,
      inReplyTo: t.inReplyTo,
      references: t.references,
      date,
      spamScore: Number.isFinite(spamField) ? spamField : spamScoreOf(h),
      spf: f.SPF !== undefined ? spfVerdict(f.SPF) : own.spf,
      dkim: f.dkim !== undefined ? dkimVerdict(f.dkim) : own.dkim,
      automatic: isAutomatic(h, from),
      attachments,
      bytes,
    };
  },
};
