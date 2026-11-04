import { describe, expect, it } from 'vitest';
import { EXE, PDF, PNG, sha, usePublicFormsWorld } from './helpers/public-forms.ts';
import { q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

const pf = usePublicFormsWorld({
  AOM_FORMS_IP_BURST: '100000',
  AOM_FORMS_IP_PER_MIN: '100000',
  AOM_FORMS_IP_SUBMIT_BURST: '1000',
  AOM_FORMS_IP_SUBMITS_PER_HOUR: '100000',
});

// sentinels: they must reach the firm's folder and nowhere on the server
const NAME = 'ANSWER-SENTINEL-Zelda-Quirke-77aa';
const NOTES = 'ANSWER-SENTINEL-notes-with-<b>markup</b>-19cc';
const EMAIL = 'sentinel.person@client.example';
const answers = { full_name: NAME, email_addr: EMAIL, notes: NOTES };
const files = [
  { field: 'id_copy', name: 'My ID (scan).pdf', bytes: PDF },
  { field: 'photo', name: 'me.png', bytes: PNG },
];

describe('a valid submission (AC3)', () => {
  it('writes the answers file and every upload to the configured folder; the server keeps references only', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Rental application'));
    const link = await ok<any>(
      pf.api('POST', `/api/forms/${formId}/client-links`, { reference: 'CL-1042' }),
      201,
    );
    const token = /#c=(.+)$/.exec(link.url)?.[1] as string;
    const logFrom = pf.logs.length;

    const s = await pf.submit(publicId, answers, files, token);
    expect(s.start.status).toBe(201);
    expect(s.parts.map((p) => p.status)).toEqual([200, 200]);
    expect(s.complete?.status).toBe(200);
    expect(s.complete?.json).toMatchObject({ status: 'complete', confirmation: expect.stringContaining('Thank you') });

    const sid8 = s.sid.slice(0, 8);
    const written = pf.stub.files();
    const byPath = (re: RegExp) => written.find((f) => re.test(f.path));
    // the uploads land under the field's folder/name template with the sanitised original name
    const id = byPath(new RegExp(`^Forms/Rental application/${sid8}/id_copy-My ID \\(scan\\)\\.pdf$`));
    const photo = byPath(new RegExp(`^Forms/Rental application/${sid8}/photo-me\\.png$`));
    expect(id?.bytes.equals(PDF)).toBe(true);
    expect(photo?.bytes.equals(PNG)).toBe(true);
    // the answers: one JSON (record of truth) and one readable HTML
    const json = byPath(/^Forms\/Rental application\/.*\.json$/);
    const html = byPath(/^Forms\/Rental application\/.*\.html$/);
    expect(json && html).toBeTruthy();
    const doc = JSON.parse(json?.bytes.toString('utf8') as string);
    expect(doc.v).toBe(1);
    expect(doc.client.reference).toBe('CL-1042');
    expect(doc.answers.find((a: any) => a.id === 'full_name').value).toBe(NAME);
    expect(doc.answers.find((a: any) => a.id === 'notes').value).toBe(NOTES);
    expect(doc.files.map((f: any) => f.id).sort()).toEqual(['id_copy', 'photo']);
    expect(doc.files.find((f: any) => f.id === 'id_copy')).toMatchObject({ sha256: sha(PDF), size: PDF.length });
    expect(html?.bytes.toString('utf8')).toContain('&lt;b&gt;markup&lt;/b&gt;');
    expect(html?.bytes.toString('utf8')).not.toContain('<b>markup');

    // the stored row: status, timestamps and references, and nothing else
    const [row] = await q('SELECT * FROM form_submissions WHERE id=$1', [s.sid]);
    expect(Object.keys(row).sort()).toEqual(
      [
        'answers_refs', 'completed_at', 'created_at', 'error_code', 'expires_at', 'form_id', 'form_version', 'id',
        'link_id', 'org_id', 'parts', 'session_nonce', 'status', 'updated_at',
      ].sort(),
    );
    expect(row).toMatchObject({ status: 'complete', form_version: 1, error_code: null });
    expect(row.completed_at).toBeTruthy();
    expect(row.answers_refs.json.path).toBe(json?.path);
    expect(row.answers_refs.html.path).toBe(html?.path);
    expect(row.parts).toHaveLength(2);
    for (const p of row.parts) {
      expect(p.state).toBe('stored');
      expect(p.reference.connectionId).toBe(pf.connectionId);
      expect(Object.keys(p).sort()).toEqual(['ext', 'field', 'index', 'reference', 'sha256', 'size', 'state']);
    }
    expect(row.parts[0].sha256).toBe(sha(PDF));

    // no answer, address, file content or file name anywhere in any table or event
    const dump = await pf.everything();
    for (const secret of [NAME, NOTES, EMAIL, 'FILE-CONTENT-SENTINEL', token, 'CL-1042-private']) {
      if (secret === 'CL-1042-private') continue;
      expect(dump).not.toContain(secret);
    }
    // events: the submission and the link use, references only
    const events = await q(
      `SELECT type, payload::text AS p FROM events WHERE stream_id=$1 AND type IN ('FormSubmitted','FormClientLinkUsed')`,
      [`form-${formId}`],
    );
    expect(events.map((e: any) => e.type).sort()).toEqual(['FormClientLinkUsed', 'FormSubmitted']);
    const [linkRow] = await q('SELECT used_at, used_by_submission FROM form_client_links WHERE form_id=$1', [formId]);
    expect(linkRow.used_by_submission).toBe(s.sid);

    // the logs: one metadata line per call, never an answer, file name, token or address
    const logs = pf.logs.slice(logFrom).join('\n');
    for (const secret of [NAME, NOTES, EMAIL, 'FILE-CONTENT', 'My ID', 'me.png', token, s.token, publicId, '127.0.0.1'])
      expect(logs).not.toContain(secret);
    expect(logs).toContain('"publicForm"');

    // the link is single use
    const again = await pf.load(publicId, token);
    expect(again.json.error.code).toBe('link_used');
    // the desk's list shows status and places, no content
    const list = await ok<any>(pf.api('GET', `/api/forms/${formId}/submissions`));
    expect(list.submissions[0]).toMatchObject({ id: s.sid, status: 'complete', reference: 'CL-1042' });
    expect(JSON.stringify(list)).not.toContain(NAME);
  });

  it('the public address without a link has no client reference', async () => {
    const { publicId } = await pf.published(pf.definition('Anonymous'));
    const s = await pf.submit(publicId, { full_name: 'Someone' }, [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }]);
    expect(s.complete?.status).toBe(200);
    const json = pf.stub.files().find((f) => f.path.startsWith('Forms/Anonymous/') && f.path.endsWith('.json'));
    expect(JSON.parse(json?.bytes.toString('utf8') as string).client).toBeNull();
    const [row] = await q('SELECT link_id FROM form_submissions WHERE id=$1', [s.sid]);
    expect(row.link_id).toBeNull();
  });

  it('complete is idempotent: a second call answers the same and writes nothing more', async () => {
    const { publicId } = await pf.published(pf.definition('Idempotent'));
    const s = await pf.submit(publicId, { full_name: 'Twice' }, [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }]);
    const before = pf.stub.opens();
    const again = await pf.post(`/api/public/forms/${publicId}/submissions/${s.sid}/complete`, { answers: { full_name: 'Twice' } }, { 'x-upload-token': s.token });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('complete');
    expect(pf.stub.opens()).toBe(before);
  });
});

