import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromHttp, fromNodeError } from '../src/storage/errors.ts';
import { GDriveConnector } from '../src/storage/gdrive.ts';
import { OneDriveConnector } from '../src/storage/onedrive.ts';
import { S3Connector } from '../src/storage/s3.ts';
import { type Spooled, StorageError } from '../src/storage/types.ts';
import { VaultConnector } from '../src/storage/vault.ts';

const BODY = Buffer.from('hello storage connectors');
const sha = createHash('sha256').update(BODY).digest('hex');
function spool(): Spooled {
  const dir = mkdtempSync(join(tmpdir(), 'gw-conn-'));
  const file = join(dir, 'f.bin');
  writeFileSync(file, BODY);
  return { file, size: BODY.length, sha256: sha, contentType: 'text/plain' };
}
const sig = new AbortController().signal;
const target = { folder: ['Matter', 'Smith'], name: 'doc.txt' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const token = async () => 'tok';

describe('S3 write (AC3)', () => {
  it('signs the request, hashes the payload and uses a virtual-host key with the prefix', async () => {
    const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, headers: init?.headers as Record<string, string> });
      if (method === 'HEAD') return new Response(null, { status: 404 });
      if (init?.body) await new Response(init.body as never).arrayBuffer();
      return new Response('', { status: 200, headers: { etag: '"abc"' } });
    };
    const c = new S3Connector(
      {
        endpoint: 'https://s3.example.com',
        region: 'eu-1',
        bucket: 'firm',
        prefix: 'intake',
        pathStyle: false,
      },
      { accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
      fetchFn,
    );
    const ref = await c.put(target, spool(), sig);
    expect(ref.path).toBe('intake/Matter/Smith/doc.txt');
    expect(ref.providerId).toBe('abc');
    const put = calls.find((x) => x.method === 'PUT');
    expect(put?.url).toBe('https://firm.s3.example.com/intake/Matter/Smith/doc.txt');
    const h = Object.fromEntries(Object.entries(put?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(h['x-amz-content-sha256']).toBe(sha);
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-1\/s3\/aws4_request/);
    expect(JSON.stringify(calls)).not.toContain('SECRET');
  });
  it('uses path style when asked and renames a clash', async () => {
    const urls: string[] = [];
    let heads = 0;
    const fetchFn = async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method} ${url}`);
      if (init?.method === 'HEAD') return new Response(null, { status: heads++ === 0 ? 200 : 404 });
      if (init?.body) await new Response(init.body as never).arrayBuffer();
      return new Response('', { status: 200 });
    };
    const c = new S3Connector(
      { endpoint: 'https://s3.example.com', region: 'r', bucket: 'b', prefix: '', pathStyle: true },
      { accessKeyId: 'A', secretAccessKey: 'S' },
      fetchFn,
    );
    const ref = await c.put({ folder: [], name: 'doc.txt' }, spool(), sig);
    expect(ref.path).toBe('doc-2.txt');
    expect(urls.at(-1)).toBe('PUT https://s3.example.com/b/doc-2.txt');
  });
  it.each([
    [507, 'XMinioStorageFull', 'quota'],
    [403, 'AccessDenied', 'permission'],
    [403, 'InvalidAccessKeyId', 'auth_expired'],
    [503, 'SlowDown', 'unavailable'],
  ])('a PUT answered %s %s ends in %s', async (status, code, expected) => {
    const fetchFn = async (_u: string, init?: RequestInit) =>
      init?.method === 'HEAD'
        ? new Response(null, { status: 404 })
        : new Response(`<Error><Code>${code}</Code></Error>`, { status });
    const c = new S3Connector(
      { endpoint: 'https://s3.example.com', region: 'r', bucket: 'b', prefix: '', pathStyle: true },
      { accessKeyId: 'A', secretAccessKey: 'S' },
      fetchFn,
    );
    await expect(c.put(target, spool(), sig)).rejects.toMatchObject({ code: expected });
  });
});

describe('OneDrive write (AC3)', () => {
  it('creates folders, opens an upload session, PUTs with Content-Range and returns the item id', async () => {
    const seen: string[] = [];
    let range = '';
    const fetchFn = async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`);
      if (url.endsWith('/children')) return json(201, { id: 'folder1' });
      if (url.includes('createUploadSession')) return json(200, { uploadUrl: 'https://upload.test/u1' });
      if (url === 'https://upload.test/u1') {
        range = (init?.headers as Record<string, string>)['content-range'] ?? '';
        return json(201, { id: 'item-9' });
      }
      return json(500, {});
    };
    const c = new OneDriveConnector(
      { driveId: 'd1', baseFolder: 'Intake', baseItemId: 'base' },
      token,
      fetchFn,
    );
    const ref = await c.put(target, spool(), sig);
    expect(ref).toEqual({ path: 'Matter/Smith/doc.txt', providerId: 'item-9' });
    expect(range).toBe(`bytes 0-${BODY.length - 1}/${BODY.length}`);
  });
  it('moves to the next name when the session answers 409', async () => {
    let n = 0;
    const fetchFn = async (url: string) => {
      if (url.endsWith('/children')) return json(201, { id: 'f' });
      if (url.includes('createUploadSession'))
        return n++ === 0 ? json(409, {}) : json(200, { uploadUrl: 'https://upload.test/u2' });
      return json(200, { id: 'i2' });
    };
    const c = new OneDriveConnector({ driveId: 'd', baseFolder: 'x' }, token, fetchFn);
    const ref = await c.put({ folder: [], name: 'doc.txt' }, spool(), sig);
    expect(ref.path).toBe('doc-2.txt');
  });
  it('a full drive ends in quota and a refused folder in permission', async () => {
    const full = async (url: string) =>
      url.endsWith('/children')
        ? json(201, { id: 'f' })
        : url.includes('createUploadSession')
          ? json(200, { uploadUrl: 'https://upload.test/u' })
          : json(507, { error: { code: 'quotaLimitReached' } });
    await expect(
      new OneDriveConnector({ driveId: 'd', baseFolder: 'x' }, token, full).put(target, spool(), sig),
    ).rejects.toMatchObject({ code: 'quota' });
    const denied = async () => json(403, { error: { code: 'accessDenied' } });
    await expect(
      new OneDriveConnector({ driveId: 'd', baseFolder: 'x' }, token, denied).put(target, spool(), sig),
    ).rejects.toMatchObject({ code: 'permission' });
  });
});

