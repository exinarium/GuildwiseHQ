import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepEventTriggers } from '../src/commands/schedule-triggers.ts';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import type { MailMessage } from '../src/mail/mailer.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** "Draft with BA" for e-mail replies (#67 D): a BA task writes the draft, a person reviews and sends it. */

const SECRET = 'draft-secret-1234567890';
const DOMAIN = 'in.draft.example';
let w: World;
let r: FakeRunner;
let inbox: any;
let orgId = '';
let cardId = '';
let threadId = '';
const sent: MailMessage[] = [];

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const sweep = async () => {
  await w.t.app.ctx.services.scheduler.run();
  await sweepEventTriggers(w.t.app.ctx);
};
const draftOf = async (path: string) => (await ok<any>(owner('GET', path))).draft;

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
  const res = await w.t.app.inject({
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
    },
  });
  expect(res.statusCode).toBe(200);
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
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

/** The next draft task shift, accepted and started like a real runner. */
async function draftShift(from = 0) {
  await w.t.app.ctx.services.dispatcher.runPass();
  const start = (await r.waitFor(
    'shift.start',
    (f) => f.kind === 'ba_task' && f.baTask?.kind === 'mail_reply_draft',
    10_000,
    from,
  )) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'shift running',
  );
  return start;
}
const report = async (shiftId: string, rep: Record<string, unknown>) => {
  const { reportId } = r.report(shiftId, rep);
  return (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
};
const end = async (shiftId: string) => {
  r.ended(shiftId, 'reported');
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [shiftId]))[0],
    3000,
    'shift ended',
  );
};

describe('asking for a draft', () => {
  it('is refused when the organisation has no BA, and for people who may not reply', async () => {
    const none = await owner('POST', `/api/cards/${cardId}/mail-draft`);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('no_ba');
    await w.hire('Ben', 'ba', 'senior');
    const m = await addMember(w, 'plainmember');
    const asMember = await w.t.req('POST', `/api/mail-threads/${threadId}/draft`, { cookie: m.cookie });
    expect(asMember.status).toBe(404);
    expect((await w.t.req('GET', `/api/mail-threads/${threadId}/draft`, { cookie: m.cookie })).status).toBe(
      404,
    );
    expect(await q('SELECT 1 FROM mail_reply_drafts')).toHaveLength(0);
  });

  it('queues a mail_reply_draft task, once while one is on its way, and shows the state', async () => {
    const first = await owner('POST', `/api/cards/${cardId}/mail-draft`);
    expect(first.status).toBe(202);
    expect(first.body.draft).toMatchObject({ status: 'queued', text: null });
    const again = await ok<any>(owner('POST', `/api/mail-threads/${threadId}/draft`), 202);
    expect(again.draft.id).toBe(first.body.draft.id);
    const task = (await q(`SELECT * FROM ba_tasks WHERE kind='mail_reply_draft'`)) as any[];
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ status: 'queued', org_level: true, mail_draft_id: first.body.draft.id });
    expect((await draftOf(`/api/cards/${cardId}/mail-draft`)).status).toBe('queued');
  });
});

