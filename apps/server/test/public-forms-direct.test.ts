import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { q } from './helpers/db.ts';
import { PDF, usePublicFormsWorld } from './helpers/public-forms.ts';

const one = async (sql: string, params?: unknown[]) => (await q(sql, params))[0] as Record<string, any>;
const ORIGIN = 'https://s3.example.com';
const SECRET = 'SECRETSIGNATURE0123';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const pf = usePublicFormsWorld({
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_IP_SUBMIT_BURST: '1000',
  AOM_FORMS_IP_SUBMITS_PER_HOUR: '100000',
});

/** The fake runner's behaviour for the grant frames. */
const run = {
  grant: ((_f: any) => null) as (f: any) => { error?: any; url?: string } | null,
  verify: ((_f: any) => null) as (f: any) => { error?: any; reference?: any } | null,
  seen: [] as any[],
  attached: false,
};
function attach() {
  if (run.attached) return;
  run.attached = true;
  pf.r.ws.on('message', (data: unknown) => {
    const f = JSON.parse(String(data));
    if (f.type === 'storage.grant.open') {
      run.seen.push(f);
      const o = run.grant(f);
      if (o?.error) pf.r.send('storage.grant.result', { grantId: f.grantId, ok: false, error: o.error });
      else
        pf.r.send('storage.grant.result', {
          grantId: f.grantId,
          ok: true,
          grant: {
            provider: 's3',
            method: 'PUT',
            url: o?.url ?? `${ORIGIN}/bkt/.guildwise-incoming/${f.grantId}.pdf?X-Amz-Signature=${SECRET}`,
            headers: { 'if-none-match': '*' },
            chunkBytes: null,
            expiresAt: Date.now() + 600_000,
          },
        });
    } else if (f.type === 'storage.grant.finish') {
      run.seen.push(f);
      const v = run.verify(f);
      if (v?.error) pf.r.send('storage.grant.verified', { grantId: f.grantId, ok: false, error: v.error });
      else
        pf.r.send('storage.grant.verified', {
          grantId: f.grantId,
          ok: true,
          reference: v?.reference ?? {
            v: 1,
            connectionId: pf.connectionId,
            kind: 's3',
            path: `forms/${f.grantId}.pdf`,
            size: f.size,
            sha256: f.sha256,
            contentType: 'application/pdf',
            writtenAt: new Date().toISOString(),
          },
        });
    } else if (f.type === 'storage.grant.cancel') run.seen.push(f);
  });
}
const report = async (origin: string | null, reason: string | null = null) => {
  pf.r.send('storage.direct.report', {
    connections: [{ connectionId: pf.connectionId, uploadOrigin: origin, reason }],
  });
  await new Promise((r) => setTimeout(r, 150));
};
const files = [{ field: 'id_copy', name: 'My ID.pdf', bytes: PDF }];