describe('Google Drive write (AC3)', () => {
  function drive(over: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
    const calls: string[] = [];
    let existing = 0;
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      const o = over(url, init);
      if (o) return o;
      if (url.includes('/files/base?')) return json(200, { id: 'base', trashed: false });
      if (url.includes('uploadType=resumable'))
        return new Response('', { status: 200, headers: { location: 'https://upload.test/g1' } });
      if (url === 'https://upload.test/g1') return json(200, { id: 'file-7' });
      if (url.includes('mimeType')) return json(200, { files: [{ id: 'sub' }] });
      if (url.includes('/files?fields=files'))
        return json(200, { files: existing++ === 0 ? [{ id: 'taken' }] : [] });
      return json(500, {});
    };
    return { calls, fetchFn };
  }
  it('finds the folders, skips a taken name and uploads through the resumable URL', async () => {
    const d = drive();
    const c = new GDriveConnector({ baseFolder: 'Intake', baseFolderId: 'base' }, token, d.fetchFn);
    const ref = await c.put(target, spool(), sig);
    expect(ref).toEqual({ path: 'Matter/Smith/doc-2.txt', providerId: 'file-7' });
    expect(d.calls.some((x) => x.startsWith('PUT https://upload.test/g1'))).toBe(true);
  });
  it('recreates the base folder when it was trashed and reports the new id', async () => {
    const d = drive((url, init) => {
      if (url.includes('/files/base?')) return json(200, { id: 'base', trashed: true });
      if (init?.method === 'POST' && url.includes('/files?fields=id')) return json(200, { id: 'newbase' });
      return undefined;
    });
    let saved = '';
    const c = new GDriveConnector({ baseFolder: 'Intake', baseFolderId: 'base' }, token, d.fetchFn, (i) => {
      saved = i;
    });
    await c.put({ folder: [], name: 'a.txt' }, spool(), sig);
    expect(saved).toBe('newbase');
  });
  it('maps a full Drive to quota and missing rights to permission', async () => {
    const q = drive((url) =>
      url === 'https://upload.test/g1'
        ? json(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } })
        : undefined,
    );
    await expect(
      new GDriveConnector({ baseFolder: 'x', baseFolderId: 'base' }, token, q.fetchFn).put(
        { folder: [], name: 'a' },
        spool(),
        sig,
      ),
    ).rejects.toMatchObject({ code: 'quota' });
    const p = drive((url) =>
      url === 'https://upload.test/g1'
        ? json(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } })
        : undefined,
    );
    await expect(
      new GDriveConnector({ baseFolder: 'x', baseFolderId: 'base' }, token, p.fetchFn).put(
        { folder: [], name: 'a' },
        spool(),
        sig,
      ),
    ).rejects.toMatchObject({ code: 'permission' });
  });
});

