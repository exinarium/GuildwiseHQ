import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { authVerdict, orgSlug, randomToken } from '../src/mail/inbound/ingest.ts';
import { postmarkProvider } from '../src/mail/inbound/postmark.ts';
import { configuredProvider, webhookAuthorised } from '../src/mail/inbound/providers.ts';
import { bodyText, htmlToText } from '../src/mail/inbound/sanitize.ts';
import { BadInbound } from '../src/mail/inbound/types.ts';
import { conversationHeaders, mailDomain, replyAddressFor } from '../src/mail/threading.ts';

/** Pure parts of inbound mail: the Postmark adapter, HTML to text, webhook credentials, headers. No database. */

const postmarkBody = (over: Record<string, unknown> = {}) => ({
  From: 'Ana <ana@acme.com>',
  FromName: 'Ana',
  FromFull: { Email: 'ana@acme.com', Name: 'Ana', MailboxHash: '' },
  To: 'acme-k3x9p2m7qd+thr4g8h2j7@in.example.com',
  ToFull: [{ Email: 'acme-k3x9p2m7qd+thr4g8h2j7@in.example.com', Name: '', MailboxHash: 'thr4g8h2j7' }],
  CcFull: [{ Email: 'cc@acme.com' }],
  OriginalRecipient: 'acme-k3x9p2m7qd+thr4g8h2j7@in.example.com',
  Subject: 'Printer',
  MessageID: '73e6d360-66eb-11e1-8e72-a8904824019b',
  Date: 'Thu, 5 Oct 2026 16:59:01 +0200',
  TextBody: 'text',
  HtmlBody: '<p>html</p>',
  Headers: [
    { Name: 'Message-ID', Value: '<CAF123@mail.gmail.com>' },
    { Name: 'In-Reply-To', Value: '<out-1@in.example.com>' },
    { Name: 'References', Value: '<root@x> <out-1@in.example.com>' },
    { Name: 'Received-SPF', Value: 'Pass (sender SPF authorized) identity=mailfrom' },
    { Name: 'X-Spam-Status', Value: 'No, score=1.2 required=5.0 tests=HTML_MESSAGE' },
    { Name: 'Authentication-Results', Value: 'mx.example.com; dkim=pass header.d=acme.com; spf=pass' },
  ],
  Attachments: [{ Name: 'a.pdf', Content: 'AAAA', ContentType: 'application/pdf', ContentLength: 3 }],
  ...over,
});

describe('the Postmark adapter', () => {
  it('reads sender, recipients with the plus-tag, thread headers, spam score, checks and attachment metadata', () => {
    const m = postmarkProvider.parse(postmarkBody());
    expect(m).toMatchObject({
      messageId: '<CAF123@mail.gmail.com>',
      from: 'ana@acme.com',
      fromName: 'Ana',
      subject: 'Printer',
      text: 'text',
      inReplyTo: '<out-1@in.example.com>',
      references: ['<root@x>', '<out-1@in.example.com>'],
      spamScore: 1.2,
      spf: 'pass',
      dkim: 'pass',
      automatic: false,
    });
    expect(m.recipients).toContain('acme-k3x9p2m7qd+thr4g8h2j7@in.example.com');
    expect(m.recipients).toContain('cc@acme.com');
    // attachments: name, type and size only; the content is not carried
    expect(m.attachments).toEqual([{ name: 'a.pdf', contentType: 'application/pdf', size: 3 }]);
    expect(JSON.stringify(m)).not.toContain('AAAA');
  });

  it('uses a derived id when the Message-ID header is missing, and flags automatic mail', () => {
    const m = postmarkProvider.parse(
      postmarkBody({ Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] }),
    );
    expect(m.messageId).toBe('<postmark-73e6d360-66eb-11e1-8e72-a8904824019b@postmarkapp.com>');
    expect(m.automatic).toBe(true);
    expect(
      postmarkProvider.parse(postmarkBody({ Headers: [{ Name: 'Precedence', Value: 'bulk' }] })).automatic,
    ).toBe(true);
    expect(
      postmarkProvider.parse(
        postmarkBody({ From: 'MAILER-DAEMON@x.com', FromFull: { Email: 'mailer-daemon@x.com' } }),
      ).automatic,
    ).toBe(true);
  });

  it('reads a failing DKIM and an X-Spam-Score header', () => {
    const m = postmarkProvider.parse(
      postmarkBody({
        Headers: [
          { Name: 'Authentication-Results', Value: 'x; dkim=fail; spf=softfail' },
          { Name: 'X-Spam-Score', Value: '8.4' },
        ],
      }),
    );
    expect(m).toMatchObject({ dkim: 'fail', spf: 'fail', spamScore: 8.4 });
    expect(authVerdict(m)).toBe('fail');
    expect(authVerdict({ spf: 'pass', dkim: 'fail' })).toBe('pass');
    expect(authVerdict({ spf: 'none', dkim: 'none' })).toBe('unknown');
  });

  it('refuses a body that is not a Postmark message', () => {
    expect(() => postmarkProvider.parse(null)).toThrow(BadInbound);
    expect(() => postmarkProvider.parse({ hello: 'world' })).toThrow(BadInbound);
  });
});

