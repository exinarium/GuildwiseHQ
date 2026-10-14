import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendgridProvider } from '../src/mail/inbound/sendgrid.ts';
import { BadInbound } from '../src/mail/inbound/types.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Inbound e-mail through SendGrid Inbound Parse: multipart/form-data in raw-MIME mode and in parsed mode. */

const SECRET = 'inbound-secret-1234567';
const DOMAIN = 'in.test.example';
let w: World;
let inbox: any;

const basic = (secret = SECRET) => `Basic ${Buffer.from(`inbound:${secret}`).toString('base64')}`;

type Part = { name: string; value: string | Buffer; filename?: string; contentType?: string };
/** A multipart/form-data body the way SendGrid builds it. */
function form(parts: Part[]): { payload: Buffer; contentType: string } {
  const boundary = `----sg${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename)
      head += `; filename="${p.filename}"\r\nContent-Type: ${p.contentType ?? 'application/octet-stream'}`;
    chunks.push(
      Buffer.from(`${head}\r\n\r\n`),
      Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value, 'utf8'),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
const post = (
  parts: Part[],
  headers: Record<string, string> = { authorization: basic() },
  provider = 'sendgrid',
) => {
  const f = form(parts);
  return w.t.app.inject({
    method: 'POST',
    url: `/api/inbound/mail/${provider}`,
    headers: { 'content-type': f.contentType, ...headers },
    payload: f.payload,
  });
};

const rawMime = (o: {
  to: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  body?: string;
  attachment?: Buffer;
}) => {
  const lines = [
    'From: Ana <ana@acme.com>',
    `To: Support <${o.to}>`,
    `Subject: ${o.subject ?? 'Printer is on fire'}`,
    `Message-ID: ${o.messageId ?? `<${randomUUID()}@acme.com>`}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    'Date: Wed, 14 Oct 2026 09:00:00 +0200',
    'MIME-Version: 1.0',
  ];
  if (!o.attachment)
    return `${lines.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${o.body ?? 'Please come and look.'}\r\n`;
  return [
    ...lines,
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body ?? 'See the photo.',
    '--mix',
    'Content-Type: image/png; name="photo.png"',
    'Content-Disposition: attachment; filename="photo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    o.attachment.toString('base64'),
    '--mix--',
    '',
  ].join('\r\n');
};

/** The form SendGrid posts in raw mode. */
const rawForm = (o: Parameters<typeof rawMime>[0], extra: Part[] = []): Part[] => [
  { name: 'email', value: rawMime(o) },
  { name: 'to', value: o.to },
  { name: 'from', value: 'Ana <ana@acme.com>' },
  { name: 'subject', value: o.subject ?? 'Printer is on fire' },
  { name: 'envelope', value: JSON.stringify({ to: [o.to], from: 'ana@acme.com' }) },
  { name: 'dkim', value: '{@acme.com : pass}' },
  { name: 'SPF', value: 'pass' },
  { name: 'spam_score', value: '0.3' },
  { name: 'charsets', value: JSON.stringify({ to: 'UTF-8', subject: 'UTF-8', from: 'UTF-8' }) },
  { name: 'sender_ip', value: '203.0.113.9' },
  ...extra,
];

/** The form SendGrid posts in the default, parsed mode. */
const parsedForm = (o: {
  to: string;
  subject?: string;
  text?: string;
  messageId?: string;
  inReplyTo?: string;
  attachment?: { name: string; type: string; body: Buffer };
  charsets?: Record<string, string>;
}): Part[] => [
  {
    name: 'headers',
    value: [
      'Received: by mx.sendgrid.net',
      'From: Ana <ana@acme.com>',
      `To: ${o.to}`,
      `Subject: ${o.subject ?? 'Parsed hello'}`,
      `Message-ID: ${o.messageId ?? `<${randomUUID()}@acme.com>`}`,
      ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
      'Date: Wed, 14 Oct 2026 09:00:00 +0200',
      '',
    ].join('\r\n'),
  },
  { name: 'dkim', value: '{@acme.com : pass}' },
  { name: 'to', value: o.to },
  { name: 'from', value: 'Ana <ana@acme.com>' },
  { name: 'subject', value: o.subject ?? 'Parsed hello' },
  { name: 'text', value: o.text ?? 'Hello from parsed mode.' },
  { name: 'html', value: '<p>Hello from <b>parsed</b> mode.</p>' },
  { name: 'envelope', value: JSON.stringify({ to: [o.to], from: 'ana@acme.com' }) },
  {
    name: 'charsets',
    value: JSON.stringify(o.charsets ?? { to: 'UTF-8', subject: 'UTF-8', from: 'UTF-8', text: 'UTF-8' }),
  },
  { name: 'SPF', value: 'pass' },
  { name: 'spam_score', value: '0.1' },
  ...(o.attachment
    ? [
        { name: 'attachments', value: '1' },
        {
          name: 'attachment-info',
          value: JSON.stringify({
            attachment1: { filename: o.attachment.name, type: o.attachment.type, 'content-id': 'f1' },
          }),
        },
        {
          name: 'attachment1',
          value: o.attachment.body,
          filename: o.attachment.name,
          contentType: o.attachment.type,
        },
      ]
    : []),
];

