import { describe, expect, it } from 'vitest';
import { GDriveConnector } from '../src/storage/gdrive.ts';
import { LocalConnector } from '../src/storage/local.ts';
import { OneDriveConnector } from '../src/storage/onedrive.ts';
import { S3Connector } from '../src/storage/s3.ts';
import { type DirectGrant, isDirectCapable } from '../src/storage/types.ts';

const sig = new AbortController().signal;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const file = { size: 1000, contentType: 'application/pdf', sha256: 'a'.repeat(64) };

describe('OneDrive direct upload', () => {
  const make = (route: (url: string, init: RequestInit) => Response) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new OneDriveConnector(
      { driveId: 'D', baseFolder: 'Base', baseItemId: 'BASE' },
      async () => 'tok',
      (async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        return route(url, init);
      }) as never,
    );
    return { c, calls };
  };

  it('creates the staging session for exactly this file and keeps the host for the report', async () => {
    const { c, calls } = make((url) =>
      url.endsWith('/children')
        ? json({ id: 'STAGE' })
        : json({ uploadUrl: 'https://contoso-my.sharepoint.com/up/xyz' }),
    );
    const g = await c.grant('g1.pdf', file, 60_000, 'https://app.example', sig);
    expect(g.url).toBe('https://contoso-my.sharepoint.com/up/xyz');
    expect(g.chunkBytes).toBe(5 * 1024 * 1024);
    expect(g.stagingRef).toBe('.guildwise-incoming/g1.pdf');
    const sess = calls.find((x) => x.url.includes('createUploadSession'));
    expect(sess?.url).toContain('/items/STAGE:/g1.pdf:/createUploadSession');
    const body = JSON.parse(String(sess?.init.body));
    expect(body.item.fileSize).toBe(1000);
    expect(body.item['@microsoft.graph.conflictBehavior']).toBe('fail');
  });

  it('reads the next expected byte and names the clash -2 on promote', async () => {
    let patches = 0;
    const { c } = make((url, init) => {
      if (init.method === 'GET' && url.startsWith('https://contoso'))
        return json({ nextExpectedRanges: ['5242880-'] });
      if (init.method === 'PATCH') return ++patches === 1 ? json({}, 409) : json({ id: 'FINAL' });
      return json({ id: 'FOLDER' });
    });
    const g: DirectGrant = {
      provider: 'onedrive',
      url: 'https://contoso-my.sharepoint.com/up/xyz',
      headers: {},
      chunkBytes: 1,
      expiresAt: 1,
      stagingRef: '.guildwise-incoming/g1.pdf',
    };
    expect(await c.offset(g, sig, 1000)).toBe(5242880);
    const r = await c.promote(g, { size: 1000 }, { folder: ['forms'], name: 'doc.pdf' }, sig);
    expect(r.path).toBe('forms/doc-2.pdf');
    expect(r.providerId).toBe('FINAL');
  });
});

describe('Google Drive direct upload', () => {
  it('starts the session with the page origin and the declared length', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new GDriveConnector({ baseFolder: 'Base', baseFolderId: 'B' }, async () => 'tok', (async (
      url: string,
      init: RequestInit = {},
    ) => {
      calls.push({ url, init });
      if (url.includes('uploadType=resumable'))
        return new Response(null, {
          status: 200,
          headers: { location: 'https://www.googleapis.com/upload/s/1' },
        });
      if (url.includes('fields=id,trashed')) return json({ id: 'B' });
      if (url.includes('q=')) return json({ files: [] });
      return json({ id: 'STAGE' });
    }) as never);
    const g = await c.grant('g1.pdf', file, 60_000, 'https://app.example', sig);
    expect(g.url).toBe('https://www.googleapis.com/upload/s/1');
    const start = calls.find((x) => x.url.includes('uploadType=resumable'));
    const h = start?.init.headers as Record<string, string>;
    expect(h.origin).toBe('https://app.example');
    expect(h['x-upload-content-length']).toBe('1000');
    expect((await c.uploadOrigin()).origin).toBe('https://www.googleapis.com');
  });

  it('reads the resume offset from the Range answer', async () => {
    const c = new GDriveConnector(
      { baseFolder: 'Base', baseFolderId: 'B' },
      async () => 'tok',
      (async () => new Response(null, { status: 308, headers: { range: 'bytes=0-8388607' } })) as never,
    );
    const g: DirectGrant = {
      provider: 'google_drive',
      url: 'https://www.googleapis.com/u',
      headers: {},
      chunkBytes: 1,
      expiresAt: 1,
      stagingRef: 'P|g1.pdf',
    };
    expect(await c.offset(g, sig, 20_000_000)).toBe(8388608);
  });
});

describe('S3 direct upload', () => {
  const keys = { accessKeyId: 'AK', secretAccessKey: 'SK' };
  it('cannot take direct uploads over http', async () => {
    const c = new S3Connector(
      { endpoint: 'http://localhost:9000', region: 'us-east-1', bucket: 'b', prefix: '', pathStyle: true },
      keys,
    );
    expect(await c.uploadOrigin(sig, 'https://app.example')).toEqual({
      origin: null,
      reason: 'http_endpoint',
    });
    await expect(c.grant('g.pdf', file, 60_000, 'https://app.example', sig)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
  it('signs the prefix, the length and the checksum into the grant', async () => {
    const c = new S3Connector(
      {
        endpoint: 'https://s3.example.com',
        region: 'eu-west-1',
        bucket: 'b',
        prefix: 'firm',
        pathStyle: false,
      },
      keys,
      undefined,
      () => new Date('2026-11-08T10:00:00Z'),
    );
    const g = await c.grant('g.pdf', file, 120_000, 'https://app.example', sig);
    expect(g.url.startsWith('https://b.s3.example.com/firm/.guildwise-incoming/g.pdf?')).toBe(true);
    expect(g.url).toContain('X-Amz-Expires=120');
    expect(g.url).toContain('content-length');
    expect(g.headers['x-amz-checksum-sha256']).toBe(Buffer.from(file.sha256, 'hex').toString('base64'));
    expect(g.headers['if-none-match']).toBe('*');
  });
});

describe('connectors without the capability', () => {
  it('a local folder is not direct capable', () => {
    expect(isDirectCapable(new LocalConnector('/tmp'))).toBe(false);
  });
});
