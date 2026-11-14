import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSubmissions, pruneFormSubmissions } from '../src/commands/public-forms.ts';
import {
  cleanupGraceMs,
  EXPIRED_DURING_COMPLETE,
  resetFormUploadCleanupForTests,
  sweepFormUploadCleanup,
} from '../src/public-forms/cleanup.ts';
import { q } from './helpers/db.ts';
import { PNG, usePublicFormsWorld } from './helpers/public-forms.ts';

const pf = usePublicFormsWorld();
const ctx = () => pf.w.t.app.ctx;
const DAY = 86_400_000;
const NAME = 'Racey Respondent-7f3a';

/** Runs `hook` once the answers document of `ext` has been written, before the handler goes on. */
function afterWrite(ext: string, hook: (submissionId: string) => Promise<unknown>) {
  const storage = ctx().services.storage;
  const real = storage.write.bind(storage);
  return vi.spyOn(storage, 'write').mockImplementation(async (o: any) => {
    const r = await real(o);
    if (o.ext === ext && o.submission?.submissionId) await hook(o.submission.submissionId);
    return r;
  });
}

/** Runs `hook` before the answers document of `ext` is written. */
function beforeWrite(ext: string, hook: (submissionId: string) => Promise<unknown>) {
  const storage = ctx().services.storage;
  const real = storage.write.bind(storage);
  return vi.spyOn(storage, 'write').mockImplementation(async (o: any) => {
    if (o.ext === ext && o.submission?.submissionId) await hook(o.submission.submissionId);
    return real(o);
  });
}

const submittedEvents = (formId: string) =>
  q(`SELECT type FROM events WHERE stream_id=$1 AND type IN ('FormSubmitted','FormClientLinkUsed')`, [
    `form-${formId}`,
  ]);
const rowOf = async (sid: string) =>
  (
    await q('SELECT status, error_code, answers_refs, completed_at FROM form_submissions WHERE id=$1', [sid])
  )[0];
const files = [
  { field: 'id_copy', name: 'id.png', bytes: PNG },
  { field: 'photo', name: 'photo.png', bytes: PNG },
];

afterEach(() => {
  vi.restoreAllMocks();
  pf.stub.pdf = 'none';
  pf.stub.failWhen = () => null;
  pf.stub.deleteFrames.length = 0;
  pf.stub.deleteBehavior = { error: null, ignore: false };
  resetFormUploadCleanupForTests();
});