describe('Vault write (AC3)', () => {
  it('writes below the vault folder, renames a clash and returns the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-vault-'));
    const access = {
      exclusive: async <T>(_id: string, fn: (d: string) => Promise<T>) => fn(dir),
      isLocal: () => true,
    };
    const c = new VaultConnector(access, 'v1', 'Intake');
    const first = await c.put({ folder: ['Smith'], name: 'doc.txt' }, spool());
    const second = await c.put({ folder: ['Smith'], name: 'doc.txt' }, spool());
    expect(first.path).toBe('Intake/Smith/doc.txt');
    expect(second.path).toBe('Intake/Smith/doc-2.txt');
    expect(readFileSync(join(dir, 'Intake', 'Smith', 'doc.txt'))).toEqual(BODY);
    await c.delete(first.path);
    expect(existsSync(join(dir, 'Intake', 'Smith', 'doc.txt'))).toBe(false);
  });
  it('says not_found when the vault is not on this workstation', async () => {
    const access = {
      exclusive: async () => {
        throw new Error('vault is not configured');
      },
      isLocal: () => true,
    };
    await expect(new VaultConnector(access, 'v', '').put(target, spool())).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('typed errors (AC4)', () => {
  it.each([
    ['onedrive', 401, undefined, 'auth_expired'],
    ['s3', 401, undefined, 'auth_expired'],
    ['s3', 403, 'InvalidAccessKeyId', 'auth_expired'],
    ['s3', 403, 'SignatureDoesNotMatch', 'auth_expired'],
    ['s3', 403, 'AccessDenied', 'permission'],
    ['google_drive', 403, 'insufficientPermissions', 'permission'],
    ['onedrive', 403, 'accessDenied', 'permission'],
    ['onedrive', 507, undefined, 'quota'],
    ['onedrive', 409, 'quotaLimitReached', 'quota'],
    ['google_drive', 403, 'storageQuotaExceeded', 'quota'],
    ['s3', 400, 'XMinioStorageFull', 'quota'],
    ['s3', 413, undefined, 'too_large'],
    ['s3', 400, 'EntityTooLarge', 'too_large'],
    ['s3', 404, 'NoSuchBucket', 'not_found'],
    ['google_drive', 404, undefined, 'not_found'],
    ['google_drive', 403, 'userRateLimitExceeded', 'unavailable'],
    ['s3', 503, 'SlowDown', 'unavailable'],
    ['onedrive', 429, undefined, 'unavailable'],
    ['onedrive', 502, undefined, 'unavailable'],
    ['onedrive', 418, undefined, 'unavailable'],
  ] as const)('%s %s %s maps to %s', (kind, status, code, expected) => {
    const e = fromHttp(kind, status, code);
    expect(e).toBeInstanceOf(StorageError);
    expect(e.code).toBe(expected);
  });
  it.each([
    ['ENOSPC', 'quota'],
    ['EDQUOT', 'quota'],
    ['EACCES', 'permission'],
    ['EPERM', 'permission'],
    ['EROFS', 'permission'],
    ['ENOENT', 'not_found'],
    ['ECONNRESET', 'unavailable'],
  ])('node %s maps to %s without the path', (code, expected) => {
    const e = fromNodeError(Object.assign(new Error('/secret/path failed'), { code }));
    expect(e.code).toBe(expected);
    expect(e.message).not.toContain('/secret');
  });
  it('maps a timeout to timeout', () => {
    expect(fromNodeError(Object.assign(new Error('x'), { name: 'TimeoutError' })).code).toBe('timeout');
  });
});
