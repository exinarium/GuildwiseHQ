import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClamdClient, ScanVerdict } from '../src/storage/scan.ts';
import { StorageService, type StorageServiceDeps } from '../src/storage/service.ts';

const CONN = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
const ORG = 'aaaaaaaa-1b6e-4c0f-9a53-2c1f3e4a5b66';
const FORM = 'bbbbbbbb-1b6e-4c0f-9a53-2c1f3e4a5b66';
const SID = 'cccccccc-1b6e-4c0f-9a53-2c1f3e4a5b66';
const keyOf = () => Buffer.alloc(32, 7);
const posix = process.platform !== 'win32';

type Frame = { type: string; payload: Record<string, any> };

function setup(
  verdict: () => ScanVerdict,
  scanOn = true,
  over: Partial<StorageServiceDeps> = {},
  quarantineInside = false,
) {
  const root = mkdtempSync(join(tmpdir(), 'gw-scan-svc-'));
  const stored = join(root, 'files');
  mkdirSync(stored);
  const quarantineDir = quarantineInside ? join(stored, 'q') : join(root, 'quarantine');
  const frames: Frame[] = [];
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const calls = { scan: 0, ping: 0 };
  const scanner: ClamdClient = {
    scanFile: async () => {
      calls.scan++;
      return verdict();
    },
    ping: async () => {
      calls.ping++;
      return true;
    },
  };
  const make = () =>
    new StorageService({
      secretsDir: join(root, 'secrets'),
      spoolDir: join(root, 'tmp', 'storage'),
      keyOf,
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
      log: (l) => logs.info.push(l),
      logWarn: (l) => logs.warn.push(l),
      logError: (l) => logs.error.push(l),
      uploadScan: { enabled: scanOn, clamd: '127.0.0.1:1', timeoutMs: 5000, quarantineDir },
      scanner,
      journalFile: join(root, 'state', 'journal.json'),
      ...over,
    });
  return { svc: make(), make, root, stored, quarantineDir, frames, logs, calls };
}
type T = ReturnType<typeof setup>;

const connect = async (t: T) => {
  const r = await t.svc.handle('storage.connect', {
    requestId: 'r1',
    connectionId: CONN,
    kind: 'local',
    envelope: {},
  });
  expect(r.error).toBeUndefined();
  return r;
};

