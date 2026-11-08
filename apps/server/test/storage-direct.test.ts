import { describe, expect, it } from 'vitest';
import { publicPageCsp } from '../src/public-forms/routes.ts';
import { DirectUploads, validUploadOrigin } from '../src/storage-relay/direct.ts';

describe('upload host rules', () => {
  it.each([
    ['google_drive', 'https://www.googleapis.com', true],
    ['google_drive', 'https://evil.googleapis.com', false],
    ['onedrive', 'https://contoso-my.sharepoint.com', true],
    ['onedrive', 'https://api.onedrive.com', true],
    ['onedrive', 'https://evil.example.com', false],
    ['s3', 'https://bucket.s3.eu-west-1.amazonaws.com', true],
    ['s3', 'http://s3.example.com', false],
    ['s3', 'https://localhost', false],
    ['s3', 'https://10.0.0.1', false],
    ['s3', 'https://user:pw@s3.example.com', false],
    ['local', 'https://s3.example.com', false],
  ] as const)('%s %s -> %s', (kind, origin, ok) => {
    expect(validUploadOrigin(kind, origin)).toBe(ok);
  });
});

describe('page rules', () => {
  it('connect-src is self plus the exact reported hosts, sorted and without duplicates', () => {
    expect(publicPageCsp(true)).toContain("connect-src 'self';");
    const csp = publicPageCsp(false, [
      'https://b.example.com',
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(csp).toContain("connect-src 'self' https://a.example.com https://b.example.com;");
    expect(csp).not.toContain('*');
  });
});

describe('DirectUploads', () => {
  const make = (online = true, verifyTimeoutMs?: number) => {
    const sent: Array<{ type: string; payload: any }> = [];
    const d = new DirectUploads({
      lookup: async () => ({ kind: 's3', workstationId: 'ws' }),
      isOnline: () => online,
      send: (_ws, type, payload) => (sent.push({ type, payload }), true),
      log: () => undefined,
      answerTimeoutMs: 50,
      ...(verifyTimeoutMs ? { verifyTimeoutMs } : {}),
    });
    return { d, sent };
  };
  const req = {
    orgId: 'o',
    formId: 'f',
    submissionId: 's',
    index: 0,
    connectionId: 'c',
    folder: '',
    name: 'n',
    vars: {},
    ext: 'pdf',
    contentType: 'application/pdf',
    size: 1,
    sha256: 'a'.repeat(64),
    accepted: ['pdf'],
    pageOrigin: 'https://p.example',
    ttlMs: 1000,
    scan: { field: 'f', fileName: 'x' },
  };

  it('keeps only valid reported hosts and forgets them when the runner disconnects', () => {
    const { d } = make();
    d.onReport('ws', () => 's3', [
      { connectionId: 'c', uploadOrigin: 'https://s3.example.com', reason: null },
      { connectionId: 'bad', uploadOrigin: 'https://localhost', reason: null },
    ]);
    expect(d.originOf('c')).toBe('https://s3.example.com');
    expect(d.availabilityOf('bad', 's3')).toEqual({ state: 'unavailable', reason: 'probe_failed' });
    expect(d.availabilityOf('c', 'local')).toBeNull();
    d.onDisconnect('ws');
    expect(d.originOf('c')).toBeNull();
  });

  it('asks for no grant without a reported host, and times out when the runner does not answer', async () => {
    const { d, sent } = make();
    const none = await d.open(req);
    expect(none).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(sent).toEqual([]);
    d.onReport('ws', () => 's3', [
      { connectionId: 'c', uploadOrigin: 'https://s3.example.com', reason: null },
    ]);
    const slow = await d.open(req);
    expect(slow).toMatchObject({ ok: false, error: { code: 'timeout', retryable: true } });
  });

  it('refuses an offline runner as runner_offline', async () => {
    const { d } = make(false);
    expect(await d.open(req)).toMatchObject({ ok: false, error: { code: 'runner_offline' } });
  });

  it('ignores answers from another workstation', async () => {
    const { d, sent } = make();
    d.onReport('ws', () => 's3', [
      { connectionId: 'c', uploadOrigin: 'https://s3.example.com', reason: null },
    ]);
    const p = d.open(req);
    await new Promise((r) => setTimeout(r, 5));
    const id = sent[0]?.payload.grantId;
    d.onResult('other', {
      grantId: id,
      ok: true,
      grant: { method: 'PUT', url: 'https://s3.example.com/x', headers: {}, chunkBytes: null, expiresAt: 1 },
    });
    expect(await p).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });
  const opened = async (d: DirectUploads, sent: Array<{ type: string; payload: any }>) => {
    d.onReport('ws', () => 's3', [
      { connectionId: 'c', uploadOrigin: 'https://s3.example.com', reason: null },
    ]);
    const p = d.open(req);
    await new Promise((r) => setTimeout(r, 5));
    const grantId = sent[0]?.payload.grantId;
    d.onResult('ws', {
      grantId,
      ok: true,
      grant: { method: 'PUT', url: 'https://s3.example.com/x', headers: {}, chunkBytes: null, expiresAt: 1 },
    });
    await p;
    return grantId as string;
  };
  const ref = { v: 1, connectionId: 'c', kind: 's3', path: 'p', size: 1, sha256: 'a'.repeat(64) } as any;

  it('waits for the check of a big file longer than the control answer wait', async () => {
    const { d, sent } = make(true, 2000);
    const id = await opened(d, sent);
    const v = d.finish(id, { size: 1, sha256: 'a'.repeat(64) });
    await new Promise((r) => setTimeout(r, 120)); // past the 50 ms answer wait
    d.onVerified('ws', { grantId: id, ok: true, reference: ref });
    expect(await v).toMatchObject({ ok: true });
    expect(sent.some((m) => m.type === 'storage.grant.cancel')).toBe(false);
  });

  it('tells the runner to drop the staged file when the check never answers', async () => {
    const { d, sent } = make(true, 40);
    const id = await opened(d, sent);
    expect(await d.finish(id, { size: 1, sha256: 'a'.repeat(64) })).toMatchObject({
      ok: false,
      error: { code: 'timeout' },
    });
    expect(sent.find((m) => m.type === 'storage.grant.cancel')?.payload).toMatchObject({ grantId: id });
  });
});