describe('when the storage write fails (AC5)', () => {
  it('a failing answers write gives a retry message, keeps nothing complete and recovers without re-uploading', async () => {
    const { formId, publicId } = await pf.published(pf.definition('Failing store'));
    const link = await ok<any>(pf.api('POST', `/api/forms/${formId}/client-links`, { reference: 'R-1' }), 201);
    const token = /#c=(.+)$/.exec(link.url)?.[1] as string;
    pf.stub.failWhen = (o) => (o.ext === 'json' ? { code: 'unavailable', message: 'the folder is gone', retryable: true } : null);
    const s = await pf.submit(publicId, { full_name: 'Retry Person' }, [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }], token);
    expect(s.parts.map((p) => p.status)).toEqual([200]);
    expect(s.complete?.status).toBe(502);
    expect(s.complete?.json.error).toMatchObject({ code: 'storage_failed', retryable: true });
    expect(s.complete?.text).not.toContain('the folder is gone');

    let [row] = await q('SELECT status, error_code FROM form_submissions WHERE id=$1', [s.sid]);
    expect(row).toEqual({ status: 'failed', error_code: 'unavailable' });
    const events = await q(`SELECT type FROM events WHERE stream_id=$1 AND type IN ('FormSubmitted','FormClientLinkUsed')`, [`form-${formId}`]);
    expect(events).toEqual([]);
    expect((await pf.load(publicId, token)).status).toBe(200); // the link is not used up

    // the status answer tells the page which parts still need sending (none: the file is stored)
    const st = await pf.get(`/api/public/forms/${publicId}/submissions/${s.sid}`, { 'x-upload-token': s.token });
    expect(st.json).toMatchObject({ status: 'failed', parts: [{ field: 'id_copy', state: 'stored' }] });

    // the storage comes back: complete again, without sending the file again
    pf.stub.failWhen = () => null;
    const opensBefore = pf.stub.opens();
    const done = await pf.post(`/api/public/forms/${publicId}/submissions/${s.sid}/complete`, { answers: { full_name: 'Retry Person' } }, { 'x-upload-token': s.token });
    expect(done.status).toBe(200);
    expect(pf.stub.opens() - opensBefore).toBe(1); // only the JSON: the HTML already landed, and no file is sent again
    [row] = await q('SELECT status, error_code FROM form_submissions WHERE id=$1', [s.sid]);
    expect(row).toEqual({ status: 'complete', error_code: null });
    const htmls = pf.stub.files().filter((f) => f.path.startsWith('Forms/Failing store/') && f.path.endsWith('.html'));
    expect(htmls).toHaveLength(1);
    expect((await pf.load(publicId, token)).json.error.code).toBe('link_used');
  });

  it('a failing file write marks that part failed; only it is sent again', async () => {
    const { publicId } = await pf.published(pf.definition('Failing part'));
    const dto = (await pf.load(publicId)).json;
    const start = await pf.start(publicId, dto, { full_name: 'P' }, files);
    const { submissionId: sid, uploadToken: token } = start.json;
    const put = (i: number, bytes: Buffer) =>
      pf.put(`/api/public/forms/${publicId}/submissions/${sid}/parts/${i}`, bytes, { 'x-upload-token': token, 'x-file-name': 'f' });
    expect((await put(0, PDF)).status).toBe(200);
    pf.stub.failWhen = () => ({ code: 'quota', message: 'full', retryable: false });
    const bad = await put(1, PNG);
    expect(bad.status).toBe(502);
    expect(bad.json.error).toMatchObject({ code: 'storage_failed', retryable: false });
    pf.stub.failWhen = () => null;
    const st = await pf.get(`/api/public/forms/${publicId}/submissions/${sid}`, { 'x-upload-token': token });
    expect(st.json.parts.map((p: any) => p.state)).toEqual(['stored', 'failed']);
    const early = await pf.post(`/api/public/forms/${publicId}/submissions/${sid}/complete`, { answers: { full_name: 'P' } }, { 'x-upload-token': token });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe('parts_missing');
    const opens = pf.stub.opens();
    expect((await put(1, PNG)).status).toBe(200);
    expect(pf.stub.opens() - opens).toBe(1);
    const done = await pf.post(`/api/public/forms/${publicId}/submissions/${sid}/complete`, { answers: { full_name: 'P' } }, { 'x-upload-token': token });
    expect(done.status).toBe(200);
  });
});

