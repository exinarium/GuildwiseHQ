import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listSubmissions, pruneFormSubmissions } from '../src/commands/public-forms.ts';
import {
  MAX_CLEANUP_ATTEMPTS,
  resetFormUploadCleanupForTests,
  sweepFormUploadCleanup,
} from '../src/public-forms/cleanup.ts';
import { q } from './helpers/db.ts';
import { PNG, usePublicFormsWorld } from './helpers/public-forms.ts';

const pf = usePublicFormsWorld();
const ctx = () => pf.w.t.app.ctx;
const DAY = 86_400_000;

let ipSeq = 0;

/** A submission that stored two files and then stopped (no complete call). */
async function stalled(): Promise<{ sid: string; formId: string; paths: string[] }> {
  const { formId, publicId } = await pf.published(pf.definition(`Cleanup ${Math.random()}`));
  const dto = (await pf.load(publicId)).json;
  const files = [
    { field: 'id_copy', name: 'id.png', bytes: PNG },
    { field: 'photo', name: 'photo.png', bytes: PNG },
  ];
  const start = await pf.start(publicId, dto, { full_name: 'Stalled' }, files, {}, `10.9.0.${++ipSeq}`);
  expect(start.status).toBe(201);
  const sid = start.json.submissionId as string;
  for (const [i, f] of files.entries()) {
    const r = await pf.put(`/api/public/forms/${publicId}/submissions/${sid}/parts/${i}`, f.bytes, {
      'x-upload-token': start.json.uploadToken,
      'x-file-name': encodeURIComponent(f.name),
    });
    expect(r.status).toBe(200);
  }
  const parts = (await q('SELECT parts FROM form_submissions WHERE id=$1', [sid]))[0]?.parts as Array<{
    reference?: { path: string };
  }>;
  return { sid, formId, paths: parts.map((p) => p.reference?.path as string) };
}

const expireAgo = (sid: string, ms: number) =>
  q(`UPDATE form_submissions SET expires_at=$2 WHERE id=$1`, [
    sid,
    new Date(ctx().clock.now().getTime() - ms),
  ]);
const cleanupRows = (sid: string) =>
  q('SELECT * FROM form_submission_cleanup WHERE submission_id=$1 ORDER BY seq', [sid]);
const onDisk = () => pf.stub.files().map((f) => f.path);

beforeEach(() => {
  pf.stub.deleteFrames.length = 0;
  pf.stub.deleteBehavior = { error: null, ignore: false };
  resetFormUploadCleanupForTests();
});

