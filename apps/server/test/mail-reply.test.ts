import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepEventTriggers } from '../src/commands/schedule-triggers.ts';
import type { MailMessage } from '../src/mail/mailer.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Replying to an e-mail conversation from inside Guildwise (#15). */

const SECRET = 'reply-secret-1234567890';
const DOMAIN = 'in.reply.example';
let w: World;
let inbox: any;
let orgId = '';
const sent: MailMessage[] = [];

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const hook = (over: Record<string, unknown>) =>
  w.t.app.inject({
    method: 'POST',
    url: '/api/inbound/mail/fake',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`aom:${SECRET}`).toString('base64')}`,
    },
    payload: {
      from: 'ana@acme.com',
      fromName: 'Ana',
      to: inbox.address,
      subject: 'Printer is on fire',
      text: 'Please come and look.',
      messageId: `<${randomUUID()}@acme.com>`,
      dkim: 'pass',
      ...over,
    },
  });
const sweep = async () => {
  await w.t.app.ctx.services.scheduler.run();
  await sweepEventTriggers(w.t.app.ctx);
};

let cardId = '';
let threadId = '';

beforeAll(async () => {
  w = await createWorld({
    env: {
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      AOM_INBOUND_PROVIDER: 'fake',
      AOM_INBOUND_DOMAIN: DOMAIN,
      AOM_INBOUND_SECRET: SECRET,
      AOM_INBOUND_RATE_PER_HOUR: '100',
      AOM_INBOUND_RATE_PER_SENDER_PER_HOUR: '0',
    },
  });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  inbox = await ok(owner('POST', '/api/mail-inboxes', { label: 'Support' }), 201);
  w.t.app.ctx.mailer = {
    async send(m) {
      sent.push(m);
    },
    close() {},
  };
  const s = await ok<any>(
    owner('POST', '/api/schedules', {
      name: 'Mail to cards',
      trigger: { kind: 'email_received', inboxId: inbox.id },
      action: {
        kind: 'create_card',
        projectId: w.projectId,
        template: {
          title: 'Mail',
          fields: {},
          mapping: { title: '{email.subject}', context: '{email.body}' },
        },
      },
    }),
    201,
  );
  await sweep();
  expect((await hook({})).statusCode).toBe(200);
  await until(
    async () => {
      await sweep();
      return (await q('SELECT 1 FROM cards WHERE schedule_id=$1', [s.id])).length === 1;
    },
    8000,
    'card from mail',
  );
  cardId = (await q('SELECT id FROM cards WHERE schedule_id=$1', [s.id]))[0]?.id as string;
  threadId = (await q('SELECT id FROM mail_threads WHERE card_id=$1', [cardId]))[0]?.id as string;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('the organisation looks like itself to the client', () => {
  it('sends plain mail from the platform address under the organisation name, with no Guildwise text', async () => {
    const res = await ok<any>(
      owner('POST', `/api/cards/${cardId}/mail-reply`, { text: 'We will look at it today.' }),
    );
    const m = sent.at(-1) as any;
    const org = (await q('SELECT name FROM organizations WHERE id=$1', [orgId]))[0]?.name as string;
    expect(m.from.startsWith(`"${org}" <`) && m.from.endsWith('>')).toBe(true);
    expect(m.html).toBeUndefined();
    expect(m.text).toBe('We will look at it today.');
    expect(m.text.toLowerCase()).not.toContain('guildwise');
    expect(m.subject.toLowerCase()).not.toContain('guildwise');
    expect(m.replyTo).toContain(`@${DOMAIN}`);
    expect(m.inReplyTo).toBeTruthy();
    expect(res.messages.at(-1).direction).toBe('out');
    sent.length = 0;
    await q(`DELETE FROM mail_messages WHERE direction='out'`);
  });

  it('refuses a reply that names agents, AI or Guildwise, so the person edits it', async () => {
    const agent = (await q('SELECT name FROM agents WHERE org_id=$1 LIMIT 1', [orgId]))[0]?.name as
      | string
      | undefined;
    for (const text of [
      'Our AI agent will look into it',
      'Sent via Guildwise',
      'See https://guildwisehq.com/x',
      ...(agent ? [`${agent} fixed it`] : []),
    ]) {
      const res = await owner('POST', `/api/cards/${cardId}/mail-reply`, { text });
      expect(res.status, text).toBe(422);
      expect(res.body.error.code).toBe('reply_reveals_internals');
    }
    const subject = await owner('POST', `/api/cards/${cardId}/mail-reply`, {
      text: 'Fine',
      subject: 'Re: Guildwise',
    });
    expect(subject.status).toBe(422);
    expect(sent).toHaveLength(0);
  });
});

describe('reply to an e-mail conversation', () => {
  it('shows the conversation on the card and who may reply', async () => {
    const t = await ok<any>(owner('GET', `/api/cards/${cardId}/mail-thread`));
    expect(t).toMatchObject({ id: threadId, canReply: true, replyTo: 'ana@acme.com', cardId });
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ direction: 'in', from: 'ana@acme.com' });
  });

  it('sends the reply into the thread, stores it and notes it on the card', async () => {
    const res = await ok<any>(owner('POST', `/api/cards/${cardId}/mail-reply`, { text: 'On our way.' }));
    expect(res.messages.map((m: any) => m.direction)).toEqual(['in', 'out']);
    expect(res.messages[1]).toMatchObject({ text: 'On our way.', subject: 'Re: Printer is on fire' });
    expect(res.messages[1].sentByName).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'ana@acme.com',
      subject: 'Re: Printer is on fire',
      text: 'On our way.',
    });
    expect(sent[0]?.replyTo).toMatch(new RegExp(`\\+[a-z2-9]{10}@${DOMAIN.replace(/\./g, '\\.')}$`));
    const ev = await q(`SELECT payload FROM events WHERE type='MailReplySent' AND payload->>'messageId'=$1`, [
      res.messages[1].id,
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ cardId, to: 'ana@acme.com' });
    const note = await q(
      `SELECT body FROM thread_messages WHERE thread_id=$1 AND body LIKE 'E-mail reply sent to%On our way.%'`,
      [cardId],
    );
    expect(note).toHaveLength(1);
    expect(note[0]?.body).toContain('On our way.');
  });

  it('a customer answer to the reply lands on the same card', async () => {
    const out = (
      await q(`SELECT message_id FROM mail_messages WHERE thread_id=$1 AND direction='out'`, [threadId])
    )[0];
    expect((await hook({ inReplyTo: out?.message_id, subject: 'Re: Printer is on fire' })).statusCode).toBe(
      200,
    );
    await until(
      async () => {
        await sweep();
        return (
          (await q(`SELECT 1 FROM mail_messages WHERE thread_id=$1 AND status='comment_added'`, [threadId]))
            .length === 1
        );
      },
      8000,
      'customer reply',
    );
  });

  it('works from the inbox for an organisation Owner, on a thread without a card', async () => {
    expect((await hook({ subject: 'Nobody takes this', from: 'bob@acme.com' })).statusCode).toBe(200);
    const t2 = (
      await q(
        `SELECT t.id FROM mail_threads t JOIN mail_messages m ON m.thread_id = t.id WHERE m.subject='Nobody takes this'`,
      )
    )[0]?.id as string;
    const res = await ok<any>(
      owner('POST', `/api/mail-threads/${t2}/reply`, { text: 'Hello Bob', subject: 'Custom' }),
    );
    expect(res.messages.at(-1)).toMatchObject({ direction: 'out', subject: 'Custom' });
    expect(sent.at(-1)).toMatchObject({ to: 'bob@acme.com', subject: 'Custom' });
  });

  it('refuses people without a role on the project or the organisation, and other organisations', async () => {
    const stranger = await w.t.userSession(`stranger-${randomUUID().slice(0, 6)}@example.com`);
    const before = sent.length;
    for (const [m, url] of [
      ['GET', `/api/cards/${cardId}/mail-thread`],
      ['POST', `/api/cards/${cardId}/mail-reply`],
      ['GET', `/api/mail-threads/${threadId}`],
      ['POST', `/api/mail-threads/${threadId}/reply`],
    ] as const) {
      const res = await w.t.req(m, url, {
        cookie: stranger.cookie,
        body: m === 'POST' ? { text: 'hi' } : undefined,
      });
      expect([403, 404]).toContain(res.status);
    }
    expect(sent.length).toBe(before);
  });

  it('a project member (manager) may reply on the card but has no inbox access', async () => {
    const member = await addMember(w, 'mailmanager');
    const res = await w.t.req('POST', `/api/cards/${cardId}/mail-reply`, {
      cookie: member.cookie,
      body: { text: 'From a manager' },
    });
    expect(res.status).toBe(200);
    expect(sent.at(-1)?.text).toBe('From a manager');
    const inboxView = await w.t.req('GET', `/api/mail-threads/${threadId}`, { cookie: member.cookie });
    expect(inboxView.status).toBe(404);
  });

  it('does not answer a thread with nobody accepted to answer, and a send failure stores nothing', async () => {
    expect((await hook({ subject: 'Spam', from: 'x@y.com', spamScore: 99 })).statusCode).toBe(200);
    const spam = (await q(`SELECT thread_id FROM mail_messages WHERE subject='Spam'`))[0]
      ?.thread_id as string;
    const res = await w.t.req('POST', `/api/mail-threads/${spam}/reply`, {
      cookie: w.owner.cookie,
      body: { text: 'hi' },
    });
    expect(res.status).toBe(409);

    const ctx = w.t.app.ctx;
    const saved = ctx.mailer;
    ctx.mailer = {
      async send() {
        throw new Error('smtp down');
      },
      close() {},
    };
    try {
      const outBefore = (await q(`SELECT count(*)::int AS n FROM mail_messages WHERE direction='out'`))[0]?.n;
      const fail = await w.t.req('POST', `/api/cards/${cardId}/mail-reply`, {
        cookie: w.owner.cookie,
        body: { text: 'will fail' },
      });
      expect(fail.status).toBe(409);
      expect(fail.body.error?.code ?? fail.body.code).toBe('mail_send_failed');
      expect((await q(`SELECT count(*)::int AS n FROM mail_messages WHERE direction='out'`))[0]?.n).toBe(
        outBefore,
      );
    } finally {
      ctx.mailer = saved;
    }
  });

  it('limits replies per organisation per hour', async () => {
    const outHour = Number(
      (await q(`SELECT count(*) AS n FROM mail_messages WHERE org_id=$1 AND direction='out'`, [orgId]))[0]?.n,
    );
    for (let i = outHour; i < 30; i++)
      await ok(owner('POST', `/api/cards/${cardId}/mail-reply`, { text: `bulk ${i}` }));
    const over = await owner('POST', `/api/cards/${cardId}/mail-reply`, { text: 'one too many' });
    expect(over.status).toBe(409);
  });
});
