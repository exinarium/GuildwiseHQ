import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PdfError, type PdfRenderer } from '../src/storage/pdf.ts';
import { StorageService } from '../src/storage/service.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const ORG = 'aaaaaaaa-1b6e-4c0f-9a53-2c1f3e4a5b66';
const FORM = 'bbbbbbbb-1b6e-4c0f-9a53-2c1f3e4a5b66';
const SID = 'cccccccc-1b6e-4c0f-9a53-2c1f3e4a5b66';
const SECRET_ANSWER = 'my-very-private-answer-4711';
const HTML = `<!doctype html><html><body><p>${SECRET_ANSWER}</p></body></html>`;

type Frame = { type: string; payload: Record<string, any> };

const fakePdf = (render: PdfRenderer['render']): PdfRenderer => ({
  render,
  status: async () => ({ ready: true }),
  install: async () => undefined,
  close: async () => undefined,
});
const okPdf = () => fakePdf(async (html) => Buffer.from(`%PDF-1.4 fake of ${html.length}`));

function setup(pdf: PdfRenderer | undefined, over: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-pdf-svc-'));
  const stored = join(root, 'files');
  mkdirSync(stored);
  const frames: Frame[] = [];
  const logs: string[] = [];
  const svc = new StorageService({
    secretsDir: join(root, 'secrets'),
    spoolDir: join(root, 'tmp', 'storage'),
    keyOf: () => Buffer.alloc(32, 7),
    keys: {
      open: (_e: unknown, outer: { ref: string }) => ({
        ref: outer.ref,
        exp: Date.now() + 1000,
        fields: { root: stored },
      }),
    } as never,
    seen: { claim: () => true },
    workstationId: 'ws',
    send: (type, payload) => frames.push({ type, payload }),
    vaults: { exclusive: async () => undefined as never, isLocal: () => true },
    forbiddenRoots: [join(root, 'secrets')],
    sleep: async () => undefined,
    log: (l) => logs.push(l),
    journalFile: join(root, 'state', 'journal.json'),
    ...(pdf ? { pdf } : {}),
    ...over,
  });
  return { svc, root, stored, frames, logs };
}
type T = ReturnType<typeof setup>;

const connect = async (t: T) =>
  expect(
    (
      await t.svc.handle('storage.connect', {
        requestId: 'r1',
        connectionId: CONN,
        kind: 'local',
        envelope: {},
      })
    ).error,
  ).toBeUndefined();

