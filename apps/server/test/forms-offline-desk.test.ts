import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sweepFormsOffline } from '../src/commands/forms-offline.ts';
import { q as rawQ } from './helpers/db.ts';
import { messagesTo, waitForMessages } from './helpers/mailpit.ts';
import { serveStorage, usePublicFormsWorld } from './helpers/public-forms.ts';
import { ok } from './helpers/world.ts';

const q = (sql: string, params?: unknown[]) => rawQ(sql, params) as Promise<any[]>;

/** GWP-68 option A2: the desk can show the held address (audited) and resend the same link, until the case closes. */
const pf = usePublicFormsWorld({
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_OFFLINE_IP_BURST: '1000',
  AOM_FORMS_OFFLINE_IP_PER_HOUR: '100000',
  AOM_FORMS_OFFLINE_SETTLE_SEC: '0',
});
const ctx = () => pf.w.t.app.ctx;

async function sentCase(email: string) {
  const { formId, publicId } = await pf.published(pf.definition('Desk A2'));
  pf.stub.stop();
  pf.r.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const dto = (await pf.load(publicId)).json;
  const res = await pf.post(`/api/public/forms/${publicId}/offline-requests`, {
    session: dto.session,
    nonce: '0',
    website: '',
    email,
  });
  expect(res.status).toBe(202);
  pf.r = await pf.w.connectRunner({ capabilities: ['storage:1'] });
  pf.stub = serveStorage(pf.r, pf.dir, pf.connectionId);
  await sweepFormsOffline(ctx());
  await waitForMessages(email);
  const c = (await q('SELECT * FROM form_offline_requests WHERE form_id=$1', [formId]))[0] as any;
  return { formId, publicId, id: c.id as string };
}

describe('desk: show email and resend link', () => {
  it('an Owner sees the address, audited without the address; the same link goes out again, at most three times', async () => {
    const email = `a2-${randomUUID().slice(0, 8)}@client.example`;
    const { id, formId } = await sentCase(email);

    const shown = await ok<any>(pf.api('POST', `/api/forms/offline-requests/${id}/email`));
    expect(shown).toEqual({ email });
    const audit = await q(
      `SELECT payload::text AS p FROM events WHERE type='FormOfflineEmailViewed' AND stream_id=$1`,
      [`form-${formId}`],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].p).toContain(id);
    expect(audit[0].p).not.toContain('@');

    for (let n = 1; n <= 3; n++) {
      const r = await ok<any>(pf.api('POST', `/api/forms/offline-requests/${id}/resend`));
      expect(r.resends).toBe(n);
    }
    const fourth = await pf.api('POST', `/api/forms/offline-requests/${id}/resend`);
    expect(fourth.status).toBe(400);
    expect(JSON.stringify(fourth.body)).toContain('resend_limit');
    expect(await messagesTo(email)).toHaveLength(4);
    const resent = await q(
      `SELECT payload::text AS p FROM events WHERE type='FormOfflineLinkResent' AND stream_id=$1`,
      [`form-${formId}`],
    );
    expect(resent).toHaveLength(3);
    for (const e of resent) expect(e.p).not.toContain('@');
  });

  it('a member (not Owner or Admin) is refused, and a cancelled case can no longer show or resend; the address is deleted', async () => {
    const email = `a2c-${randomUUID().slice(0, 8)}@client.example`;
    const { id } = await sentCase(email);
    const { showOfflineEmail } = await import('../src/commands/forms-offline.ts');
    await expect(
      showOfflineEmail(ctx(), { userId: randomUUID(), orgId: pf.orgId } as any, id),
    ).rejects.toThrow();

    await ok(pf.api('POST', `/api/forms/offline-requests/${id}/cancel`));
    const row = (
      await q('SELECT status, email_enc, email_key FROM form_offline_requests WHERE id=$1', [id])
    )[0] as any;
    expect(row).toEqual({ status: 'cancelled', email_enc: null, email_key: null });
    expect((await pf.api('POST', `/api/forms/offline-requests/${id}/email`)).status).toBe(400);
    expect((await pf.api('POST', `/api/forms/offline-requests/${id}/resend`)).status).toBe(400);
  });
});