let n = 0;
const send = async (
  t: T,
  body: Buffer,
  o: { scan?: boolean; submission?: boolean; name?: string; sid?: string } = {},
) => {
  const id = `5c9d1d0e-1b6e-4c0f-9a53-${String(++n).padStart(12, '0')}`;
  const before = t.frames.filter((f) => f.type === 'storage.write.result').length;
  t.svc.onMessage({
    type: 'storage.write.open',
    transferId: id,
    connectionId: CONN,
    folder: 'sub',
    name: o.name ?? 'doc',
    vars: {},
    ext: 'txt',
    contentType: 'text/plain',
    size: body.length,
    deadlineMs: 5000,
    ...(o.submission === false
      ? {}
      : { submission: { orgId: ORG, formId: FORM, submissionId: o.sid ?? SID } }),
    ...(o.scan === false ? {} : { scan: { field: 'f_file', fileName: 'report.pdf' } }),
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
  for (let i = 0; i < 200 && t.frames.filter((f) => f.type === 'storage.write.result').length === before; i++)
    await new Promise((r) => setTimeout(r, 10));
  return t.frames.filter((f) => f.type === 'storage.write.result').at(-1)?.payload as Record<string, any>;
};
const filesIn = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? filesIn(join(dir, d.name)).map((f) => join(d.name, f)) : [d.name],
      );

describe('upload scan off (the default)', () => {
  it('writes the file and never contacts clamd', async () => {
    const t = setup(() => ({ kind: 'infected', signature: 'X' }), false);
    await connect(t);
    const r = await send(t, Buffer.from('hello'));
    expect(r.ok).toBe(true);
    expect(filesIn(t.stored)).toEqual([join('sub', 'doc.txt')]);
    expect(t.calls).toEqual({ scan: 0, ping: 0 });
    expect(t.logs.warn.length + t.logs.error.length).toBe(0);
  });
  it('connect and test say nothing about clamd', async () => {
    const t = setup(() => ({ kind: 'clean' }), false);
    const r = (await connect(t)) as any;
    expect(r.health.message).toBeUndefined();
    const x = (await t.svc.handle('storage.test', { requestId: 'r2', connectionId: CONN })) as any;
    expect(x.health.message).toBeUndefined();
    expect(t.calls.ping).toBe(0);
  });
});

describe('upload scan on', () => {
  let t: T;
  describe('clean', () => {
    beforeEach(async () => {
      t = setup(() => ({ kind: 'clean' }));
      await connect(t);
    });
    it('scans, then writes', async () => {
      const r = await send(t, Buffer.from('fine'));
      expect(r.ok).toBe(true);
      expect(t.calls.scan).toBe(1);
      expect(readFileSync(join(t.stored, 'sub', 'doc.txt'), 'utf8')).toBe('fine');
      expect(filesIn(t.quarantineDir)).toEqual([]);
    });
    it('does not scan the answers documents or writes without scan context', async () => {
      expect((await send(t, Buffer.from('<html>'), { scan: false })).ok).toBe(true);
      expect((await send(t, Buffer.from('plain'), { scan: false, submission: false })).ok).toBe(true);
      expect(t.calls.scan).toBe(0);
    });
    it('connect/test report that clamd answers', async () => {
      const x = (await t.svc.handle('storage.test', { requestId: 'r2', connectionId: CONN })) as any;
      expect(x.health).toMatchObject({ state: 'connected', message: 'Malware scan: clamd reachable.' });
    });
  });

  describe('infected', () => {
    beforeEach(async () => {
      let call = 0;
      // the first file of the submission is clean, the second is infected
      t = setup(() =>
        ++call === 1 ? { kind: 'clean' } : { kind: 'infected', signature: 'Eicar-Signature' },
      );
      await connect(t);
    });
    it('writes nothing of the submission, quarantines the file with a sidecar, answers malware_detected', async () => {
      expect((await send(t, Buffer.from('first'), { name: 'one' })).ok).toBe(true);
      expect(filesIn(t.stored)).toEqual([join('sub', 'one.txt')]);
      const body = Buffer.from('second-bad-file');
      const r = await send(t, body, { name: 'two' });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('malware_detected');
      expect(JSON.stringify(r)).not.toMatch(/Eicar|clam|quarantine/i);
      expect(filesIn(t.stored)).toEqual([]); // the earlier file went too
      const q = filesIn(t.quarantineDir).sort();
      const sha = createHash('sha256').update(body).digest('hex');
      expect(q).toHaveLength(2);
      const bin = q.find((f) => f.endsWith('.bin')) as string;
      const side = q.find((f) => f.endsWith('.json')) as string;
      expect(bin).toMatch(new RegExp(`^\\d{8}T\\d{9}Z-${sha}\\.bin$`));
      expect(side).toBe(bin.replace(/\.bin$/, '.json'));
      expect(readFileSync(join(t.quarantineDir, bin))).toEqual(body);
      expect(JSON.parse(readFileSync(join(t.quarantineDir, side), 'utf8'))).toMatchObject({
        originalName: 'report.pdf',
        size: body.length,
        sha256: sha,
        signature: 'Eicar-Signature',
        formId: FORM,
        submissionId: SID,
        organisationId: ORG,
      });
      if (posix) {
        expect(statSync(t.quarantineDir).mode & 0o777).toBe(0o700);
        expect(statSync(join(t.quarantineDir, bin)).mode & 0o777).toBe(0o600);
        expect(statSync(join(t.quarantineDir, side)).mode & 0o777).toBe(0o600);
      }
      expect(t.logs.warn.join('\n')).toMatch(/storage\.scan infected .*signature=Eicar-Signature/);
      expect(t.logs.warn.join('\n')).toContain(`sha256=${sha}`);
      expect(t.logs.warn.join('\n')).not.toContain('second-bad-file');
      expect(readdirSync(join(t.root, 'tmp', 'storage'))).toEqual([]); // spool is gone
    });
    it('leaves another submission alone', async () => {
      const other = 'dddddddd-1b6e-4c0f-9a53-2c1f3e4a5b66';
      await send(t, Buffer.from('keep'), { name: 'keep', sid: other, scan: false });
      await send(t, Buffer.from('first'), { name: 'one' });
      await send(t, Buffer.from('bad'), { name: 'two' });
      expect(filesIn(t.stored)).toEqual([join('sub', 'keep.txt')]);
    });
  });

  describe('scan failure', () => {
    beforeEach(async () => {
      t = setup(() => ({ kind: 'failed', reason: 'clamd not reachable at 127.0.0.1:1: ECONNREFUSED' }));
      await connect(t);
    });
    it('fails closed: nothing written, nothing quarantined, scan_unavailable, error logged', async () => {
      const r = await send(t, Buffer.from('unknown'));
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('scan_unavailable');
      expect(filesIn(t.stored)).toEqual([]);
      expect(filesIn(t.quarantineDir)).toEqual([]);
      expect(t.logs.error.join('\n')).toMatch(/storage\.scan failed .*reason=clamd not reachable/);
      expect(readdirSync(join(t.root, 'tmp', 'storage'))).toEqual([]);
    });
    it('takes back the earlier files of the submission', async () => {
      let first = true;
      const t2 = setup(() => {
        if (first) {
          first = false;
          return { kind: 'clean' };
        }
        return { kind: 'failed', reason: 'size limit exceeded' };
      });
      await connect(t2);
      await send(t2, Buffer.from('one'), { name: 'one' });
      expect((await send(t2, Buffer.from('two'), { name: 'two' })).error.code).toBe('scan_unavailable');
      expect(filesIn(t2.stored)).toEqual([]);
    });
    it('the real client against nothing listening is a scan failure', async () => {
      const t3 = setup(() => ({ kind: 'clean' }), true, { scanner: undefined });
      await connect(t3).catch(() => undefined);
      const r = await send(t3, Buffer.from('x'));
      expect(r.error?.code).toBe('scan_unavailable');
      expect(filesIn(t3.stored)).toEqual([]);
    });
  });

  it('a quarantine folder inside a storage destination makes the scan unusable', async () => {
    const t7 = setup(() => ({ kind: 'infected', signature: 'X' }), true, {}, true);
    await connect(t7);
    const r = await send(t7, Buffer.from('bad'));
    expect(r.error.code).toBe('scan_unavailable');
    expect(t7.logs.error.join('\n')).toContain('inside a storage destination');
    expect(filesIn(t7.stored)).toEqual([]);
  });
});

describe('storage.discard and the journal', () => {
  it('removes what was written for the submission, idempotently, and survives a restart', async () => {
    const t = setup(() => ({ kind: 'clean' }));
    await connect(t);
    await send(t, Buffer.from('one'), { name: 'one' });
    await send(t, Buffer.from('two'), { name: 'two', scan: false });
    expect(filesIn(t.stored)).toHaveLength(2);
    const t2 = { ...t, svc: t.make() }; // a restarted runner reads the journal file
    expect(await t2.svc.handle('storage.discard', { submissionId: SID })).toEqual({ discarded: 2 });
    expect(filesIn(t.stored)).toEqual([]);
    expect(await t2.svc.handle('storage.discard', { submissionId: SID })).toEqual({ discarded: 0 });
  });
  it('rejects a payload that is not a submission id', async () => {
    const t = setup(() => ({ kind: 'clean' }));
    const r = (await t.svc.handle('storage.discard', { submissionId: '../etc' })) as any;
    expect(r.error).toBeDefined();
  });
});

describe('health with clamd down', () => {
  it('connect reports unavailable with the address', async () => {
    const t = setup(() => ({ kind: 'clean' }), true, {
      scanner: { scanFile: async () => ({ kind: 'clean' }), ping: async () => false },
    });
    const r = (await connect(t)) as any;
    expect(r.health.state).toBe('unavailable');
    expect(r.health.errorCode).toBe('scan_unavailable');
    expect(r.health.message).toContain('clamd not reachable at 127.0.0.1:1');
  });
});