describe('text from HTML', () => {
  it('drops scripts, styles, comments and tags; keeps link targets visible; decodes entities', () => {
    const t = htmlToText(
      '<html><head><title>x</title><style>.a{}</style></head><body><!-- c --><h1>Title</h1><p>Hi&nbsp;&amp; <a href="https://e.com/p?a=1&amp;b=2">go</a></p><script>steal()</script><ul><li>one</li><li>two</li></ul></body></html>',
    );
    expect(t).toContain('Title');
    expect(t).toContain('Hi & go (https://e.com/p?a=1&b=2)');
    expect(t).toContain('- one\n- two');
    expect(t).not.toMatch(/steal|\.a\{|<|c -->/);
  });

  it('an unclosed script swallows nothing that is not script', () => {
    expect(htmlToText('before<script>evil(')).toBe('before');
  });

  it('prefers the plain part, cleans control characters and caps the length', () => {
    expect(bodyText('plain\u0000text', '<b>html</b>', 100).text).toBe('plain text');
    expect(bodyText('', '<b>html</b>', 100).text).toBe('html');
    const long = bodyText('x'.repeat(500), null, 100);
    expect(long.text).toHaveLength(100);
    expect(long.truncated).toBe(true);
  });
});

describe('webhook credentials', () => {
  const config = loadConfig({
    AOM_INBOUND_PROVIDER: 'postmark',
    AOM_INBOUND_DOMAIN: '@In.Example.com',
    AOM_INBOUND_SECRET: 'a-long-enough-secret',
  });
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  it('accepts the secret as the Basic-auth password (any user name) or in the header', () => {
    expect(webhookAuthorised(config, { authorization: basic('postmark', 'a-long-enough-secret') })).toBe(
      true,
    );
    expect(webhookAuthorised(config, { authorization: basic('', 'a-long-enough-secret') })).toBe(true);
    expect(webhookAuthorised(config, { 'x-aom-inbound-secret': 'a-long-enough-secret' })).toBe(true);
  });

  it('refuses everything else, including a secret with the right start', () => {
    expect(webhookAuthorised(config, {})).toBe(false);
    expect(webhookAuthorised(config, { authorization: basic('u', 'wrong') })).toBe(false);
    expect(webhookAuthorised(config, { authorization: basic('u', 'a-long-enough-secre') })).toBe(false);
    expect(webhookAuthorised(config, { authorization: 'Bearer a-long-enough-secret' })).toBe(false);
    expect(webhookAuthorised(config, { 'x-aom-inbound-secret': 'nope' })).toBe(false);
  });

  it('nothing is accepted without a configured secret; the domain is normalised', () => {
    const none = loadConfig({ AOM_INBOUND_PROVIDER: 'fake' });
    expect(webhookAuthorised(none, { 'x-aom-inbound-secret': '' })).toBe(false);
    expect(webhookAuthorised(none, { authorization: basic('u', '') })).toBe(false);
    expect(config.inbound.domain).toBe('in.example.com');
    expect(configuredProvider(config)?.id).toBe('postmark');
    expect(configuredProvider(loadConfig({}))).toBeNull();
  });
});

describe('addresses and headers', () => {
  it('makes slugs and unguessable tokens', () => {
    expect(orgSlug('Acme Ltd. (Pty)')).toBe('acme-ltd-pty');
    expect(orgSlug('Ünïcode Café')).toBe('unicode-cafe');
    expect(orgSlug('***')).toBe('org');
    expect(orgSlug('A'.repeat(50))).toHaveLength(20);
    const t = new Set(Array.from({ length: 50 }, () => randomToken(10)));
    expect(t.size).toBe(50);
    for (const x of t) expect(x).toMatch(/^[a-z2-9]{10}$/);
  });

  it('threads outgoing mail: the first is the root, later ones answer the one before and list all earlier', () => {
    const d = 'guildwise.example';
    const root = conversationHeaders(d, 'support', 'T1', []);
    expect(root).toEqual({ messageId: '<support.T1@guildwise.example>' });
    const one = conversationHeaders(d, 'support', 'T1', [], 'M1');
    expect(one).toEqual({
      messageId: '<support.T1.M1@guildwise.example>',
      inReplyTo: root.messageId,
      references: [root.messageId],
    });
    const two = conversationHeaders(d, 'support', 'T1', ['M1'], 'M2');
    expect(two.inReplyTo).toBe(one.messageId);
    expect(two.references).toEqual([root.messageId, one.messageId]);
    expect(replyAddressFor('acme-x@in.example.com', 'tok')).toBe('acme-x+tok@in.example.com');
  });

  it('the Message-ID domain is the sender domain, else the public origin host', () => {
    expect(
      mailDomain({
        supportFrom: 'Support <support@guildwisehq.com>',
        mailFrom: 'x <n@aom.local>',
        publicOrigin: 'https://app.example.com',
      }),
    ).toBe('guildwisehq.com');
    expect(
      mailDomain({
        supportFrom: undefined,
        mailFrom: 'Guildwise <noreply@aom.local>',
        publicOrigin: 'https://app.example.com',
      }),
    ).toBe('app.example.com');
  });
});
