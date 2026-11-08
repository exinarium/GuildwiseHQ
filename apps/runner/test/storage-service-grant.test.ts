import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClamdClient, ScanVerdict } from '../src/storage/scan.ts';
import { StorageService } from '../src/storage/service.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const ORG = 'aaaaaaaa-1b6e-4c0f-9a53-2c1f3e4a5b66';
const FORM = 'bbbbbbbb-1b6e-4c0f-9a53-2c1f3e4a5b66';
const SID = 'cccccccc-1b6e-4c0f-9a53-2c1f3e4a5b66';
const PAGE = 'https://app.example';
type Frame = { type: string; payload: Record<string, any> };

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'.repeat(5));

/** A bucket in memory behind the fetch the S3 connector uses (path style, https). */
function bucket(opts: { checksum?: boolean; cors?: boolean } = {}) {
  const objs = new Map<string, { body: Buffer; mod: number }>();
  const calls: string[] = [];
  const keyOf = (u: URL) => decodeURIComponent(u.pathname.replace(/^\/bkt\/?/, ''));
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const h = new Headers(init.headers as HeadersInit);
    calls.push(`${method} ${keyOf(u)}${h.get('range') ? ' range' : ''}${u.searchParams.get('list-type') ? ' list' : ''}`);
    const key = keyOf(u);
    if (method === 'OPTIONS')
      return opts.cors === false
        ? new Response(null, { status: 403 })
        : new Response(null, {
            status: 200,
            headers: { 'access-control-allow-origin': PAGE, 'access-control-allow-methods': 'PUT' },
          });
    if (method === 'GET' && u.searchParams.get('list-type')) {
      const prefix = u.searchParams.get('prefix') ?? '';
      const xml = [...objs]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>${new Date(v.mod).toISOString()}</LastModified></Contents>`)
        .join('');
      return new Response(`<ListBucketResult>${xml}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') {
      const src = h.get('x-amz-copy-source');
      if (src) {
        const from = objs.get(decodeURIComponent(src).replace(/^\/bkt\//, ''));
        if (!from) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        objs.set(key, { body: from.body, mod: Date.now() });
        return new Response('<CopyObjectResult/>', { status: 200 });
      }
      objs.set(key, { body: Buffer.from(String(init.body ?? '')), mod: Date.now() });
      return new Response(null, { status: 200, headers: { etag: '"e1"' } });
    }
    if (method === 'DELETE') {
      objs.delete(key);
      return new Response(null, { status: 204 });
    }
    const o = objs.get(key);
    if (!o) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    if (method === 'HEAD') {
      const hd: Record<string, string> = { 'content-length': String(o.body.length), etag: '"e1"' };
      if (opts.checksum !== false) hd['x-amz-checksum-sha256'] = Buffer.from(sha(o.body), 'hex').toString('base64');
      return new Response(null, { status: 200, headers: hd });
    }
    const r = /bytes=(\d+)-(\d+)/.exec(h.get('range') ?? '');
    const body = r ? o.body.subarray(Number(r[1]), Number(r[2]) + 1) : o.body;
    return new Response(new Uint8Array(body), { status: r ? 206 : 200 });
  };
  return { objs, calls, fetchFn };
}

function setup(o: { checksum?: boolean; cors?: boolean; scan?: () => ScanVerdict; kind?: 's3' | 'local' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-grant-'));
  mkdirSync(join(root, 'files'));
  const b = bucket(o);
  const frames: Frame[] = [];
  const logs: string[] = [];
  let clock = Date.now();
  const scanner: ClamdClient = { scanFile: async () => (o.scan as () => ScanVerdict)(), ping: async () => true };
  const kind = o.kind ?? 's3';
  const svc = new StorageService({
    secretsDir: join(root, 'secrets'),
    spoolDir: join(root, 'tmp', 'storage'),
    keyOf: () => Buffer.alloc(32, 7),
    keys: {
      open: (_e: unknown, outer: { ref: string }) => ({
        ref: outer.ref,
        exp: Date.now() + 1000,
        fields:
          kind === 's3'
            ? {
                endpoint: 'https://s3.example.com',
                region: 'us-east-1',
                bucket: 'bkt',
                accessKeyId: 'AK',
                secretAccessKey: 'SK',
                pathStyle: 'true',
              }
            : { root: join(root, 'files') },
      }),
    } as never,
    seen: { claim: () => true },
    workstationId: 'ws',
    send: (type, payload) => frames.push({ type, payload }),
    vaults: { exclusive: async () => undefined as never, isLocal: () => true },
    forbiddenRoots: [join(root, 'secrets')],
    fetch: b.fetchFn as never,
    now: () => clock,
    log: (l) => logs.push(l),
    logWarn: (l) => logs.push(l),
    logError: (l) => logs.push(l),
    uploadScan: { enabled: !!o.scan, clamd: '127.0.0.1:1', timeoutMs: 5000, quarantineDir: join(root, 'quarantine') },
    scanner,
    journalFile: join(root, 'state', 'journal.json'),
    pageOrigin: PAGE,
  });
  return { svc, b, frames, logs, root, advance: (ms: number) => (clock += ms), kind };
}
type T = ReturnType<typeof setup>;

const connect = async (t: T) => {
  const r = await t.svc.handle('storage.connect', { requestId: 'r1', connectionId: CONN, kind: t.kind, envelope: {} });
  expect(r.error).toBeUndefined();
};
const last = (t: T, type: string) => t.frames.filter((f) => f.type === type).at(-1)?.payload as Record<string, any>;
const until = async (t: T, type: string, n: number) => {
  for (let i = 0; i < 300 && t.frames.filter((f) => f.type === type).length < n; i++)
    await new Promise((r) => setTimeout(r, 10));
  return last(t, type);
};

let seq = 0;
async function open(t: T, body: Buffer, over: Record<string, unknown> = {}) {
  const grantId = `5c9d1d0e-1b6e-4c0f-9a53-${String(++seq).padStart(12, '0')}`;
  const n = t.frames.filter((f) => f.type === 'storage.grant.result').length;
  t.svc.onMessage({
    type: 'storage.grant.open',
    grantId,
    connectionId: CONN,
    folder: 'forms',
    name: 'doc',
    vars: {},
    ext: 'pdf',
    contentType: 'application/pdf',
    size: body.length,
    sha256: sha(body),
    accepted: ['pdf'],
    pageOrigin: PAGE,
    ttlMs: 300_000,
    submission: { orgId: ORG, formId: FORM, submissionId: SID },
    scan: { field: 'f_file', fileName: 'report.pdf' },
    ...over,
  } as never);
  const res = await until(t, 'storage.grant.result', n + 1);
  return { grantId, res };
}
const stagedKey = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/bkt\//, ''));
const finish = async (t: T, grantId: string, body: Buffer, over: Record<string, unknown> = {}) => {
  const n = t.frames.filter((f) => f.type === 'storage.grant.verified').length;
  t.svc.onMessage({ type: 'storage.grant.finish', grantId, size: body.length, sha256: sha(body), ...over } as never);
  return until(t, 'storage.grant.verified', n + 1);
};

describe('direct upload grants', () => {
  it('issues a presigned PUT under the staging folder and never logs it', async () => {
    const t = setup();
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    expect(res.ok).toBe(true);
    expect(res.grant.method).toBe('PUT');
    expect(stagedKey(res.grant.url)).toBe(`.guildwise-incoming/${grantId}.pdf`);
    expect(res.grant.url).toContain('X-Amz-Expires=300');
    expect(Object.keys(res.grant.headers).sort()).toEqual(['content-type', 'if-none-match', 'x-amz-checksum-sha256']);
    expect(res.grant.chunkBytes).toBeNull();
    expect(t.logs.join('\n')).not.toContain(res.grant.url);
    expect(t.logs.join('\n')).not.toContain('X-Amz-Signature');
    expect(t.logs.join('\n')).not.toContain(grantId);
  });

  it('verifies size and the provider sha256 with a range read only, then promotes', async () => {
    const t = setup();
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    t.b.objs.set(stagedKey(res.grant.url), { body: PDF, mod: Date.now() });
    const v = await finish(t, grantId, PDF);
    expect(v.ok).toBe(true);
    expect(v.reference.size).toBe(PDF.length);
    expect(v.reference.sha256).toBe(sha(PDF));
    expect(v.reference.contentType).toBe('application/pdf');
    expect(t.b.objs.get(v.reference.path)?.body.equals(PDF)).toBe(true);
    // Only the first bytes were read back, not the whole object.
    expect(t.b.calls.some((c) => c.startsWith('GET ') && c.endsWith(' range'))).toBe(true);
    expect(t.b.calls.some((c) => c.startsWith('GET ') && !c.endsWith(' range') && !c.endsWith(' list'))).toBe(false);
    // The submission can be taken back: the journal knows the file.
    const gone = await t.svc.handle('storage.discard', { submissionId: SID });
    expect(gone.discarded).toBe(1);
    expect(t.b.objs.has(v.reference.path)).toBe(false);
  });

  it('reads the whole object when the provider exposes no hash', async () => {
    const t = setup({ checksum: false });
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    t.b.objs.set(stagedKey(res.grant.url), { body: PDF, mod: Date.now() });
    const v = await finish(t, grantId, PDF);
    expect(v.ok).toBe(true);
    expect(t.b.calls.some((c) => c.startsWith('GET ') && !c.endsWith(' range') && !c.endsWith(' list'))).toBe(true);
  });

  it('deletes the object when the size is not the declared one', async () => {
    const t = setup();
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    const key = stagedKey(res.grant.url);
    t.b.objs.set(key, { body: Buffer.concat([PDF, Buffer.from('extra')]), mod: Date.now() });
    const v = await finish(t, grantId, PDF);
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe('invalid');
    expect(t.b.objs.has(key)).toBe(false);
    expect([...t.b.objs.keys()].some((k) => k.startsWith('forms/'))).toBe(false);
  });

  it.each([
    ['provider checksum', true],
    ['full read', false],
  ])('deletes the object when the content differs (%s)', async (_n, checksum) => {
    const t = setup({ checksum });
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    const key = stagedKey(res.grant.url);
    const tampered = Buffer.from(PDF);
    tampered[12] = tampered[12]! ^ 1;
    t.b.objs.set(key, { body: tampered, mod: Date.now() });
    const v = await finish(t, grantId, PDF);
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe('invalid');
    expect(t.b.objs.has(key)).toBe(false);
  });

  it('says invalid when the file never arrived', async () => {
    const t = setup();
    await connect(t);
    const { grantId } = await open(t, PDF);
    const v = await finish(t, grantId, PDF);
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe('invalid');
  });

  it('refuses a file whose content is not the type its name says', async () => {
    const t = setup();
    await connect(t);
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
    const { grantId, res } = await open(t, exe);
    const key = stagedKey(res.grant.url);
    t.b.objs.set(key, { body: exe, mod: Date.now() });
    const v = await finish(t, grantId, exe);
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe('type_refused');
    expect(t.b.objs.has(key)).toBe(false);
  });

  it('runs the malware scan on the staged object and takes the submission back', async () => {
    const t = setup({ scan: () => ({ kind: 'infected', signature: 'Eicar' }) });
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    const key = stagedKey(res.grant.url);
    t.b.objs.set(key, { body: PDF, mod: Date.now() });
    const v = await finish(t, grantId, PDF);
    expect(v.ok).toBe(false);
    expect(v.error.code).toBe('malware_detected');
    expect(t.b.objs.has(key)).toBe(false);
    expect([...t.b.objs.keys()].some((k) => k.startsWith('forms/'))).toBe(false);
    expect(existsSync(join(t.root, 'quarantine'))).toBe(true);
    expect(readdirSync(join(t.root, 'quarantine')).length).toBeGreaterThan(0);
  });

  it('fails closed when the scanner cannot run', async () => {
    const t = setup({ scan: () => ({ kind: 'failed', reason: 'down' }) });
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    t.b.objs.set(stagedKey(res.grant.url), { body: PDF, mod: Date.now() });
    const v = await finish(t, grantId, PDF);
    expect(v.error.code).toBe('scan_unavailable');
  });

  it('accepts a grant once: a second finish and an unknown grant are refused', async () => {
    const t = setup();
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    t.b.objs.set(stagedKey(res.grant.url), { body: PDF, mod: Date.now() });
    expect((await finish(t, grantId, PDF)).ok).toBe(true);
    const again = await finish(t, grantId, PDF);
    expect(again.ok).toBe(false);
    expect(again.error.code).toBe('invalid');
    const unknown = await finish(t, '5c9d1d0e-1b6e-4c0f-9a53-ffffffffffff', PDF);
    expect(unknown.error.code).toBe('invalid');
  });

  it('refuses a finish that reports another size or hash than the grant', async () => {
    const t = setup();
    await connect(t);
    const { grantId, res } = await open(t, PDF);
    const key = stagedKey(res.grant.url);
    t.b.objs.set(key, { body: PDF, mod: Date.now() });
    const v = await finish(t, grantId, PDF, { size: PDF.length + 1 });
    expect(v.ok).toBe(false);
    expect(t.b.objs.has(key)).toBe(false);
  });

  it('cancels an unused grant at its expiry', async () => {
    const t = setup();
    await connect(t);
    const { grantId, res } = await open(t, PDF, { ttlMs: 30 });
    const key = stagedKey(res.grant.url);
    t.b.objs.set(key, { body: PDF, mod: Date.now() });
    await new Promise((r) => setTimeout(r, 120));
    expect(t.b.objs.has(key)).toBe(false);
    const v = await finish(t, grantId, PDF);
    expect(v.error.code).toBe('invalid');
  });

  it('cancel and remove delete what the provider holds', async () => {
    const t = setup();
    await connect(t);
    const a = await open(t, PDF);
    const ka = stagedKey(a.res.grant.url);
    t.b.objs.set(ka, { body: PDF, mod: Date.now() });
    t.svc.onMessage({ type: 'storage.grant.cancel', grantId: a.grantId, reason: 'retry' } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.b.objs.has(ka)).toBe(false);
    const b = await open(t, PDF);
    const kb = stagedKey(b.res.grant.url);
    t.b.objs.set(kb, { body: PDF, mod: Date.now() });
    await t.svc.handle('storage.remove', { connectionId: CONN });
    expect(t.b.objs.has(kb)).toBe(false);
  });

  it('sweeps old staged entries and keeps open grants and young ones', async () => {
    const t = setup();
    await connect(t);
    const { res } = await open(t, PDF);
    const open1 = stagedKey(res.grant.url);
    const now = Date.now();
    t.b.objs.set(open1, { body: PDF, mod: now - 3 * 3600_000 });
    t.b.objs.set('.guildwise-incoming/old.pdf', { body: PDF, mod: now - 3 * 3600_000 });
    t.b.objs.set('.guildwise-incoming/young.pdf', { body: PDF, mod: now });
    t.b.objs.set('forms/real.pdf', { body: PDF, mod: now - 9 * 3600_000 });
    expect(await t.svc.sweepStaging()).toBe(1);
    expect(t.b.objs.has('.guildwise-incoming/old.pdf')).toBe(false);
    expect(t.b.objs.has(open1)).toBe(true);
    expect(t.b.objs.has('.guildwise-incoming/young.pdf')).toBe(true);
    expect(t.b.objs.has('forms/real.pdf')).toBe(true);
  });

  it('reports the upload host of a bucket, and the reason when CORS is missing', async () => {
    const ok = setup();
    await connect(ok);
    await ok.svc.reportDirect();
    expect(last(ok, 'storage.direct.report').connections[0]).toEqual({
      connectionId: CONN,
      uploadOrigin: 'https://s3.example.com',
      reason: null,
    });
    const bad = setup({ cors: false });
    await connect(bad);
    await bad.svc.reportDirect();
    expect(last(bad, 'storage.direct.report').connections[0]).toEqual({
      connectionId: CONN,
      uploadOrigin: null,
      reason: 'cors_missing',
    });
  });
});

describe('local folders keep the relay', () => {
  it('refuses a grant and reports no upload host', async () => {
    const t = setup({ kind: 'local' });
    await connect(t);
    const { res } = await open(t, PDF);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid');
    await t.svc.reportDirect();
    expect(last(t, 'storage.direct.report').connections[0]).toEqual({
      connectionId: CONN,
      uploadOrigin: null,
      reason: 'unsupported_kind',
    });
  });
});
