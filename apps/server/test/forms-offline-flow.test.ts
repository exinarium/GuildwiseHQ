import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sweepFormsOffline } from '../src/commands/forms-offline.ts';
import { journeyTick } from '../src/journeys/tick.ts';
import { toDeskDto } from '../src/queries/desk.ts';
import { q } from './helpers/db.ts';
import { messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';
import { PNG, serveStorage, usePublicFormsWorld } from './helpers/public-forms.ts';
import { ok } from './helpers/world.ts';

/**
 * GWP-68: the firm's runner is offline when a client opens a public form. The page asks for an email address only, the
 * runner coming back sends one secure link per case, the desk gets one notice per case, and the journey goes on.
 */
const pf = usePublicFormsWorld({
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_IP_SUBMIT_BURST: '1000',
  AOM_FORMS_IP_SUBMITS_PER_HOUR: '100000',
  AOM_FORMS_OFFLINE_IP_BURST: '1000',
  AOM_FORMS_OFFLINE_IP_PER_HOUR: '100000',
  AOM_FORMS_OFFLINE_FORM_PER_HOUR: '100000',
  AOM_FORMS_OFFLINE_SETTLE_SEC: '0',
});
const ctx = () => pf.w.t.app.ctx;
const sweep = () => sweepFormsOffline(ctx());
const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await journeyTick(ctx(), { projectId: pf.w.projectId });
};
const addr = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@client.example`;
const ANSWER = 'ANSWER-SENTINEL-offline-Quirke-31ab';

async function goOffline() {
  pf.stub.stop();
  pf.r.ws.close();
  await new Promise((r) => setTimeout(r, 300));
}
async function goOnline() {
  pf.r = await pf.w.connectRunner({ capabilities: ['storage:1'] });
  pf.stub = serveStorage(pf.r, pf.dir, pf.connectionId);
}
/** The offline request the page sends: a session from the definition reply, the address, and the personal link. */
async function askForLink(publicId: string, email: string, link?: string, ip?: string) {
  const dto = (await pf.load(publicId, link)).json;
  return pf.post(
    `/api/public/forms/${publicId}/offline-requests`,
    { session: dto.session, nonce: '0', website: '', email, ...(link ? { link } : {}) },
    {},
    ip,
  );
}
const caseOf = async (email: string) => {
  // find by decrypting nothing: the newest case of the form
  return (await q('SELECT * FROM form_offline_requests ORDER BY created_at DESC LIMIT 1'))[0] as any;
};
const linkFromMail = async (email: string, count = 1) => {
  const msgs = await waitForMessages(email, count);
  const text = await messageText(msgs[0]!.ID);
  const m = /#c=([A-Za-z0-9._-]+)/.exec(text);
  return { token: m?.[1] as string, text, subject: msgs[0]!.Subject };
};
const formWaitJourney = async (formId: string) => {
  const created = await ok<any>(
    pf.api('POST', '/api/journeys', {
      projectId: pf.w.projectId,
      definition: {
        name: 'Rentals',
        recordType: 'client',
        firstStepId: 'docs',
        steps: [
          {
            kind: 'wait',
            id: 'docs',
            label: 'Documents',
            waitFor: { kind: 'form', formId, purpose: 'answers', send: { via: 'desk' } },
            duration: { amount: 5, unit: 'days' },
            onTimeout: { action: 'escalate' },
          },
          { kind: 'wait', id: 'screening', label: 'Screening' },
        ],
        handoffs: [{ id: 'h1', from: 'docs', on: 'done', to: 'screening' }],
      },
    }),
    201,
  );
  return created.id as string;
};
const startInstance = async (journeyId: string, name: string) => {
  const id = (
    await ok<any>(
      pf.api('POST', '/api/journey-instances', { journeyId, record: { type: 'client', displayName: name } }),
      201,
    )
  ).id as string;
  await tick();
  const wait = (await q('SELECT * FROM journey_waits WHERE instance_id=$1', [id]))[0] as any;
  const view = await ok<any>(pf.api('GET', `/api/journey-instances/${id}/waits`));
  const token = /#c=(.+)$/.exec(view.waits[0].linkUrl as string)?.[1] as string;
  return { id, wait, token };
};
const instStep = async (id: string) =>
  ((await q('SELECT current_step_id FROM journey_instances WHERE id=$1', [id]))[0] as any).current_step_id;

describe('public-URL case: the runner is offline, then back', () => {
  it('shows nothing to fill in, holds only the encrypted address, then mails one secure link and raises one notice', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Offline public'));
    await goOffline();
    const logFrom = pf.logs.length;

    // the definition says offline; the start is refused before the body is read
    const dto = (await pf.load(publicId)).json;
    expect(dto.availability).toBe('offline');
    const started = await pf.start(publicId, dto, { full_name: ANSWER }, []);
    expect(started.status).toBe(503);
    expect(started.json.error).toMatchObject({ code: 'runner_offline', retryable: true });

    const email = addr('pub');
    const res = await askForLink(publicId, email);
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: 'pending' });
    const c = await caseOf(email);
    expect(c).toMatchObject({ status: 'held', form_id: formId, origin_link_id: null, journey_wait_id: null });
    expect(c.email_enc).toMatch(/^v1:/);
    expect(c.email_enc).not.toContain(email);

    // nothing of the answers anywhere; the address only encrypted; never in a log line
    const dump = await pf.everything();
    expect(dump).not.toContain(ANSWER);
    expect(dump).not.toContain(email);
    expect(pf.logs.slice(logFrom).join('\n')).not.toContain(email);
    expect(pf.stub.files()).toEqual([]);
    const events = await q(`SELECT payload::text AS p FROM events WHERE type LIKE 'FormOffline%'`);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.p).not.toContain('@');

    // a second ask for the same address looks the same and changes nothing
    const again = await askForLink(publicId, email);
    expect(again.status).toBe(202);
    expect((await q('SELECT count(*)::int AS n FROM form_offline_requests WHERE form_id=$1', [formId]))[0].n).toBe(1);

    // still offline: the sweep sends nothing
    await sweep();
    expect(await messagesTo(email)).toHaveLength(0);

    await goOnline();
    await sweep();
    const mail = await linkFromMail(email);
    expect(mail.subject).toMatch(/^Your secure link from /);
    // only the firm name and the link: no form title, no answer, no client reference
    expect(mail.text).not.toContain('Offline public');
    expect(mail.text).not.toContain(ANSWER);
    const after = await caseOf(email);
    expect(after).toMatchObject({ status: 'sent' });
    expect(after.link_sent_at).not.toBeNull();
    expect(after.email_enc).toMatch(/^v1:/); // kept until the case closes (A2)

    // one desk notice with times and no address
    const items = await q(`SELECT * FROM desk_items WHERE subkind='form_offline_link' AND data->>'requestId'=$1`, [c.id]);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).not.toContain(email);
    expect(items[0].data).toMatchObject({ requestId: c.id, formTitle: 'Offline public' });
    expect(items[0].data.attemptedAt).toBeTruthy();
    expect(items[0].data.linkSentAt).toBeTruthy();
    const view = toDeskDto(items[0], pf.w.owner.id, new Map());
    expect((view as any).data).toMatchObject({ requestId: c.id, linkSentAt: items[0].data.linkSentAt });

    // submitting through the secure link writes to the firm's storage and closes the case
    expect((await pf.load(publicId, mail.token)).json.link).toMatchObject({ state: 'valid', purpose: 'offline' });
    const s = await pf.submit(publicId, { full_name: 'Ann' }, [{ field: 'id_copy', name: 'id.png', bytes: PNG }], mail.token);
    expect(s.complete?.status).toBe(200);
    expect(pf.stub.files().length).toBeGreaterThan(0);
    await sweep();
    const closed = await caseOf(email);
    expect(closed).toMatchObject({ status: 'submitted', email_enc: null, email_key: null });
    expect(closed.submission_id).toBe(s.sid);
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [items[0].id]))[0].status).not.toBe('open');

    // used link: refused with a clear message
    const used = await pf.load(publicId, mail.token);
    expect(used.status).toBe(410);
    expect(used.json.error).toMatchObject({ code: 'link_used' });
    expect(used.json.error.message).toContain('secure link');
  });
});

describe('runner flapping sends one link per case', () => {
  it('waits for the settle delay, then two concurrent passes send one mail, one link and one notice', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Flapping'));
    await goOffline();
    const e1 = addr('flap1');
    const e2 = addr('flap2');
    expect((await askForLink(publicId, e1)).status).toBe(202);
    expect((await askForLink(publicId, e2)).status).toBe(202);
    await goOnline();
    // the runner came back a moment ago: wait for the settle delay
    ctx().config.publicForms.offlineSettleSec = 30;
    await q(`UPDATE workstations SET connected_at=now() WHERE id=$1`, [pf.w.workstationId]);
    await sweep();
    expect(await messagesTo(e1)).toHaveLength(0);
    // the runner drops and returns again, then stays up past the settle delay
    await goOffline();
    await sweep();
    await goOnline();
    await q(`UPDATE workstations SET connected_at=now() - interval '5 minutes' WHERE id=$1`, [pf.w.workstationId]);
    await Promise.all([sweep(), sweep()]);
    await sweep();
    ctx().config.publicForms.offlineSettleSec = 0;

    expect(await waitForMessages(e1)).toHaveLength(1);
    expect(await waitForMessages(e2)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await messagesTo(e1)).toHaveLength(1);
    const links = await q(`SELECT id FROM form_client_links WHERE form_id=$1 AND purpose='offline'`, [formId]);
    expect(links).toHaveLength(2);
    const notices = await q(`SELECT id FROM desk_items WHERE subkind='form_offline_link' AND data->>'formId'=$1`, [formId]);
    expect(notices).toHaveLength(2);
  });

  it('a reclaimed "sending" case resends the same link, never a second one', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Reclaim'));
    await goOffline();
    const email = addr('reclaim');
    await askForLink(publicId, email);
    await goOnline();
    await sweep();
    const first = await caseOf(email);
    const m1 = await linkFromMail(email);
    // a crash after the mail, before "sent": the row is back in "sending" and stale
    await q(`UPDATE form_offline_requests SET status='sending', updated_at=now() - interval '10 minutes' WHERE id=$1`, [first.id]);
    await sweep();
    const mails = await waitForMessages(email, 2);
    expect(mails).toHaveLength(2);
    const m2 = /#c=([A-Za-z0-9._-]+)/.exec(await messageText(mails[0]!.ID))?.[1];
    expect(m2).toBe(m1.token);
    expect((await q(`SELECT id FROM form_client_links WHERE form_id=$1 AND purpose='offline'`, [formId])).length).toBe(1);
  });
});

describe('journey case: documents pending, runner offline', () => {
  it('shows the sub-state with its start time, re-points the wait to the secure link, and the journey continues on submission', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Journey docs'));
    const j = await formWaitJourney(formId);
    const { id, wait, token } = await startInstance(j, 'Ann Journey');
    await goOffline();
    const email = addr('jr');
    const asked = await askForLink(publicId, email, token);
    expect(asked.status).toBe(202);

    // visible on the instance like every other wait; the wait itself keeps running
    const view = await ok<any>(pf.api('GET', `/api/journey-instances/${id}/waits`));
    const w = view.waits[0];
    expect(w.status).toBe('open');
    const c = await caseOf(email);
    expect(w.offline).toMatchObject({ requestId: c.id, status: 'held', linkSentAt: null });
    expect(new Date(w.offline.since).toISOString()).toBe(new Date(c.attempted_at).toISOString());
    expect(w.events.map((e: any) => e.text)).toContain('Documents pending, runner offline');
    expect(JSON.stringify(view)).not.toContain(email);
    expect(c.journey_wait_id).toBe(wait.id);

    await goOnline();
    await sweep();
    const mail = await linkFromMail(email);
    const after = (await q('SELECT * FROM journey_waits WHERE id=$1', [wait.id]))[0] as any;
    expect(after.link_id).not.toBe(wait.link_id);
    expect(after.link_id).toBe((await caseOf(email)).link_id);
    // the old personal link is revoked
    const old = (await q('SELECT revoked_at FROM form_client_links WHERE id=$1', [wait.link_id]))[0] as any;
    expect(old.revoked_at).not.toBeNull();
    const notice = (await q(`SELECT * FROM desk_items WHERE subkind='form_offline_link' AND data->>'requestId'=$1`, [c.id]))[0] as any;
    expect(notice.data).toMatchObject({ waitId: wait.id, instanceId: id, journeyName: 'Rentals' });

    const s = await pf.submit(publicId, { full_name: 'Ann' }, [{ field: 'id_copy', name: 'id.png', bytes: PNG }], mail.token);
    expect(s.complete?.status).toBe(200);
    await tick();
    expect(await instStep(id)).toBe('screening');
    await sweep();
    expect((await caseOf(email)).status).toBe('submitted');
    // the notice closed with the wait
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [notice.id]))[0].status).not.toBe('open');
  });

  it('the desk "continue journey" action moves it on, revokes the secure link and closes the case; a repeat is refused', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Journey continue'));
    const j = await formWaitJourney(formId);
    const { id, wait, token } = await startInstance(j, 'Bea Continue');
    await goOffline();
    const email = addr('jc');
    await askForLink(publicId, email, token);
    await goOnline();
    await sweep();
    const mail = await linkFromMail(email);

    await ok(pf.api('POST', `/api/journey-waits/${wait.id}/continue`));
    expect(await instStep(id)).toBe('screening');
    const again = await pf.api('POST', `/api/journey-waits/${wait.id}/continue`);
    expect(again.status).toBe(400);
    expect(JSON.stringify(again.body)).toContain('wait_not_open');

    await sweep();
    expect(await caseOf(email)).toMatchObject({ status: 'continued', email_enc: null });
    const gone = await pf.load(publicId, mail.token);
    expect(gone.status).toBe(410);
    expect(gone.json.error.code).toBe('link_revoked');
    expect(gone.json.error.message).toContain('secure link');
  });
});

describe('secure link refusals', () => {
  it('an expired link and a tampered link are refused with a clear message', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Link errors'));
    await goOffline();
    const email = addr('exp');
    await askForLink(publicId, email);
    await goOnline();
    await sweep();
    const mail = await linkFromMail(email);

    const tampered = `${mail.token.slice(0, -3)}AAA`;
    const bad = await pf.load(publicId, tampered);
    expect(bad.status).toBe(404);
    expect(bad.json.error.code).toBe('link_invalid');

    await q(`UPDATE form_client_links SET expires_at = now() - interval '1 hour' WHERE form_id=$1 AND purpose='offline'`, [formId]);
    const expired = await pf.load(publicId, mail.token);
    expect(expired.status).toBe(410);
    expect(expired.json.error.code).toBe('link_expired');
    expect(expired.json.error.message).toContain('secure link');

    // the case closes as expired, the address is deleted and the desk is told
    await q(`UPDATE form_offline_requests SET link_expires_at = now() - interval '1 hour' WHERE form_id=$1`, [formId]);
    await sweep();
    expect(await caseOf(email)).toMatchObject({ status: 'expired', email_enc: null, email_key: null });
    const notices = await q(`SELECT title FROM desk_items WHERE subkind='form_offline_hold_expired' AND data->>'formId'=$1`, [formId]);
    expect(notices).toHaveLength(1);
  });

  it('a case whose hold ran out is closed, the address deleted and the desk told once', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Hold ran out'));
    await goOffline();
    const email = addr('hold');
    await askForLink(publicId, email);
    await q(`UPDATE form_offline_requests SET hold_expires_at = now() - interval '1 minute' WHERE form_id=$1`, [formId]);
    await sweep();
    await sweep();
    expect(await caseOf(email)).toMatchObject({ status: 'expired', email_enc: null });
    const n = await q(`SELECT 1 FROM desk_items WHERE subkind='form_offline_hold_expired' AND data->>'formId'=$1`, [formId]);
    expect(n).toHaveLength(1);
    await goOnline();
  });

  it('the page does not accept an offline request when the runner is online, or a replayed session', async () => {
    const { publicId } = await pf.published(pf.definition('Online'));
    const online = await askForLink(publicId, addr('on'));
    expect(online.status).toBe(409);
    expect(online.json.error.code).toBe('runner_online');
    await goOffline();
    const dto = (await pf.load(publicId)).json;
    const body = { session: dto.session, nonce: '0', website: '', email: addr('rp') };
    expect((await pf.post(`/api/public/forms/${publicId}/offline-requests`, body)).status).toBe(202);
    const replay = await pf.post(`/api/public/forms/${publicId}/offline-requests`, { ...body, email: addr('rp2') });
    expect(replay.status).toBe(409);
    expect(replay.json.error.code).toBe('session_used');
    const bot = await pf.post(`/api/public/forms/${publicId}/offline-requests`, {
      ...body,
      session: (await pf.load(publicId)).json.session,
      website: 'http://spam',
      email: addr('bot'),
    });
    expect(bot.status).toBe(422);
    await goOnline();
  });
});
