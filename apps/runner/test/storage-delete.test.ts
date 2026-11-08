import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GDriveConnector } from '../src/storage/gdrive.ts';
import { LocalConnector } from '../src/storage/local.ts';
import { OneDriveConnector } from '../src/storage/onedrive.ts';
import { S3Connector } from '../src/storage/s3.ts';
import { VaultConnector } from '../src/storage/vault.ts';

const sig = new AbortController().signal;
const token = async () => 'tok';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const OUTSIDE = ['../x.pdf', '/etc/passwd', 'C:\\x\\y.pdf', 'C:/x/y.pdf', 'a/../../x.pdf', 'a\\b.pdf'];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gw-del-'));
}

describe('Local deleteFile', () => {
  it('deletes an existing file, then reports not_found for a repeat', async () => {
    const root = tmp();
    mkdirSync(join(root, 'Forms'));
    writeFileSync(join(root, 'Forms', 'a.pdf'), 'x');
    const c = new LocalConnector(root);
    await expect(c.deleteFile({ path: 'Forms/a.pdf' })).resolves.toBe('deleted');
    expect(existsSync(join(root, 'Forms', 'a.pdf'))).toBe(false);
    await expect(c.deleteFile({ path: 'Forms/a.pdf' })).resolves.toBe('not_found');
  });
  it.each(OUTSIDE)('refuses %j and deletes nothing', async (p) => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'x.pdf'), 'keep');
    await expect(new LocalConnector(join(root)).deleteFile({ path: p })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(existsSync(join(outside, 'x.pdf'))).toBe(true);
  });
  it('never deletes a folder', async () => {
    const root = tmp();
    mkdirSync(join(root, 'Forms'));
    await expect(new LocalConnector(root).deleteFile({ path: 'Forms' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(existsSync(join(root, 'Forms'))).toBe(true);
  });
  it('refuses a file reached through a link', async () => {
    const root = tmp();
    const other = tmp();
    writeFileSync(join(other, 'a.pdf'), 'keep');
    symlinkSync(other, join(root, 'Forms'));
    await expect(new LocalConnector(root).deleteFile({ path: 'Forms/a.pdf' })).rejects.toMatchObject({
      code: 'permission',
    });
    expect(existsSync(join(other, 'a.pdf'))).toBe(true);
  });
  it('says unavailable, not not_found, when the root is missing', async () => {
    await expect(new LocalConnector(join(tmp(), 'gone')).deleteFile({ path: 'a.pdf' })).rejects.toMatchObject(
      {
        code: 'unavailable',
      },
    );
  });
});

describe('Vault deleteFile', () => {
  const access = (dir: string) => ({
    exclusive: async <T>(_id: string, fn: (d: string) => Promise<T>) => fn(dir),
    isLocal: () => true,
  });
  it('deletes below the vault folder and reports not_found for a repeat', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'Intake', 'Smith'), { recursive: true });
    writeFileSync(join(dir, 'Intake', 'Smith', 'doc.txt'), 'x');
    const c = new VaultConnector(access(dir), 'v1', 'Intake');
    await expect(c.deleteFile({ path: 'Intake/Smith/doc.txt' })).resolves.toBe('deleted');
    expect(existsSync(join(dir, 'Intake', 'Smith', 'doc.txt'))).toBe(false);
    await expect(c.deleteFile({ path: 'Intake/Smith/doc.txt' })).resolves.toBe('not_found');
  });
  it.each([...OUTSIDE, 'Other/doc.txt', 'Intake'])('refuses %j and deletes nothing', async (p) => {
    const dir = tmp();
    mkdirSync(join(dir, 'Other'));
    writeFileSync(join(dir, 'Other', 'doc.txt'), 'keep');
    await expect(
      new VaultConnector(access(dir), 'v1', 'Intake').deleteFile({ path: p }),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(existsSync(join(dir, 'Other', 'doc.txt'))).toBe(true);
  });
  it('says not_found as an error when the vault is not here', async () => {
    const a = {
      exclusive: async () => {
        throw new Error('vault is not configured');
      },
      isLocal: () => true,
    };
    await expect(new VaultConnector(a, 'v', '').deleteFile({ path: 'a.pdf' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('S3 deleteFile', () => {
  const mk = (fetchFn: (url: string, init?: RequestInit) => Promise<Response>) =>
    new S3Connector(
      { endpoint: 'https://s3.example.com', region: 'r', bucket: 'b', prefix: 'intake', pathStyle: true },
      { accessKeyId: 'A', secretAccessKey: 'S' },
      fetchFn,
    );
  it('deletes an existing key', async () => {
    const calls: string[] = [];
    const c = mk(async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response('', { status: 200 });
    });
    await expect(c.deleteFile({ path: 'intake/Forms/a.pdf' }, sig)).resolves.toBe('deleted');
    expect(calls).toEqual([
      'HEAD https://s3.example.com/b/intake/Forms/a.pdf',
      'DELETE https://s3.example.com/b/intake/Forms/a.pdf',
    ]);
  });
  it('reports not_found for a missing key without a DELETE', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));
    await expect(mk(fetchFn).deleteFile({ path: 'intake/a.pdf' }, sig)).resolves.toBe('not_found');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([...OUTSIDE, 'other/a.pdf', 'a.pdf'])('refuses %j before any call', async (p) => {
    const fetchFn = vi.fn(async () => new Response('', { status: 200 }));
    await expect(mk(fetchFn).deleteFile({ path: p }, sig)).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('gives a typed error for a refused request', async () => {
    const c = mk(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    await expect(c.deleteFile({ path: 'intake/a.pdf' }, sig)).rejects.toMatchObject({ code: 'permission' });
  });
});

describe('OneDrive deleteFile', () => {
  const cfg = { driveId: 'd1', baseFolder: 'Forms', baseItemId: 'base1' };
  it('deletes by path under the base folder and ignores a provider id', async () => {
    const calls: string[] = [];
    const c = new OneDriveConnector(cfg, token, async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      return new Response(null, { status: 204 });
    });
    await expect(c.deleteFile({ path: 'Acme/a b.pdf' }, sig)).resolves.toBe('deleted');
    expect(calls).toEqual(['DELETE https://graph.microsoft.com/v1.0/drives/d1/items/base1:/Acme/a%20b.pdf']);
  });
  it('reports not_found on 404', async () => {
    const c = new OneDriveConnector(cfg, token, async () => json(404, {}));
    await expect(c.deleteFile({ path: 'a.pdf' }, sig)).resolves.toBe('not_found');
  });
  it.each([...OUTSIDE, 'id:abc'])('refuses %j before any call', async (p) => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(
      new OneDriveConnector(cfg, token, fetchFn).deleteFile({ path: p }, sig),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('gives a typed error for an auth failure and a server error', async () => {
    const c401 = new OneDriveConnector(cfg, token, async () => json(401, {}));
    await expect(c401.deleteFile({ path: 'a.pdf' }, sig)).rejects.toMatchObject({ code: 'auth_expired' });
    const c500 = new OneDriveConnector(cfg, token, async () => json(500, {}));
    await expect(c500.deleteFile({ path: 'a.pdf' }, sig)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('Google Drive deleteFile', () => {
  const FOLDER = 'application/vnd.google-apps.folder';
  /** A tiny fake drive: id -> metadata. */
  function drive(
    files: Record<string, { name: string; parents: string[]; mimeType?: string; trashed?: boolean }>,
  ) {
    const calls: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      const id = decodeURIComponent(/files\/([^?]+)/.exec(url)?.[1] ?? '');
      const f = files[id];
      if (!f) return json(404, {});
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return json(200, { id, ...f });
    };
    return { calls, fetchFn };
  }
  const tree = {
    base: { name: 'Forms', parents: ['root'], mimeType: FOLDER },
    acme: { name: 'Acme', parents: ['base'], mimeType: FOLDER },
    f1: { name: 'a.pdf', parents: ['acme'] },
    top: { name: 'b.pdf', parents: ['base'] },
    stray: { name: 'a.pdf', parents: ['elsewhere'] },
    elsewhere: { name: 'Acme', parents: ['otherroot'], mimeType: FOLDER },
    bin: { name: 'a.pdf', parents: ['acme'], trashed: true },
  };
  const mk = (fetchFn: (u: string, i?: RequestInit) => Promise<Response>) =>
    new GDriveConnector({ baseFolder: 'Forms', baseFolderId: 'base' }, token, fetchFn);

  it('deletes a file whose parent chain reaches the base folder', async () => {
    const d = drive(tree);
    await expect(mk(d.fetchFn).deleteFile({ path: 'Acme/a.pdf', providerId: 'f1' }, sig)).resolves.toBe(
      'deleted',
    );
    expect(d.calls.at(-1)).toMatch(/^DELETE .*files\/f1$/);
  });
  it('deletes a file directly in the base folder', async () => {
    const d = drive(tree);
    await expect(mk(d.fetchFn).deleteFile({ path: 'b.pdf', providerId: 'top' }, sig)).resolves.toBe(
      'deleted',
    );
  });
  it('reports not_found for a missing or binned file', async () => {
    const d = drive(tree);
    await expect(mk(d.fetchFn).deleteFile({ path: 'a.pdf', providerId: 'nope' }, sig)).resolves.toBe(
      'not_found',
    );
    await expect(mk(d.fetchFn).deleteFile({ path: 'Acme/a.pdf', providerId: 'bin' }, sig)).resolves.toBe(
      'not_found',
    );
    expect(d.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
  it('refuses a file outside the base folder and sends no DELETE', async () => {
    const d = drive(tree);
    await expect(
      mk(d.fetchFn).deleteFile({ path: 'Acme/a.pdf', providerId: 'stray' }, sig),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    // The name does not match the stored path.
    await expect(
      mk(d.fetchFn).deleteFile({ path: 'Acme/other.pdf', providerId: 'f1' }, sig),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    // A folder is never deleted.
    await expect(mk(d.fetchFn).deleteFile({ path: 'Acme', providerId: 'acme' }, sig)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(d.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
  it.each([...OUTSIDE])('refuses the path %j before any call', async (p) => {
    const fetchFn = vi.fn(async () => json(200, {}));
    await expect(mk(fetchFn).deleteFile({ path: p, providerId: 'f1' }, sig)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('requires a provider id and a base folder id', async () => {
    const fetchFn = vi.fn(async () => json(200, {}));
    await expect(mk(fetchFn).deleteFile({ path: 'a.pdf' }, sig)).rejects.toMatchObject({ code: 'invalid' });
    const noBase = new GDriveConnector({ baseFolder: 'Forms' }, token, fetchFn);
    await expect(noBase.deleteFile({ path: 'a.pdf', providerId: 'f1' }, sig)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('gives a typed error when Drive refuses', async () => {
    const c = mk(async () => json(403, { error: { errors: [{ reason: 'forbidden' }] } }));
    await expect(c.deleteFile({ path: 'a.pdf', providerId: 'f1' }, sig)).rejects.toMatchObject({
      code: 'permission',
    });
  });
});