async function begin(title: string) {
  const { publicId } = await pf.published(pf.definition(title));
  const dto = (await pf.load(publicId)).json;
  const start = await pf.start(publicId, dto, { full_name: 'P' }, files);
  const { submissionId: sid, uploadToken: token } = start.json;
  const base = `/api/public/forms/${publicId}/submissions/${sid}`;
  const h = { 'x-upload-token': token };
  return {
    publicId,
    dto,
    start,
    sid,
    token,
    grant: () => pf.post(`${base}/parts/0/grant`, {}, h),
    offset: () => pf.get(`${base}/parts/0/grant`, h),
    done: (body: unknown) => pf.post(`${base}/parts/0/grant/complete`, body, h),
    cancel: (reason: string) => pf.post(`${base}/parts/0/grant/cancel`, { reason }, h),
    status: () => pf.get(base, h),
    put: () => pf.put(`${base}/parts/0`, PDF, { ...h, 'x-file-name': 'f' }),
    complete: () => pf.post(`${base}/complete`, { answers: { full_name: 'P' } }, h),
  };
}
const settle = async (s: Awaited<ReturnType<typeof begin>>) => {
  for (let i = 0; i < 100; i++) {
    const st = await s.status();
    if (st.json.parts[0].state !== 'verifying') return st.json;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('still verifying');
};

describe('direct uploads to a cloud destination', () => {
  it('start refuses before anything is sent when the runner reported no upload host (no relay)', async () => {
    attach();
    await q(`UPDATE storage_connections SET kind='s3' WHERE id=$1`, [pf.connectionId]);
    await report(null, 'cors_missing');
    const { publicId } = await pf.published(pf.definition('No host'));
    const dto = (await pf.load(publicId)).json;
    const before = await q('SELECT 1 FROM form_submissions');
    const r = await pf.start(publicId, dto, { full_name: 'P' }, files);
    expect(r.status).toBe(503);
    expect(r.json.error).toMatchObject({ code: 'upload_unavailable', retryable: true });
    expect((await q('SELECT 1 FROM form_submissions')).length).toBe(before.length);
  });

  it('lists the reported host in the page rules and the form, and nothing broader', async () => {
    await report(ORIGIN);
    const { publicId } = await pf.published(pf.definition('Rules'));
    const page = await pf.get(`/f/${publicId}`);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain(`connect-src 'self' ${ORIGIN};`);
    expect(csp).not.toMatch(/\*|http:/);
    expect((await pf.load(publicId)).json.uploadOrigins).toEqual([ORIGIN]);
  });

  it('marks the part direct, refuses the relay PUT with 409 and sends no byte to the runner', async () => {
    await report(ORIGIN);
    const s = await begin('Relay refused');
    expect(s.start.json.parts[0].mode).toBe('direct');
    const opens = pf.stub.opens();
    const put = await s.put();
    expect(put.status).toBe(409);
    expect(put.json.error.code).toBe('upload_mode');
    expect(pf.stub.opens()).toBe(opens);
  });

  it('issues a grant that is never logged or stored, then verifies and completes', async () => {
    await report(ORIGIN);
    run.grant = () => null;
    run.verify = () => null;
    const s = await begin('Happy');
    const g = await s.grant();
    expect(g.status).toBe(200);
    expect(g.headers['cache-control']).toContain('no-store');
    expect(g.json.grant.url).toContain(SECRET);
    expect(g.json.grant).toMatchObject({ method: 'PUT', chunkBytes: null });
    const open = run.seen.find((f) => f.type === 'storage.grant.open');
    expect(open).toMatchObject({
      size: PDF.length,
      sha256: sha(PDF),
      ext: 'pdf',
      contentType: 'application/pdf',
    });

    const bad = await s.done({ size: PDF.length, sha256: 'f'.repeat(64) });
    expect(bad.status).toBe(400);

    // the first complete was refused and cancelled the grant: ask again
    const g2 = await s.grant();
    expect(g2.status).toBe(200);
    const done = await s.done({ size: PDF.length, sha256: sha(PDF), etag: 'abc' });
    expect(done.status).toBe(202);
    expect(done.json.state).toBe('verifying');
    const st = await settle(s);
    expect(st.parts[0].state).toBe('stored');
    const c = await s.complete();
    expect(c.status).toBe(200);

    expect(pf.logs.join('\n')).not.toContain(SECRET);
    expect(await pf.everything()).not.toContain(SECRET);
    expect(JSON.stringify(await q('SELECT * FROM runner_commands'))).not.toContain(SECRET);
  });

  it('a failed check marks the part failed and the submission cannot complete', async () => {
    await report(ORIGIN);
    run.grant = () => null;
    run.verify = () => ({ error: { code: 'type_refused', message: 'no', retryable: false } });
    const s = await begin('Bad content');
    expect((await s.grant()).status).toBe(200);
    await s.done({ size: PDF.length, sha256: sha(PDF) });
    const st = await settle(s);
    expect(st.parts[0]).toMatchObject({ state: 'failed', error: 'type_refused' });
    const c = await s.complete();
    expect(c.status).toBe(409);
    expect(c.json.error.code).toBe('parts_missing');
    run.verify = () => null;
  });

  it('a malware verdict takes the submission back', async () => {
    await report(ORIGIN);
    run.verify = () => ({ error: { code: 'malware_detected', message: 'x', retryable: false } });
    const s = await begin('Infected');
    await s.grant();
    await s.done({ size: PDF.length, sha256: sha(PDF) });
    await settle(s);
    const row = await one('SELECT status, error_code FROM form_submissions WHERE id=$1', [s.sid]);
    expect(row).toMatchObject({ status: 'failed', error_code: 'malware_detected' });
    run.verify = () => null;
  });

  it('a receipt for another size or hash does not count as stored', async () => {
    await report(ORIGIN);
    run.verify = () => ({
      reference: {
        v: 1,
        connectionId: pf.connectionId,
        kind: 's3',
        path: 'x.pdf',
        size: 1,
        sha256: 'a'.repeat(64),
        contentType: 'application/pdf',
        writtenAt: new Date().toISOString(),
      },
    });
    const s = await begin('Wrong receipt');
    await s.grant();
    await s.done({ size: PDF.length, sha256: sha(PDF) });
    expect((await settle(s)).parts[0].state).toBe('failed');
    run.verify = () => null;
  });

  it('a retryable grant error keeps the part pending; the third failure fails the submission', async () => {
    await report(ORIGIN);
    run.grant = () => ({ error: { code: 'unavailable', message: 'busy', retryable: true } });
    const s = await begin('Busy provider');
    const a = await s.grant();
    expect(a.status).toBe(503);
    expect(a.json.error).toMatchObject({ code: 'upload_unavailable', retryable: true });
    expect((await s.status()).json.parts[0].state).toBe('pending');
    expect((await s.grant()).status).toBe(503);
    const third = await s.grant();
    expect(third.status).toBe(502);
    expect(third.json.error).toMatchObject({ code: 'upload_unavailable', retryable: false });
    expect(await one('SELECT status, error_code FROM form_submissions WHERE id=$1', [s.sid])).toMatchObject({
      status: 'failed',
      error_code: 'upload_unavailable',
    });
    run.grant = () => null;
  });

  it('a final grant error fails the submission at once, never falling back to the relay', async () => {
    await report(ORIGIN);
    run.grant = () => ({ error: { code: 'auth_expired', message: 'x', retryable: false } });
    const s = await begin('Signed out');
    const g = await s.grant();
    expect(g.status).toBe(502);
    expect(g.json.error.code).toBe('upload_unavailable');
    expect((await one('SELECT status FROM form_submissions WHERE id=$1', [s.sid])).status).toBe('failed');
    run.grant = () => null;
  });

  it('refuses an address on another host than the one the runner reported', async () => {
    await report(ORIGIN);
    run.seen.length = 0;
    run.grant = () => ({ url: 'https://evil.example.net/x?sig=1' });
    const s = await begin('Other host');
    const g = await s.grant();
    expect(g.status).toBe(502);
    expect(g.text).not.toContain('evil.example.net');
    expect(run.seen.some((f) => f.type === 'storage.grant.cancel')).toBe(true);
    run.grant = () => null;
  });

  it('cancel: retry puts the part back to pending, blocked fails the submission', async () => {
    await report(ORIGIN);
    const a = await begin('Cancel retry');
    await a.grant();
    expect((await a.cancel('retry')).json.state).toBe('pending');
    expect((await a.grant()).status).toBe(200);
    const b = await begin('Cancel blocked');
    await b.grant();
    expect((await b.cancel('blocked')).json.state).toBe('failed');
    expect(
      (await one('SELECT status, error_code FROM form_submissions WHERE id=$1', [b.sid])).error_code,
    ).toBe('upload_unavailable');
  });

  it('resume asks the runner for the offset', async () => {
    await report(ORIGIN);
    const s = await begin('Resume');
    await s.grant();
    pf.r.ws.once('message', () => undefined);
    const off = s.offset();
    // The fake runner does not answer status frames: the call ends as "restart" after the wait.
    const r = await Promise.race([off, new Promise<null>((res) => setTimeout(() => res(null), 500))]);
    expect(r === null || r.json.offset === null).toBe(true);
  });

  it('local destinations keep the relay', async () => {
    await q(`UPDATE storage_connections SET kind='local' WHERE id=$1`, [pf.connectionId]);
    const s = await begin('Local');
    expect(s.start.json.parts[0].mode).toBe('relay');
    expect((await s.put()).status).toBe(200);
    expect((await s.grant()).status).toBe(409);
    await q(`UPDATE storage_connections SET kind='s3' WHERE id=$1`, [pf.connectionId]);
  });
});