let n = 0;
async function writeHtml(t: T, o: { derive?: boolean; name?: string; deadlineMs?: number } = {}) {
  const body = Buffer.from(HTML);
  const id = `5c9d1d0e-1b6e-4c0f-9a53-${String(++n).padStart(12, '0')}`;
  t.svc.onMessage({
    type: 'storage.write.open',
    transferId: id,
    connectionId: CONN,
    folder: 'sub',
    name: o.name ?? 'answers-x',
    vars: {},
    ext: 'html',
    contentType: 'text/html; charset=utf-8',
    size: body.length,
    deadlineMs: o.deadlineMs ?? 60_000,
    submission: { orgId: ORG, formId: FORM, submissionId: SID },
    ...(o.derive === false ? {} : { derive: { pdf: true } }),
  } as never);
  await new Promise((r) => setTimeout(r, 30));
  t.svc.onMessage({
    type: 'storage.write.chunk',
    transferId: id,
    seq: 0,
    data: body.toString('base64'),
  } as never);
  t.svc.onMessage({
    type: 'storage.write.end',
    transferId: id,
    chunks: 1,
    size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  } as never);
  for (
    let i = 0;
    i < 300 && !t.frames.some((f) => f.type === 'storage.write.result' && f.payload.transferId === id);
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  return t.frames.find((f) => f.type === 'storage.write.result' && f.payload.transferId === id)
    ?.payload as Record<string, any>;
}
const names = (t: T) => (existsSync(join(t.stored, 'sub')) ? readdirSync(join(t.stored, 'sub')).sort() : []);
const pdfLines = (t: T) => t.logs.filter((l) => l.startsWith('storage.pdf'));
const noContent = async (t: T) => {
  for (const l of t.logs) expect(l).not.toContain(SECRET_ANSWER);
  // the result is sent before the spool file is removed: give the removal a moment
  const spool = join(t.root, 'tmp', 'storage');
  for (let i = 0; i < 100 && readdirSync(spool).length > 0; i++) await new Promise((r) => setTimeout(r, 20));
  expect(readdirSync(spool)).toEqual([]);
};

describe('PDF copy of the answers', () => {
  it('writes <base>.pdf next to the html and reports the reference', async () => {
    const t = setup(okPdf());
    await connect(t);
    const r = await writeHtml(t);
    expect(r.ok).toBe(true);
    expect(names(t)).toEqual(['answers-x.html', 'answers-x.pdf']);
    expect(r.derived.pdf.ok).toBe(true);
    expect(r.derived.pdf.reference).toMatchObject({
      connectionId: CONN,
      contentType: 'application/pdf',
      path: expect.stringMatching(/answers-x\.pdf$/),
    });
    const bytes = readFileSync(join(t.stored, 'sub', 'answers-x.pdf'));
    expect(r.derived.pdf.reference.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(pdfLines(t)).toHaveLength(1);
    await noContent(t);
  });

  it('follows the clash suffix of the written html', async () => {
    const t = setup(okPdf());
    await connect(t);
    mkdirSync(join(t.stored, 'sub'));
    writeFileSync(join(t.stored, 'sub', 'answers-x.html'), 'old');
    const r = await writeHtml(t);
    expect(r.derived.pdf.ok).toBe(true);
    expect(names(t)).toEqual(['answers-x-2.html', 'answers-x-2.pdf', 'answers-x.html']);
  });

  it('does nothing without derive.pdf', async () => {
    let calls = 0;
    const t = setup(fakePdf(async () => (calls++, Buffer.from('%PDF'))));
    await connect(t);
    const r = await writeHtml(t, { derive: false });
    expect(r.ok).toBe(true);
    expect(r.derived).toBeUndefined();
    expect(calls).toBe(0);
    expect(names(t)).toEqual(['answers-x.html']);
  });

  it('with no renderer the html is written and the copy is unavailable', async () => {
    const t = setup(undefined);
    await connect(t);
    const r = await writeHtml(t);
    expect(r.ok).toBe(true);
    expect(r.derived.pdf).toEqual({ ok: false, code: 'pdf_unavailable' });
    expect(names(t)).toEqual(['answers-x.html']);
    expect(pdfLines(t)).toHaveLength(1);
    await noContent(t);
  });

  it('a renderer that throws (with the answer in its message) gives pdf_failed and no content in the log', async () => {
    const t = setup(
      fakePdf(async (html) => {
        throw new Error(`boom ${html}`);
      }),
    );
    await connect(t);
    const r = await writeHtml(t);
    expect(r.ok).toBe(true);
    expect(r.derived.pdf).toEqual({ ok: false, code: 'pdf_failed' });
    expect(names(t)).toEqual(['answers-x.html']);
    expect(pdfLines(t)).toHaveLength(1);
    await noContent(t);
  });

  it('a renderer that reports a code is passed on', async () => {
    const t = setup(
      fakePdf(async () => {
        throw new PdfError('pdf_unavailable');
      }),
    );
    await connect(t);
    expect((await writeHtml(t)).derived.pdf).toEqual({ ok: false, code: 'pdf_unavailable' });
  });

  it('a renderer that hangs ends as pdf_timeout inside the budget', async () => {
    const t = setup(
      fakePdf(
        (_h, signal) =>
          new Promise((_res, rej) =>
            signal.addEventListener('abort', () => rej(new PdfError('pdf_timeout'))),
          ),
      ),
    );
    await connect(t);
    const started = Date.now();
    const r = await writeHtml(t, { deadlineMs: 5_200 }); // budget = 5.2s - 3s = 2.2s
    expect(r.ok).toBe(true);
    expect(r.derived.pdf).toEqual({ ok: false, code: 'pdf_timeout' });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(names(t)).toEqual(['answers-x.html']);
  });

  it('too little time left skips the render as pdf_timeout', async () => {
    let calls = 0;
    const t = setup(fakePdf(async () => (calls++, Buffer.from('%PDF'))));
    await connect(t);
    const r = await writeHtml(t, { deadlineMs: 4_000 });
    expect(r.derived.pdf).toEqual({ ok: false, code: 'pdf_timeout' });
    expect(calls).toBe(0);
  });

  it('a put that fails for the pdf gives pdf_write_failed and keeps the html', async () => {
    const dir = { v: '' };
    const t = setup(
      fakePdf(async () => {
        chmodSync(dir.v, 0o500); // the html is already in; the pdf cannot be added
        return Buffer.from('%PDF-1.4 x');
      }),
    );
    await connect(t);
    dir.v = join(t.stored, 'sub');
    mkdirSync(dir.v, { recursive: true });
    const r = await writeHtml(t);
    chmodSync(dir.v, 0o700);
    expect(r.ok).toBe(true);
    expect(r.derived.pdf).toEqual({ ok: false, code: 'pdf_write_failed' });
    expect(names(t)).toEqual(['answers-x.html']);
    await noContent(t);
  });

  it('storage.discard removes the html and the pdf', async () => {
    const t = setup(okPdf());
    await connect(t);
    await writeHtml(t);
    expect(names(t)).toHaveLength(2);
    expect(await t.svc.handle('storage.discard', { submissionId: SID })).toEqual({ discarded: 2 });
    expect(names(t)).toEqual([]);
  });

  it('an abort while the pdf is being made deletes the html and the pdf', async () => {
    let started!: () => void;
    const renderStarted = new Promise<void>((r) => (started = r));
    const t = setup(
      fakePdf(() => {
        started();
        return new Promise((res) => setTimeout(() => res(Buffer.from('%PDF')), 300));
      }),
    );
    await connect(t);
    const p = writeHtml(t);
    await renderStarted;
    const open = [...(t.svc as any).transfers.keys()][0] as string;
    t.svc.onMessage({ type: 'storage.write.abort', transferId: open, reason: 'client_gone' } as never);
    await new Promise((r) => setTimeout(r, 600));
    void p;
    expect(names(t)).toEqual([]);
  });
});