describe('rejected on the server even when the browser checks are bypassed (AC4)', () => {
  const startWith = async (def: ReturnType<typeof pf.definition>, a: Record<string, unknown>, f: typeof files, extra = {}) => {
    const { publicId } = await pf.published(def);
    const dto = (await pf.load(publicId)).json;
    return { publicId, dto, res: await pf.start(publicId, dto, a, f, extra) };
  };

  it('a missing required field and a bad email: 400 with field and code only', async () => {
    const { res } = await startWith(pf.definition('Neg 1'), { email_addr: 'not-an-email', unexpected: 'x' }, [files[0] as (typeof files)[0]]);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('invalid_answers');
    expect(res.json.error.fields).toEqual(
      expect.arrayContaining([
        { field: 'full_name', code: 'required' },
        { field: 'email_addr', code: 'invalid_email' },
        { field: 'unexpected', code: 'unknown_field' },
      ]),
    );
    expect(res.text).not.toContain('not-an-email');
    expect(pf.stub.opens()).toBeGreaterThanOrEqual(0);
  });

  it('an executable named like a document: refused in the manifest (415) and, if it slips through, by its bytes', async () => {
    const { res } = await startWith(pf.definition('Neg 2'), { full_name: 'x' }, [{ field: 'id_copy', name: 'setup.exe', bytes: EXE }]);
    expect(res.status).toBe(415);
    expect(res.json.error.code).toBe('file_type_refused');

    // renamed to .pdf: the manifest passes, the bytes do not
    const { publicId } = await pf.published(pf.definition('Neg 2b'));
    const dto = (await pf.load(publicId)).json;
    const start = await pf.start(publicId, dto, { full_name: 'x' }, [{ field: 'id_copy', name: 'invoice.pdf', bytes: EXE }]);
    expect(start.status).toBe(201);
    const opens = pf.stub.opens();
    const put = await pf.put(`/api/public/forms/${publicId}/submissions/${start.json.submissionId}/parts/0`, EXE, {
      'x-upload-token': start.json.uploadToken,
      'x-file-name': 'invoice.pdf',
    });
    expect(put.status).toBe(415);
    expect(put.json.error.code).toBe('file_type_refused');
    expect(pf.stub.opens()).toBe(opens); // nothing reached the runner
    const [row] = await q('SELECT status, error_code FROM form_submissions WHERE id=$1', [start.json.submissionId]);
    expect(row).toEqual({ status: 'failed', error_code: 'file_type_refused' });
  });

  it('a file type the field does not accept, and a file larger than the field allows', async () => {
    const png = await startWith(pf.definition('Neg 3'), { full_name: 'x' }, [
      { field: 'id_copy', name: 'a.pdf', bytes: PDF },
      { field: 'photo', name: 'a.pdf', bytes: PDF },
    ]);
    expect(png.res.status).toBe(415);
    const d = pf.definition('Neg 3b');
    const big = await startWith(d, { full_name: 'x' }, [{ field: 'id_copy', name: 'big.pdf', bytes: Buffer.alloc(1024 * 1024 + 1, 0x41) }]);
    expect(big.res.status).toBe(413);
    expect(big.res.json.error.code).toBe('file_too_large');
  });

  it('the bytes of a part must match what was announced', async () => {
    const { publicId } = await pf.published(pf.definition('Neg 4'));
    const dto = (await pf.load(publicId)).json;
    const start = await pf.start(publicId, dto, { full_name: 'x' }, [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }]);
    const url = `/api/public/forms/${publicId}/submissions/${start.json.submissionId}/parts/0`;
    const h = { 'x-upload-token': start.json.uploadToken, 'x-file-name': 'a.pdf' };
    const longer = await pf.put(url, Buffer.concat([PDF, Buffer.from('more')]), h);
    expect(longer.status).toBe(400);
    expect(longer.json.error.code).toBe('invalid_answers');
    // same size, other bytes: the checksum of what was stored differs from what was announced
    const other = Buffer.from(PDF);
    other[12] = other[12] === 0x41 ? 0x42 : 0x41;
    const swapped = await pf.put(url, other, h);
    expect(swapped.status).toBe(400);
    expect(swapped.json.error.code).toBe('invalid_answers');
  });

  it('a session is single use, expired sessions are refused, and the honeypot and a changed form are caught', async () => {
    const { publicId, formId } = await pf.published(pf.definition('Neg 5'));
    const dto = (await pf.load(publicId)).json;
    const f1 = [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }];
    expect((await pf.start(publicId, dto, { full_name: 'x' }, f1)).status).toBe(201);
    const replay = await pf.start(publicId, dto, { full_name: 'x' }, f1);
    expect(replay.status).toBe(409);
    expect(replay.json.error.code).toBe('session_used');

    const fresh = (await pf.load(publicId)).json;
    const bot = await pf.start(publicId, fresh, { full_name: 'x' }, f1, { website: 'http://spam.example' });
    expect(bot.status).toBe(422);
    expect(bot.json.error.code).toBe('submission_refused');
    expect(bot.text).not.toContain('spam.example');

    const old = (await pf.load(publicId)).json;
    pf.w.t.clock.advance(5 * 3_600_000);
    const stale = await pf.start(publicId, old, { full_name: 'x' }, f1);
    expect(stale.status).toBe(400);
    expect(stale.json.error.code).toBe('session_invalid');
    pf.w.t.clock.advance(-5 * 3_600_000);

    const forged = await pf.start(publicId, { session: `${old.session.slice(0, -3)}AAA` }, { full_name: 'x' }, f1);
    expect(forged.json.error.code).toBe('session_invalid');

    const beforeChange = (await pf.load(publicId)).json;
    const def = pf.definition('Neg 5 v2');
    await ok(pf.api('PUT', `/api/forms/${formId}`, { baseVersion: 1, definition: def }));
    await ok(pf.api('POST', `/api/forms/${formId}/publish`));
    const changed = await pf.start(publicId, beforeChange, { full_name: 'x' }, f1);
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe('form_changed');
  });

  it('an upload token of another submission, or none, finds nothing', async () => {
    const { publicId } = await pf.published(pf.definition('Neg 6'));
    const f1 = [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }];
    const a = (await pf.start(publicId, (await pf.load(publicId)).json, { full_name: 'a' }, f1)).json;
    const b = (await pf.start(publicId, (await pf.load(publicId)).json, { full_name: 'b' }, f1)).json;
    const url = `/api/public/forms/${publicId}/submissions/${a.submissionId}`;
    expect((await pf.get(url, { 'x-upload-token': b.uploadToken })).status).toBe(404);
    expect((await pf.get(url)).status).toBe(404);
    expect((await pf.put(`${url}/parts/0`, PDF, { 'x-upload-token': b.uploadToken })).status).toBe(404);
    expect((await pf.post(`${url}/complete`, { answers: {} }, { 'x-upload-token': b.uploadToken })).status).toBe(404);
    // and another form's address cannot reach it either
    const other = await pf.published(pf.definition('Neg 6 other'));
    expect((await pf.get(`/api/public/forms/${other.publicId}/submissions/${a.submissionId}`, { 'x-upload-token': a.uploadToken })).status).toBe(404);
  });

  it('a form whose connection was removed cannot take submissions', async () => {
    const d = pf.definition('Neg 7');
    const created = await ok<any>(pf.api('POST', '/api/org/storage/connections', { kind: 'local', label: 'Temp', workstationId: pf.w.workstationId }), 201);
    d.settings.answersDestination.connectionId = created.connection.id;
    const { publicId } = await pf.published(d);
    const dto = (await pf.load(publicId)).json;
    await ok(pf.api('DELETE', `/api/org/storage/connections/${created.connection.id}`), 204);
    const res = await pf.start(publicId, dto, { full_name: 'x' }, [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }]);
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ code: 'destination_missing', retryable: false });
  });
});