describe('cleanup of expired submissions', () => {
  it('removes both files of an expired submission without answers and lists them as removed (AC5)', async () => {
    const s = await stalled();
    expect(s.paths.every((p) => onDisk().includes(p))).toBe(true);
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    expect(await cleanupRows(s.sid)).toHaveLength(2);
    expect(await sweepFormUploadCleanup(ctx())).toBe(2);
    expect(pf.stub.deleteFrames.map((f) => f.path).sort()).toEqual([...s.paths].sort());
    for (const p of s.paths) expect(onDisk()).not.toContain(p);
    expect((await cleanupRows(s.sid)).map((r) => r.state)).toEqual(['removed', 'removed']);
    const list = await listSubmissions(ctx(), pf.orgId, s.formId);
    const sub = list.submissions.find((x) => x.id === s.sid);
    expect(sub?.cleanup).toEqual({ pending: 0, removed: 2, failed: 0 });
    expect(sub?.stored.map((x) => x.cleanup?.state)).toEqual(['removed', 'removed']);
    // The next sweep has nothing to do.
    expect(await sweepFormUploadCleanup(ctx())).toBe(0);
  });

  it('never touches a completed submission, one with an answers file, or one inside the grace window (AC6)', async () => {
    const { publicId } = await pf.published(pf.definition('Completed'));
    const done = await pf.submit(publicId, { full_name: 'Done' }, [
      { field: 'id_copy', name: 'id.png', bytes: PNG },
    ]);
    expect(done.complete?.status).toBe(200);
    const before = onDisk();
    await expireAgo(done.sid, DAY);
    // Even forced into the expired state, the answers refs keep it out.
    await q(`UPDATE form_submissions SET status='expired' WHERE id=$1`, [done.sid]);
    const onlyHtml = await stalled();
    await q(`UPDATE form_submissions SET answers_refs=$2::jsonb WHERE id=$1`, [
      onlyHtml.sid,
      JSON.stringify({
        html: {
          v: 1,
          connectionId: pf.connectionId,
          kind: 'local',
          path: 'x/a.html',
          size: 1,
          sha256: 'a'.repeat(64),
          contentType: 'text/html',
          writtenAt: new Date().toISOString(),
        },
      }),
    ]);
    await expireAgo(onlyHtml.sid, DAY);
    const fresh = await stalled();
    await expireAgo(fresh.sid, 30_000); // expired, but a write could still be running
    await pruneFormSubmissions(ctx());
    for (const id of [done.sid, onlyHtml.sid, fresh.sid]) expect(await cleanupRows(id)).toHaveLength(0);
    await sweepFormUploadCleanup(ctx());
    expect(pf.stub.deleteFrames).toHaveLength(0);
    expect(onDisk()).toEqual(expect.arrayContaining(before));
  });

  it('does not queue twice', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    await pruneFormSubmissions(ctx());
    expect(await cleanupRows(s.sid)).toHaveLength(2);
  });

  it('keeps the files pending, uncounted, while the runner is offline, and removes them later (AC7)', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    const runners = ctx().services.runners;
    const online = runners.isOnline.bind(runners);
    runners.isOnline = () => false;
    try {
      await sweepFormUploadCleanup(ctx());
    } finally {
      runners.isOnline = online;
    }
    let rows = await cleanupRows(s.sid);
    expect(rows.map((r) => [r.state, r.attempts, r.last_error_code])).toEqual([
      ['pending', 0, 'runner_offline'],
      ['pending', 0, 'runner_offline'],
    ]);
    expect(pf.stub.deleteFrames).toHaveLength(0);
    ctx().clock.advance(10 * 60_000);
    await sweepFormUploadCleanup(ctx());
    rows = await cleanupRows(s.sid);
    expect(rows.map((r) => r.state)).toEqual(['removed', 'removed']);
    expect(onDisk()).not.toContain(s.paths[0]);
  });

  it('treats a repeat delete (file already gone) as done', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    pf.stub.deleteBehavior.error = { code: 'unavailable', message: 'busy', retryable: true };
    await sweepFormUploadCleanup(ctx());
    expect((await cleanupRows(s.sid)).map((r) => r.attempts)).toEqual([1, 1]);
    // The file goes away by itself (or an earlier delete landed), then the retry says not found.
    const { rmSync } = await import('node:fs');
    for (const p of s.paths) rmSync(join(pf.dir, p));
    pf.stub.deleteBehavior.error = null;
    ctx().clock.advance(30 * 60_000);
    await sweepFormUploadCleanup(ctx());
    expect((await cleanupRows(s.sid)).map((r) => r.state)).toEqual(['removed', 'removed']);
  });

  it('stops after the maximum attempts and shows the last error (AC8)', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    pf.stub.deleteBehavior.error = {
      code: 'permission',
      message: 'The storage refused this action.',
      retryable: false,
    };
    for (let i = 0; i < MAX_CLEANUP_ATTEMPTS; i++) {
      await sweepFormUploadCleanup(ctx());
      ctx().clock.advance(7 * 3_600_000);
    }
    const rows = await cleanupRows(s.sid);
    expect(rows.map((r) => [r.state, r.attempts, r.last_error])).toEqual([
      ['failed', MAX_CLEANUP_ATTEMPTS, 'The storage refused this action.'],
      ['failed', MAX_CLEANUP_ATTEMPTS, 'The storage refused this action.'],
    ]);
    const calls = pf.stub.deleteFrames.length;
    expect(calls).toBe(2 * MAX_CLEANUP_ATTEMPTS);
    expect(await sweepFormUploadCleanup(ctx())).toBe(0);
    expect(pf.stub.deleteFrames).toHaveLength(calls);
    const sub = (await listSubmissions(ctx(), pf.orgId, s.formId)).submissions.find((x) => x.id === s.sid);
    expect(sub?.cleanup).toEqual({ pending: 0, removed: 0, failed: 2 });
    expect(sub?.stored[0]?.cleanup).toMatchObject({
      state: 'failed',
      error: 'The storage refused this action.',
    });
    // The files stay in storage, visible as orphans.
    expect(onDisk()).toEqual(expect.arrayContaining(s.paths));
  });

  it('fails at once on an invalid path (no retry can help)', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    pf.stub.deleteBehavior.error = { code: 'invalid', message: 'outside', retryable: false };
    await sweepFormUploadCleanup(ctx());
    expect((await cleanupRows(s.sid)).map((r) => [r.state, r.attempts])).toEqual([
      ['failed', 0],
      ['failed', 0],
    ]);
  });

  it('keeps the row and the file pending when the runner never answers (an older runner)', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    // An older runner is not sent the frame at all: the capability is missing.
    await q(
      `UPDATE workstation_capabilities SET capabilities = array_remove(capabilities, 'storage-delete:1')`,
    );
    try {
      await sweepFormUploadCleanup(ctx());
    } finally {
      await q(
        `UPDATE workstation_capabilities SET capabilities = array_append(capabilities, 'storage-delete:1')`,
      );
    }
    expect(pf.stub.deleteFrames).toHaveLength(0);
    const rows = await cleanupRows(s.sid);
    expect(rows.map((r) => [r.state, r.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0],
    ]);
    expect(rows[0]?.last_error).toMatch(/update/i);
    expect(existsSync(join(pf.dir, s.paths[0] as string))).toBe(true);
  });

  it('keeps an expired row for the 30-day delete while its files are pending', async () => {
    const s = await stalled();
    await expireAgo(s.sid, DAY);
    await pruneFormSubmissions(ctx());
    await q(`UPDATE form_submissions SET updated_at=$2 WHERE id=$1`, [
      s.sid,
      new Date(ctx().clock.now().getTime() - 40 * DAY),
    ]);
    await pruneFormSubmissions(ctx());
    expect(await q('SELECT 1 FROM form_submissions WHERE id=$1', [s.sid])).toHaveLength(1);
    await sweepFormUploadCleanup(ctx());
    await pruneFormSubmissions(ctx());
    expect(await q('SELECT 1 FROM form_submissions WHERE id=$1', [s.sid])).toHaveLength(0);
  });
});