describe('the BA writes the draft', () => {
  it('gets the conversation, the card and who sends; a draft naming agents is refused, a clean one is stored and nothing is sent', async () => {
    const start = await draftShift();
    const t = start.baTask.mailDraft;
    expect(t.messages.at(-1)).toMatchObject({
      direction: 'in',
      from: 'ana@acme.com',
      text: 'Please come and look.',
    });
    expect(t.subject).toBe('Printer is on fire');
    expect(t.to).toBe('ana@acme.com');
    expect(t.senderName).toBeTruthy();
    expect(t.card.ref).toMatch(/^TOY-/);
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['mail_draft_done', 'mail_draft_fail']);

    const agentName = (await q('SELECT name FROM agents WHERE org_id=$1 LIMIT 1', [orgId]))[0]
      ?.name as string;
    const bad = await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'mail_draft_done',
      note: 'Reply draft',
      data: { text: `Hello Ana,\n\n${agentName} has looked at it.\n\nKind regards` },
    });
    expect(bad.accepted).toBe(false);
    expect(bad.error ?? bad.message).toContain(agentName);
    const ai = await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'mail_draft_done',
      note: 'Reply draft',
      data: { text: 'Hello Ana,\n\nOur AI assistant is on it.' },
    });
    expect(ai.accepted).toBe(false);
    expect((await draftOf(`/api/cards/${cardId}/mail-draft`)).status).toBe('running');

    const good = await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'mail_draft_done',
      note: 'Reply draft',
      data: {
        text: 'Hello Ana,\n\nI will send someone today.\n\nKind regards,\nPat',
        subject: 'Re: Printer',
      },
    });
    expect(good.accepted).toBe(true);
    await end(start.shiftId);
    const d = await draftOf(`/api/mail-threads/${threadId}/draft`);
    expect(d).toMatchObject({
      status: 'done',
      text: 'Hello Ana,\n\nI will send someone today.\n\nKind regards,\nPat',
      subject: 'Re: Printer',
    });
    expect((await q('SELECT status FROM ba_tasks WHERE kind=$1', ['mail_reply_draft']))[0]?.status).toBe(
      'done',
    );
    // never auto-sent
    expect(sent).toHaveLength(0);
    expect(await q(`SELECT 1 FROM mail_messages WHERE direction='out'`)).toHaveLength(0);
  });

  it('the person sends the draft (edited): the send records draftedBy and the draft is used up', async () => {
    const res = await ok<any>(
      owner('POST', `/api/cards/${cardId}/mail-reply`, {
        text: 'Hello Ana,\n\nI will send someone this afternoon.\n\nKind regards,\nPat',
        draftedBy: 'ba',
      }),
    );
    expect(res.messages.at(-1).direction).toBe('out');
    expect(sent).toHaveLength(1);
    const ev = (
      await q(`SELECT payload FROM events WHERE type='MailReplySent' ORDER BY seq DESC LIMIT 1`)
    )[0] as any;
    expect(ev.payload.draftedBy).toBe('ba');
    expect(await draftOf(`/api/cards/${cardId}/mail-draft`)).toBeNull();
  });

  it('the reveal check still runs on send, whatever the draft said', async () => {
    const res = await owner('POST', `/api/cards/${cardId}/mail-reply`, {
      text: 'Sent with Guildwise.',
      draftedBy: 'ba',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('reply_reveals_internals');
  });

  it('a BA that cannot write a reply says so; the person sees why and can ask again', async () => {
    const req = await ok<any>(owner('POST', `/api/cards/${cardId}/mail-draft`), 202);
    expect(req.draft.status).toBe('queued');
    const start = await draftShift(r.received.length);
    const out = await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'mail_draft_fail',
      note: 'The customer only said thanks.',
      data: {},
    });
    expect(out.accepted).toBe(true);
    await end(start.shiftId);
    const d = await draftOf(`/api/cards/${cardId}/mail-draft`);
    expect(d).toMatchObject({ status: 'failed', error: 'The customer only said thanks.', text: null });
    const next = await ok<any>(owner('POST', `/api/cards/${cardId}/mail-draft`), 202);
    expect(next.draft.id).not.toBe(req.draft.id);
    expect(next.draft.status).toBe('queued');
  });
});

describe('when no BA takes the task', () => {
  it('after two failed attempts the server marks the draft failed, so the person writes the reply themselves', async () => {
    const queued = await ok<any>(owner('POST', `/api/cards/${cardId}/mail-draft`), 202);
    // the open request from the previous test is still waiting: it is reused, so ask only if none is open
    const id = queued.draft.id as string;
    await q(`UPDATE ba_tasks SET attempts=2 WHERE mail_draft_id=$1`, [id]);
    await baTaskPass(w.t.app.ctx);
    const task = (await q('SELECT status FROM ba_tasks WHERE mail_draft_id=$1', [id]))[0] as any;
    expect(task.status).toBe('fallback');
    const d = await draftOf(`/api/cards/${cardId}/mail-draft`);
    expect(d).toMatchObject({ id, status: 'failed', text: null });
    expect(d.error).toContain('write the reply yourself');
  });
});