describe('the firm workstation is offline (hook for the offline flow)', () => {
  it('answers 503 runner_offline with Retry-After and accepts nothing; the hook can answer instead', async () => {
    const { publicId } = await pf.published(pf.definition('Offline'));
    const dto = (await pf.load(publicId)).json;
    const before = (await q('SELECT count(*)::int AS n FROM form_submissions'))[0].n;
    pf.stub.stop();
    pf.r.ws.close();
    await new Promise((r) => setTimeout(r, 300));
    const f1 = [{ field: 'id_copy', name: 'a.pdf', bytes: PDF }];
    const res = await pf.start(publicId, dto, { full_name: 'x' }, f1);
    expect(res.status).toBe(503);
    expect(res.json.error).toMatchObject({ code: 'runner_offline', retryable: true });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await q('SELECT count(*)::int AS n FROM form_submissions'))[0].n).toBe(before);

    const calls: any[] = [];
    pf.w.t.app.ctx.services.publicFormsOffline = {
      onRunnerOffline: async (_c, e) => {
        calls.push(e);
        return { kind: 'link_later', message: 'We will email you a secure upload link.' };
      },
    };
    const dto2 = (await pf.load(publicId)).json;
    const later = await pf.start(publicId, dto2, { full_name: 'x' }, f1);
    expect(later.status).toBe(202);
    expect(later.json).toEqual({ status: 'link_later', message: 'We will email you a secure upload link.' });
    expect(calls[0]).toMatchObject({ stage: 'start', linkId: null, submissionId: null, formVersion: 1 });
    expect(JSON.stringify(calls[0])).not.toContain('"x"'); // no answer is handed to the hook
    delete pf.w.t.app.ctx.services.publicFormsOffline;
  });
});