const lastMessage = async () =>
  (
    await q(
      `SELECT * FROM mail_messages WHERE inbox_id=$1 AND direction='in' ORDER BY received_at DESC, id LIMIT 1`,
      [inbox.id],
    )
  )[0] as Record<string, any>;

beforeAll(async () => {
  w = await createWorld({
    env: {
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      AOM_INBOUND_PROVIDER: 'sendgrid',
      AOM_INBOUND_DOMAIN: DOMAIN,
      AOM_INBOUND_SECRET: SECRET,
      AOM_INBOUND_RATE_PER_HOUR: '100',
      AOM_INBOUND_RATE_PER_SENDER_PER_HOUR: '0',
      AOM_INBOUND_MAX_BYTES: '20000',
    },
  });
  inbox = await ok(
    w.t.req('POST', '/api/mail-inboxes', { cookie: w.owner.cookie, body: { label: 'Support' } }),
    201,
  );
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('SendGrid webhook authentication', () => {
  it('refuses a missing or wrong secret before reading the form; accepts Basic and the header', async () => {
    expect((await post(rawForm({ to: inbox.address }), {})).statusCode).toBe(401);
    expect(
      (await post(rawForm({ to: inbox.address }), { authorization: basic('not-the-secret-at-all') }))
        .statusCode,
    ).toBe(401);
    expect((await post(rawForm({ to: inbox.address }), { 'x-aom-inbound-secret': SECRET })).statusCode).toBe(
      200,
    );
    expect((await post(rawForm({ to: inbox.address }))).statusCode).toBe(200);
    expect(
      (await post(rawForm({ to: inbox.address }), { authorization: basic() }, 'postmark')).statusCode,
    ).toBe(415); // other provider paths stay JSON-only
  });

  it('answers 200 for a form that is not an Inbound Parse post', async () => {
    const res = await post([{ name: 'nonsense', value: '1' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe('unreadable');
  });
});

describe('SendGrid raw MIME mode', () => {
  it('stores the message with subject, text, sender and Message-ID', async () => {
    const res = await post(
      rawForm({
        to: inbox.address,
        subject: 'Raw hello',
        messageId: '<raw-1@acme.com>',
        body: 'Grüße from the raw mode',
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].status).toBe('received');
    const m = await lastMessage();
    expect(m).toMatchObject({ subject: 'Raw hello', from_address: 'ana@acme.com' });
    expect(m.body_text).toContain('Grüße from the raw mode');
    expect(m.message_id).toBe('<raw-1@acme.com>');
  });

  it('threads a reply by In-Reply-To and References, and stores a retried Message-ID once', async () => {
    await post(rawForm({ to: inbox.address, subject: 'Thread start', messageId: '<sg-t1@acme.com>' }));
    const first = await lastMessage();
    const reply = await post(
      rawForm({
        to: inbox.address,
        subject: 'Re: Thread start',
        messageId: '<sg-t2@acme.com>',
        inReplyTo: '<sg-t1@acme.com>',
        references: '<sg-t1@acme.com>',
        body: 'More detail',
      }),
    );
    expect(reply.json().results[0].status).toBe('received');
    expect((await lastMessage()).thread_id).toBe(first.thread_id);
    // a third mail with only References still joins
    await post(
      rawForm({
        to: inbox.address,
        subject: 'Re: Re: Thread start',
        messageId: '<sg-t3@acme.com>',
        references: '<sg-t1@acme.com> <sg-t2@acme.com>',
      }),
    );
    expect((await lastMessage()).thread_id).toBe(first.thread_id);
    // SendGrid retries on a non-2xx: the same Message-ID is not stored twice
    const body = rawForm({ to: inbox.address, subject: 'Retry me', messageId: '<sg-retry@acme.com>' });
    expect((await post(body)).json().results[0].status).toBe('received');
    expect((await post(body)).json().results[0].status).toBe('duplicate');
    expect(await q(`SELECT 1 FROM mail_messages WHERE subject='Retry me'`)).toHaveLength(1);
  });

  it('records an attachment by name, type and size, never its content', async () => {
    const png = Buffer.alloc(3000, 7);
    await post(rawForm({ to: inbox.address, subject: 'With photo', attachment: png }));
    const m = await lastMessage();
    expect(m.attachments).toEqual([{ name: 'photo.png', contentType: 'image/png', size: 3000 }]);
  });

  it('skips a message over AOM_INBOUND_MAX_BYTES as too large, keeping no text', async () => {
    const res = await post(
      rawForm({ to: inbox.address, subject: 'Too big', attachment: Buffer.alloc(40_000, 1) }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ status: 'skipped', reason: 'too_large' });
    expect((await lastMessage()).body_text).toBe('');
  });

  it("uses SendGrid's own checks: spam score and a failed DKIM", async () => {
    const spam = await post(
      rawForm({ to: inbox.address, subject: 'Buy now' }).map((p) =>
        p.name === 'spam_score' ? { ...p, value: '9.1' } : p,
      ),
    );
    expect(spam.json().results[0]).toMatchObject({ status: 'skipped', reason: 'spam' });
    const forged = await post(
      rawForm({ to: inbox.address, subject: 'Forged' }).map((p) =>
        p.name === 'dkim'
          ? { ...p, value: '{@acme.com : fail}' }
          : p.name === 'SPF'
            ? { ...p, value: 'none' }
            : p,
      ),
    );
    expect(forged.json().results[0]).toMatchObject({ status: 'skipped', reason: 'sender_check_failed' });
  });

  it('drops a recipient that is not an address of ours (another domain, unknown mailbox)', async () => {
    const other = await post(rawForm({ to: 'support@elsewhere.example' }));
    expect(other.statusCode).toBe(200);
    expect(other.json().results[0]).toMatchObject({ status: 'dropped', reason: 'unknown_address' });
    const unknown = await post(rawForm({ to: `nobody-aaaaaaaaaa@${DOMAIN}` }));
    expect(unknown.json().results[0]).toMatchObject({ status: 'dropped', reason: 'unknown_address' });
  });

  it('routes by the envelope recipient when the To header shows someone else (Bcc, forwarding)', async () => {
    const parts = rawForm({ to: 'team@acme.com', subject: 'Via envelope' }).map((p) =>
      p.name === 'envelope'
        ? { ...p, value: JSON.stringify({ to: [inbox.address], from: 'ana@acme.com' }) }
        : p,
    );
    expect((await post(parts)).json().results[0].status).toBe('received');
    expect((await lastMessage()).subject).toBe('Via envelope');
  });
});

describe('SendGrid parsed mode', () => {
  it('reads the fields: text, thread headers from the header block, charsets', async () => {
    await post(
      parsedForm({ to: inbox.address, subject: 'P start', messageId: '<p-1@acme.com>', text: 'First' }),
    );
    const first = await lastMessage();
    expect(first.body_text).toContain('First');
    const res = await post(
      parsedForm({
        to: inbox.address,
        subject: 'Re: P start',
        messageId: '<p-2@acme.com>',
        inReplyTo: '<p-1@acme.com>',
        text: 'Reply',
      }),
    );
    expect(res.json().results[0].status).toBe('received');
    expect((await lastMessage()).thread_id).toBe(first.thread_id);
  });

  it('decodes non-UTF-8 fields with the stated charset', async () => {
    const latin = Buffer.from('Caf\xe9 cr\xe8me', 'latin1');
    const parts = parsedForm({
      to: inbox.address,
      subject: 'Latin',
      charsets: { to: 'UTF-8', subject: 'UTF-8', from: 'UTF-8', text: 'iso-8859-1' },
    }).map((p) => (p.name === 'text' ? { ...p, value: latin } : p));
    await post(parts);
    expect((await lastMessage()).body_text).toContain('Café crème');
  });

  it('counts an attachment file from the form and reads its name from attachment-info', async () => {
    await post(
      parsedForm({
        to: inbox.address,
        subject: 'P file',
        attachment: { name: 'report.pdf', type: 'application/pdf', body: Buffer.alloc(2048, 3) },
      }),
    );
    expect((await lastMessage()).attachments).toEqual([
      { name: 'report.pdf', contentType: 'application/pdf', size: 2048 },
    ]);
  });

  it('skips an oversize post (attachments count) and a recipient off the domain', async () => {
    const big = await post(
      parsedForm({
        to: inbox.address,
        subject: 'P big',
        attachment: { name: 'x.bin', type: 'application/octet-stream', body: Buffer.alloc(50_000, 1) },
      }),
    );
    expect(big.json().results[0]).toMatchObject({ status: 'skipped', reason: 'too_large' });
    const off = await post(parsedForm({ to: 'support@elsewhere.example' }));
    expect(off.json().results[0]).toMatchObject({ status: 'dropped', reason: 'unknown_address' });
  });
});

describe('SendGrid adapter', () => {
  it('refuses a body that is not a form of fields', async () => {
    await expect(Promise.resolve().then(() => sendgridProvider.parse({ hello: 1 }))).rejects.toBeInstanceOf(
      BadInbound,
    );
    await expect(
      sendgridProvider.parse({ fields: { text: 'x' }, files: [], bytes: 1 }),
    ).rejects.toBeInstanceOf(BadInbound);
  });
});