describe('complete when the row stops being stored under the request', () => {
  it('answers submission_expired, appends nothing and lets the expiry cleanup take every document', async () => {
    pf.stub.pdf = 'ok';
    const { formId, publicId } = await pf.published(pf.definition(`Race ${Math.random()}`));
    afterWrite('json', (sid) => q(`UPDATE form_submissions SET status='expired' WHERE id=$1`, [sid]));
    const warn = vi.spyOn(ctx().log, 'warn');
    const s = await pf.submit(publicId, { full_name: NAME }, files);

    expect(s.complete?.status).toBe(410);
    expect(s.complete?.json.error).toMatchObject({ code: 'submission_expired' });
    expect(await submittedEvents(formId)).toEqual([]);
    const row = await rowOf(s.sid);
    expect(row?.status).toBe('expired');
    expect(row?.completed_at).toBeNull();
    expect(row?.error_code).toBe(EXPIRED_DURING_COMPLETE);
    expect(Object.keys(row?.answers_refs).sort()).toEqual(['html', 'json', 'pdf']);

    // The 0-rows log line: ids and the status found, no answers and no stored path.
    const calls = warn.mock.calls.filter((c: any[]) => c[0]?.publicForm?.submissionId === s.sid);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({
      publicForm: { op: 'complete', submissionId: s.sid, orgId: pf.orgId, found: 'expired' },
    });
    const logged = JSON.stringify(calls);
    expect(logged).not.toContain(NAME);
    for (const ref of Object.values(row?.answers_refs) as Array<{ path: string }>)
      expect(logged).not.toContain(ref.path);

    // Past the cleanup grace the documents are queued with the parts, removed and shown on the desk.
    const paths = [
      ...(Object.values(row?.answers_refs) as Array<{ path: string }>).map((r) => r.path),
      ...(
        ((await q('SELECT parts FROM form_submissions WHERE id=$1', [s.sid]))[0]?.parts ?? []) as any[]
      ).map((p) => p.reference.path),
    ];
    await q('UPDATE form_submissions SET expires_at=$2 WHERE id=$1', [
      s.sid,
      new Date(ctx().clock.now().getTime() - cleanupGraceMs(ctx()) - 1_000),
    ]);
    await pruneFormSubmissions(ctx());
    const queued = await q(
      'SELECT seq, label, path FROM form_submission_cleanup WHERE submission_id=$1 ORDER BY seq',
      [s.sid],
    );
    expect(queued.map((r) => [r.seq, r.label])).toEqual([
      [-3, 'Answers (PDF)'],
      [-2, 'Answers (readable)'],
      [-1, 'Answers (JSON)'],
      [0, 'id_copy'],
      [1, 'photo'],
    ]);
    expect(await sweepFormUploadCleanup(ctx())).toBe(5);
    expect(pf.stub.deleteFrames.map((f) => f.path).sort()).toEqual([...paths].sort());
    const sub = (await listSubmissions(ctx(), pf.orgId, formId)).submissions.find((x) => x.id === s.sid);
    expect(sub?.status).toBe('expired');
    expect(sub?.cleanup).toEqual({ pending: 0, removed: 5, failed: 0 });
    expect(sub?.stored.every((f) => f.cleanup?.state === 'removed')).toBe(true);
  });

  it('answers success without a second FormSubmitted when the row is already complete', async () => {
    const { formId, publicId } = await pf.published(pf.definition(`Retry ${Math.random()}`));
    afterWrite('json', (sid) =>
      q(`UPDATE form_submissions SET status='complete', completed_at=now() WHERE id=$1`, [sid]),
    );
    const warn = vi.spyOn(ctx().log, 'warn');
    const s = await pf.submit(publicId, { full_name: NAME }, files);

    expect(s.complete?.status).toBe(200);
    expect(s.complete?.json).toEqual({
      status: 'complete',
      confirmation: pf.definition().settings.confirmationText,
    });
    expect(await submittedEvents(formId)).toEqual([]);
    expect((await rowOf(s.sid))?.status).toBe('complete');
    const calls = warn.mock.calls.filter((c: any[]) => c[0]?.publicForm?.submissionId === s.sid);
    expect(calls.map((c: any[]) => c[0].publicForm.found)).toEqual(['complete']);
    expect(JSON.stringify(calls)).not.toContain(NAME);
  });

  it('does not revive an expired row to failed when a write fails after the expiry', async () => {
    const { formId, publicId } = await pf.published(pf.definition(`Fail ${Math.random()}`));
    pf.stub.failWhen = (o) =>
      o.ext === 'json' ? { code: 'unavailable', message: 'busy', retryable: true } : null;
    beforeWrite('json', (sid) => q(`UPDATE form_submissions SET status='expired' WHERE id=$1`, [sid]));
    const s = await pf.submit(publicId, { full_name: NAME }, files);

    expect(s.complete?.status).toBe(410);
    expect(s.complete?.json.error).toMatchObject({ code: 'submission_expired' });
    const row = await rowOf(s.sid);
    expect(row?.status).toBe('expired');
    expect(row?.error_code).toBe(EXPIRED_DURING_COMPLETE);
    expect(Object.keys(row?.answers_refs)).toContain('html');
    expect(await submittedEvents(formId)).toEqual([]);
  });

  it('still marks a write failure as failed while the row is being stored', async () => {
    const { publicId } = await pf.published(pf.definition(`Plain fail ${Math.random()}`));
    pf.stub.failWhen = (o) =>
      o.ext === 'json' ? { code: 'unavailable', message: 'busy', retryable: true } : null;
    const s = await pf.submit(publicId, { full_name: NAME }, files);
    expect(s.complete?.status).toBe(502);
    expect(await rowOf(s.sid)).toMatchObject({ status: 'failed', error_code: 'unavailable' });
  });

  it('keeps the normal path: complete, one FormSubmitted, the confirmation, received on the desk', async () => {
    const { formId, publicId } = await pf.published(pf.definition(`Happy ${Math.random()}`));
    const warn = vi.spyOn(ctx().log, 'warn');
    const s = await pf.submit(publicId, { full_name: NAME }, files);
    expect(s.complete?.status).toBe(200);
    expect(s.complete?.json).toEqual({
      status: 'complete',
      confirmation: pf.definition().settings.confirmationText,
    });
    expect((await submittedEvents(formId)).map((e) => e.type)).toEqual(['FormSubmitted']);
    const row = await rowOf(s.sid);
    expect(row).toMatchObject({ status: 'complete', error_code: null });
    const sub = (await listSubmissions(ctx(), pf.orgId, formId)).submissions.find((x) => x.id === s.sid);
    expect(sub?.status).toBe('complete');
    expect(warn.mock.calls.filter((c: any[]) => c[0]?.publicForm?.submissionId === s.sid)).toEqual([]);
    // A stale expiry cannot touch it afterwards.
    await q('UPDATE form_submissions SET expires_at=$2 WHERE id=$1', [
      s.sid,
      new Date(ctx().clock.now().getTime() - DAY),
    ]);
    await pruneFormSubmissions(ctx());
    expect((await rowOf(s.sid))?.status).toBe('complete');
  });
});
